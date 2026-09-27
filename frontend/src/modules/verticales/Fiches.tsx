/**
 * Fiches sectorielles — modules 13 à 25 de la Spécification fonctionnelle (construites sur les modules sectoriels
 * « acte requis », le moteur de titres et la liquidation commune) : registres géoréférencés, départs et manifestes,
 * titres à usage unique consommés au scan, bons de sortie de carrière, péage, antennes, boissons, assainissement,
 * marchés, événements, forêts, ports, liquidations (automatiques sur règle ACTIVE, propositions sinon) et indicateurs.
 * Aucune sanction automatique ; aucun encaissement par un agent ; les types [EXEMPLE] sont non contractuels.
 */
import { useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { MoneyText } from '../../components/MoneyText';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import type { MoneyJSON } from '@mosolo/shared';
import { COMMUNES } from '../../verticals/catalogue';
import Plastique from './Plastique';
import './verticales.css';
import { FichesVisuels, LiquidationsFicheViz, RegistreFicheViz } from './visuels';

type Tone = 'good' | 'warning' | 'info' | 'neutral' | 'critical';
type IndValue = string | number | MoneyJSON[] | { label: string; amounts: MoneyJSON[] }[] | null;
interface Indicator { key: string; label: string; value: IndValue; measured: boolean; reason?: string }
interface ModuleIndicators { module: string; rule: { ruleCode: string | null; status: string; version: number | null; demo: boolean }; indicators: Indicator[] }
interface Liquidation {
  id: string; module: string; objectId: string; taxpayerId: string; period: string; movementId?: string; basis: Record<string, string>; mode: string; ruleCode: string | null; ruleVersion: number | null;
  status: string; simulated?: MoneyJSON; note: string; obligationId?: string; noticeId?: string; notice?: string; payment: { state: string } | null; proposedBy: string;
}
interface CredType { code: string; label: string; activable: boolean; demo?: boolean; reason: string | null }
interface Reference { id: string; module: string; kind: string; label: string; commune: string; lat: number; lon: number; demo: boolean; operatorTaxpayerId?: string; privateQuay?: boolean }
interface SectorObject { objectId: string; commune: string; quartier: string; probativeStatus: string; taxpayerId: string | null; operator: string | null; attributes: Record<string, string | null>; plate: string | null; liquidations: { period: string; status: string }[] }
interface Departure { id: string; pointId: string; point: string; commune: string; destination: string; scheduledAt: string; titleMode: string; status: string; manifest?: { passengers: number }; titles: number; embarcationId?: string }
interface ControlView { result: string; text: string; alreadyUsed?: { at: string }; constat?: { id: string; notice: string } }

export const FICHE_TABS: [string, string][] = [
  ['indicateurs', 'Indicateurs'], ['13', '13 · Embarquement'], ['16', '16 · Antennes'], ['17', '17 · Boissons'], ['18', '18 · Plastique'],
  ['19', '19 · Assainissement'], ['20', '20 · Marchés'], ['21', '21 · Événements'], ['22', '22 · Carrières'], ['23', '23 · Forêts'], ['24', '24 · Ports'],
  ['25', '25 · Péage'], ['liquidations', 'Liquidations'], ['configuration', 'Configuration'],
];

const LIQ_STATUS: Record<string, { label: string; tone: Tone }> = {
  ACTE_REQUIS: { label: 'Acte requis — aucun montant', tone: 'neutral' }, BASE_INCOMPLETE: { label: 'Bases incomplètes', tone: 'warning' },
  PROPOSEE: { label: 'Proposée (montant simulé)', tone: 'info' }, EXECUTEE: { label: 'Exécutée', tone: 'good' }, REJETEE: { label: 'Rejetée', tone: 'critical' },
};

const has = (roles: string[] | undefined, ...r: string[]) => !!roles?.some((x) => r.includes(x));

function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const { user } = useApp();
  return useApi(path ? () => api<T>(path) : null, [user?.id, path, ...deps]);
}

function Guard<T>({ state, children }: { state: { loading: boolean; error: unknown; data: T | null; reload: () => void }; children: (d: T) => ReactElement }) {
  if (state.loading) return <Loading />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  return state.data ? children(state.data) : null;
}

/** Exécute une action POST et affiche le résultat ou l'erreur (message du serveur, en français). */
function useAction(after?: () => void) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async <T,>(path: string, body: unknown, ok: (r: T) => string) => {
    setMsg(null);
    try { const r = await api<T>(path, { method: 'POST', body }); setMsg({ ok: true, text: ok(r) }); after?.(); return r; } catch (e) { setMsg({ ok: false, text: describeError(e).message }); return null; }
  };
  const view = msg ? <p className={msg.ok ? 'notice notice-ok' : 'err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p> : null;
  return { run, view };
}

function Amounts({ items }: { items: MoneyJSON[] | undefined | null }) {
  if (!items || !items.length) return <span className="muted">—</span>;
  return <>{items.map((m, i) => <span key={m.currency}>{i > 0 ? ' + ' : ''}<MoneyText money={m} /></span>)}</>;
}

function Panel({ title, icon, children, count }: { title: string; icon: string; children: ReactNode; count?: number }) {
  return (
    <section className="panel stack-sm">
      <div className="panel-head"><h2 className="panel-title"><Icon name={icon} size={18} /> {title}</h2>{count !== undefined && <span className="count">{count}</span>}</div>
      {children}
    </section>
  );
}

const motif = (q: string) => { const m = window.prompt(q); return m && m.trim().length >= 5 ? m.trim() : null; };

// ======================================================================== Indicateurs

function renderValue(i: Indicator): ReactNode {
  if (!i.measured) return <span className="muted">{`Non mesuré — ${i.reason ?? ""}`}</span>;
  const v = i.value;
  if (v === null) return <span className="muted">—</span>;
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === 'object' && v[0] !== null && 'label' in v[0]) return <>{(v as { label: string; amounts: MoneyJSON[] }[]).map((x) => <span key={x.label} className="small">{x.label} : <Amounts items={x.amounts} /> · </span>)}</>;
    return <Amounts items={v as MoneyJSON[]} />;
  }
  return <strong className="num">{String(v)}</strong>;
}

function IndicatorsTab() {
  const q = useLoad<{ generatedAt: string; modules: ModuleIndicators[] }>('/v1/verticales/fiches/indicateurs');
  return (
    <Guard state={q}>{(d) => (
      <div className="stack">
        <div className="callout callout-info"><Icon name="info" size={18} /><p>Indicateurs calculés sur les données (heure du serveur) ; « non mesuré » indique la donnée source absente. Stationnement (14) : <Link to="/stationnement/tableau-de-bord">tableau de bord</Link> ; publicité (15) : <Link to="/publicite/tableau-de-bord">tableau de bord</Link>.</p></div>
        <FichesVisuels modules={d.modules} />
        <div className="g3-cards">
          {d.modules.map((m) => (
            <article key={m.module} className="g3-card" aria-label={`Module ${m.module}`}>
              <h3>Module {m.module}</h3>
              <StatusBadge tone={m.rule.status === 'ACTIVE' ? 'good' : 'neutral'} label={m.rule.status === 'ACTIVE' ? `Règle ${m.rule.ruleCode} v${m.rule.version} ACTIVE${m.rule.demo ? ' [EXEMPLE]' : ''}` : m.rule.ruleCode ? `Règle ${m.rule.ruleCode} : ${m.rule.status}` : 'Acte requis'} />
              <ul className="list-plain small">{m.indicators.map((i) => <li key={i.key}>{i.label} : {renderValue(i)}</li>)}</ul>
            </article>
          ))}
        </div>
      </div>
    )}</Guard>
  );
}

// ======================================================================== Registres communs

function ReferenceForm({ module, kinds, onDone }: { module: string; kinds: [string, string][]; onDone: () => void }) {
  const [kind, setKind] = useState(kinds[0]![0]);
  const [label, setLabel] = useState('');
  const [commune, setCommune] = useState('Gombe');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [operator, setOperator] = useState('');
  const [priv, setPriv] = useState(false);
  const a = useAction(onDone);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run<Reference>('/v1/verticales/fiches/references', { module, kind, label, commune, lat: Number(lat), lon: Number(lon), ...(operator ? { operatorTaxpayerId: operator } : {}), ...(module === '24' ? { privateQuay: priv } : {}) }, (r) => `Référence ${r.id} enregistrée.`);
  };
  return (
    <form className="stack-sm" onSubmit={submit} aria-label={`Nouvelle référence du module ${module}`}>
      <div className="row-wrap">
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type de référence">{kinds.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Libellé" aria-label="Libellé de la référence" />
        <select value={commune} onChange={(e) => setCommune(e.target.value)} aria-label="Commune de la référence">{COMMUNES.map((c) => <option key={c}>{c}</option>)}</select>
        <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="Latitude" aria-label="Latitude" inputMode="decimal" />
        <input value={lon} onChange={(e) => setLon(e.target.value)} placeholder="Longitude" aria-label="Longitude" inputMode="decimal" />
        {(module === '13' || module === '24') && <input value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="Opérateur (compte contribuable)" aria-label="Opérateur de rattachement" />}
        {module === '24' && <label className="small"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Port privé</label>}
      </div>
      <button type="submit" className="btn btn-secondary btn-sm" disabled={label.trim().length < 3 || !lat || !lon}>Enregistrer la référence</button>
      {a.view}
    </form>
  );
}

function References({ module, kinds, canEdit }: { module: string; kinds: [string, string][]; canEdit: boolean }) {
  const q = useLoad<{ items: Reference[] }>(`/v1/verticales/fiches/references?module=${module}`);
  return (
    <Panel title="Registre géoréférencé" icon="pin" count={q.data?.items.length}>
      <Guard state={q}>{(d) => (
        <DataTable rows={d.items} rowKey={(r) => r.id} empty={<EmptyState title="Aucune référence" />}
          columns={[
            { key: 'l', label: 'Référence', primary: true, render: (r) => <><span className="mono">{r.id}</span> — {r.label}{r.demo ? ' [EXEMPLE]' : ''}</> },
            { key: 'k', label: 'Type', render: (r) => kinds.find(([k]) => k === r.kind)?.[1] ?? r.kind },
            { key: 'c', label: 'Lieu', render: (r) => `${r.commune} · ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}` },
            { key: 'o', label: 'Opérateur', render: (r) => r.operatorTaxpayerId ?? (r.privateQuay ? 'Port privé' : '—') },
          ]} />
      )}</Guard>
      {canEdit && <ReferenceForm module={module} kinds={kinds} onDone={q.reload} />}
    </Panel>
  );
}

const OBJECT_FIELDS: Record<string, [string, string][]> = {
  '16': [['reference', 'Référence du site'], ['type', 'Type (pylône, toit)'], ['emprise_m2', 'Emprise (m²)']],
  '22': [['nom', 'Nom du site'], ['superficie_ha', 'Superficie (ha)'], ['titre', 'Titre d’exploitation']],
  '23': [['nom', 'Nom de la concession'], ['superficie_ha', 'Superficie (ha)'], ['titre', 'Titre de concession']],
  '24': [['identifiant', 'Identifiant (immatriculation)'], ['capacite_passagers', 'Capacité (passagers)'], ['capacite_tonnes', 'Capacité (tonnes)'], ['nom', 'Nom']],
};

function ObjectForm({ module, onDone }: { module: string; onDone: () => void }) {
  const [attrs, setAttrs] = useState<Record<string, string>>({});
  const [commune, setCommune] = useState('Gombe');
  const [quartier, setQuartier] = useState('');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [taxpayerId, setTaxpayerId] = useState('');
  const a = useAction(onDone);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run<{ object: { id: string }; plate: { code: string } | null }>(`/v1/verticales/fiches/${module}/objets`, { commune, quartier, lat: Number(lat), lon: Number(lon), attributes: Object.fromEntries(Object.entries(attrs).filter(([, v]) => v.trim())), ...(taxpayerId ? { taxpayerId } : {}), withPlate: true }, (r) => `Objet ${r.object.id} enregistré${r.plate ? ` — plaque QR ${r.plate.code}` : ''}.`);
  };
  return (
    <form className="stack-sm" onSubmit={submit} aria-label={`Enregistrer un objet du module ${module}`}>
      <div className="row-wrap">
        {OBJECT_FIELDS[module]!.map(([k, l]) => <input key={k} value={attrs[k] ?? ''} onChange={(e) => setAttrs({ ...attrs, [k]: e.target.value })} placeholder={l} aria-label={l} />)}
      </div>
      <div className="row-wrap">
        <select value={commune} onChange={(e) => setCommune(e.target.value)} aria-label="Commune">{COMMUNES.map((c) => <option key={c}>{c}</option>)}</select>
        <input value={quartier} onChange={(e) => setQuartier(e.target.value)} placeholder="Quartier" aria-label="Quartier" />
        <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="Latitude" aria-label="Latitude de l’objet" inputMode="decimal" />
        <input value={lon} onChange={(e) => setLon(e.target.value)} placeholder="Longitude" aria-label="Longitude de l’objet" inputMode="decimal" />
        <input value={taxpayerId} onChange={(e) => setTaxpayerId(e.target.value)} placeholder="Redevable (si agent)" aria-label="Redevable" />
      </div>
      <button type="submit" className="btn btn-secondary btn-sm" disabled={quartier.trim().length < 2 || !lat || !lon}>Enregistrer</button>
      {a.view}
    </form>
  );
}

function Objects({ module, title, canRegister }: { module: string; title: string; canRegister: boolean }) {
  const q = useLoad<{ items: SectorObject[] }>(`/v1/verticales/fiches/${module}/objets`);
  const fields = OBJECT_FIELDS[module]!;
  return (
    <Panel title={title} icon="grid" count={q.data?.items.length}>
      {q.error ? <p className="small muted">Registre réservé aux services compétents.</p> : (
        <Guard state={q}>{(d) => (
          <>
          <RegistreFicheViz items={d.items} />
          <DataTable rows={d.items} rowKey={(o) => o.objectId} empty={<EmptyState title="Aucun objet" />}
            columns={[
              { key: 'id', label: 'Objet', primary: true, render: (o) => <span className="mono">{o.objectId}</span> },
              ...fields.map(([k, l]) => ({ key: k, label: l, render: (o: SectorObject) => o.attributes[k] ?? '—' })),
              { key: 'op', label: 'Titulaire', render: (o) => o.operator ?? 'Non identifié' },
              { key: 'st', label: 'Statut', render: (o) => o.probativeStatus },
              { key: 'lq', label: 'Liquidations', render: (o) => o.liquidations.map((l) => `${l.period} : ${LIQ_STATUS[l.status]?.label ?? l.status}`).join(' ; ') || '—' },
            ]} />
          </>
        )}</Guard>
      )}
      {canRegister && <ObjectForm module={module} onDone={q.reload} />}
    </Panel>
  );
}

// ======================================================================== 13 — embarquement et débarquement

function ScanForm({ path, label, extra, onDone }: { path: string; label: string; extra?: ReactNode; onDone?: () => void }) {
  const [code, setCode] = useState('');
  const [res, setRes] = useState<{ control: ControlView | null; notice: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setRes(null);
    const presented = code.trim();
    const body = presented.startsWith('MT1.') || presented.startsWith('MD1.') || presented.includes('/preuve/') ? { qr: presented } : { code: presented };
    try { setRes(await api(path, { method: 'POST', body })); onDone?.(); } catch (ex) { setErr(describeError(ex).message); }
  };
  return (
    <form className="stack-sm" onSubmit={submit} aria-label={label}>
      <div className="row-wrap">
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="QR scanné ou code court" aria-label={`${label} — QR ou code court`} />
        {extra}
        <button type="submit" className="btn btn-primary btn-sm" disabled={!code.trim()}>{label}</button>
      </div>
      {res && (
        <div className={`callout ${res.control?.result === 'VALIDE' ? 'callout-ok' : 'callout-warn'}`} role="status">
          <Icon name={res.control?.result === 'VALIDE' ? 'check' : 'alert'} size={18} />
          <div><p><strong>{res.control?.text ?? 'Non consommé'}</strong></p><p className="small">{res.notice}</p>{res.control?.constat && <p className="small muted">Constat {res.control.constat.id} — {res.control.constat.notice}</p>}</div>
        </div>
      )}
      {err && <p className="err" role="alert">{err}</p>}
    </form>
  );
}

function DepartureRow({ d, operator, field, instructor, onDone }: { d: Departure; operator: boolean; field: boolean; instructor: boolean; onDone: () => void }) {
  const a = useAction(onDone);
  const [pax, setPax] = useState('');
  const [channel, setChannel] = useState('MOBILE_MONEY');
  const [rec, setRec] = useState<{ anomalies: string[]; proposal: string; issued: number; paid: number; consumed: number } | null>(null);
  const reconcile = async () => { try { setRec(await api(`/v1/verticales/fiches/departs/${d.id}/rapprochement`)); } catch (e) { setRec({ anomalies: [describeError(e).message], proposal: '', issued: 0, paid: 0, consumed: 0 }); } };
  return (
    <li className="list-row list-row-stack">
      <div className="row-between">
        <div className="min0">
          <p className="row-title"><span className="mono">{d.id}</span> — {d.point} → {d.destination}</p>
          <p className="small muted">{d.titleMode === 'PAR_PASSAGER' ? 'Titre par passager' : 'Titre par départ'} · manifeste : {d.manifest ? `${d.manifest.passengers} passager(s)` : 'non déposé'} · {d.titles} titre(s)</p>
        </div>
        <StatusBadge tone={d.status === 'PREVU' ? 'info' : d.status === 'ANNULE' ? 'critical' : 'good'} label={{ PREVU: 'Prévu', PARTI: 'Parti', ARRIVE: 'Arrivé', ANNULE: 'Annulé' }[d.status] ?? d.status} />
      </div>
      {operator && d.status === 'PREVU' && (
        <div className="row-wrap">
          <input value={pax} onChange={(e) => setPax(e.target.value)} placeholder="Passagers" aria-label={`Manifeste de ${d.id}`} inputMode="numeric" />
          <button type="button" className="btn btn-ghost btn-sm" disabled={!pax} onClick={() => void a.run(`/v1/verticales/fiches/departs/${d.id}/manifeste`, { passengers: Number(pax), documents: [] }, () => 'Manifeste déposé.')}>Déposer le manifeste</button>
          <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Canal de paiement">
            <option value="MOBILE_MONEY">Mobile Money</option><option value="USSD">USSD</option><option value="AGENT_POINT">Point agréé</option>
          </select>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void a.run<{ issuance: { payments: { paymentReference: string }[] } }>(`/v1/verticales/fiches/departs/${d.id}/titres`, { channel }, (r) => `Titres commandés — payez la référence ${r.issuance.payments.map((p) => p.paymentReference).join(', ')} (jamais à l’agent de quai).`)}>Commander les titres</button>
        </div>
      )}
      {field && d.status === 'PREVU' && <ScanForm path={`/v1/verticales/fiches/departs/${d.id}/embarquements`} label="Scanner un titre d’embarquement" onDone={onDone} />}
      <div className="row-wrap">
        {(operator || field) && d.status === 'PREVU' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void a.run(`/v1/verticales/fiches/departs/${d.id}/mouvements`, { kind: 'DEPART' }, () => 'Départ enregistré (heure du serveur).')}>Départ effectif</button>}
        {(operator || field) && d.status === 'PARTI' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void a.run(`/v1/verticales/fiches/departs/${d.id}/mouvements`, { kind: 'ARRIVEE' }, () => 'Arrivée enregistrée.')}>Arrivée</button>}
        {(operator || instructor) && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void reconcile()}>Rapprocher manifeste, titres et paiements</button>}
      </div>
      {rec && <p className="small">{rec.issued} titre(s), {rec.paid} payé(s), {rec.consumed} consommé(s). {rec.anomalies.length ? rec.anomalies.join(' ; ') : 'Aucun écart.'} {rec.proposal}</p>}
      {a.view}
    </li>
  );
}

function DeparturesPanel({ roles }: { roles: string[] }) {
  const q = useLoad<{ items: Departure[] }>('/v1/verticales/fiches/departs');
  const refs = useLoad<{ items: Reference[] }>('/v1/verticales/fiches/references');
  const operator = has(roles, 'R30', 'R31', 'R11');
  const [pointId, setPointId] = useState('');
  const [dest, setDest] = useState('');
  const [when, setWhen] = useState('');
  const [mode, setMode] = useState('PAR_PASSAGER');
  const [boat, setBoat] = useState('');
  const a = useAction(q.reload);
  const points = (refs.data?.items ?? []).filter((r) => r.kind === 'POINT_EMBARQUEMENT' || r.kind === 'QUAI');
  const declare = (e: FormEvent) => {
    e.preventDefault();
    void a.run<{ id: string }>('/v1/verticales/fiches/departs', { pointId: pointId || points[0]?.id, destination: dest, scheduledAt: new Date(when).toISOString(), titleMode: mode, ...(boat ? { embarcationId: boat } : {}) }, (r) => `Départ ${r.id} déclaré.`);
  };
  return (
    <Panel title="Départs, manifestes et titres" icon="anchor" count={q.data?.items.length}>
      {operator && (
        <form className="row-wrap" onSubmit={declare} aria-label="Déclarer un départ">
          <select value={pointId} onChange={(e) => setPointId(e.target.value)} aria-label="Point de départ">{points.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
          <input value={dest} onChange={(e) => setDest(e.target.value)} placeholder="Destination" aria-label="Destination" />
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Heure prévue" />
          <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Mode de titre"><option value="PAR_PASSAGER">Un titre par passager</option><option value="PAR_DEPART">Un titre par départ</option></select>
          <input value={boat} onChange={(e) => setBoat(e.target.value)} placeholder="Embarcation (facultatif)" aria-label="Embarcation" />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={!dest || !when}>Déclarer le départ</button>
        </form>
      )}
      {a.view}
      <Guard state={q}>{(d) => d.items.length ? (
        <ul className="list-rows">{d.items.map((x) => <DepartureRow key={x.id} d={x} operator={has(roles, 'R30', 'R31')} field={has(roles, 'R10', 'R11', 'R35')} instructor={has(roles, 'R06', 'R07', 'R11', 'R22')} onDone={q.reload} />)}</ul>
      ) : <EmptyState title="Aucun départ" />}</Guard>
      <p className="hint">Paiement au départ : Mobile Money ou point agréé, jamais à l’agent de quai. Titre à usage unique consommé au premier scan ; « DÉJÀ UTILISÉ » ensuite.</p>
    </Panel>
  );
}

function Tab13({ roles }: { roles: string[] }) {
  return (
    <div className="stack">
      <References module="13" kinds={[['POINT_EMBARQUEMENT', 'Point d’embarquement']]} canEdit={has(roles, 'R06', 'R07', 'R11')} />
      <DeparturesPanel roles={roles} />
    </div>
  );
}

// ======================================================================== 16 — antennes

function Tab16({ roles }: { roles: string[] }) {
  const q = useLoad<{
    exercice: string; rule: { status: string; ruleCode: string | null }; observedNotDeclared: { objectId: string; commune: string; quartier: string }[];
    indicators: Record<string, number>; operators: { taxpayerId: string; name: string; sites: number; declared: number; observed: number; liquidated: number; due: MoneyJSON[]; paid: MoneyJSON[]; recoveryRate: string | null; largeTaxpayer: { status: string } | null }[];
    imports: { id: string; source: string; received: number; created: number; known: number; at: string }[]; notice: string;
  }>(has(roles, 'R06', 'R07', 'R11') ? '/v1/verticales/fiches/antennes/recouvrement' : null);
  const muts = useLoad<{ items: { id: string; objectId: string; fromTaxpayerId: string | null; toTaxpayerId: string; dateEffet: string; status: string; motif: string }[] }>(has(roles, 'R06', 'R07', 'R11', 'R22', 'R01', 'R02', 'R05', 'R09', 'R24') ? '/v1/verticales/fiches/antennes/mutations' : null);
  const [csv, setCsv] = useState('');
  const [op, setOp] = useState('');
  const [src, setSrc] = useState('OPERATEUR');
  const a = useAction(() => { q.reload(); muts.reload(); });
  const importSites = (e: FormEvent) => {
    e.preventDefault();
    const sites = csv.split('\n').map((l) => l.split(';').map((x) => x.trim())).filter((p) => p.length >= 6).map(([reference, commune, quartier, lat, lon, type, emprise]) => ({ reference, commune, quartier, lat: Number(lat), lon: Number(lon), type, ...(emprise ? { emprise_m2: emprise } : {}) }));
    void a.run<{ received: number; created: number; known: number }>('/v1/verticales/fiches/antennes/imports', { source: src, operatorTaxpayerId: op, sites }, (r) => `${r.received} site(s) reçus : ${r.created} créé(s), ${r.known} déjà connu(s).`);
  };
  return (
    <div className="stack">
      {(has(roles, 'R30', 'R31', 'R34', 'R11')) && (
        <Panel title="Import des listes de sites (opérateur ou régulateur)" icon="upload">
          <form className="stack-sm" onSubmit={importSites}>
            <div className="row-wrap">
              <select value={src} onChange={(e) => setSrc(e.target.value)} aria-label="Source de la liste"><option value="OPERATEUR">Liste de l’opérateur</option><option value="REGULATEUR">Liste du régulateur</option></select>
              <input value={op} onChange={(e) => setOp(e.target.value)} placeholder="Opérateur (compte contribuable)" aria-label="Opérateur" />
            </div>
            <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={4} aria-label="Sites (une ligne par site)" placeholder="référence ; commune ; quartier ; latitude ; longitude ; type ; emprise m² (facultatif)" />
            <button type="submit" className="btn btn-secondary btn-sm" disabled={!op || !csv.trim()}>Importer la liste</button>
            {a.view}
          </form>
        </Panel>
      )}
      {q.data && (
        <Panel title={`Recouvrement par opérateur — exercice ${q.data.exercice}`} icon="chart">
          <p className="small">{q.data.notice}</p>
          <p className="small">Sites recensés {q.data.indicators.sitesRecenses} · déclarés {q.data.indicators.sitesDeclares} · observés {q.data.indicators.sitesObserves} · concordants {q.data.indicators.concordants}</p>
          <DataTable rows={q.data.operators} rowKey={(o) => o.taxpayerId} empty={<EmptyState title="Aucun site" />}
            columns={[
              { key: 'n', label: 'Opérateur', primary: true, render: (o) => <>{o.name}{o.largeTaxpayer ? ' · grand redevable' : ''}</> },
              { key: 's', label: 'Sites (déclarés / observés)', num: true, render: (o) => `${o.sites} (${o.declared} / ${o.observed})` },
              { key: 'l', label: 'Liquidés', num: true, render: (o) => o.liquidated },
              { key: 'd', label: 'Dû', render: (o) => <Amounts items={o.due} /> },
              { key: 'p', label: 'Payé', render: (o) => <Amounts items={o.paid} /> },
              { key: 'r', label: 'Recouvrement', num: true, render: (o) => o.recoveryRate ? `${o.recoveryRate} %` : '—' },
            ]} />
          {q.data.observedNotDeclared.length > 0 && <p className="small">Sites observés absents des listes déclarées : {q.data.observedNotDeclared.map((s) => `${s.objectId} (${s.commune})`).join(', ')} — vérification contradictoire.</p>}
        </Panel>
      )}
      <Objects module="16" title="Registre des sites et pylônes" canRegister={has(roles, 'R30', 'R31', 'R11', 'R07')} />
      {muts.data && (
        <Panel title="Mutations de site entre opérateurs" icon="replace" count={muts.data.items.length}>
          <ul className="list-rows">{muts.data.items.map((m) => (
            <li key={m.id} className="list-row">
              <span className="mono">{m.id}</span> — {m.objectId} : {m.fromTaxpayerId ?? '—'} → {m.toTaxpayerId} au {m.dateEffet} · {m.status}
              {has(roles, 'R06', 'R07') && m.status === 'PROPOSEE' && <>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const x = motif('Motif de la décision'); if (x) void a.run(`/v1/verticales/fiches/antennes/mutations/${m.id}/decision`, { approve: true, motif: x }, () => 'Mutation acceptée.'); }}>Accepter</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const x = motif('Motif du refus'); if (x) void a.run(`/v1/verticales/fiches/antennes/mutations/${m.id}/decision`, { approve: false, motif: x }, () => 'Mutation refusée.'); }}>Refuser</button>
              </>}
            </li>
          ))}</ul>
        </Panel>
      )}
    </div>
  );
}

// ======================================================================== 17 — boissons

function Tab17({ roles }: { roles: string[] }) {
  const sensitive = has(roles, 'R06', 'R07', 'R11', 'R22', 'R24');
  const map = useLoad<{ items: { id: string; label: string; commune: string; status: string; deliveries: number; volumeLitres: string; transmitted: boolean }[] }>(sensitive ? '/v1/verticales/fiches/boissons/points-livraison' : null);
  const coh = useLoad<{ items: { taxpayerId: string; name: string; incoherences: number; months: { period: string; declaredLitres: string | null; deliveredLitres: string; variationVsPreviousPct: string | null; flags: string[] }[] }[] }>(sensitive ? '/v1/verticales/fiches/boissons/coherence' : null);
  const fu = useLoad<{ items: { taxpayerId: string; name: string; missingDeclarations: string[]; unpaid: number; reminders: { id: string; kind: string; at: string }[]; largeTaxpayer: string | null }[] }>(sensitive ? '/v1/verticales/fiches/boissons/suivi' : null);
  const a = useAction(() => { map.reload(); fu.reload(); });
  if (!sensitive) return <EmptyState title="Données commerciales sensibles" icon="lock">Accès réservé à la régie et au contrôle. Les brasseries déclarent leurs volumes dans « Modules sectoriels ».</EmptyState>;
  const unauth = (map.data?.items ?? []).filter((p) => p.status !== 'AUTORISE' && !p.transmitted);
  return (
    <div className="stack">
      <Panel title="Carte des points de livraison (accès restreint, consultation journalisée)" icon="pin" count={map.data?.items.length}>
        <Guard state={map}>{(d) => (
          <DataTable rows={d.items} rowKey={(p) => p.id} empty={<EmptyState title="Aucune livraison versée" />}
            columns={[
              { key: 'l', label: 'Point', primary: true, render: (p) => `${p.label} (${p.commune})` },
              { key: 's', label: 'Statut', render: (p) => <StatusBadge tone={p.status === 'AUTORISE' ? 'good' : 'warning'} label={{ AUTORISE: 'Autorisé', NON_AUTORISE: 'Non autorisé', A_IDENTIFIER: 'À identifier' }[p.status] ?? p.status} /> },
              { key: 'v', label: 'Volume livré (l)', num: true, render: (p) => p.volumeLitres },
              { key: 't', label: 'Module 10', render: (p) => p.transmitted ? 'Transmis' : '—' },
            ]} />
        )}</Guard>
        {has(roles, 'R06', 'R07', 'R11') && unauth.length > 0 && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { const x = motif('Motif de la transmission au registre des activités'); if (x) void a.run('/v1/verticales/fiches/boissons/transmissions', { pointIds: unauth.map((p) => p.id), motif: x }, () => `${unauth.length} point(s) transmis au registre des activités (module 10).`); }}>
            Transmettre {unauth.length} point(s) non autorisé(s) au module 10
          </button>
        )}
        {a.view}
      </Panel>
      <Panel title="Cohérence mensuelle des volumes" icon="analysis">
        <Guard state={coh}>{(d) => d.items.length ? (
          <ul className="list-rows">{d.items.map((r) => (
            <li key={r.taxpayerId} className="list-row list-row-stack">
              <p className="row-title">{r.name} — {r.incoherences} incohérence(s)</p>
              <p className="small">{r.months.map((m) => `${m.period} : déclaré ${m.declaredLitres ?? '—'} l, livré ${m.deliveredLitres} l${m.variationVsPreviousPct ? `, variation ${m.variationVsPreviousPct} %` : ''}${m.flags.length ? ` [${m.flags.join(', ')}]` : ''}`).join(' · ')}</p>
            </li>
          ))}</ul>
        ) : <EmptyState title="Aucun redevable suivi" />}</Guard>
      </Panel>
      <Panel title="Suivi des paiements et relances" icon="clock">
        <Guard state={fu}>{(d) => (
          <ul className="list-rows">{d.items.map((r) => (
            <li key={r.taxpayerId} className="list-row">
              <span>{r.name}{r.largeTaxpayer ? ' · grand redevable' : ''} — mois non déclarés : {r.missingDeclarations.join(', ') || 'aucun'} · impayés : {r.unpaid} · relances : {r.reminders.length}</span>
              {has(roles, 'R06', 'R07', 'R11') && <>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const x = motif('Motif de la relance'); if (x) void a.run(`/v1/verticales/fiches/boissons/redevables/${r.taxpayerId}/relances`, { kind: 'DECLARATION', motif: x }, () => 'Relance de déclaration envoyée.'); }}>Relancer (déclaration)</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const x = motif('Motif de la relance'); if (x) void a.run(`/v1/verticales/fiches/boissons/redevables/${r.taxpayerId}/relances`, { kind: 'PAIEMENT', motif: x }, () => 'Relance de paiement envoyée.'); }}>Relancer (paiement)</button>
              </>}
            </li>
          ))}</ul>
        )}</Guard>
      </Panel>
    </div>
  );
}

// ======================================================================== 19 — assainissement

function Tab19({ roles }: { roles: string[] }) {
  const q = useLoad<{ exercice: string; rule: { status: string; ruleCode: string | null }; categories: string[]; total: number; byState: Record<string, number>; items: { objectId: string; category: string; commune: string; state: string; missing: string[] }[]; notice: string }>('/v1/verticales/fiches/assainissement/portefeuille');
  const a = useAction(q.reload);
  const [obj, setObj] = useState('');
  const [notice, setNotice] = useState<{ id: string; lines: { obligationId: string; label: string; amount: MoneyJSON; payment: string }[]; totals: MoneyJSON[]; paid: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = async (e: FormEvent) => { e.preventDefault(); setErr(null); try { setNotice(await api(`/v1/verticales/fiches/objets/${encodeURIComponent(obj)}/avis-unique`)); } catch (ex) { setErr(describeError(ex).message); } };
  return (
    <div className="stack">
      <Guard state={q}>{(d) => (
        <Panel title={`Portefeuille d’objets rattachés — exercice ${d.exercice}`} icon="building" count={d.total}>
          <p className="small">{d.notice} Catégories : {d.categories.join(', ') || 'non configurées'} · règle : {d.rule.ruleCode ?? 'aucune'} ({d.rule.status})</p>
          <p className="small">À liquider {d.byState.A_LIQUIDER ?? 0} · déjà liquidés {d.byState.DEJA_LIQUIDE ?? 0} · bases incomplètes {d.byState.BASE_INCOMPLETE ?? 0} · acte requis {d.byState.ACTE_REQUIS ?? 0}</p>
          {has(roles, 'R06', 'R07') && <button type="button" className="btn btn-secondary btn-sm" disabled={!d.byState.A_LIQUIDER} onClick={() => { const x = motif('Motif de l’application de la règle'); if (x) void a.run<{ executed: number }>('/v1/verticales/fiches/assainissement/application', { exercice: d.exercice, motif: x }, (r) => `${r.executed} objet(s) liquidé(s) — aucune double facturation.`); }}>Appliquer la règle au portefeuille</button>}
          {a.view}
        </Panel>
      )}</Guard>
      <Panel title="Avis unique d’un objet (toutes ses obligations)" icon="file">
        <form className="row-wrap" onSubmit={load}><input value={obj} onChange={(e) => setObj(e.target.value)} placeholder="Identifiant de l’objet" aria-label="Objet de l’avis unique" /><button type="submit" className="btn btn-ghost btn-sm" disabled={!obj}>Afficher l’avis</button></form>
        {err && <p className="err" role="alert">{err}</p>}
        {notice && <div className="small"><p>Avis {notice.id} — total <Amounts items={notice.totals} /> {notice.paid ? '(payé)' : ''}</p><ul>{notice.lines.map((l) => <li key={l.obligationId}>{l.label} : <MoneyText money={l.amount} /> — {l.payment}</li>)}</ul></div>}
      </Panel>
    </div>
  );
}

// ======================================================================== 20 — marchés

function Tab20({ roles }: { roles: string[] }) {
  const reg = has(roles, 'R06', 'R07', 'R09', 'R11', 'R22');
  const q = useLoad<{ items: { marketId: string; name: string; commune: string; stalls: number; occupied: number; paidOccupied: number; titles: number; paidTitles: number; paidOccupancyRate: string | null; revenue: MoneyJSON[] }[] }>(reg ? '/v1/verticales/fiches/marches/rapprochement' : null);
  const mine = useLoad<{ items: { id: string; stallId: string; status: string; renewals: { at: string }[] }[] }>(has(roles, 'R30', 'R31') ? '/v1/verticales/fiches/marches/abonnements/mine' : null);
  const [stall, setStall] = useState('');
  const a = useAction(mine.reload);
  return (
    <div className="stack">
      {q.data && (
        <Panel title="Rapprochement occupations ↔ titres ↔ paiements" icon="store">
          <DataTable rows={q.data.items} rowKey={(m) => m.marketId}
            columns={[
              { key: 'n', label: 'Marché', primary: true, render: (m) => `${m.name} (${m.commune})` },
              { key: 'e', label: 'Étals (occupés / payés)', num: true, render: (m) => `${m.stalls} (${m.occupied} / ${m.paidOccupied})` },
              { key: 't', label: 'Titres (payés)', num: true, render: (m) => `${m.titles} (${m.paidTitles})` },
              { key: 'r', label: 'Taux d’occupation payée', num: true, render: (m) => m.paidOccupancyRate ? `${m.paidOccupancyRate} %` : '—' },
              { key: 'm', label: 'Recettes', render: (m) => <Amounts items={m.revenue} /> },
            ]} />
          <p className="hint">Aucun encaissement par le placier : paiement numérique ou point agréé ; contrôle par scan de la plaque QR de l’étal.</p>
        </Panel>
      )}
      {mine.data && (
        <Panel title="Mon abonnement de droit d’étal" icon="clock">
          <p className="small">Le titre mensuel suivant est demandé à l’échéance, avec votre consentement ; vous le payez par Mobile Money ou au point agréé.</p>
          <div className="row-wrap">
            <input value={stall} onChange={(e) => setStall(e.target.value)} placeholder="Numéro de l’étal (ex. MCH-GMB-C-1044)" aria-label="Étal" />
            <button type="button" className="btn btn-secondary btn-sm" disabled={!stall} onClick={() => void a.run(`/v1/verticales/fiches/marches/etals/${encodeURIComponent(stall)}/abonnement`, { consent: true }, () => 'Abonnement activé.')}>M’abonner</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={!stall} onClick={() => void a.run(`/v1/verticales/fiches/marches/etals/${encodeURIComponent(stall)}/abonnement`, { consent: false }, () => 'Abonnement résilié.')}>Résilier</button>
          </div>
          {a.view}
          <ul className="list-plain small">{mine.data.items.map((s) => <li key={s.id}>{s.stallId} — {s.status === 'ACTIF' ? 'actif' : 'résilié'} · {s.renewals.length} renouvellement(s)</li>)}</ul>
        </Panel>
      )}
      {!q.data && !mine.data && <EmptyState title="Rapprochement réservé à la régie" />}
    </div>
  );
}

// ======================================================================== 21 — événements

function Tab21({ roles }: { roles: string[] }) {
  const q = useLoad<{ items: { objectId: string; name: string; commune: string; authorized: boolean; certificate: string | null; ticketsDeclared: number | null; attendanceObserved: number | null; gap: number | null; obligations: number; revenue: MoneyJSON[] }[] }>(has(roles, 'R01', 'R02', 'R05', 'R06', 'R07', 'R09', 'R10', 'R11', 'R22', 'R23', 'R24') ? '/v1/verticales/fiches/evenements/recettes' : null);
  const a = useAction(q.reload);
  const decide = has(roles, 'R06', 'R07');
  if (!q.data && !q.loading) return <EmptyState title="Recettes des événements réservées à la régie" />;
  return (
    <Panel title="Événements : autorisations, billetterie, recettes" icon="ticket">
      <Guard state={q}>{(d) => (
        <DataTable rows={d.items} rowKey={(e) => e.objectId} empty={<EmptyState title="Aucun événement" />}
          columns={[
            { key: 'n', label: 'Événement', primary: true, render: (e) => `${e.name} (${e.commune})` },
            { key: 'a', label: 'Autorisation', render: (e) => e.authorized ? `Autorisé — certificat ${e.certificate}` : 'Non autorisé' },
            { key: 'b', label: 'Billetterie déclarée / contrôlée', num: true, render: (e) => `${e.ticketsDeclared ?? '—'} / ${e.attendanceObserved ?? '—'}${e.gap && e.gap > 0 ? ` (écart ${e.gap})` : ''}` },
            { key: 'r', label: 'Recettes', render: (e) => <Amounts items={e.revenue} /> },
            { key: 'x', label: 'Liquidation', render: (e) => e.obligations ? `${e.obligations} obligation(s)` : decide && e.ticketsDeclared !== null ? (
              <span className="row-wrap">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const x = motif('Motif (billetterie déclarée)'); if (x) void a.run(`/v1/verticales/fiches/evenements/${e.objectId}/liquidation`, { basis: 'DECLAREE', motif: x }, () => 'Liquidé sur la billetterie déclarée.'); }}>Sur la billetterie déclarée</button>
                {e.gap !== null && e.gap > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const x = motif('Motif (fréquentation contrôlée)'); if (x) void a.run(`/v1/verticales/fiches/evenements/${e.objectId}/liquidation`, { basis: 'CONTROLEE', motif: x }, () => 'Liquidé sur la fréquentation contrôlée.'); }}>Sur le contrôle</button>}
              </span>
            ) : '—' },
          ]} />
      )}</Guard>
      {a.view}
      <p className="hint">Autorisation refusée sans enregistrement préalable (compte contribuable) ; certificat QR affiché sur le lieu ; l’écart de contrôle est décidé par une personne distincte du contrôleur.</p>
    </Panel>
  );
}

// ======================================================================== 22 — carrières

function Tab22({ roles }: { roles: string[] }) {
  const [site, setSite] = useState('');
  const [plates, setPlates] = useState('');
  const [channel, setChannel] = useState('MOBILE_MONEY');
  const [volume, setVolume] = useState('');
  const exits = useLoad<{ total: number; valid: number; refused: number; items: { id: string; plate: string | null; result: string; alreadyUsed: boolean; at: string }[] }>(site && has(roles, 'R01', 'R02', 'R05', 'R06', 'R07', 'R09', 'R10', 'R11', 'R22', 'R23', 'R24') ? `/v1/verticales/fiches/carrieres/${encodeURIComponent(site)}/sorties` : null, [site]);
  const a = useAction(exits.reload);
  return (
    <div className="stack">
      <Objects module="22" title="Registre des sites d’extraction" canRegister={has(roles, 'R30', 'R31', 'R11', 'R07')} />
      <Panel title="Bons de sortie (QR à usage unique par camion) et point de contrôle" icon="crane">
        <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="Site (identifiant de l’objet)" aria-label="Site d’extraction" />
        {has(roles, 'R30', 'R31') && (
          <div className="row-wrap">
            <input value={plates} onChange={(e) => setPlates(e.target.value)} placeholder="Plaques des camions (séparées par des virgules)" aria-label="Plaques des camions" />
            <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Canal de paiement des bons"><option value="MOBILE_MONEY">Mobile Money</option><option value="USSD">USSD</option><option value="AGENT_POINT">Point agréé</option></select>
            <button type="button" className="btn btn-secondary btn-sm" disabled={!site || !plates} onClick={() => void a.run<{ issuance: { payments: { paymentReference: string }[] } }>(`/v1/verticales/fiches/carrieres/${encodeURIComponent(site)}/bons`, { plates: plates.split(',').map((p) => p.trim()).filter(Boolean), channel }, (r) => `Bons commandés — payez la référence ${r.issuance.payments.map((p) => p.paymentReference).join(', ')}.`)}>Commander les bons</button>
          </div>
        )}
        {has(roles, 'R10', 'R11', 'R35') && site && (
          <ScanForm path={`/v1/verticales/fiches/carrieres/${encodeURIComponent(site)}/sorties`} label="Contrôler une sortie" onDone={exits.reload}
            extra={<input value={volume} onChange={(e) => setVolume(e.target.value)} placeholder="Volume chargé (m³)" aria-label="Volume chargé" inputMode="decimal" />} />
        )}
        {a.view}
        {exits.data && <p className="small">Sorties comptées : {exits.data.total} · bons valides : {exits.data.valid} · refus : {exits.data.refused}</p>}
        {exits.data && <ul className="list-plain small">{exits.data.items.slice(0, 10).map((x) => <li key={x.id}>{x.at.slice(0, 16).replace('T', ' ')} — {x.plate ?? '—'} : {x.result}{x.alreadyUsed ? ' (DÉJÀ UTILISÉ)' : ''}</li>)}</ul>}
        <p className="hint">Toute sortie est comptée puis rapprochée de la déclaration mensuelle ; un bon consommé n’est jamais réutilisable.</p>
      </Panel>
    </div>
  );
}

// ======================================================================== 23 — forêts

function Tab23({ roles }: { roles: string[] }) {
  const competent = has(roles, 'R06', 'R07', 'R11', 'R22');
  const q = useLoad<{ items: { id: string; point: string; produit: string; quantiteKg: string; declarant: string; at: string }[] }>(competent ? '/v1/verticales/fiches/forets/declarations' : null);
  const refs = useLoad<{ items: Reference[] }>('/v1/verticales/fiches/references?module=23');
  const [point, setPoint] = useState('');
  const [produit, setProduit] = useState('');
  const [qte, setQte] = useState('');
  const [decl, setDecl] = useState('');
  const a = useAction(q.reload);
  return (
    <div className="stack">
      {competent ? <Objects module="23" title="Concessions forestières (accès limité aux services compétents)" canRegister={has(roles, 'R11', 'R07')} /> : <EmptyState title="Accès limité aux services compétents" icon="lock" />}
      {has(roles, 'R10', 'R11', 'R35') && (
        <Panel title="Déclaration au point de contrôle (produits non ligneux)" icon="leaf">
          <form className="row-wrap" onSubmit={(e) => { e.preventDefault(); void a.run('/v1/verticales/fiches/forets/declarations', { pointId: point || refs.data?.items[0]?.id, produit, quantiteKg: qte, declarant: decl }, () => 'Déclaration enregistrée.'); }}>
            <select value={point} onChange={(e) => setPoint(e.target.value)} aria-label="Point de contrôle">{(refs.data?.items ?? []).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
            <input value={produit} onChange={(e) => setProduit(e.target.value)} placeholder="Produit" aria-label="Produit" />
            <input value={qte} onChange={(e) => setQte(e.target.value)} placeholder="Quantité (kg)" aria-label="Quantité (kg)" inputMode="decimal" />
            <input value={decl} onChange={(e) => setDecl(e.target.value)} placeholder="Déclarant" aria-label="Déclarant" />
            <button type="submit" className="btn btn-secondary btn-sm" disabled={!produit || !qte || decl.length < 2}>Enregistrer</button>
          </form>
          {a.view}
        </Panel>
      )}
      {q.data && (
        <Panel title="Déclarations enregistrées" icon="file" count={q.data.items.length}>
          <ul className="list-plain small">{q.data.items.map((d) => <li key={d.id}>{d.at.slice(0, 10)} — {d.point} : {d.produit}, {d.quantiteKg} kg ({d.declarant})</li>)}</ul>
        </Panel>
      )}
    </div>
  );
}

// ======================================================================== 24 — ports

function Tab24({ roles }: { roles: string[] }) {
  const [ref, setRef] = useState('');
  const [commune, setCommune] = useState('Nsele');
  const [ctl, setCtl] = useState<{ registered: boolean; identifiant?: string; capacitePassagers?: string; plate?: string | null; titles?: { typeCode: string; text: string }[]; movements?: { id: string; destination: string; status: string }[]; notice: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const port = useLoad<{ items: { objectId: string; identifiant: string | null; movements: number; accostageTitles: number; paid: MoneyJSON[]; gap: number; proposal: string }[] }>(has(roles, 'R01', 'R02', 'R05', 'R06', 'R07', 'R09', 'R11', 'R22', 'R23', 'R24') ? '/v1/verticales/fiches/ports/rapprochement' : null);
  const check = async (e: FormEvent) => { e.preventDefault(); setErr(null); setCtl(null); try { setCtl(await api(`/v1/verticales/fiches/embarcations/${encodeURIComponent(ref)}/controle?commune=${encodeURIComponent(commune)}`)); } catch (ex) { setErr(describeError(ex).message); } };
  return (
    <div className="stack">
      <References module="24" kinds={[['QUAI', 'Quai ou port privé']]} canEdit={has(roles, 'R06', 'R07', 'R11')} />
      <Objects module="24" title="Registre des embarcations" canRegister={has(roles, 'R30', 'R31', 'R11', 'R07')} />
      {has(roles, 'R09', 'R10', 'R11', 'R35') && (
        <Panel title="Contrôler une embarcation (QR ou numéro)" icon="anchor">
          <form className="row-wrap" onSubmit={check}>
            <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Plaque QR, identifiant ou numéro" aria-label="Embarcation à contrôler" />
            <select value={commune} onChange={(e) => setCommune(e.target.value)} aria-label="Commune du contrôle">{COMMUNES.map((c) => <option key={c}>{c}</option>)}</select>
            <button type="submit" className="btn btn-secondary btn-sm" disabled={!ref}>Contrôler</button>
          </form>
          {err && <p className="err" role="alert">{err}</p>}
          {ctl && <div className="callout callout-info"><Icon name="anchor" size={18} /><div><p>{ctl.registered ? `${ctl.identifiant} — capacité ${ctl.capacitePassagers ?? '—'} passagers` : 'Embarcation non enregistrée'}</p>{ctl.titles && <p className="small">Titres : {ctl.titles.map((t) => `${t.typeCode} — ${t.text}`).join(' ; ') || 'aucun'}</p>}{ctl.movements && <p className="small">Mouvements : {ctl.movements.map((m) => `${m.id} → ${m.destination} (${m.status})`).join(' ; ') || 'aucun'}</p>}<p className="small muted">{ctl.notice}</p></div></div>}
        </Panel>
      )}
      {port.data && (
        <Panel title="Rapprochement mouvements ↔ titres d’accostage (mois en cours)" icon="sync">
          <DataTable rows={port.data.items} rowKey={(x) => x.objectId} empty={<EmptyState title="Aucune embarcation" />}
            columns={[
              { key: 'i', label: 'Embarcation', primary: true, render: (x) => x.identifiant ?? x.objectId },
              { key: 'm', label: 'Mouvements', num: true, render: (x) => x.movements },
              { key: 't', label: 'Titres d’accostage', num: true, render: (x) => x.accostageTitles },
              { key: 'p', label: 'Payé', render: (x) => <Amounts items={x.paid} /> },
              { key: 'g', label: 'Proposition', render: (x) => x.proposal },
            ]} />
        </Panel>
      )}
    </div>
  );
}

// ======================================================================== 25 — péage

function Tab25({ roles }: { roles: string[] }) {
  const refs = useLoad<{ items: Reference[] }>('/v1/verticales/fiches/references?module=25');
  const types = useLoad<{ items: CredType[] }>('/v1/verticales/fiches/25/types-titres');
  const [point, setPoint] = useState('');
  const [plate, setPlate] = useState('');
  const [type, setType] = useState('');
  const [channel, setChannel] = useState('MOBILE_MONEY');
  const [bal, setBal] = useState<{ titles: { number: string; typeCode: string; usesTotal: number | null; usesLeft: number | null; text: string }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const a = useAction();
  const pts = (refs.data?.items ?? []).filter((r) => r.kind === 'AXE' || r.kind === 'POINT_PEAGE');
  const activable = (types.data?.items ?? []).filter((t) => t.activable);
  const pointId = point || pts[0]?.id || '';
  const balance = async () => { setErr(null); try { setBal(await api(`/v1/verticales/fiches/peage/carnets/${encodeURIComponent(plate)}`)); } catch (e) { setErr(describeError(e).message); } };
  return (
    <div className="stack">
      <References module="25" kinds={[['AXE', 'Axe de péage'], ['POINT_PEAGE', 'Point de péage']]} canEdit={has(roles, 'R06', 'R07', 'R11')} />
      <Panel title="Titres de péage liés à la plaque" icon="car">
        <div className="row-wrap">
          <input value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="Plaque" aria-label="Plaque du véhicule (péage)" />
          <select value={pointId} onChange={(e) => setPoint(e.target.value)} aria-label="Point de péage">{pts.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        </div>
        {has(roles, 'R30', 'R31') && (
          <div className="row-wrap">
            <select value={type || activable[0]?.code || ''} onChange={(e) => setType(e.target.value)} aria-label="Type de titre de péage">
              {activable.length ? activable.map((t) => <option key={t.code} value={t.code}>{t.label}</option>) : <option value="">Acte requis : aucun titre activable</option>}
            </select>
            <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Canal de paiement du péage"><option value="MOBILE_MONEY">Mobile Money</option><option value="USSD">USSD</option><option value="AGENT_POINT">Point agréé</option></select>
            <button type="button" className="btn btn-secondary btn-sm" disabled={!plate || !activable.length} onClick={() => void a.run<{ issuance: { payments: { paymentReference: string }[] } }>('/v1/verticales/fiches/peage/titres', { typeCode: type || activable[0]!.code, plate, pointId, channel }, (r) => `Titre commandé — payez la référence ${r.issuance.payments.map((p) => p.paymentReference).join(', ')}.`)}>Acheter</button>
          </div>
        )}
        {has(roles, 'R10', 'R11', 'R35') && <button type="button" className="btn btn-primary btn-sm" disabled={!plate || !pointId} onClick={() => void a.run<{ passage: { result: string; fraud: boolean }; notice: string }>('/v1/verticales/fiches/peage/passages', { pointId, plate }, (r) => `${r.passage.result === 'VALIDE' ? 'Passage consommé' : r.passage.result === 'ACTE_REQUIS' ? 'Acte requis' : 'Aucun titre valide'} — ${r.notice}`)}>Enregistrer un franchissement</button>}
        <button type="button" className="btn btn-ghost btn-sm" disabled={!plate} onClick={() => void balance()}>Solde du carnet</button>
        {a.view}
        {err && <p className="err" role="alert">{err}</p>}
        {bal && <ul className="list-plain small">{bal.titles.map((t) => <li key={t.number}>{t.number} ({t.typeCode}) — {t.usesLeft !== null ? `${t.usesLeft} passage(s) restant(s) sur ${t.usesTotal}` : t.text}</li>)}</ul>}
        <p className="hint">Aucun encaissement non tracé : paiement numérique au compte public ; chaque franchissement consomme un passage (heure du serveur).</p>
      </Panel>
    </div>
  );
}

// ======================================================================== Liquidations

function LiquidationsTab({ roles }: { roles: string[] }) {
  const [module, setModule] = useState('');
  const q = useLoad<{ items: Liquidation[] }>(`/v1/verticales/fiches/liquidations${module ? `?module=${module}` : ''}`, [module]);
  const st = useLoad<{ modules: { module: string; mode: string; rule: { ruleCode: string | null; status: string } }[]; schedulerNote: string; lastRun: { at: string; modules: { module: string; executed: number }[] } | null; doctrine: string }>('/v1/verticales/fiches/liquidations/automatique');
  const a = useAction(() => { q.reload(); st.reload(); });
  const [obj, setObj] = useState('');
  const [period, setPeriod] = useState('');
  const [mod, setMod] = useState('16');
  const [mv, setMv] = useState('');
  return (
    <div className="stack">
      <Guard state={st}>{(d) => (
        <Panel title="Liquidation automatique (antennes, carrières, concessions)" icon="sync">
          <p className="small">{d.doctrine}</p>
          <ul className="list-plain small">{d.modules.map((m) => <li key={m.module}>Module {m.module} : {m.mode === 'AUTOMATIQUE' ? `automatique — règle ${m.rule.ruleCode} ACTIVE` : `proposition seulement (${m.rule.ruleCode ? `règle ${m.rule.status}` : 'acte requis'})`}</li>)}</ul>
          <p className="small muted">{d.schedulerNote} Dernier passage : {d.lastRun ? `${d.lastRun.at.slice(0, 16).replace('T', ' ')} — ${d.lastRun.modules.map((m) => `${m.module} : ${m.executed}`).join(', ')}` : 'aucun'}.</p>
          {has(roles, 'R11') && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void a.run<{ modules: { module: string; executed: number }[] }>('/v1/verticales/fiches/liquidations/automatique', {}, (r) => `Passage exécuté : ${r.modules.map((m) => `${m.module} → ${m.executed}`).join(', ')}.`)}>Lancer le passage maintenant</button>}
        </Panel>
      )}</Guard>
      {has(roles, 'R11') && (
        <Panel title="Proposer une liquidation" icon="file">
          <form className="row-wrap" onSubmit={(e) => { e.preventDefault(); void a.run<Liquidation>('/v1/verticales/fiches/liquidations', { module: mod, objectId: obj, period, ...(mv ? { movementId: mv } : {}) }, (r) => `${r.id} : ${LIQ_STATUS[r.status]?.label ?? r.status}. ${r.note}`); }}>
            <select value={mod} onChange={(e) => setMod(e.target.value)} aria-label="Module de la liquidation">{['16', '17', '19', '22', '23', '24'].map((m) => <option key={m}>{m}</option>)}</select>
            <input value={obj} onChange={(e) => setObj(e.target.value)} placeholder="Objet" aria-label="Objet à liquider" />
            <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="AAAA ou AAAA-MM" aria-label="Période" />
            {mod === '24' && <input value={mv} onChange={(e) => setMv(e.target.value)} placeholder="Mouvement (facultatif)" aria-label="Mouvement" />}
            <button type="submit" className="btn btn-secondary btn-sm" disabled={!obj || !period}>Proposer</button>
          </form>
        </Panel>
      )}
      {a.view}
      <Panel title="Liquidations" icon="ledger" count={q.data?.items.length}>
        <select value={module} onChange={(e) => setModule(e.target.value)} aria-label="Filtrer par module"><option value="">Tous les modules</option>{['16', '17', '19', '22', '23', '24'].map((m) => <option key={m}>{m}</option>)}</select>
        <Guard state={q}>{(d) => (
          <>
          {d.items.length > 0 && <LiquidationsFicheViz items={d.items} vue={LIQ_STATUS} />}
          <DataTable rows={d.items} rowKey={(l) => l.id} empty={<EmptyState title="Aucune liquidation" />}
            columns={[
              { key: 'id', label: 'Liquidation', primary: true, render: (l) => <><span className="mono">{l.id}</span> · module {l.module} · {l.period}{l.movementId ? ` · ${l.movementId}` : ''}</> },
              { key: 'o', label: 'Objet', render: (l) => l.objectId },
              { key: 'b', label: 'Bases (données)', render: (l) => Object.entries(l.basis).map(([k, v]) => `${k} ${v}`).join(', ') || '—' },
              { key: 's', label: 'Statut', render: (l) => <StatusBadge tone={LIQ_STATUS[l.status]?.tone ?? 'neutral'} label={`${LIQ_STATUS[l.status]?.label ?? l.status}${l.mode === 'AUTOMATIQUE' ? ' (auto)' : ''}`} /> },
              { key: 'm', label: 'Montant', render: (l) => l.simulated ? <MoneyText money={l.simulated} /> : '—' },
              { key: 'r', label: 'Règlement', render: (l) => l.payment ? l.payment.state : '—' },
              { key: 'x', label: 'Décision', render: (l) => has(roles, 'R06', 'R07') && ['PROPOSEE', 'ACTE_REQUIS', 'BASE_INCOMPLETE'].includes(l.status) ? (
                <span className="row-wrap">
                  <button type="button" className="btn btn-ghost btn-sm" disabled={l.status !== 'PROPOSEE'} onClick={() => { const x = motif('Motif de l’exécution'); if (x) void a.run(`/v1/verticales/fiches/liquidations/${l.id}/decision`, { decision: 'EXECUTER', motif: x }, () => 'Liquidation exécutée.'); }}>Exécuter</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const x = motif('Motif du rejet'); if (x) void a.run(`/v1/verticales/fiches/liquidations/${l.id}/decision`, { decision: 'REJETER', motif: x }, () => 'Liquidation rejetée.'); }}>Rejeter</button>
                </span>
              ) : l.noticeId ? `Avis ${l.noticeId}` : '—' },
            ]} />
          </>
        )}</Guard>
      </Panel>
    </div>
  );
}

// ======================================================================== Configuration (régie)

function ConfigRow({ module }: { module: string }) {
  const q = useLoad<{ ruleCode: string | null; credentialTypeCode: string | null; extraCredentialTypeCodes?: string[]; objectCategories: string[]; actReference: string; rule: string }>(`/v1/verticales/fiches/${module}/configuration`);
  const types = useLoad<{ available: CredType[] }>(`/v1/verticales/fiches/${module}/types-titres`);
  const [rule, setRule] = useState('');
  const [type, setType] = useState('');
  const [act, setAct] = useState('');
  const [cats, setCats] = useState('');
  const a = useAction(q.reload);
  const avail = types.data?.available ?? [];
  const catalogueModule = ['13', '22', '24', '25'].includes(module);
  return (
    <li className="list-row list-row-stack">
      <p className="row-title">Module {module} — règle {q.data?.ruleCode ?? 'aucune'} ({q.data?.rule ?? '…'}){q.data?.credentialTypeCode ? ` · titre ${q.data.credentialTypeCode}` : ''}{q.data?.extraCredentialTypeCodes?.length ? ` + ${q.data.extraCredentialTypeCodes.join(', ')}` : ''}</p>
      <form className="row-wrap" onSubmit={(e) => { e.preventDefault(); const m = motif('Motif de la configuration'); if (m) void a.run(`/v1/verticales/fiches/${module}/configuration`, { ruleCode: rule || null, ...(catalogueModule && type ? { credentialTypeCode: type } : {}), ...(module === '19' && cats ? { objectCategories: cats.split(',').map((c) => c.trim()) } : {}), actReference: act, motif: m }, () => 'Configuration enregistrée.'); }}>
        <input value={rule} onChange={(e) => setRule(e.target.value)} placeholder="Code de la règle du registre" aria-label={`Règle du module ${module}`} />
        {catalogueModule && avail.length > 0 && (
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label={`Type de titre du module ${module}`}>
            <option value="">(inchangé)</option>
            {avail.map((t) => <option key={t.code} value={t.code}>{t.label}{t.demo ? ' [EXEMPLE]' : ''}{t.activable ? '' : ' — non activable'}</option>)}
          </select>
        )}
        {module === '19' && <input value={cats} onChange={(e) => setCats(e.target.value)} placeholder="Catégories (PARCELLE, ACTIVITE…)" aria-label="Catégories d’objets" />}
        <input value={act} onChange={(e) => setAct(e.target.value)} placeholder="Référence de l’acte" aria-label={`Acte du module ${module}`} />
        <button type="submit" className="btn btn-ghost btn-sm" disabled={act.trim().length < 2}>Enregistrer</button>
      </form>
      {a.view}
    </li>
  );
}

function ConfigurationTab({ roles }: { roles: string[] }) {
  if (!has(roles, 'R06')) return <EmptyState title="Configuration réservée à la direction de la régie" icon="lock">Choisissez « Directeur DGTK — configuration des fiches sectorielles » dans l’en-tête.</EmptyState>;
  return (
    <Panel title="Règle du registre et type de titre de chaque fiche (avec l’acte)" icon="scale">
      <p className="small">Sans règle ACTIVE, le module reste en « acte requis » : propositions sans montant. Les types [EXEMPLE] sont réservés à la démonstration.</p>
      <ul className="list-rows">{['13', '16', '17', '18', '19', '22', '23', '24', '25'].map((m) => <ConfigRow key={m} module={m} />)}</ul>
    </Panel>
  );
}

// ======================================================================== Page

export default function Fiches() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const [tab, setTab] = useState('indicateurs');
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Spécification fonctionnelle — modules 13 à 25" title="Fiches sectorielles"
        lead="Registres, titres consommés au scan, liquidations automatiques sur règle ACTIVE (propositions sinon), rapprochements et indicateurs. Aucune sanction automatique, aucun encaissement par un agent." />
      <div className="seg seg-wrap" role="tablist" aria-label="Fiches">
        {FICHE_TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'indicateurs' && <IndicatorsTab />}
      {tab === '13' && <Tab13 roles={roles} />}
      {tab === '16' && <Tab16 roles={roles} />}
      {tab === '17' && <Tab17 roles={roles} />}
      {tab === '18' && <Plastique />}
      {tab === '19' && <Tab19 roles={roles} />}
      {tab === '20' && <Tab20 roles={roles} />}
      {tab === '21' && <Tab21 roles={roles} />}
      {tab === '22' && <Tab22 roles={roles} />}
      {tab === '23' && <Tab23 roles={roles} />}
      {tab === '24' && <Tab24 roles={roles} />}
      {tab === '25' && <Tab25 roles={roles} />}
      {tab === 'liquidations' && <LiquidationsTab roles={roles} />}
      {tab === 'configuration' && <ConfigurationTab roles={roles} />}
    </div>
  );
}
