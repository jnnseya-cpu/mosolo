/**
 * Inspection et constat (spécification fonctionnelle, module 35) : dossiers d'inspection préparés avant la visite,
 * paquet hors ligne de la mission (conservé sur le terminal, consultable sans réseau), procès-verbal selon les pouvoirs
 * de l'agent (signature ou refus de signer), transmission au superviseur, validation par une personne distincte ;
 * un procès-verbal validé est figé ; contestations et réponses motivées ; indicateurs du module.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { useOnline } from '../../hooks/useOnline';
import { api, describeError, safeGet, safeSet } from '../../lib/api';
import { sha256Hex, uid } from '../../lib/crypto';
import { ReasonAction } from '../fiscal/common';
import './terrain.css';

interface Dossier {
  id: string; objectId: string; version: number; contentHash: string;
  content: { object: { id: string; category: string; commune: string; quartier: string; lat: number; lon: number; igf?: string }; holder: { nameMasked: string | null }; situation: { label: string; openAppeal: boolean }; lastFindings: { id: string; outcome: string; status: string }[]; checklist: string[] };
}
interface Template { id: string; title: string; power: string; sections: string[]; mentions: string[]; legalBasis: { status: string; note: string } }
export interface OfflinePackage { mission: { id: string; title: string; commune: string; dueDate: string; toleranceM: number }; dossiers: Dossier[]; itinerary?: { order: number; objectId: string; legM: number; cumulativeM: number }[]; templates: Template[]; powers: string[]; issuedAt: string; validUntil: string; packageHash: string; signature: string }
interface Pv {
  id: string; number: string; version: number; findingId: string; missionId: string; templateId: string; power: string; authorId: string; status: string; commune: string;
  distanceM: number; geofenceFlags: string[]; signature: { kind: string; signerName?: string; refusalNote?: string }; statements: { personDeclaration: string; observations: string };
  seal: string; recordedAt: string; review?: { by: string; reason: string }; contestations: { id: string; text: string; acknowledgement: string; answer?: { text: string } }[];
}
interface MissionLite { id: string; title: string; commune: string; status: string; assignedAgentId?: string }
interface FindingLite { id: string; outcome: string; status: string; objectId?: string; capturedAt: string }
interface Indicators {
  constats: { total: number; soumis: number; valides: number; rejetes: number; horsZone: number };
  tauxValidation: { statut: string; valeur?: string; motif?: string };
  procesVerbaux: { total: number; transmis: number; valides: number; rejetes: number; tauxValidation: string | null; refusDeSigner: number };
  contestations: { total: number; traitees: number };
}

const PV_STATUS: Record<string, { label: string; tone: Tone }> = {
  TRANSMIS: { label: 'Transmis au superviseur', tone: 'warning' }, VALIDE: { label: 'Validé — figé', tone: 'good' }, REJETE: { label: 'Rejeté', tone: 'critical' }, REMPLACE: { label: 'Remplacé (version conservée)', tone: 'neutral' },
};
const SIGN: Record<string, string> = { SIGNE: 'Signé', REFUS_DE_SIGNER: 'Refus de signer', PERSONNE_ABSENTE: 'Personne absente' };
const pkgKey = (missionId: string) => `mosolo.inspection.paquet.${missionId}`;
const QUEUE_KEY = 'mosolo.inspection.pv-en-attente';

/** Paquet conservé sur le terminal (consultable sans réseau). */
export function readPackage(missionId: string): OfflinePackage | null {
  try { const raw = safeGet(pkgKey(missionId)); return raw ? JSON.parse(raw) as OfflinePackage : null; } catch { return null; }
}
function readQueue(): Record<string, unknown>[] {
  try { return JSON.parse(safeGet(QUEUE_KEY) ?? '[]') as Record<string, unknown>[]; } catch { return []; }
}

function PvForm({ pkg, onDone }: { pkg: OfflinePackage; onDone: () => void }) {
  const online = useOnline();
  const findings = useApi(() => api<{ items: FindingLite[] }>(`/v1/terrain/findings?missionId=${encodeURIComponent(pkg.mission.id)}`), [pkg.mission.id]);
  const [f, setF] = useState({ findingId: '', templateId: pkg.templates[0]?.id ?? '', declaration: '', kind: 'SIGNE', signerName: '', refusalNote: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault(); setErr(null); setMsg(null);
    const signature = f.kind === 'SIGNE' ? { kind: 'SIGNE', signerName: f.signerName, signatureImageSha256: await sha256Hex(`signature|${f.signerName}|${f.findingId}`) }
      : f.kind === 'REFUS_DE_SIGNER' ? { kind: 'REFUS_DE_SIGNER', refusalNote: f.refusalNote } : { kind: 'PERSONNE_ABSENTE' };
    const body = { clientRef: uid('pv'), findingId: f.findingId, templateId: f.templateId, personDeclaration: f.declaration, signature, signedAt: new Date().toISOString() };
    if (!online) {
      safeSet(QUEUE_KEY, JSON.stringify([...readQueue(), body]));
      setMsg('Hors ligne : procès-verbal conservé sur le terminal, transmis à la reconnexion.');
      return;
    }
    try { const pv = await api<Pv>('/v1/terrain/proces-verbaux', { method: 'POST', body }); setMsg(`Procès-verbal ${pv.number} transmis au superviseur.`); onDone(); } catch (x) { setErr(describeError(x).message); }
  }
  const tpl = pkg.templates.find((t) => t.id === f.templateId);
  return (
    <form className="panel stack-sm" onSubmit={(e) => void go(e)} aria-label="Établir un procès-verbal">
      <h3 className="h-sub">Procès-verbal (selon vos pouvoirs)</h3>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="pv-finding">Constat</label>
          <select id="pv-finding" required value={f.findingId} onChange={(e) => setF({ ...f, findingId: e.target.value })}>
            <option value="">—</option>{(findings.data?.items ?? []).filter((x) => x.status !== 'REJETE').map((x) => <option key={x.id} value={x.id}>{x.id} · {x.outcome} · {x.objectId ?? 'zone'}</option>)}
          </select></div>
        <div className="field"><label className="label" htmlFor="pv-tpl">Modèle</label>
          <select id="pv-tpl" value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}>{pkg.templates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></div>
      </div>
      {tpl && <p className="small muted">Rubriques : {tpl.sections.join(' · ')}. Base légale : {tpl.legalBasis.status === 'A_VERIFIER' ? 'À VÉRIFIER' : tpl.legalBasis.status} — {tpl.legalBasis.note}</p>}
      <div className="field"><label className="label" htmlFor="pv-decl">Déclaration de la personne rencontrée</label><textarea id="pv-decl" rows={2} value={f.declaration} onChange={(e) => setF({ ...f, declaration: e.target.value })} /></div>
      <fieldset className="btn-row"><legend className="label">Signature</legend>
        {Object.entries(SIGN).map(([k, v]) => <label key={k} className="small"><input type="radio" name="pv-sign" checked={f.kind === k} onChange={() => setF({ ...f, kind: k })} /> {v}</label>)}
      </fieldset>
      {f.kind === 'SIGNE' && <div className="field"><label className="label" htmlFor="pv-signer">Nom du signataire</label><input id="pv-signer" required value={f.signerName} onChange={(e) => setF({ ...f, signerName: e.target.value })} /></div>}
      {f.kind === 'REFUS_DE_SIGNER' && <div className="field"><label className="label" htmlFor="pv-refus">Circonstances du refus (obligatoire)</label><input id="pv-refus" required value={f.refusalNote} onChange={(e) => setF({ ...f, refusalNote: e.target.value })} /></div>}
      {msg && <p className="notice notice-ok" role="status">{msg}</p>}
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <button type="submit" className="btn btn-primary btn-sm">Transmettre au superviseur</button>
    </form>
  );
}

/** Constats « objet non enregistré » : fiche provisoire (identifiant provisoire, aucun effet fiscal avant qualification). */
function Unregistered({ missionId }: { missionId: string }) {
  const q = useApi(() => api<{ items: FindingLite[] }>(`/v1/terrain/findings?missionId=${encodeURIComponent(missionId)}`), [missionId]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const items = (q.data?.items ?? []).filter((f) => f.outcome === 'OBJET_NON_ENREGISTRE' && f.status !== 'REJETE');
  if (!items.length) return null;
  async function create(id: string) {
    setErr(null);
    try { const o = await api<{ id: string }>(`/v1/terrain/findings/${id}/objet-provisoire`, { method: 'POST', body: { category: 'ACTIVITE', quartier: 'À préciser', localityRank: 3 } }); setMsg(`Fiche provisoire ${o.id} (aucun effet fiscal avant qualification).`); } catch (x) { setErr(describeError(x).message); }
  }
  return (
    <section className="panel stack-sm" aria-label="Objets non enregistrés">
      <h3 className="h-sub">Objets non enregistrés découverts</h3>
      <ul className="plain-list small">{items.map((f) => <li key={f.id}>{f.id} · {new Date(f.capturedAt).toLocaleString('fr-FR')} <button type="button" className="btn btn-ghost btn-sm" onClick={() => void create(f.id)}>Créer la fiche provisoire</button></li>)}</ul>
      {msg && <p className="notice notice-ok" role="status">{msg}</p>}
      {err && <p className="notice notice-err" role="alert">{err}</p>}
    </section>
  );
}

function PackageView({ pkg }: { pkg: OfflinePackage }) {
  return (
    <section className="stack-sm" aria-label="Dossiers d'inspection">
      <p className="small">Paquet de la mission <span className="mono">{pkg.mission.id}</span> émis le {new Date(pkg.issuedAt).toLocaleString('fr-FR')} · valable jusqu’au {pkg.mission.dueDate} · empreinte <span className="mono">{pkg.packageHash.slice(0, 12)}…</span> · tolérance GPS {pkg.mission.toleranceM} m</p>
      {pkg.itinerary && pkg.itinerary.length > 0 && <p className="small">Itinéraire : {pkg.itinerary.map((s) => `${s.order}. ${s.objectId} (+${s.legM} m)`).join(' → ')} — {pkg.itinerary.at(-1)!.cumulativeM} m au total (indicatif).</p>}
      {pkg.dossiers.length === 0 && <EmptyState title="Aucun dossier préparé pour cette mission." />}
      <ul className="stack-sm">{pkg.dossiers.map((d) => (
        <li key={d.id} className="panel stack-sm">
          <p className="panel-title"><span className="mono">{d.content.object.id}</span> · {d.content.object.category} · {d.content.object.commune} / {d.content.object.quartier}{d.content.object.igf ? ` · ${d.content.object.igf}` : ''}</p>
          <p className="small">Titulaire : {d.content.holder.nameMasked ?? 'non rattaché'} · {d.content.situation.label} · dossier v{d.version}</p>
          <ul className="plain-list small">{d.content.checklist.map((c) => <li key={c}>☐ {c}</li>)}</ul>
          {d.content.lastFindings.length > 0 && <p className="small muted">Derniers constats : {d.content.lastFindings.map((x) => `${x.id} (${x.outcome}, ${x.status})`).join(', ')}</p>}
        </li>))}</ul>
    </section>
  );
}

function Supervision() {
  const { user } = useApp();
  const q = useApi(() => api<Pv[]>('/v1/terrain/proces-verbaux'), [user?.id]);
  const roles = user?.roles ?? [];
  const reviewer = roles.some((r) => r === 'R09' || r === 'R11');
  if (q.loading) return <Loading />;
  if (q.error !== null) return <ErrorState error={q.error} onRetry={q.reload} />;
  return (
    <section className="stack-sm" aria-label="Procès-verbaux">
      <h2 className="h-sub">Procès-verbaux</h2>
      {(q.data ?? []).length === 0 && <EmptyState title="Aucun procès-verbal." />}
      <ul className="stack-sm">{(q.data ?? []).map((p) => {
        const st = PV_STATUS[p.status] ?? { label: p.status, tone: 'neutral' as Tone };
        return (
          <li key={p.id} className="panel stack-sm">
            <div className="panel-head"><p className="panel-title"><span className="mono">{p.number}</span> v{p.version} · {p.templateId} · {p.commune}</p><StatusBadge tone={st.tone} label={st.label} /></div>
            <p className="small">Constat {p.findingId} · écart GPS {p.distanceM} m{p.geofenceFlags.length ? ` (${p.geofenceFlags.join(', ')})` : ''} · {SIGN[p.signature.kind] ?? p.signature.kind}{p.signature.refusalNote ? ` — ${p.signature.refusalNote}` : ''} · scellé <span className="mono">{p.seal.slice(0, 12)}…</span></p>
            {p.statements.personDeclaration && <p className="small">Déclaration : « {p.statements.personDeclaration} »</p>}
            {p.contestations.map((c) => (
              <div key={c.id} className="small"><p>Contestation : « {c.text} » — {c.acknowledgement}</p>
                {c.answer ? <p>Réponse : {c.answer.text}</p> : reviewer && user?.id !== p.authorId && <ReasonAction label="Répondre" confirmLabel="Répondre" minLength={10} onSubmit={(text) => api(`/v1/terrain/proces-verbaux/${p.id}/contestations/${c.id}/reponse`, { method: 'POST', body: { text } }).then(q.reload)} />}
              </div>))}
            {reviewer && p.status === 'TRANSMIS' && user?.id !== p.authorId && (
              <div className="btn-row">
                <ReasonAction label="Valider" confirmLabel="Valider (figé)" minLength={5} onSubmit={(reason) => api(`/v1/terrain/proces-verbaux/${p.id}/decision`, { method: 'POST', body: { decision: 'VALIDE', reason } }).then(q.reload)} />
                <ReasonAction label="Rejeter" confirmLabel="Rejeter" tone="secondary" minLength={5} onSubmit={(reason) => api(`/v1/terrain/proces-verbaux/${p.id}/decision`, { method: 'POST', body: { decision: 'REJETE', reason } }).then(q.reload)} />
              </div>)}
          </li>);
      })}</ul>
    </section>
  );
}

function IndicatorsPanel() {
  const q = useApi(() => api<Indicators>('/v1/terrain/inspection/indicateurs'), []);
  if (!q.data) return null;
  const d = q.data;
  return (
    <section className="panel stack-sm" aria-label="Indicateurs de l'inspection">
      <h2 className="h-sub">Indicateurs (module 35)</h2>
      <p className="small">Constats : <strong>{d.constats.total}</strong> ({d.constats.valides} validés, {d.constats.rejetes} rejetés, {d.constats.soumis} en attente, {d.constats.horsZone} hors zone ou à distance)</p>
      <p className="small">Taux de validation : <strong>{d.tauxValidation.valeur ?? 'non mesuré'}</strong>{d.tauxValidation.motif ? ` — ${d.tauxValidation.motif}` : ''}</p>
      <p className="small">Procès-verbaux : {d.procesVerbaux.total} ({d.procesVerbaux.valides} validés, {d.procesVerbaux.transmis} transmis, {d.procesVerbaux.refusDeSigner} refus de signer) · contestations : <strong>{d.contestations.total}</strong> ({d.contestations.traitees} traitées)</p>
    </section>
  );
}

export default function Inspection() {
  const { user } = useApp();
  const online = useOnline();
  const roles = user?.roles ?? [];
  const preparer = roles.some((r) => ['R07', 'R09', 'R11'].includes(r));
  const missions = useApi(() => api<{ items: MissionLite[] }>('/v1/terrain/missions'), [user?.id]);
  const [missionId, setMissionId] = useState('');
  const [pkg, setPkg] = useState<OfflinePackage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const select = (id: string) => { setMissionId(id); setPkg(id ? readPackage(id) : null); setErr(null); setInfo(null); };
  async function prepare() {
    setErr(null);
    try { const d = await api<Dossier[]>(`/v1/terrain/missions/${missionId}/dossiers-inspection`, { method: 'POST' }); setInfo(`${d.length} dossier(s) préparé(s).`); } catch (x) { setErr(describeError(x).message); }
  }
  async function download() {
    setErr(null);
    try {
      const p = await api<OfflinePackage>(`/v1/terrain/missions/${missionId}/paquet-hors-ligne`);
      safeSet(pkgKey(missionId), JSON.stringify(p)); setPkg(p); setInfo('Paquet conservé sur ce terminal : consultable sans réseau.');
    } catch (x) { setErr(describeError(x).message); }
  }
  async function flush() {
    const queue = readQueue();
    const left: Record<string, unknown>[] = [];
    for (const body of queue) { try { await api('/v1/terrain/proces-verbaux', { method: 'POST', body }); } catch { left.push(body); } }
    safeSet(QUEUE_KEY, JSON.stringify(left)); setInfo(`${queue.length - left.length} procès-verbal(aux) transmis, ${left.length} en attente.`); setTick((n) => n + 1);
  }
  const pending = readQueue().length;
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Terrain" title="Inspection et constat"
        lead="Le dossier de chaque objet est préparé avant la visite et emporté hors ligne ; le procès-verbal est établi selon vos pouvoirs, signé ou avec mention du refus, puis validé par une autre personne. Un procès-verbal validé n’est jamais modifié. Aucun encaissement, aucune sanction." />
      {!online && <p className="notice" role="status">Hors ligne : les paquets déjà téléchargés restent consultables ; les procès-verbaux sont conservés puis transmis.</p>}
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="ins-mission">Mission</label>
          <select id="ins-mission" value={missionId} onChange={(e) => select(e.target.value)}>
            <option value="">—</option>{(missions.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.id} · {m.title}</option>)}
          </select></div>
      </div>
      <div className="btn-row">
        {preparer && missionId && online && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void prepare()}>Préparer les dossiers</button>}
        {missionId && online && <button type="button" className="btn btn-primary btn-sm" onClick={() => void download()}>Télécharger le paquet hors ligne</button>}
        {pending > 0 && online && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void flush()}>Transmettre {pending} procès-verbal(aux) en attente</button>}
      </div>
      {info && <p className="notice notice-ok" role="status">{info}</p>}
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {pkg && <PackageView pkg={pkg} />}
      {pkg && pkg.templates.length > 0 && <PvForm pkg={pkg} onDone={() => setTick((n) => n + 1)} />}
      {pkg && online && <Unregistered missionId={pkg.mission.id} />}
      <Supervision key={tick} />
      <IndicatorsPanel key={`i-${tick}`} />
    </div>
  );
}
