import { MesPenalites } from '../modules/rakapay/Billetterie';
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../context';
import { Icon } from '../components/Icon';
import { MoneyText } from '../components/MoneyText';
import { StatusBadge } from '../components/StatusBadge';
import { ValidityCountdown, ValidityLegend } from '../components/ValidityCountdown';
import { QrCode } from '../components/QrCode';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../components/States';
import { useApi } from '../hooks/useApi';
import { api, describeError, newIdempotencyKey } from '../lib/api';
import { DynamicQr, ISSUANCE_LABEL, TitleStatus, type CredentialView, type Issuance } from '../modules/titres/common';
import '../modules/titres/titres.css';
import '../modules/rakapay/rakapay.css';
import { PrintProofLink } from '../modules/preuves/PrintLink';
import { PassVisuel, RakaPayHistoriqueVisuel } from './visuels';

/**
 * Espace citoyen RakaPay (modules 76, 70, 71) et pass des moto-taxis wewa (module 81, composante de RakaPay) — branché sur l'API.
 * Doctrine : tarif issu de la règle du registre (démo : règle FICTIVE publiée) ; un wewa en vert n'a rien à payer ;
 * aucun encaissement d'espèces sur la route ; paiement par le circuit commun vers le compte public ; titre émis
 * seulement après la confirmation signée du prestataire (quittance provisoire).
 */

type Tab = 'pass' | 'tickets' | 'history';
type Duration = 'JOUR' | 'SEMAINE' | 'MOIS';
interface Price { duration: Duration; amount: MoneyJSON | null; ruleCode: string | null; ruleVersion: number | null; demo: boolean; executable: boolean; reason?: string }
interface WewaStatus { color: 'VERT' | 'AMBRE' | 'ROUGE'; text: string; nothingToPay: boolean; passNumber?: string; validFrom?: string; validUntil?: string; validity?: { from: string; until: string } | null }
interface MyWewa {
  registered: boolean;
  driver?: { id: string; displayName: string; vestNumber: string; vestToken: string; cardCode: string; status: string };
  moto?: { id: string; plate: string; orderNumber: string; make: string } | null;
  station?: { id: string; code: string; name: string; commune: string } | null;
  cooperative?: { id: string; name: string; status: string } | null;
  status?: WewaStatus | null;
  currentPass?: CredentialView | null;
  passes?: CredentialView[];
  prices?: Price[];
}
interface Station { id: string; code: string; name: string; commune: string; kinds: string[] }
interface Product {
  id: string; commercialName: string; typeCode: string; serviceType: string;
  operator: { name: string; status: string } | null;
  line: { code: string; name: string; stations: { id: string; name: string; commune: string }[] } | null;
  type: { label: string; modelLabel?: string; validity: { modelLabel: string }; demo: boolean; activable: boolean; notActivableReason?: string; price: { amount: MoneyJSON | null; ruleCode: string | null; demo: boolean } };
}

const DURATIONS: { id: Duration; label: string }[] = [{ id: 'JOUR', label: 'Jour' }, { id: 'SEMAINE', label: 'Semaine' }, { id: 'MOIS', label: 'Mois' }];
const CHANNELS = [
  { id: 'USSD', icon: 'keypad', label: 'USSD', hint: 'Tout téléphone, sans internet' },
  { id: 'MOBILE_MONEY', icon: 'phone', label: 'Mobile Money', hint: 'Depuis votre portefeuille mobile' },
  { id: 'AGENT_POINT', icon: 'store', label: 'Point de paiement agréé', hint: 'Seul lieu où les espèces sont possibles' },
];
const WEWA_TONE = { VERT: 'vert', AMBRE: 'ambre', ROUGE: 'rouge' } as const;

function Channels({ value, onChange, name }: { value: string; onChange: (v: string) => void; name: string }) {
  return (
    <fieldset className="field">
      <legend className="label">Moyen de paiement</legend>
      <div className="choice-grid">
        {CHANNELS.map((c) => (
          <label key={c.id} className={`choice ${value === c.id ? 'checked' : ''}`}>
            <input type="radio" name={name} value={c.id} checked={value === c.id} onChange={() => onChange(c.id)} />
            <Icon name={c.icon} size={20} /> <span><strong>{c.label}</strong><br /><span className="small muted">{c.hint}</span></span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Référence de paiement réelle issue du circuit commun. */
function ReferenceCard({ iss, onRefresh, onReset }: { iss: Issuance; onRefresh: () => void; onReset: () => void }) {
  const { fmtDate } = useApp();
  return (
    <div className="result-card" role="status">
      {iss.payments.map((p) => (
        <div key={p.paymentReference} className="stack-sm">
          <p className="label">Référence de paiement</p>
          <p className="ref-big mono">{p.paymentReference}</p>
          <dl className="kv">
            <div><dt>Montant</dt><dd><MoneyText money={p.amount} /> <span className="small muted">règle de démonstration</span></dd></div>
            <div><dt>Bénéficiaire</dt><dd>Compte public des recettes (coffre MOSOLO)</dd></div>
            <div><dt>Recette comptée pour</dt><dd>{p.commune ?? 'Non attribuée'} <span className="small muted">— commune de la station</span></dd></div>
            <div><dt>Valable jusqu’au</dt><dd>{fmtDate(p.expiresAt, true)}{p.status === 'EN_ATTENTE' && <> <ValidityCountdown compact from={iss.createdAt} until={p.expiresAt} label="Référence de paiement" /></>}</dd></div>
            <div><dt>Statut</dt><dd><StatusBadge tone={p.status === 'PAYE' ? 'good' : p.status === 'EN_ATTENTE' ? 'warning' : 'neutral'} label={p.status === 'PAYE' ? 'Payé — titre émis' : p.status === 'EN_ATTENTE' ? 'En attente de paiement' : 'Clos — rien n’est dû'} /></dd></div>
          </dl>
        </div>
      ))}
      <ol className="steps">
        <li>Composez le code USSD officiel [à configurer] ou ouvrez votre Mobile Money, ou rendez-vous dans un point agréé.</li>
        <li>Saisissez la référence ci-dessus : le montant est fixé, personne ne peut le modifier.</li>
        <li>Dès la confirmation signée de l’opérateur, votre titre passe au vert et une quittance provisoire vous est envoyée.</li>
        <li>La quittance devient définitive après rapprochement avec le relevé du compte public.</li>
      </ol>
      <div className="btn-row">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRefresh}><Icon name="refresh" size={16} /> Actualiser le statut</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onReset}>Nouvelle demande</button>
      </div>
    </div>
  );
}

function PassCard({ me }: { me: MyWewa }) {
  const { fmtDate } = useApp();
  const s = me.status;
  const tone = s ? WEWA_TONE[s.color] : 'rouge';
  // Rouge peut signifier « encore en règle, moins de 1 % de validité restante » (nothingToPay).
  const ok = !!s && (s.color !== 'ROUGE' || s.nothingToPay);
  return (
    <article className={`rk-pass rkx-pass-${tone}`} aria-label="Pass wewa numérique">
      <div className="rk-pass-top">
        <span className="rk-pass-brand"><Icon name="ticket" size={18} /> RakaPay · Pass wewa</span>
        <span className={`tt-status tt-${tone}`}><Icon name={tone === 'vert' ? 'check' : ok ? 'alert' : 'x'} size={16} /> {ok ? 'EN RÈGLE' : 'PAS EN RÈGLE'}</span>
      </div>
      <div className="rk-pass-body">
        <div className="min0">
          <p className="rk-pass-plate mono">{me.moto?.plate ?? '—'}</p>
          <p className="rk-pass-line">Gilet {me.driver?.vestNumber} · carte {me.driver?.cardCode}</p>
          <p className="rk-pass-line">{me.station ? `${me.station.name} (${me.station.commune})` : 'Aucune station'}</p>
          {me.cooperative && <p className="rk-pass-line">{me.cooperative.name}</p>}
          <p className="rk-pass-valid">{s?.validUntil ? <>Valable jusqu’au <strong>{fmtDate(s.validUntil, true)}</strong></> : s?.text}</p>
        </div>
        {me.currentPass && ok ? (
          <div className="rkx-qr-light"><DynamicQr credentialId={me.currentPass.id} size={124} /></div>
        ) : (
          <figure className="rk-pass-qr">
            <QrCode value={me.driver?.vestToken ?? ''} size={116} alt="QR du gilet (vérification passager)" />
            <figcaption className="mono">Gilet {me.driver?.vestNumber}</figcaption>
          </figure>
        )}
      </div>
      {(s?.validUntil ?? s?.validity?.until) && (
        <ValidityCountdown from={s?.validFrom ?? s?.validity?.from} until={s?.validUntil ?? s?.validity?.until} label="Validité du pass" />
      )}
      {s?.passNumber && <p className="small">Pass <span className="mono">{s.passNumber}</span> <PrintProofLink code={s.passNumber} label="Imprimer le pass" /></p>}
      <div className="rk-pass-strip" aria-hidden="true"><span /><span /><span /></div>
    </article>
  );
}

function BuyPass({ me, onDone }: { me: MyWewa; onDone: () => void }) {
  const [duration, setDuration] = useState<Duration>('SEMAINE');
  const [channel, setChannel] = useState('USSD');
  const [iss, setIss] = useState<Issuance | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  const price = me.prices?.find((p) => p.duration === duration);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!me.moto) return;
    setBusy(true); setErr(null);
    try {
      setIss(await api<Issuance>('/v1/rakapay/wewa/passes', { method: 'POST', body: { motoId: me.moto.id, duration, channel }, idempotencyKey: key }));
    } catch (ex) { setErr(describeError(ex).message); } finally { setBusy(false); }
  }
  const renew = me.status?.color !== 'ROUGE' || !!me.status?.nothingToPay;
  return (
    <section className="panel" aria-labelledby="rk-buy">
      <div className="panel-head">
        <div><h2 className="panel-title" id="rk-buy">{renew ? 'Renouveler mon pass' : 'Acheter mon pass'}</h2><p className="panel-sub">Un pass, un conducteur, une moto : non transférable{renew ? ' ; le nouveau pass commence à la fin de l’actuel' : ''}</p></div>
      </div>
      {!iss ? (
        <form className="form" onSubmit={(e) => void submit(e)}>
          <fieldset className="field">
            <legend className="label">Durée</legend>
            <div className="seg" role="group">
              {DURATIONS.map((x) => <button key={x.id} type="button" aria-pressed={duration === x.id} onClick={() => { setDuration(x.id); setKey(newIdempotencyKey()); }}>{x.label}</button>)}
            </div>
          </fieldset>
          <div className="rk-price">
            {price?.amount ? <MoneyText money={price.amount} /> : <span className="muted">Tarif indisponible</span>}
            <p className="small muted">Tarif calculé par la règle {price?.ruleCode ?? '—'}{price?.ruleVersion ? ` v${price.ruleVersion}` : ''} du registre{price?.demo ? ' — règle FICTIVE de démonstration, non opposable' : ''}. Ni l’agent, ni la coopérative, ni l’opérateur ne peuvent le modifier ; le tarif réel sera fixé par l’acte (J28).</p>
          </div>
          <Channels value={channel} onChange={(v) => { setChannel(v); setKey(newIdempotencyKey()); }} name="rk-channel" />
          <div className="callout callout-warn"><Icon name="cash" size={18} /><p><strong>Aucune espèce sur la route.</strong> Personne n’encaisse le pass en liquide : ni agent, ni policier, ni chef de station.</p></div>
          {err && <p className="notice notice-err" role="alert">{err}</p>}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy || !price?.executable}>{busy ? 'Création…' : 'Obtenir ma référence de paiement'}</button>
        </form>
      ) : (
        <ReferenceCard iss={iss} onRefresh={onDone} onReset={() => { setIss(null); setKey(newIdempotencyKey()); onDone(); }} />
      )}
    </section>
  );
}

function PassTab() {
  const { user, fmtDate } = useApp();
  const me = useApi(user?.taxpayerId ? () => api<MyWewa>('/v1/rakapay/wewa/moi') : null, [user?.id]);
  if (!user?.taxpayerId) return <EmptyState title="Espace réservé aux conducteurs" icon="moto">Choisissez « Kabeya Tshibangu (conducteur wewa fictif) » dans l’en-tête pour voir un pass réel de démonstration.</EmptyState>;
  if (me.loading) return <Loading />;
  if (me.error) return <ErrorState error={me.error} onRetry={me.reload} />;
  const d = me.data;
  if (!d?.registered) {
    return (
      <EmptyState title="Vous n’êtes pas encore enregistré comme conducteur" icon="moto">
        L’enregistrement de la moto et du conducteur est <strong>gratuit</strong> : il se fait avec votre coopérative ou un agent de recensement, à la station. Le gilet numéroté et l’autocollant QR vous sont remis sur place.
      </EmptyState>
    );
  }
  return (
    <>
      <PassCard me={d} />
      {d.status?.nothingToPay ? (
        <div className="callout callout-strong rk-green"><Icon name="shieldCheck" size={20} /><p><strong>Vous êtes en vert : vous n’avez rien à payer et ne pouvez être sanctionné.</strong> Toute demande d’argent sur la route est irrégulière : signalez-la, le signalement est protégé.</p></div>
      ) : (
        <div className="callout callout-warn"><Icon name="alert" size={20} /><p><strong>{d.status?.text}</strong> Aucun agent ne peut vous faire payer sur place : réglez votre pass par téléphone, USSD ou dans un point agréé.</p></div>
      )}
      <BuyPass me={d} onDone={me.reload} />
      {d.passes && d.passes.length > 0 && (
        <section className="panel" aria-labelledby="rk-passes">
          <div className="panel-head"><h2 className="panel-title" id="rk-passes">Mes pass</h2><span className="count">{d.passes.length}</span></div>
          {/* Visuel (27/09/2026) : mes pass par état et leurs périodes de validité, depuis la même réponse. */}
          <PassVisuel passes={d.passes} />
          <ul className="list-rows">
            {d.passes.map((c) => (
              <li key={c.id} className="list-row">
                <div className="min0"><p className="row-title mono">{c.number}</p><p className="small muted">{c.typeLabel} · du {fmtDate(c.validFrom, true)} au {fmtDate(c.validUntil, true)}</p></div>
                <div className="row-side"><TitleStatus status={c.status} compact />{c.state === 'EMIS' && <ValidityCountdown compact from={c.validFrom} until={c.validUntil} />}{c.state === 'EMIS' && c.shortCode && <PrintProofLink code={c.shortCode} />}{c.receiptNumbers[0] && <Link className="btn btn-ghost btn-sm" to={`/verifier/${c.receiptNumbers[0]}`}>Quittance</Link>}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function TicketsTab() {
  const { user, fmtDate } = useApp();
  const cat = useApi(() => api<Product[]>('/v1/rakapay/catalogue'), []);
  const stations = useApi(() => api<Station[]>('/v1/rakapay/stations'), []);
  const mine = useApi(user?.taxpayerId ? () => api<CredentialView[]>('/v1/rakapay/tickets') : null, [user?.id]);
  const [productId, setProductId] = useState('');
  const [stationId, setStationId] = useState('');
  const [channel, setChannel] = useState('MOBILE_MONEY');
  const [iss, setIss] = useState<Issuance | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const product = cat.data?.find((p) => p.id === productId) ?? cat.data?.[0];
  const allowed = useMemo(() => (product?.line ? product.line.stations.map((s) => s.id) : (stations.data ?? []).filter((s) => s.kinds.includes('BUS')).map((s) => s.id)), [product, stations.data]);
  const station = allowed.includes(stationId) ? stationId : allowed[0] ?? '';
  async function buy(e: FormEvent) {
    e.preventDefault();
    if (!product) return;
    setBusy(true); setErr(null);
    try { setIss(await api<Issuance>('/v1/rakapay/tickets', { method: 'POST', body: { productId: product.id, departureStationId: station, channel }, idempotencyKey: key })); }
    catch (ex) { setErr(describeError(ex).message); } finally { setBusy(false); }
  }
  if (cat.loading || stations.loading) return <Loading />;
  if (cat.error) return <ErrorState error={cat.error} onRetry={cat.reload} />;
  return (
    <>
      <section className="panel" aria-labelledby="rk-tk">
        <div className="panel-head"><div><h2 className="panel-title" id="rk-tk">Acheter un ticket urbain</h2><p className="panel-sub">Un seul moteur de titres pour tous les usages payants de la ville</p></div></div>
        {!iss ? (
          <form className="form" onSubmit={(e) => void buy(e)}>
            <ul className="rk-tickets">
              {(cat.data ?? []).map((p) => (
                <li key={p.id}>
                  <label className={`rk-ticket rkx-ticket ${product?.id === p.id ? 'checked' : ''}`}>
                    <input type="radio" name="rk-product" className="sr-only" checked={product?.id === p.id} onChange={() => { setProductId(p.id); setKey(newIdempotencyKey()); }} />
                    <span className="rk-ticket-icon"><Icon name={p.serviceType === 'BUS' ? 'bus' : 'moto'} size={24} /></span>
                    <span className="min0" style={{ flex: 1 }}>
                      <span className="row-title">{p.commercialName}</span><br />
                      <span className="small muted">{p.type.label} · {p.type.validity.modelLabel}{p.line ? ` · ${p.line.name}` : ''}</span>
                    </span>
                    {p.type.price.amount ? <MoneyText money={p.type.price.amount} /> : <StatusBadge tone="info" label="Acte requis" />}
                  </label>
                </li>
              ))}
            </ul>
            <div className="field">
              <label className="label" htmlFor="rk-station">Station de départ (la recette est comptée pour sa commune)</label>
              <select id="rk-station" value={station} onChange={(e) => setStationId(e.target.value)}>
                {(stations.data ?? []).filter((s) => allowed.includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.name} — {s.commune}</option>)}
              </select>
            </div>
            <Channels value={channel} onChange={(v) => { setChannel(v); setKey(newIdempotencyKey()); }} name="rk-tk-channel" />
            {product?.type.price.demo && <p className="small muted">Tarif issu d’une règle FICTIVE de démonstration publiée par le circuit ; aucun ticket réel avant les actes (J21, J25).</p>}
            {err && <p className="notice notice-err" role="alert">{err}</p>}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy || !user?.taxpayerId || !product?.type.activable}>{user?.taxpayerId ? (busy ? 'Création…' : 'Obtenir ma référence de paiement') : 'Connectez-vous avec un compte contribuable'}</button>
          </form>
        ) : <ReferenceCard iss={iss} onRefresh={mine.reload} onReset={() => { setIss(null); setKey(newIdempotencyKey()); mine.reload(); }} />}
      </section>
      {user?.taxpayerId && (
        <section className="panel" aria-labelledby="rk-mine">
          <div className="panel-head"><h2 className="panel-title" id="rk-mine">Mes tickets</h2>{mine.data && <span className="count">{mine.data.length}</span>}</div>
          {mine.loading ? <Loading /> : mine.error ? <ErrorState error={mine.error} onRetry={mine.reload} /> : !mine.data?.length ? <EmptyState title="Aucun ticket" icon="ticket">Vos tickets apparaissent ici dès la confirmation du paiement.</EmptyState> : (
            <ul className="list-rows">
              {mine.data.map((c) => {
                const live = c.status.status === 'VALIDE' || c.status.status === 'BIENTOT_EXPIRE' || c.status.status === 'CRITIQUE' || c.status.status === 'PAS_ENCORE_ACTIF';
                return (
                  <li key={c.id} className="list-row rkx-ticket-row">
                    <div className="min0">
                      <p className="row-title">{c.typeLabel}</p>
                      <p className="small muted mono">{c.number} · code {c.shortCode}</p>
                      <p className="small muted">{c.place.label} · jusqu’au {fmtDate(c.validUntil, true)}{c.usesLeft !== undefined ? ` · ${c.usesLeft} usage(s) restant(s)` : ''}</p>
                      <TitleStatus status={c.status} />
                      {(live || c.status.status === 'EXPIRE') && <ValidityCountdown compact from={c.validFrom} until={c.validUntil} />}
                    </div>
                    {live && <DynamicQr credentialId={c.id} size={120} />}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

function HistoryTab() {
  const { user, fmtDate } = useApp();
  const orders = useApi(user?.taxpayerId ? () => api<Issuance[]>('/v1/titres/commandes') : null, [user?.id]);
  const titles = useApi(user?.taxpayerId ? () => api<CredentialView[]>('/v1/titres') : null, [user?.id]);
  const [err, setErr] = useState<string | null>(null);
  if (!user?.taxpayerId) return <EmptyState title="Historique réservé aux titulaires" icon="history" />;
  if (orders.loading || titles.loading) return <Loading />;
  if (orders.error) return <ErrorState error={orders.error} onRetry={orders.reload} />;
  const byId = new Map((titles.data ?? []).map((t) => [t.id, t]));
  async function cancel(id: string) {
    setErr(null);
    try { await api(`/v1/titres/commandes/${id}/annulation`, { method: 'POST', body: {} }); orders.reload(); } catch (ex) { setErr(describeError(ex).message); }
  }
  return (
    <section className="panel" aria-labelledby="rk-hist">
      <div className="panel-head"><h2 className="panel-title" id="rk-hist">Historique et quittances</h2><span className="count">{orders.data?.length ?? 0}</span></div>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {/* Visuel (27/09/2026) : commandes par état et par jour, depuis l'historique déjà chargé. */}
      {!!orders.data?.length && <RakaPayHistoriqueVisuel orders={orders.data} />}
      {!orders.data?.length ? <EmptyState title="Aucune commande" icon="history" /> : (
        <ul className="list-rows">
          {orders.data.map((o) => (
            <li key={o.id} className="list-row">
              <div className="min0">
                <p className="row-title">{o.context === 'PAIEMENT_GROUPE' ? `Paiement groupé — ${o.groupPayer?.label}` : o.context === 'BILLETTERIE' ? 'Ticket urbain' : o.context === 'PASS_WEWA' ? 'Pass wewa' : o.context ?? 'Titre'}</p>
                <p className="small muted">{fmtDate(o.createdAt, true)} · {o.items.length} titre(s) · {o.payments.map((p) => p.paymentReference).join(', ')}</p>
                <p className="small">{o.items.map((it) => { const t = it.credentialId ? byId.get(it.credentialId) : undefined; return t ? `${t.number}${t.receiptNumbers[0] ? ` (quittance ${t.receiptNumbers[0]})` : ''}` : it.subject.plate ?? it.subject.label ?? it.typeCode; }).join(' · ')}</p>
              </div>
              <div className="row-side">
                {o.payments[0] && <MoneyText money={o.payments[0].amount} />}
                <StatusBadge tone={o.status === 'EMISE' ? 'good' : o.status === 'EN_ATTENTE_PAIEMENT' ? 'warning' : 'neutral'} label={ISSUANCE_LABEL[o.status] ?? o.status} />
                {o.status === 'EN_ATTENTE_PAIEMENT' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void cancel(o.id)}>Annuler</button>}
                {o.items.map((it) => { const t = it.credentialId ? byId.get(it.credentialId) : undefined; return t?.receiptNumbers[0] ? <Link key={t.id} className="btn btn-ghost btn-sm" to={`/verifier/${t.receiptNumbers[0]}`}>Vérifier</Link> : null; })}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="small muted">Historique utilisable, avec votre accord, auprès de partenaires (assurance, épargne, crédit).</p>
    </section>
  );
}

function ReportForm() {
  const [commune, setCommune] = useState('Kalamu');
  const [category, setCategory] = useState('PRELEVEMENT_IRREGULIER');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const communes = useApi(() => api<{ communes: string[] }>('/v1/meta'), []);
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try {
      const r = await api<{ id: string; message: string }>('/v1/rakapay/signalements', { method: 'POST', body: {
        category, commune, occurredAt: new Date().toISOString(), description, anonymous: true,
        ...(amount.trim() ? { amountDemanded: { amount: amount.trim(), currency: 'CDF' } } : {}),
      } });
      setDone(`${r.message} Numéro : ${r.id}.`); setDescription(''); setAmount('');
    } catch (ex) { setErr(describeError(ex).message); }
  }
  return (
    <section className="panel" aria-labelledby="rk-report">
      <h2 className="panel-title" id="rk-report"><Icon name="alert" size={18} /> Signaler un prélèvement irrégulier</h2>
      <p className="small muted">Lieu, heure, description. Vous n’avez pas à donner votre nom.</p>
      {done ? <p className="notice notice-ok" role="status" style={{ marginTop: 12 }}>{done}</p> : (
        <form className="form" style={{ marginTop: 12 }} onSubmit={(e) => void submit(e)}>
          <div className="field"><label className="label" htmlFor="rk-cat">Nature</label>
            <select id="rk-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="PRELEVEMENT_IRREGULIER">Prélèvement irrégulier sur la route</option>
              <option value="DEMANDE_ESPECES">Demande d’espèces</option>
              <option value="CONTROLE_ABUSIF">Contrôle abusif</option>
              <option value="AUTRE">Autre</option>
            </select></div>
          <div className="field"><label className="label" htmlFor="rk-com">Commune</label>
            <select id="rk-com" value={commune} onChange={(e) => setCommune(e.target.value)}>{(communes.data?.communes ?? ['Kalamu', 'Limete', 'Lemba', 'Gombe']).map((c) => <option key={c}>{c}</option>)}</select></div>
          <div className="field"><label className="label" htmlFor="rk-desc">Ce qui s’est passé</label><textarea id="rk-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} minLength={10} required /></div>
          <div className="field"><label className="label" htmlFor="rk-amt">Montant réclamé en FC (facultatif)</label><input id="rk-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} /></div>
          {err && <p className="notice notice-err" role="alert">{err}</p>}
          <button type="submit" className="btn btn-secondary btn-block" disabled={description.trim().length < 10}>Envoyer le signalement</button>
        </form>
      )}
    </section>
  );
}

function PassengerCheck() {
  const [code, setCode] = useState('');
  const [res, setRes] = useState<{ registered: boolean; driverVerified?: boolean; pass?: { color: string; text: string; validFrom?: string | null; validUntil?: string | null; validity?: { from: string; until: string } | null } | null; message: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function check(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try { setRes(await api(`/v1/public/wewa/${encodeURIComponent(code.trim())}`)); } catch (ex) { setErr(describeError(ex).message); }
  }
  const tone = res?.pass ? WEWA_TONE[res.pass.color as keyof typeof WEWA_TONE] ?? 'noir' : 'noir';
  return (
    <section className="panel" aria-labelledby="rk-pax">
      <h2 className="panel-title" id="rk-pax"><Icon name="shieldCheck" size={18} /> Passager : vérifier un conducteur</h2>
      <p className="small muted">Numéro du gilet (ex. W-KAL-0001) ou contenu du QR. Aucun nom n’est affiché.</p>
      <form className="form" style={{ marginTop: 12 }} onSubmit={(e) => void check(e)}>
        <div className="input-row"><input aria-label="Numéro de gilet" className="mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="W-KAL-0001" /><button type="submit" className="btn btn-secondary" disabled={!code.trim()}>Vérifier</button></div>
      </form>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {res && (
        <div className="stack-sm" style={{ marginTop: 12 }} role="status">
          <span className={`tt-status tt-${res.registered ? tone : 'noir'}`}><Icon name={res.registered && (tone !== 'rouge' || res.pass?.text.startsWith('EN RÈGLE')) ? 'check' : 'x'} size={16} /> {res.registered ? (res.pass?.text ?? 'Enregistré') : 'Non enregistré'}</span>
          {res.registered && (res.pass?.validUntil ?? res.pass?.validity?.until) && (
            <ValidityCountdown from={res.pass?.validFrom ?? res.pass?.validity?.from} until={res.pass?.validUntil ?? res.pass?.validity?.until} label="Validité du pass" />
          )}
          <p className="small">{res.message}</p>
          <ValidityLegend />
        </div>
      )}
    </section>
  );
}

const STEPS = [
  ['Enregistrement gratuit', 'Moto, conducteur, station et coopérative, avec une période de grâce.'],
  ['Paiement numérique', 'USSD, Mobile Money, point agréé ou paiement groupé par la coopérative.'],
  ['Statut vert', 'Dès la confirmation signée de l’opérateur de paiement.'],
  ['Contrôle par QR ou plaque', 'Le contrôleur voit valide, expiré ou invalide — sans nom ni adresse.'],
  ['Compte public', 'Chaque paiement est rapproché avec le relevé du compte public.'],
];

export default function RakaPay() {
  const [tab, setTab] = useState<Tab>('pass');
  return (
    <div className="page page-wide">
      <header className="vx-hero rk-hero" style={{ ['--vx' as string]: '#1E9BD7' }}>
        <Link to="/services" className="vx-back small"><Icon name="chevronRight" size={14} className="flip" /> Services de la Ville</Link>
        <div className="vx-hero-row">
          <span className="vx-hero-icon"><Icon name="ticket" size={30} /></span>
          <div className="min0">
            <p className="eyebrow">Billetterie RakaPay · modules 76 · 70 · 71 · 81</p>
            <h1>RakaPay</h1>
            <p className="lead">Tickets urbains et pass des moto-taxis : achetés par téléphone, contrôlés par QR ou plaque, rapprochés au compte public.</p>
          </div>
        </div>
        <div className="vx-hero-facts">
          <StatusBadge tone="info" label="Tarifs réels : acte requis (J28)" />
          <span className="small muted"><Icon name="users" size={14} /> Usagers des transports, conducteurs de wewa, coopératives</span>
        </div>
      </header>
      <ExampleNotice text="Démonstration : identités, plaques et gilets fictifs ; tarifs issus de règles FICTIVES publiées par le circuit (non opposables). Les références de paiement et les titres sont réels dans l’environnement de démonstration." />

      <div className="seg seg-wrap rk-tabs" role="tablist" aria-label="RakaPay">
        {([['pass', 'moto', 'Mon pass wewa'], ['tickets', 'ticket', 'Tickets urbains'], ['history', 'history', 'Historique']] as const).map(([id, icon, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} aria-pressed={tab === id} onClick={() => setTab(id)}>
            <Icon name={icon} size={16} /> {label}
          </button>
        ))}
      </div>

      <div className="vx-layout">
        <div className="stack">
          {tab === 'pass' && <PassTab />}
          {tab === 'tickets' && <TicketsTab />}
          {tab === 'history' && <HistoryTab />}
        </div>
        <aside className="stack">
          <section className="panel" aria-labelledby="rk-how">
            <h2 className="panel-title" id="rk-how">Comment ça marche</h2>
            <ol className="rk-steps">
              {STEPS.map(([t, d], i) => <li key={t}><span className="rk-step-n">{i + 1}</span><span><strong>{t}</strong><span className="small muted">{d}</span></span></li>)}
            </ol>
          </section>
          <PassengerCheck />
          <MesPenalites />
          <ReportForm />
        </aside>
      </div>
    </div>
  );
}
