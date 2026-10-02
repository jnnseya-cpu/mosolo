/**
 * KIN PUB CONTROL — carte à couches (§ 11B.2), pilote en sept étapes, signalements citoyens à trier et propositions
 * d'analyse d'image (§ 11B.5). Zones saturées = décisions motivées de l'autorité ; zones à contrôler = faits cumulés
 * sans seuil ; l'analyse d'image PROPOSE, une personne vérifie ; aucune sanction automatique.
 */
import { useState, type FormEvent } from 'react';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { GeoMapLazy } from '../../components/GeoMapLazy';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { circleRing } from '../../lib/geo';
import { COMMUNES } from '../../verticals/catalogue';
import '../referentiel/referentiel.css';
import { CarteVisuels } from './visuels';

interface Zone { id: string; kind: string; label: string; commune: string; lat: number; lon: number; radiusM: number; motif: string }
interface Layers {
  supports: { id: string; reference: string; lat: number; lon: number; status: string; expiringSoon: boolean; openCase: boolean }[];
  density: { commune: string; activeSupports: number }[];
  saturatedZones: Zone[];
  zonesToControl: { designated: Zone[]; computed: { commune: string; undeclared: number; expired: number; openCases: number; citizenReports: number; aiConfirmed: number; total: number }[] };
  availableSpaces: { id: string; label: string; commune: string; lat: number; lon: number; widthM: string; heightM: string }[];
  interventions: { id: string; reference: string; lat: number; lon: number; finding: string; observedAt: string }[];
  citizenReports: { id: string; kind: string; lat: number; lon: number; commune: string | null; status: string }[];
  aiProposals: { id: string; kind: string; lat: number; lon: number }[];
  notice: string;
}
interface PilotStep { id: string; rank: number; label: string; status: string; measure: string | null; notes: { note: string; at: string }[] }
interface Proposal { id: string; photoId: string; kind: string; explanation: string; status: string; candidates: { reference: string; distanceM: number }[] }

const LAYER_COLORS = { supports: '#232C6B', spaces: '#1E8C3A', interventions: '#8a5cc2', reports: '#eb6834', ai: '#E0A526' };
const PILOT_TONE: Record<string, 'good' | 'warning' | 'neutral'> = { TERMINEE: 'good', EN_COURS: 'warning', A_FAIRE: 'neutral' };
const PILOT_LABEL: Record<string, string> = { TERMINEE: 'Terminée', EN_COURS: 'En cours', A_FAIRE: 'À faire' };

function useAction(reload: () => void) {
  const [err, setErr] = useState<string | null>(null);
  const run = async (path: string, body?: unknown) => {
    setErr(null);
    try { await api(path, { method: 'POST', body: body ?? {} }); reload(); return true; } catch (e) { setErr(describeError(e).message); return false; }
  };
  return { err, run };
}
const ask = (label: string) => { const m = window.prompt(label); return m && m.trim().length >= 5 ? m.trim() : null; };

export default function AdCarte() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const authority = roles.some((r) => r === 'R06' || r === 'R07');
  const field = roles.some((r) => r === 'R09' || r === 'R11');
  const layers = useApi(() => api<Layers>('/v1/publicite/carte/couches'), [user?.id]);
  const pilot = useApi(() => api<{ steps: PilotStep[] }>('/v1/publicite/pilote'), [user?.id]);
  const proposals = useApi(() => api<{ items: Proposal[] }>('/v1/publicite/ia/propositions'), [user?.id]);
  const reload = () => { layers.reload(); pilot.reload(); proposals.reload(); };
  const { err, run } = useAction(reload);
  const [show, setShow] = useState({ supports: true, spaces: true, interventions: false, reports: true, ai: true, zones: true });
  const [z, setZ] = useState({ kind: 'SATUREE', label: '', commune: 'Gombe', lat: '-4.31', lon: '15.30', radiusM: '300' });
  const [photoId, setPhotoId] = useState('');
  const declareZone = (e: FormEvent) => {
    e.preventDefault();
    const motif = ask('Motif de la décision (obligatoire)');
    if (motif) void run('/v1/publicite/zones', { kind: z.kind, label: z.label, commune: z.commune, lat: Number(z.lat), lon: Number(z.lon), radiusM: Number(z.radiusM), motif });
  };
  const L = layers.data;
  const zones = L ? [...L.saturatedZones, ...L.zonesToControl.designated] : [];
  return (
    <div className="page page-wide">
      <PageHead eyebrow="MOSOLO Advertising · KIN PUB CONTROL" title="Carte et pilote de la publicité"
        lead="Supports autorisés, zones saturées, zones à contrôler, espaces disponibles, interventions et signalements — puis le suivi du pilote en sept étapes." />
      <ExampleNotice text="Positions, zones et espaces de démonstration [EXEMPLE], non contractuels." />
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {layers.loading && <Loading />}
      {!!layers.error && <ErrorState error={layers.error} onRetry={layers.reload} />}
      {L && <CarteVisuels L={L} steps={pilot.data?.steps} />}
      {L && (
        <div className="stack">
          <div className="row-wrap" role="group" aria-label="Couches de la carte">
            {([['supports', 'Supports'], ['zones', 'Zones'], ['spaces', 'Espaces disponibles'], ['interventions', 'Interventions réalisées'], ['reports', 'Signalements'], ['ai', 'Propositions d’analyse d’image']] as const).map(([k, label]) => (
              <label key={k} className="small"><input type="checkbox" checked={show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} /> {label}</label>
            ))}
          </div>
          <GeoMapLazy center={[15.31, -4.33]} zoom={11} height={380} ariaLabel="Carte des couches de la publicité"
            polygons={show.zones ? zones.map((zz) => ({ id: zz.id, rings: [circleRing(zz.lon, zz.lat, zz.radiusM, 24)], color: zz.kind === 'SATUREE' ? '#e34948' : '#E0A526', fillOpacity: 0.12, label: zz.label })) : []}
            markers={[
              ...(show.supports ? L.supports.map((s) => ({ id: s.id, lon: s.lon, lat: s.lat, color: s.openCase ? '#e34948' : LAYER_COLORS.supports, label: '' })) : []),
              ...(show.spaces ? L.availableSpaces.map((s) => ({ id: s.id, lon: s.lon, lat: s.lat, color: LAYER_COLORS.spaces, label: '' })) : []),
              ...(show.interventions ? L.interventions.map((i) => ({ id: i.id, lon: i.lon, lat: i.lat, color: LAYER_COLORS.interventions, label: '' })) : []),
              ...(show.reports ? L.citizenReports.map((r) => ({ id: r.id, lon: r.lon, lat: r.lat, color: LAYER_COLORS.reports, label: '' })) : []),
              ...(show.ai ? L.aiProposals.map((p) => ({ id: p.id, lon: p.lon, lat: p.lat, color: LAYER_COLORS.ai, label: '' })) : []),
            ]}
            caption="Bleu : supports (rouge : dossier ouvert). Vert : espaces disponibles. Violet : interventions. Orange : signalements. Jaune : propositions d’analyse d’image. Cercles : zones saturées (rouge) et à contrôler (ambre)." />
          <p className="small muted">{L.notice}</p>
          <section className="panel">
            <h2 className="panel-title"><Icon name="analysis" size={18} /> Zones à contrôler (faits cumulés)</h2>
            {!L.zonesToControl.computed.length ? <EmptyState title="Aucun fait à contrôler" icon="check" /> : (
              <ul className="list-rows">{L.zonesToControl.computed.map((c) => (
                <li key={c.commune} className="list-row"><div className="min0"><p className="row-title">{c.commune}</p><p className="small muted">{c.undeclared} non déclaré(s) · {c.expired} expiré(s) · {c.openCases} dossier(s) ouvert(s) · {c.citizenReports} signalement(s) · {c.aiConfirmed} proposition(s) confirmée(s)</p></div><strong>{c.total}</strong></li>
              ))}</ul>
            )}
            <p className="small muted">Densité par commune (information) : {L.density.map((d) => `${d.commune} ${d.activeSupports}`).join(' · ')}</p>
          </section>
          {authority && (
            <form className="panel stack-sm" onSubmit={declareZone}>
              <h2 className="panel-title"><Icon name="pin" size={18} /> Décider une zone</h2>
              <div className="row-wrap">
                <select value={z.kind} onChange={(e) => setZ({ ...z, kind: e.target.value })} aria-label="Nature de la zone"><option value="SATUREE">Zone saturée</option><option value="A_CONTROLER">Zone à contrôler</option></select>
                <input value={z.label} onChange={(e) => setZ({ ...z, label: e.target.value })} placeholder="Libellé" aria-label="Libellé de la zone" />
                <select value={z.commune} onChange={(e) => setZ({ ...z, commune: e.target.value })} aria-label="Commune">{COMMUNES.map((c) => <option key={c}>{c}</option>)}</select>
                <input value={z.lat} onChange={(e) => setZ({ ...z, lat: e.target.value })} aria-label="Latitude" />
                <input value={z.lon} onChange={(e) => setZ({ ...z, lon: e.target.value })} aria-label="Longitude" />
                <input value={z.radiusM} onChange={(e) => setZ({ ...z, radiusM: e.target.value })} aria-label="Rayon (m)" />
              </div>
              <button type="submit" className="btn btn-secondary btn-sm" disabled={z.label.trim().length < 3}>Enregistrer la décision</button>
            </form>
          )}
        </div>
      )}
      {pilot.data && (
        <section className="panel">
          <h2 className="panel-title"><Icon name="gauge" size={18} /> Pilote en sept étapes (§ 11B.5)</h2>
          <ol className="list-rows">{pilot.data.steps.map((s) => (
            <li key={s.id} className="list-row">
              <div className="min0"><p className="row-title">{s.rank}. {s.label}</p>{s.measure && <p className="small muted">{s.measure}</p>}{s.notes.length > 0 && <p className="small">{s.notes[s.notes.length - 1]!.note}</p>}</div>
              <div className="row-side">
                <StatusBadge tone={PILOT_TONE[s.status] ?? 'neutral'} label={PILOT_LABEL[s.status] ?? s.status} />
                {authority && s.status !== 'TERMINEE' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const n = ask('Note d’avancement'); if (n) void run(`/v1/publicite/pilote/${s.rank}`, { status: s.status === 'A_FAIRE' ? 'EN_COURS' : 'TERMINEE', note: n }); }}>{s.status === 'A_FAIRE' ? 'Démarrer' : 'Terminer'}</button>}
              </div>
            </li>
          ))}</ol>
        </section>
      )}
      {(field || authority) && (
        <section className="panel stack-sm">
          <h2 className="panel-title"><Icon name="camera" size={18} /> Analyse d’image — propositions à vérifier</h2>
          {roles.some((r) => r === 'R09' || r === 'R11') && (
            <form className="row-wrap" onSubmit={(e) => { e.preventDefault(); void run(`/v1/publicite/ia/analyses/${encodeURIComponent(photoId)}`); }}>
              <input value={photoId} onChange={(e) => setPhotoId(e.target.value)} placeholder="Identifiant de la photo versée" aria-label="Photo" />
              <button type="submit" className="btn btn-secondary btn-sm" disabled={!photoId}>Demander une proposition</button>
            </form>
          )}
          {!(proposals.data?.items ?? []).length ? <EmptyState title="Aucune proposition" /> : (
            <ul className="list-rows">{proposals.data!.items.map((p) => (
              <li key={p.id} className="list-row">
                <div className="min0"><p className="row-title">{p.kind === 'SUPPORT_NON_ENREGISTRE_PROBABLE' ? 'Support non enregistré probable' : p.kind === 'SUPPORT_ENREGISTRE_PROCHE' ? 'Support enregistré proche' : 'Position insuffisante'}</p><p className="small">{p.explanation}</p></div>
                <div className="row-side">
                  <StatusBadge tone={p.status === 'A_VERIFIER' ? 'warning' : p.status === 'CONFIRMEE' ? 'good' : 'neutral'} label={p.status === 'A_VERIFIER' ? 'À vérifier' : p.status === 'CONFIRMEE' ? 'Confirmée par une personne' : 'Rejetée'} />
                  {p.status === 'A_VERIFIER' && <>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const m = ask('Motif (constat sur place)'); if (m) void run(`/v1/publicite/ia/propositions/${p.id}/verification`, { confirm: true, motif: m }); }}>Confirmer</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const m = ask('Motif du rejet'); if (m) void run(`/v1/publicite/ia/propositions/${p.id}/verification`, { confirm: false, motif: m }); }}>Rejeter</button>
                  </>}
                </div>
              </li>
            ))}</ul>
          )}
          <p className="hint">L’analyse propose ; une personne vérifie. Une proposition confirmée signale une zone à contrôler : elle ne crée ni dossier ni sanction.</p>
        </section>
      )}
      {(field || authority) && <CitizenReports />}
    </div>
  );
}

function CitizenReports() {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<{ items: { id: string; kind: string; description: string; commune: string | null; status: string; receivedAt: string; integrityReference?: string }[] }>('/v1/publicite/signalements'), [user?.id]);
  const { err, run } = useAction(q.reload);
  if (q.loading || q.error) return null;
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="panel-title"><Icon name="megaphone" size={18} /> Signalements citoyens</h2><span className="count">{q.data?.items.length ?? 0}</span></div>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {!q.data?.items.length ? <EmptyState title="Aucun signalement" icon="check" /> : (
        <ul className="list-rows">{q.data.items.map((r) => (
          <li key={r.id} className="list-row">
            <div className="min0"><p className="row-title">{r.kind.toLowerCase().replace(/_/g, ' ')} · {r.commune ?? 'commune non précisée'}</p><p className="small">{r.description}</p><p className="small muted">{r.id} · {fmtDate(r.receivedAt, true)}{r.integrityReference ? ` · ligne d’intégrité ${r.integrityReference}` : ''}</p></div>
            <div className="row-side">
              <StatusBadge tone={r.status === 'RECU' ? 'warning' : 'neutral'} label={r.status.toLowerCase().replace(/_/g, ' ')} />
              {(r.status === 'RECU' || r.status === 'A_INSPECTER') && ['A_INSPECTER', 'CLASSE', 'DOUBLON'].filter((o) => o !== r.status).map((o) => (
                <button key={o} type="button" className="btn btn-ghost btn-sm" onClick={() => { const m = ask('Motif'); if (m) void run(`/v1/publicite/signalements/${r.id}/tri`, { outcome: o, motif: m }); }}>{o === 'A_INSPECTER' ? 'À inspecter' : o === 'CLASSE' ? 'Classer' : 'Doublon'}</button>
              ))}
            </div>
          </li>
        ))}</ul>
      )}
    </section>
  );
}
