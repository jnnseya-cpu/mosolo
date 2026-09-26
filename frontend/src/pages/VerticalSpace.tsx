import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApp } from '../context';
import { useApi } from '../hooks/useApi';
import { Icon } from '../components/Icon';
import { MoneyText } from '../components/MoneyText';
import { StatusBadge } from '../components/StatusBadge';
import { MapStatusChip } from '../components/MapStatusChip';
import { QrCode } from '../components/QrCode';
import { Drawer } from '../components/Drawer';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../components/States';
import { api, describeError, newIdempotencyKey } from '../lib/api';
import { sha256Hex } from '../lib/crypto';
import {
  CASE_TONE, COMMUNES, fetchSpace, fetchVertical, LEGAL_TONE, OBJ_LABEL, OBJ_MAP, OBLIGATION_LABEL, OBLIGATION_TONE, PAYMENT_LABEL, RECEIPT_LABEL,
  TITLE_TONE, verifyPath, type AviaDeclaration, type CaseView, type CertificateView, type Procedure, type StallView, type TicketingView,
  type VerticalDetail, type VObject, type VObligation,
} from '../verticals/catalogue';
import RakaPay from './RakaPay';
import '../modules/verticales/verticales.css';

export { OBLIGATION_TONE as DUE_TONE };

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError(describeError(e).message); return undefined; } finally { setBusy(false); }
  };
  return { busy, error, run, setError };
}

// ------------------------------------------------------------------------------------------------ obligations

function ObligationCard({ o, onChange }: { o: VObligation; onChange: () => void }) {
  const { fmtDate } = useApp();
  const [open, setOpen] = useState(false);
  const [order, setOrder] = useState<{ paymentReference: string; expiresAt: string } | null>(null);
  const act = useAction();
  const requestReference = () => act.run(async () => {
    const r = await api<{ paymentReference: string; expiresAt: string }>(`/v1/obligations/${encodeURIComponent(o.id)}/payment-orders`, { method: 'POST', body: { channel: 'MOBILE_MONEY' }, idempotencyKey: newIdempotencyKey() });
    setOrder(r); onChange();
  });
  return (
    <li className="vx-due">
      <div className="vx-due-main">
        <div className="min0">
          <p className="row-title">{o.label.replace(/^DÉMONSTRATION — /, '')}</p>
          <p className="small muted">Échéance {fmtDate(o.dueDate)}{o.commune ? ` · ${o.commune}` : ''}</p>
          {o.demo && <span className="vx-demo-rule"><Icon name="info" size={13} /> {o.ruleNotice}</span>}
        </div>
        <div className="vx-due-side">
          <MoneyText money={o.amount} />
          <StatusBadge tone={o.payment ? 'good' : OBLIGATION_TONE[o.status] ?? 'neutral'} label={o.payment && o.payment.status !== 'INITIE' ? PAYMENT_LABEL[o.payment.status] ?? o.payment.status : OBLIGATION_LABEL[o.status] ?? o.status} />
        </div>
      </div>
      {open && (
        <dl className="kv kv-dense vx-due-detail">
          <div><dt>Règle appliquée</dt><dd><span className="mono">{o.ruleCode}</span> v{o.ruleVersion} — {o.ruleStatus}{o.demo ? ' (fictive)' : ''}</dd></div>
          {o.commune && <div><dt>Recette comptée pour</dt><dd>{o.commune} <span className="small muted">— commune du bien, de l’emplacement ou de l’activité, pas celle de votre domicile</span></dd></div>}
          <div><dt>Effet</dt><dd>{o.demo ? 'Démonstration du circuit : montant issu d’une règle fictive, sans valeur juridique.' : 'Montant exigible à l’échéance ; contestation possible à tout moment.'}</dd></div>
          {o.payment && <div><dt>Référence de paiement</dt><dd className="mono">{o.payment.paymentReference}</dd></div>}
        </dl>
      )}
      {order && (
        <div className="callout callout-info">
          <Icon name="phone" size={18} />
          <p>Référence <strong className="mono">{order.paymentReference}</strong> — valable jusqu’au {fmtDate(order.expiresAt, true)}. Payez par Mobile Money, USSD, banque ou point agréé : la quittance est émise à la confirmation signée du prestataire, jamais sur capture d’écran.</p>
        </div>
      )}
      {act.error && <p className="err" role="alert">{act.error}</p>}
      <div className="row-actions">
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}><Icon name="info" size={16} /> Comprendre ce montant</button>
        {o.payable && !o.payment && !order && <button type="button" className="btn btn-primary btn-sm" disabled={act.busy} onClick={requestReference}><Icon name="card" size={16} /> Obtenir une référence de paiement</button>}
        {o.status !== 'SOLDEE' && <Link className="btn btn-secondary btn-sm" to="/espace">Contester</Link>}
      </div>
    </li>
  );
}

// ------------------------------------------------------------------------------------------------ démarches

function ProcedureForm({ slug, proc, objects, onDone }: { slug: string; proc: Procedure; objects: VObject[]; onDone: (c: CaseView) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [objectId, setObjectId] = useState(objects[0]?.id ?? '');
  const [docs, setDocs] = useState<Record<string, { name: string; sha256: string }>>({});
  const [key] = useState(newIdempotencyKey);
  const act = useAction();
  const eligible = objects.filter((o) => !o.cessation);

  const onFile = async (label: string, file: File | undefined) => {
    if (!file) return;
    const hash = await sha256Hex(await file.arrayBuffer());
    setDocs((d) => ({ ...d, [label]: { name: file.name, sha256: hash } }));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      const body = {
        type: proc.code, details: values, ...(proc.requiresObject ? { objectId } : {}),
        documents: Object.entries(docs).map(([label, d]) => ({ label, sha256: d.sha256 })),
      };
      const c = await api<CaseView>(`/v1/verticales/${slug}/cases`, { method: 'POST', body, idempotencyKey: key });
      onDone(c);
    });
  };
  if (proc.requiresObject && eligible.length === 0) return <EmptyState title="Aucun objet concerné" icon="file">Cette démarche porte sur un objet déjà enregistré à votre compte.</EmptyState>;
  return (
    <form className="form" onSubmit={submit}>
      <p className="small muted">{proc.hint}{proc.visit === 'OBLIGATOIRE' ? ' · une visite sur place précède la décision' : ''}</p>
      {proc.protectedReport && <div className="callout callout-info"><Icon name="lock" size={18} /><p>Signalement protégé : il est instruit par l’anti-fraude, votre identité n’est pas communiquée aux agents concernés.</p></div>}
      {proc.requiresObject && (
        <label className="field"><span className="label">Objet concerné</span>
          <select value={objectId} onChange={(e) => setObjectId(e.target.value)} required>
            {eligible.map((o) => <option key={o.id} value={o.id}>{o.label} — {o.ref}</option>)}
          </select>
        </label>
      )}
      {proc.fields.map((f) => (
        <label key={f.key} className="field"><span className="label">{f.label}{f.required ? ' *' : ''}</span>
          {f.type === 'select' ? (
            <select value={values[f.key] ?? ''} required={f.required} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
              <option value="">Choisir…</option>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : f.type === 'commune' ? (
            <select value={values[f.key] ?? ''} required={f.required} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
              <option value="">Choisir…</option>{COMMUNES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : f.type === 'textarea' ? (
            <textarea rows={3} value={values[f.key] ?? ''} required={f.required} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
          ) : (
            <input type={f.type === 'number' ? 'text' : f.type} inputMode={f.type === 'number' ? 'decimal' : undefined} pattern={f.type === 'number' ? '\\d+(\\.\\d+)?' : undefined}
              value={values[f.key] ?? ''} required={f.required} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
          )}
        </label>
      ))}
      {proc.documents.length > 0 && (
        <fieldset className="field">
          <legend className="label">Pièces</legend>
          <p className="hint">Seule l’empreinte SHA-256 du fichier est transmise ; le document reste sur votre appareil jusqu’à la demande de l’agent.</p>
          {proc.documents.map((d) => (
            <label key={d} className="vx-doc">
              <span className="small">{d}</span>
              <input type="file" onChange={(e) => void onFile(d, e.target.files?.[0])} />
              {docs[d] && <span className="mono small muted">{docs[d]!.sha256.slice(0, 16)}…</span>}
            </label>
          ))}
        </fieldset>
      )}
      {act.error && <p className="err" role="alert">{act.error}</p>}
      <button type="submit" className="btn btn-primary" disabled={act.busy}><Icon name="send" size={16} /> Déposer la démarche</button>
    </form>
  );
}

function CaseRow({ c, onChange }: { c: CaseView; onChange: () => void }) {
  const { fmtDate } = useApp();
  const [open, setOpen] = useState(false);
  const act = useAction();
  const addDoc = async (file: File | undefined) => {
    if (!file) return;
    const hash = await sha256Hex(await file.arrayBuffer());
    await act.run(async () => {
      await api(`/v1/verticales/cases/${c.id}/documents`, { method: 'POST', body: { documents: [{ label: file.name.slice(0, 150), sha256: hash }] } });
      onChange();
    });
  };
  return (
    <li className="list-row list-row-stack">
      <div className="row-between">
        <div className="min0">
          <p className="row-title">{c.typeLabel}</p>
          <p className="small muted"><span className="mono">{c.id}</span> · déposée le {fmtDate(c.createdAt)}{c.commune ? ` · ${c.commune}` : ''}</p>
        </div>
        <div className="row-side">
          <StatusBadge tone={CASE_TONE[c.status] ?? 'neutral'} label={c.statusLabel} />
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? 'Masquer' : 'Suivi'}</button>
        </div>
      </div>
      {open && (
        <div className="vx-case-body">
          <ol className="vx-timeline">
            {c.history.map((h, i) => (
              <li key={i}><span className="small muted">{fmtDate(h.at, true)}</span> <strong>{h.action}</strong>{h.note ? <span className="small"> — {h.note}</span> : null}</li>
            ))}
          </ol>
          {c.decision && <p className="small"><strong>Motif de la décision :</strong> {c.decision.reason} <span className="muted">Recours ouvert auprès de l’entité gestionnaire.</span></p>}
          {c.certificateCode && <p className="small"><Icon name="shieldCheck" size={14} /> Titre délivré : <Link to={verifyPath(c.certificateCode)} className="mono">{c.certificateCode}</Link></p>}
          {c.documents.length > 0 && <p className="small muted">{c.documents.length} pièce(s) déposée(s) par empreinte.</p>}
          {['DEPOSE', 'EN_INSTRUCTION', 'COMPLEMENT_DEMANDE'].includes(c.status) && (
            <label className="vx-doc"><span className="small">{c.status === 'COMPLEMENT_DEMANDE' ? 'Déposer le complément demandé' : 'Ajouter une pièce'}</span><input type="file" onChange={(e) => void addDoc(e.target.files?.[0])} disabled={act.busy} /></label>
          )}
          {act.error && <p className="err" role="alert">{act.error}</p>}
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------------------------------------------ spécificités

function Stalls({ stalls, onChange }: { stalls: StallView[]; onChange: () => void }) {
  const { fmtDate } = useApp();
  const act = useAction();
  const buy = (id: string, period: 'JOUR' | 'SEMAINE' | 'MOIS') => act.run(async () => {
    await api(`/v1/verticales/marches/stalls/${id}/titles`, { method: 'POST', body: { period }, idempotencyKey: newIdempotencyKey() });
    onChange();
  });
  return (
    <section className="panel" aria-labelledby="vx-stalls">
      <div className="panel-head"><h2 className="panel-title" id="vx-stalls"><Icon name="basket" size={18} /> Mes étals et titres</h2></div>
      <ul className="list-rows">
        {stalls.map((s) => (
          <li key={s.id} className="list-row vx-stall">
            {s.plateCode && (
              <figure className="receipt-qr">
                <QrCode value={`${window.location.origin}${verifyPath(s.plateCode)}`} size={80} alt={`Code QR de la plaque d’étal ${s.plateCode}`} />
                <figcaption className="mono small">{s.plateCode}</figcaption>
              </figure>
            )}
            <div className="min0 vx-grow">
              <p className="row-title">{s.market} — rangée {s.row}, n° {s.number}</p>
              <p className="small muted">{s.category} · {s.commune} · <span className="mono">{s.id}</span></p>
              <p className="small"><StatusBadge tone={TITLE_TONE[s.current.status] ?? 'neutral'} label={s.current.statusLabel} />{s.current.validUntil ? <span className="muted"> jusqu’au {fmtDate(s.current.validUntil, true)}</span> : null}</p>
              <p className="hint">Le contrôleur scanne la plaque de l’étal : vous n’avez pas besoin de téléphone. Aucun placier n’encaisse d’espèces.</p>
            </div>
            <div className="row-actions">
              <span className="small muted">Acheter un titre :</span>
              <div className="seg seg-sm" role="group" aria-label="Durée du titre">
                {(['JOUR', 'SEMAINE', 'MOIS'] as const).map((p) => <button key={p} type="button" disabled={act.busy || s.current.status === 'GRIS'} onClick={() => void buy(s.id, p)}>{p === 'JOUR' ? 'Jour' : p === 'SEMAINE' ? 'Semaine' : 'Mois'}</button>)}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {act.error && <p className="err" role="alert">{act.error}</p>}
    </section>
  );
}

function Ticketing({ objects, ticketing, onChange }: { objects: VObject[]; ticketing: TicketingView[]; onChange: () => void }) {
  const events = objects.filter((o) => o.objectType === 'EVENEMENT');
  const [values, setValues] = useState<Record<string, string>>({});
  const act = useAction();
  if (!events.length) return null;
  const submit = (id: string) => act.run(async () => {
    await api(`/v1/verticales/evenements/events/${id}/ticketing`, { method: 'POST', body: { ticketsSold: Number.parseInt(values[id] ?? '0', 10), source: 'DECLARATION_MANUELLE' } });
    onChange();
  });
  return (
    <section className="panel" aria-labelledby="vx-tix">
      <div className="panel-head"><h2 className="panel-title" id="vx-tix"><Icon name="ticket" size={18} /> Déclaration de billetterie</h2></div>
      <ul className="list-rows">
        {events.map((e) => {
          const t = ticketing.find((x) => x.eventObjectId === e.id);
          return (
            <li key={e.id} className="list-row">
              <div className="min0"><p className="row-title">{e.label}</p><p className="small muted">{e.detail}</p></div>
              {t ? (
                <div className="row-side"><span className="small">{t.ticketsSold.toLocaleString('fr-FR')} billets déclarés ({t.source === 'RAKAPAY' ? 'billetterie RakaPay' : 'déclaration'})</span>
                  <StatusBadge tone={t.obligationId ? 'good' : 'info'} label={t.obligationId ? 'Liquidée' : 'En attente de liquidation'} /></div>
              ) : (
                <div className="input-row">
                  <input className="input-sm" inputMode="numeric" pattern="\d+" placeholder="Billets vendus" value={values[e.id] ?? ''} onChange={(ev) => setValues({ ...values, [e.id]: ev.target.value })} aria-label="Billets vendus" />
                  <button type="button" className="btn btn-primary btn-sm" disabled={act.busy || !/^\d+$/.test(values[e.id] ?? '')} onClick={() => void submit(e.id)}>Déclarer</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {act.error && <p className="err" role="alert">{act.error}</p>}
    </section>
  );
}

function AviaPanel({ objects }: { objects: VObject[] }) {
  const { fmtDate } = useApp();
  const q = useApi(() => api<AviaDeclaration[]>('/v1/verticales/avia/declarations'), []);
  const [form, setForm] = useState({ period: '', flights: '', passengersDeparting: '', freightKg: '0' });
  const [obs, setObs] = useState<Record<string, string>>({});
  const act = useAction();
  const aircraft = objects.filter((o) => o.objectType === 'AERONEF').map((o) => o.id);
  const declare = (e: FormEvent) => { e.preventDefault(); void act.run(async () => {
    await api('/v1/verticales/avia/declarations', { method: 'POST', body: { period: form.period, aircraftObjectIds: aircraft, flights: Number(form.flights), passengersDeparting: Number(form.passengersDeparting), freightKg: Number(form.freightKg) } });
    q.reload();
  }); };
  const observe = (id: string) => act.run(async () => { await api(`/v1/verticales/avia/declarations/${id}/observations`, { method: 'POST', body: { text: obs[id] ?? '', documents: [] } }); q.reload(); });
  return (
    <section className="panel" aria-labelledby="vx-avia">
      <div className="panel-head"><h2 className="panel-title" id="vx-avia"><Icon name="plane" size={18} /> Déclarations mensuelles de mouvements</h2></div>
      <p className="small muted">Chaque déclaration est rapprochée des données de l’exploitant (embarquements, sorties). Un écart ouvre une procédure contradictoire ; aucune facturation n’est automatique et aucune n’est possible avant l’arrêté (acte requis).</p>
      {q.loading && <Loading />}
      {!!q.error && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <ul className="list-rows">
          {q.data.map((d) => (
            <li key={d.id} className="list-row list-row-stack">
              <div className="row-between">
                <div className="min0"><p className="row-title">Mois {d.period}</p><p className="small muted">{d.declared.flights} vols · {d.declared.passengersDeparting.toLocaleString('fr-FR')} passagers déclarés · fret {d.declared.freightKg.toLocaleString('fr-FR')} kg</p></div>
                <StatusBadge tone={d.status === 'ECART_CONSTATE' ? 'warning' : d.status === 'VALIDEE' || d.status === 'RAPPROCHEE' ? 'good' : 'info'} label={d.statusLabel} />
              </div>
              {d.reconciliation && (
                <p className="small">Exploitant : {d.reconciliation.observed.passengersBoarded.toLocaleString('fr-FR')} embarqués · écart {d.reconciliation.gaps.passengers >= 0 ? '+' : ''}{d.reconciliation.gaps.passengers} passagers ({d.reconciliation.passengerGapRate} %) · fret {d.reconciliation.gaps.freightKg >= 0 ? '+' : ''}{d.reconciliation.gaps.freightKg} kg</p>
              )}
              {d.contradictory && ['ECART_CONSTATE', 'OBSERVATIONS_RECUES'].includes(d.status) && (
                <div className="input-row">
                  <input value={obs[d.id] ?? ''} onChange={(e) => setObs({ ...obs, [d.id]: e.target.value })} placeholder={`Vos observations avant le ${fmtDate(d.contradictory.deadline)}`} aria-label="Observations" />
                  <button type="button" className="btn btn-secondary btn-sm" disabled={act.busy || (obs[d.id] ?? '').trim().length < 5} onClick={() => void observe(d.id)}>Répondre</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="form vx-inline-form" onSubmit={declare}>
        <div className="field-row">
          <label className="field"><span className="label">Mois échu</span><input type="month" required value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} /></label>
          <label className="field"><span className="label">Vols</span><input inputMode="numeric" pattern="\d+" required value={form.flights} onChange={(e) => setForm({ ...form, flights: e.target.value })} /></label>
          <label className="field"><span className="label">Passagers au départ</span><input inputMode="numeric" pattern="\d+" required value={form.passengersDeparting} onChange={(e) => setForm({ ...form, passengersDeparting: e.target.value })} /></label>
          <label className="field"><span className="label">Fret (kg)</span><input inputMode="numeric" pattern="\d+" required value={form.freightKg} onChange={(e) => setForm({ ...form, freightKg: e.target.value })} /></label>
        </div>
        {act.error && <p className="err" role="alert">{act.error}</p>}
        <button type="submit" className="btn btn-primary btn-sm" disabled={act.busy}>Déclarer le mois</button>
      </form>
    </section>
  );
}

function Certificates({ items }: { items: CertificateView[] }) {
  const { fmtDate } = useApp();
  if (!items.length) return null;
  const tone: Record<string, 'good' | 'warning' | 'neutral' | 'serious'> = { VALIDE: 'good', A_VENIR: 'warning', EXPIRE: 'neutral', REVOQUE: 'serious' };
  const label: Record<string, string> = { VALIDE: 'Valide', A_VENIR: 'Validité à venir', EXPIRE: 'Échu', REVOQUE: 'Révoqué' };
  return (
    <section className="panel" aria-labelledby="vx-certs">
      <div className="panel-head"><h2 className="panel-title" id="vx-certs"><Icon name="shieldCheck" size={18} /> Mes autorisations et certificats</h2><span className="count">{items.length}</span></div>
      <ul className="list-rows">
        {items.map((c) => (
          <li key={c.code} className="list-row receipt-row">
            <figure className="receipt-qr">
              <QrCode value={`${window.location.origin}${verifyPath(c.code)}`} size={88} alt={`Code QR du titre ${c.code}`} />
              <figcaption className="mono small">{c.code}</figcaption>
            </figure>
            <div className="min0"><p className="row-title">{c.label}</p><p className="small muted">Du {fmtDate(c.validFrom)}{c.validUntil ? ` au ${fmtDate(c.validUntil)}` : ''}{c.commune ? ` · ${c.commune}` : ''}</p><p className="hint">À afficher sur le lieu : vérifiable par QR, sans donnée personnelle.</p></div>
            <div className="row-side"><StatusBadge tone={tone[c.status] ?? 'neutral'} label={label[c.status] ?? c.status} /><Link className="btn btn-ghost btn-sm" to={verifyPath(c.code)}>Vérifier</Link></div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ page

function Hero({ v }: { v: VerticalDetail }) {
  return (
    <header className="vx-hero" style={{ ['--vx' as string]: v.accent }}>
      <Link to="/services" className="vx-back small"><Icon name="chevronRight" size={14} className="flip" /> Services de la Ville</Link>
      <div className="vx-hero-row">
        <span className="vx-hero-icon"><Icon name={v.icon} size={30} /></span>
        <div className="min0">
          <p className="eyebrow">{v.short} · modules {v.modules.join(' · ')}</p>
          <h1>{v.name}</h1>
          <p className="lead">{v.promise}</p>
        </div>
      </div>
      <div className="vx-hero-facts">
        <StatusBadge tone={LEGAL_TONE[v.legal]} label={v.legalLabel} />
        <span className="small muted"><Icon name="building" size={14} /> {v.entityName}</span>
        <span className="small muted"><Icon name="users" size={14} /> {v.audience}</span>
      </div>
    </header>
  );
}

export default function VerticalSpace() {
  const { slug = '' } = useParams();
  if (slug === 'rakapay') return <RakaPay />;
  return <VerticalSpaceInner slug={slug} />;
}

function VerticalSpaceInner({ slug }: { slug: string }) {
  const { user, fmtDate } = useApp();
  const detail = useApi(() => fetchVertical(slug), [slug]);
  const isTaxpayer = !!user?.roles.includes('R30');
  const space = useApi(isTaxpayer ? () => fetchSpace(slug) : null, [slug, user?.id]);
  const [proc, setProc] = useState<Procedure | null>(null);
  const [done, setDone] = useState<CaseView | null>(null);

  if (detail.loading) return <div className="page page-wide"><Loading /></div>;
  if (detail.error || !detail.data) return <div className="page page-wide"><ErrorState error={detail.error ?? new Error('Verticale introuvable')} onRetry={detail.reload} /><p><Link to="/services">Retour aux services</Link></p></div>;
  const v = detail.data;
  const s = space.data;
  const objects = s?.objects ?? [];

  return (
    <div className="page page-wide">
      <Hero v={v} />
      <ExampleNotice text="Démonstration : objets et références fictifs. Les montants proviennent de règles fictives de démonstration, non opposables." />
      {v.managedBy && (
        <div className="callout callout-info"><Icon name="info" size={18} /><p>Les démarches et titres de ce service sont servis par son module dédié. Vos objets et obligations rattachés apparaissent ci-dessous depuis votre compte unique.</p></div>
      )}

      <div className="vx-layout">
        <div className="stack">
          {!isTaxpayer && (
            <section className="panel">
              <EmptyState title="Espace personnel réservé aux contribuables" icon="user">
                Choisissez un profil de contribuable dans l’en-tête pour voir vos objets, obligations et démarches.{' '}
                {user && <Link to="/verticales/console">Agents : ouvrir la console d’instruction</Link>}
              </EmptyState>
            </section>
          )}
          {isTaxpayer && space.loading && <Loading />}
          {isTaxpayer && !!space.error && <ErrorState error={space.error} onRetry={space.reload} />}
          {s && (
            <>
              <section className="panel" aria-labelledby="vx-obj">
                <div className="panel-head"><h2 className="panel-title" id="vx-obj">{v.objectsTitle}</h2><span className="count">{objects.length}</span></div>
                {objects.length === 0 ? <EmptyState title="Aucun élément enregistré" /> : (
                  <ul className="list-rows">
                    {objects.map((o) => (
                      <li key={o.id} className="list-row">
                        <div className="min0">
                          <p className="row-title">{o.label}</p>
                          <p className="small muted">{o.detail} · <span className="mono">{o.ref}</span></p>
                          {o.cessation && <p className="small"><StatusBadge tone="neutral" label={`Cessation au ${fmtDate(o.cessation.dateEffet)}`} /></p>}
                        </div>
                        <div className="row-side">
                          {o.plate && <Link className="tag mono" to={verifyPath(o.plate.code)} title="Plaque vérifiable publiquement"><Icon name="qr" size={13} /> {o.plate.code}</Link>}
                          <MapStatusChip status={OBJ_MAP[o.probativeStatus] ?? 'grey'} />
                          {o.probativeStatus !== 'VERIFIE' && <span className="tag">{OBJ_LABEL[o.probativeStatus] ?? o.probativeStatus}</span>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {s.stalls && s.stalls.length > 0 && <Stalls stalls={s.stalls} onChange={space.reload} />}
              {slug === 'evenements' && <Ticketing objects={objects} ticketing={s.ticketing ?? []} onChange={space.reload} />}
              {slug === 'avia' && <AviaPanel objects={objects} />}

              <section className="panel" aria-labelledby="vx-due">
                <div className="panel-head"><h2 className="panel-title" id="vx-due">Mes obligations</h2><span className="count">{s.obligations.length}</span></div>
                {!v.acceptsLevies && <div className="callout callout-info"><Icon name="scale" size={18} /><p><strong>{v.legalLabel}.</strong> Aucune obligation ne peut être émise dans ce service tant que l’acte n’est pas adopté.</p></div>}
                {s.obligations.length === 0 ? <EmptyState title="Aucune obligation" /> : (
                  <ul className="vx-dues">{s.obligations.map((o) => <ObligationCard key={o.id} o={o} onChange={space.reload} />)}</ul>
                )}
              </section>

              <Certificates items={s.certificates} />

              <section className="panel" aria-labelledby="vx-rc">
                <div className="panel-head"><h2 className="panel-title" id="vx-rc">Mes quittances</h2><span className="count">{s.receipts.length}</span></div>
                {s.receipts.length === 0 ? <EmptyState title="Aucune quittance pour ce service" /> : (
                  <ul className="list-rows">
                    {s.receipts.map((r) => (
                      <li key={r.code} className="list-row receipt-row">
                        <figure className="receipt-qr">
                          <QrCode value={`${window.location.origin}/verifier/${r.code}`} size={88} alt={`Code QR de vérification de la quittance ${r.code}`} />
                          <figcaption className="mono small">{r.code}</figcaption>
                        </figure>
                        <div className="min0"><p className="row-title">{r.label.replace(/^DÉMONSTRATION — /, '')}</p><p className="small muted">{fmtDate(r.paidAt, true)} · <span className="mono">{r.number}</span></p></div>
                        <div className="row-side">
                          <MoneyText money={r.amount} />
                          <StatusBadge tone={r.status === 'DEFINITIVE' ? 'good' : r.status === 'PROVISOIRE' ? 'warning' : 'neutral'} label={RECEIPT_LABEL[r.status] ?? r.status} />
                          <Link className="btn btn-ghost btn-sm" to={`/verifier/${r.code}`}>Vérifier</Link>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="panel" aria-labelledby="vx-cases">
                <div className="panel-head"><h2 className="panel-title" id="vx-cases">Mes démarches</h2><span className="count">{s.cases.length}</span></div>
                {s.cases.length === 0 ? <EmptyState title="Aucune démarche déposée" /> : <ul className="list-rows">{s.cases.map((c) => <CaseRow key={c.id} c={c} onChange={space.reload} />)}</ul>}
              </section>
            </>
          )}
        </div>

        <aside className="stack">
          {v.procedures.length > 0 && (
            <section className="panel" aria-labelledby="vx-svc">
              <h2 className="panel-title" id="vx-svc">Démarches en ligne</h2>
              <ul className="vx-services">
                {v.procedures.map((p) => (
                  <li key={p.code}>
                    <button type="button" className="list-button" disabled={!isTaxpayer} onClick={() => { setDone(null); setProc(p); }}>
                      <span><strong>{p.label}</strong><span className="small muted">{p.hint}</span></span>
                      <Icon name="chevronRight" size={16} />
                    </button>
                  </li>
                ))}
              </ul>
              {!isTaxpayer && <p className="hint">Connexion d’un contribuable requise pour déposer une démarche.</p>}
            </section>
          )}
          {v.pendingLevies.length > 0 && (
            <section className="panel" aria-labelledby="vx-levies">
              <h2 className="panel-title" id="vx-levies"><Icon name="lock" size={18} /> Prélèvements en attente d’un acte</h2>
              <ul className="vx-rights">{v.pendingLevies.map((l) => <li key={l.label}><Icon name="ban" size={16} /> <span><strong>{l.label}</strong> — {l.basis}. Aucun montant.</span></li>)}</ul>
            </section>
          )}
          {v.rules.length > 0 && (
            <section className="panel" aria-labelledby="vx-rules">
              <h2 className="panel-title" id="vx-rules"><Icon name="scale" size={18} /> Règle du registre</h2>
              {v.rules.map((r) => <p key={r.code} className="small"><span className="mono">{r.code}</span> v{r.version} — {r.status}<br /><span className="vx-demo-rule"><Icon name="info" size={13} /> {r.notice}</span></p>)}
            </section>
          )}
          <div className="callout callout-info"><Icon name="scale" size={18} /><p><strong>Point de vigilance.</strong> {v.vigilance}</p></div>
          <section className="panel" aria-labelledby="vx-rights">
            <h2 className="panel-title" id="vx-rights"><Icon name="shieldCheck" size={18} /> Vos droits</h2>
            <ul className="vx-rights">{v.rights.map((r) => <li key={r}><Icon name="check" size={16} /> {r}</li>)}</ul>
          </section>
          <section className="panel" aria-labelledby="vx-legal">
            <h2 className="panel-title" id="vx-legal"><Icon name="file" size={18} /> Cadre et prérequis</h2>
            <dl className="kv kv-dense">
              <div><dt>Entité gestionnaire</dt><dd>{v.entityName}</dd></div>
              <div><dt>Tutelle</dt><dd>{v.tutelle}</dd></div>
              <div><dt>Mise en service</dt><dd>{v.release}</dd></div>
            </dl>
            <ul className="plain-list small vx-prereq">{v.prerequisites.map((p) => <li key={p}>{p}</li>)}</ul>
          </section>
        </aside>
      </div>

      <Drawer open={!!proc} title={proc?.label ?? ''} onClose={() => setProc(null)}>
        {proc && !done && <ProcedureForm slug={slug} proc={proc} objects={objects} onDone={(c) => { setDone(c); space.reload(); }} />}
        {done && (
          <div className="stack">
            <div className="callout callout-info"><Icon name="check" size={18} /><p>Démarche <strong className="mono">{done.id}</strong> déposée. Vous serez notifié à chaque étape ; un agent de l’entité gestionnaire l’instruit, une autre personne décide avec motif.</p></div>
            <button type="button" className="btn btn-secondary" onClick={() => setProc(null)}>Fermer</button>
          </div>
        )}
      </Drawer>
    </div>
  );
}
