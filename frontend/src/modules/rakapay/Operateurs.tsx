/**
 * Opérateurs de billetterie (RakaPay, § 11D) : candidature et agrément à quatre yeux, offres proposées par l'exploitant
 * (recette publique : tarif de la règle ACTIVE ; opérateur privé : prix commercial), agents exclusifs, ventes privées
 * dans un circuit comptable séparé (AC-TKT-01), tableau de l'opérateur sans visibilité croisée, supervision des deux
 * circuits jamais additionnés, redevance d'usage ARB-08 en simulation, revue des ventes atypiques.
 */
import { useState, type FormEvent } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { MoneyText } from '../../components/MoneyText';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { COMMUNES } from '../../verticals/catalogue';
import '../referentiel/referentiel.css';
import './rakapay.css';

interface Operator { id: string; code: string; name: string; kind: string; commune: string; status: string }
interface Offer { id: string; operatorId: string; commercialName: string; family: string; duration: { unit: string; value: number }; publicRevenue: boolean; price?: MoneyJSON; typeCode?: string; status: string; place: { commune: string; label: string } }
interface Mine { agentOf: { operatorId: string; name: string } | null; adminOf: { id: string; name: string; kind: string; status: string }[] }
interface Group { key: string; count: number; amounts: MoneyJSON[] }
interface Dashboard {
  operator: Operator; viewer: string; offers: Offer[]; agents: { userId: string; name: string; status: string }[];
  privateCircuit: { settlement: string; sales: number; amounts: MoneyJSON[]; byZone: Group[]; byHour: Group[]; byAgent: Group[]; cancellations: number } | null;
  publicCircuit: { settlement: string; paidReferences: number; amounts: MoneyJSON[]; controls: number } | null;
}
interface Circuits { public: { label: string; amounts: MoneyJSON[] }; private: { label: string; amounts: MoneyJSON[]; sales: number }; notice: string; platformFee: { label: string; status: string; note: string } }
interface Review { id: string; operatorId: string; agentId: string; day: string; signal: string; explanation: string; status: string }

const STATUS_LABEL: Record<string, string> = { CANDIDAT: 'Candidature', ACCREDITE: 'Accrédité', REFUSE: 'Refusé', SUSPENDU: 'Suspendu', INVITE: 'Invité' };
const Amounts = ({ list }: { list: MoneyJSON[] }) => list.length ? <>{list.map((m) => <MoneyText key={m.currency} money={m} />)}</> : <span>0</span>;

function useAction(reload: () => void) {
  const [err, setErr] = useState<string | null>(null);
  const run = async (path: string, body?: unknown) => {
    setErr(null);
    try { await api(path, { method: 'POST', body: body ?? {} }); reload(); return true; } catch (e) { setErr(describeError(e).message); return false; }
  };
  return { err, run };
}
const ask = (label: string) => { const m = window.prompt(label); return m && m.trim().length >= 5 ? m.trim() : null; };

function OperatorSpace({ id }: { id: string }) {
  const { user } = useApp();
  const dash = useApi(() => api<Dashboard>(`/v1/rakapay/operateurs/${id}/tableau`), [user?.id, id]);
  const { err, run } = useAction(dash.reload);
  const [name, setName] = useState('');
  const [family, setFamily] = useState('STATIONNEMENT');
  const [unit, setUnit] = useState('HEURE');
  const [value, setValue] = useState('3');
  const [commune, setCommune] = useState('Gombe');
  const [label, setLabel] = useState('');
  const [price, setPrice] = useState('');
  const [typeCode, setTypeCode] = useState('');
  const [agentId, setAgentId] = useState('');
  if (dash.loading) return <Loading />;
  if (dash.error) return <ErrorState error={dash.error} onRetry={dash.reload} />;
  const d = dash.data!;
  const priv = d.operator.kind === 'PRIVE';
  const propose = (e: FormEvent) => {
    e.preventDefault();
    void run(`/v1/rakapay/operateurs/${id}/offres`, {
      family, commercialName: name, duration: { unit, value: Number(value) }, place: { commune, label, lat: -4.32, lon: 15.31 },
      ...(priv ? { price: { amount: price, currency: 'CDF' } } : { typeCode }),
    });
  };
  return (
    <section className="panel stack-sm">
      <div className="panel-head"><h2 className="panel-title"><Icon name="ticket" size={18} /> {d.operator.name}</h2><StatusBadge tone={d.operator.status === 'ACCREDITE' ? 'good' : 'warning'} label={STATUS_LABEL[d.operator.status] ?? d.operator.status} /></div>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <h3>Offres</h3>
      {!d.offers.length ? <EmptyState title="Aucune offre" /> : (
        <ul className="list-rows">{d.offers.map((o) => (
          <li key={o.id} className="list-row">
            <div className="min0"><p className="row-title">{o.commercialName}</p><p className="small muted">{o.duration.value} {o.duration.unit === 'HEURE' ? 'h' : 'j'} · {o.place.label}, {o.place.commune} · {o.publicRevenue ? `recette publique (type ${o.typeCode})` : 'opérateur privé'}</p></div>
            <div className="row-side">
              {o.price && <MoneyText money={o.price} />}
              <StatusBadge tone={o.status === 'APPROUVEE' ? 'good' : o.status === 'PROPOSEE' ? 'warning' : 'neutral'} label={o.status === 'APPROUVEE' ? 'Approuvée' : o.status === 'PROPOSEE' ? 'En attente' : 'Refusée'} />
              {priv && o.status === 'APPROUVEE' && d.viewer !== 'SUPERVISION' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void run('/v1/rakapay/ventes-privees', { offerId: o.id, channel: 'MOBILE_MONEY' })}>Vendre (paiement numérique)</button>}
            </div>
          </li>
        ))}</ul>
      )}
      {d.viewer === 'EXPLOITANT' && d.operator.status === 'ACCREDITE' && (
        <form className="stack-sm" onSubmit={propose}>
          <h3>Proposer une offre</h3>
          <div className="row-wrap">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom commercial" aria-label="Nom commercial" />
            <select value={family} onChange={(e) => setFamily(e.target.value)} aria-label="Famille"><option value="STATIONNEMENT">Stationnement</option><option value="ACCES">Accès (transport, marchés, zones)</option></select>
            <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unité"><option value="HEURE">heures</option><option value="JOUR">jours</option></select>
            <input value={value} onChange={(e) => setValue(e.target.value)} aria-label="Durée" inputMode="numeric" />
          </div>
          <div className="row-wrap">
            <select value={commune} onChange={(e) => setCommune(e.target.value)} aria-label="Commune">{COMMUNES.map((c) => <option key={c}>{c}</option>)}</select>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Lieu (localisation obligatoire)" aria-label="Lieu" />
            {priv ? <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Prix commercial (FC)" aria-label="Prix commercial" inputMode="decimal" /> : <input value={typeCode} onChange={(e) => setTypeCode(e.target.value)} placeholder="Type de titre (tarif de la règle)" aria-label="Type de titre" />}
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={name.trim().length < 2 || label.trim().length < 2}>Proposer</button>
          <p className="hint">{priv ? 'Vos ventes sont réglées directement à votre structure, hors compte public.' : 'Recette publique : le tarif vient de la règle approuvée du registre, jamais d’une saisie.'}</p>
        </form>
      )}
      {d.viewer === 'EXPLOITANT' && (
        <form className="row-wrap" onSubmit={(e) => { e.preventDefault(); void run(`/v1/rakapay/operateurs/${id}/agents`, { userId: agentId }); }}>
          <input value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="Identifiant de l’agent à rattacher" aria-label="Agent" />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={!agentId}>Rattacher (exclusif)</button>
        </form>
      )}
      {d.agents.length > 0 && <p className="small">Agents : {d.agents.map((a) => `${a.name}${a.status === 'RETIRE' ? ' (retiré)' : ''}`).join(', ')}</p>}
      {d.privateCircuit && (
        <div className="callout callout-info"><Icon name="lock" size={18} /><div>
          <p><strong>Circuit privé</strong> — {d.privateCircuit.sales} vente(s) · <Amounts list={d.privateCircuit.amounts} /> · {d.privateCircuit.cancellations} annulation(s)</p>
          <p className="small">{d.privateCircuit.settlement}</p>
          <p className="small muted">Par zone : {d.privateCircuit.byZone.map((g) => `${g.key} (${g.count})`).join(', ') || '—'} · par heure : {d.privateCircuit.byHour.map((g) => `${g.key} h (${g.count})`).join(', ') || '—'}{d.privateCircuit.byAgent.length ? ` · par agent : ${d.privateCircuit.byAgent.map((g) => `${g.key} (${g.count})`).join(', ')}` : ''}</p>
        </div></div>
      )}
      {d.publicCircuit && <p className="small"><strong>Circuit public</strong> — {d.publicCircuit.paidReferences} référence(s) payée(s) · <Amounts list={d.publicCircuit.amounts} /> · {d.publicCircuit.settlement}</p>}
    </section>
  );
}

function Supervision() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const ops = useApi(() => api<Operator[]>('/v1/rakapay/operateurs'), [user?.id]);
  const offers = useApi(() => api<{ items: Offer[] }>('/v1/rakapay/offres'), [user?.id]);
  const circ = useApi(() => api<Circuits>('/v1/rakapay/circuits'), [user?.id]);
  const reviews = useApi(roles.some((r) => r === 'R07' || r === 'R24') ? () => api<{ items: Review[] }>('/v1/rakapay/revues-ventes') : null, [user?.id]);
  const reload = () => { ops.reload(); offers.reload(); circ.reload(); reviews.reload(); };
  const { err, run } = useAction(reload);
  const [pct, setPct] = useState('');
  const [sim, setSim] = useState<{ simulated: MoneyJSON[]; notice: string } | null>(null);
  const simulate = async (e: FormEvent) => {
    e.preventDefault();
    try { setSim(await api(`/v1/rakapay/redevance-plateforme/simulation?tauxHypothetique=${encodeURIComponent(pct)}`)); } catch (ex) { setSim({ simulated: [], notice: describeError(ex).message }); }
  };
  const candidates = (ops.data ?? []).filter((o) => o.status === 'CANDIDAT');
  return (
    <div className="stack">
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <section className="panel">
        <div className="panel-head"><h2 className="panel-title"><Icon name="users" size={18} /> Agrément des opérateurs</h2><span className="count">{candidates.length}</span></div>
        {!candidates.length ? <EmptyState title="Aucune candidature en attente" icon="check" /> : (
          <ul className="list-rows">{candidates.map((o) => (
            <li key={o.id} className="list-row">
              <div className="min0"><p className="row-title">{o.name}</p><p className="small muted">{o.code} · {o.kind === 'PRIVE' ? 'opérateur privé' : 'opérateur public'} · {o.commune}</p></div>
              <div className="row-side">
                {roles.includes('R07') && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const m = ask('Motif de la proposition'); if (m) void run(`/v1/rakapay/operateurs/${o.id}/agrement/proposition`, { outcome: 'ACCREDITER', motif: m }); }}>Proposer l’agrément</button>}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const m = ask('Motif de la décision (personne distincte du proposant)'); if (m) void run(`/v1/rakapay/operateurs/${o.id}/agrement/decision`, { approve: true, motif: m }); }}>Décider : accréditer</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const m = ask('Motif du refus'); if (m) void run(`/v1/rakapay/operateurs/${o.id}/agrement/decision`, { approve: false, motif: m }); }}>Refuser</button>
              </div>
            </li>
          ))}</ul>
        )}
      </section>
      <section className="panel">
        <h2 className="panel-title"><Icon name="ticket" size={18} /> Offres proposées par les opérateurs</h2>
        {!(offers.data?.items ?? []).filter((o) => o.status === 'PROPOSEE').length ? <EmptyState title="Aucune offre en attente" icon="check" /> : (
          <ul className="list-rows">{offers.data!.items.filter((o) => o.status === 'PROPOSEE').map((o) => (
            <li key={o.id} className="list-row">
              <div className="min0"><p className="row-title">{o.commercialName}</p><p className="small muted">{o.operatorId} · {o.publicRevenue ? `recette publique, tarif de la règle du type ${o.typeCode}` : 'opérateur privé'}</p></div>
              <div className="row-side">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const m = ask('Motif'); if (m) void run(`/v1/rakapay/offres/${o.id}/decision`, { approve: true, motif: m }); }}>Approuver</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const m = ask('Motif du refus'); if (m) void run(`/v1/rakapay/offres/${o.id}/decision`, { approve: false, motif: m }); }}>Refuser</button>
              </div>
            </li>
          ))}</ul>
        )}
      </section>
      {circ.data && (
        <section className="panel stack-sm">
          <h2 className="panel-title"><Icon name="ledger" size={18} /> Deux circuits séparés (AC-TKT-01)</h2>
          <div className="g3-cards">
            <div className="g3-card"><h3>{circ.data.public.label}</h3><Amounts list={circ.data.public.amounts} /></div>
            <div className="g3-card"><h3>{circ.data.private.label}</h3><Amounts list={circ.data.private.amounts} /><span className="small muted">{circ.data.private.sales} vente(s)</span></div>
          </div>
          <p className="small muted">{circ.data.notice}</p>
          <form className="row-wrap" onSubmit={simulate}>
            <span className="small">{circ.data.platformFee.label} — <StatusBadge tone="info" label="Acte requis (ARB-08)" /></span>
            <input value={pct} onChange={(e) => setPct(e.target.value)} placeholder="Taux hypothétique (%)" aria-label="Taux hypothétique" inputMode="decimal" />
            <button type="submit" className="btn btn-ghost btn-sm" disabled={!pct}>Simuler</button>
          </form>
          {sim && <p className="small">{sim.simulated.length ? <>Simulation : <Amounts list={sim.simulated} /> — </> : null}{sim.notice}</p>}
        </section>
      )}
      {reviews.data && (
        <section className="panel">
          <div className="panel-head"><h2 className="panel-title"><Icon name="analysis" size={18} /> Revue des ventes atypiques</h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void run('/v1/rakapay/revues-ventes/detection')}>Lancer la détection</button></div>
          {!reviews.data.items.length ? <EmptyState title="Aucun signal" icon="check" /> : (
            <ul className="list-rows">{reviews.data.items.map((r) => (
              <li key={r.id} className="list-row">
                <div className="min0"><p className="row-title">{r.signal === 'VOLUME_ATYPIQUE' ? 'Volume atypique' : 'Annulations répétées'} · {r.agentId} · {r.day}</p><p className="small">{r.explanation}</p></div>
                <div className="row-side">
                  <StatusBadge tone={r.status === 'A_EXAMINER' ? 'warning' : 'neutral'} label={r.status === 'A_EXAMINER' ? 'À examiner' : r.status === 'CLASSEE' ? 'Classée' : 'Transmise à l’intégrité'} />
                  {r.status === 'A_EXAMINER' && <>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const m = ask('Motif du classement'); if (m) void run(`/v1/rakapay/revues-ventes/${r.id}/decision`, { outcome: 'CLASSER', motif: m }); }}>Classer</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const m = ask('Motif de la transmission'); if (m) void run(`/v1/rakapay/revues-ventes/${r.id}/decision`, { outcome: 'TRANSMETTRE_INTEGRITE', motif: m }); }}>Transmettre</button>
                  </>}
                </div>
              </li>
            ))}</ul>
          )}
          <p className="hint">Signal explicable, jamais une sanction : une personne examine et motive sa décision.</p>
        </section>
      )}
    </div>
  );
}

export default function Operateurs() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const mine = useApi(user ? () => api<Mine>('/v1/rakapay/operateurs/mon-rattachement') : null, [user?.id]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('PRIVE');
  const [commune, setCommune] = useState('Gombe');
  const { err, run } = useAction(mine.reload);
  const supervisor = roles.some((r) => ['R01', 'R02', 'R05', 'R06', 'R07', 'R22', 'R23', 'R24'].includes(r));
  const ids = [...(mine.data?.adminOf.map((o) => o.id) ?? []), ...(mine.data?.agentOf ? [mine.data.agentOf.operatorId] : [])];
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Billetterie multi-opérateurs (RakaPay, § 11D)" title="Opérateurs de billetterie"
        lead="Agrément à quatre yeux, offres approuvées selon les règles, agents exclusifs, ventes privées dans un circuit séparé du compte public." />
      {mine.loading && <Loading />}
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <div className="stack">
        {ids.map((id) => <OperatorSpace key={id} id={id} />)}
        {roles.includes('R30') && mine.data && !mine.data.adminOf.length && (
          <form className="panel stack-sm" onSubmit={(e) => { e.preventDefault(); void run('/v1/rakapay/operateurs/candidatures', { name, kind, commune }); }}>
            <h2 className="panel-title"><Icon name="store" size={18} /> Devenir opérateur</h2>
            <div className="row-wrap">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom de la structure" aria-label="Nom de la structure" />
              <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Nature"><option value="PRIVE">Opérateur privé</option><option value="PUBLIC">Opérateur public ou délégué</option></select>
              <select value={commune} onChange={(e) => setCommune(e.target.value)} aria-label="Commune">{COMMUNES.map((c) => <option key={c}>{c}</option>)}</select>
            </div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={name.trim().length < 3}>Déposer la candidature</button>
          </form>
        )}
        {supervisor && <Supervision />}
      </div>
    </div>
  );
}
