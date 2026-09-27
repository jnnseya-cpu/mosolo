/**
 * Espace de l'agent de terrain : missions RÉELLES affectées par la supervision (/v1/terrain/me), capture
 * hors ligne (GPS, précision, empreinte SHA-256 de la photo — jamais le fichier —, observations), file locale,
 * synchronisation des constats scellés (idempotente) et, pour les attributs observés, lot signé par le terminal.
 * L'agent n'encaisse jamais d'argent ; un constat ne crée jamais de dette.
 */
import { useState, type ChangeEvent } from 'react';
import { useApp } from '../context';
import { useAutosave } from '../hooks/useAutosave';
import { useOnline } from '../hooks/useOnline';
import { useApi } from '../hooks/useApi';
import { PageHead } from '../components/Shell';
import { AutosaveBar } from '../components/VersionHistory';
import { StatusBadge, type Tone } from '../components/StatusBadge';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../components/States';
import { Icon } from '../components/Icon';
import { GpsQualityLine, MapCheck } from '../components/GpsQuality';
import { usePreciseGps, type PreciseFix } from '../lib/geo';
import { api, describeError, safeGet, safeSet } from '../lib/api';
import { hmacSha256Hex, sha256Hex, uid } from '../lib/crypto';
import type { UIKey } from '../lib/i18n';
import type { FieldSyncResult } from '../lib/types';
import { BadgeCard, Progress } from '../modules/terrain/common';
import { FLAG_LABEL, MISSION_STATUS, moduleLabel, OUTCOME_LABEL } from '../modules/terrain/labels';
import type { CounterVisit, Finding, FindingOutcome, MeResponse, Mission } from '../modules/terrain/types';
import '../modules/terrain/terrain.css';

const OCCUPANCY = ['owner_occupied', 'rented', 'mixed', 'vacant', 'under_construction', 'commercial', 'unknown'] as const;
const NEW_OBJECT = '__nouvel_objet__';

interface Capture {
  outcome: FindingOutcome | '';
  lat: string; lon: string; accuracy: string; gpsAt: string;
  photoHash: string; photoName: string; photoSize: number;
  observations: string; occupancy: string; justification: string;
}
const EMPTY: Capture = { outcome: '', lat: '', lon: '', accuracy: '', gpsAt: '', photoHash: '', photoName: '', photoSize: 0, observations: '', occupancy: '', justification: '' };

type QState = 'pending' | 'synced' | 'flagged' | 'rejected' | 'conflict';
interface Queued { id: string; missionId?: string; objectId: string | null; observedAt: string; data: Capture; state: QState; note?: string }
const QUEUE_KEY = 'mosolo.fieldQueue.v2';
const readQueue = (): Queued[] => { try { return JSON.parse(safeGet(QUEUE_KEY) ?? '[]') as Queued[]; } catch { return []; } };
const STATE: Record<QState, { tone: Tone; label: string }> = {
  pending: { tone: 'warning', label: 'En attente' }, synced: { tone: 'good', label: 'Transmis' }, flagged: { tone: 'serious', label: 'Transmis — à vérifier' },
  rejected: { tone: 'critical', label: 'Refusé' }, conflict: { tone: 'serious', label: 'Conflit' },
};

/** Position PRÉCISE : moyenne des meilleurs relevés jusqu'à la cible de 10 m (ou 30 s), qualité affichée. */
function useGps() {
  const { tr } = useApp();
  const g = usePreciseGps({ targetM: 10 });
  const err = g.status === 'denied' ? tr('field.gpsDenied') : g.status === 'unavailable' ? (typeof navigator !== 'undefined' && !navigator.geolocation ? tr('field.gpsUnsupported') : tr('field.gpsFailed')) : null;
  const toP = (f: PreciseFix) => ({ lat: f.lat.toFixed(6), lon: f.lon.toFixed(6), accuracy: String(f.accuracy !== null ? Math.max(1, Math.round(f.accuracy)) : 25), at: f.at, source: f.source });
  function locate(cb: (p: ReturnType<typeof toP>) => void) { g.locate((f) => cb(toP(f))); }
  function pick(lat: number, lon: number, cb: (p: ReturnType<typeof toP>) => void) { g.pick(lat, lon, (f) => cb(toP(f))); }
  return { busy: g.busy, err, locate, pick, fix: g.fix, status: g.status, targetM: g.targetM };
}

function CaptureForm({ mission, objectId, onSaved }: { mission: Mission; objectId: string | null; onSaved: () => void }) {
  const { tr } = useApp();
  const draft = useAutosave<Capture>(`field-capture-${mission.id}-${objectId ?? 'nouveau'}`, { ...EMPTY, outcome: objectId ? 'CONSTATE' : 'OBJET_NON_ENREGISTRE' });
  const v = draft.value;
  const gps = useGps();
  const [hashing, setHashing] = useState(false);

  async function onPhoto(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setHashing(true);
    try {
      const h = await sha256Hex(await f.arrayBuffer());
      draft.setValue((d) => ({ ...d, photoHash: h, photoName: f.name, photoSize: f.size }));
    } finally { setHashing(false); }
  }
  function saveCapture() {
    const q = readQueue();
    q.unshift({ id: uid('CST'), missionId: mission.id, objectId, observedAt: v.gpsAt || new Date().toISOString(), data: v, state: 'pending' });
    safeSet(QUEUE_KEY, JSON.stringify(q));
    draft.reset();
    onSaved();
  }
  const acc = Number(v.accuracy);
  const canSave = !!v.outcome && !!v.lat;
  return (
    <div className="form">
      <div className="field">
        <label className="label" htmlFor="f-out">Résultat de la visite</label>
        <select id="f-out" value={v.outcome} onChange={(e) => draft.setValue((d) => ({ ...d, outcome: e.target.value as FindingOutcome }))}>
          {(objectId ? ['CONSTATE', 'ABSENT', 'REFUS'] : ['OBJET_NON_ENREGISTRE']).map((o) => <option key={o} value={o}>{OUTCOME_LABEL[o as FindingOutcome]}</option>)}
        </select>
      </div>
      <div className="field">
        <span className="label">{tr('field.gps')}</span>
        <div className="row-actions">
          <button type="button" className="btn btn-secondary" onClick={() => gps.locate((p) => draft.setValue((d) => ({ ...d, lat: p.lat, lon: p.lon, accuracy: p.accuracy, gpsAt: p.at })))} disabled={gps.busy}>
            <Icon name="gps" size={18} /> {gps.busy ? tr('field.locating') : tr('field.locate')}
          </button>
          {v.lat && <span className="mono small">{v.lat}, {v.lon}</span>}
        </div>
        {v.accuracy && (
          <p className="small">
            {tr('field.accuracy', { m: v.accuracy })}{' '}
            {acc > mission.toleranceM ? <StatusBadge tone="warning" label={`Au-delà de la tolérance de ${mission.toleranceM} m`} /> : <StatusBadge tone="good" label={tr('field.accuracyOk')} />}
          </p>
        )}
        <GpsQualityLine fix={gps.fix} status={gps.status} targetM={gps.targetM} />
        <MapCheck lat={v.lat ? Number(v.lat) : null} lon={v.lon ? Number(v.lon) : null} accuracy={v.accuracy ? Number(v.accuracy) : null}
          onPick={(y, x) => gps.pick(y, x, (p) => draft.setValue((d) => ({ ...d, lat: p.lat, lon: p.lon, accuracy: p.accuracy, gpsAt: p.at })))} />
        {gps.err && <p className="err">{gps.err}</p>}
        <span className="hint">Position obligatoire. Un écart au point enregistré est signalé pour vérification, jamais rejeté automatiquement.</span>
      </div>
      <div className="field">
        <label className="label" htmlFor="f-photo">{tr('field.photo')}</label>
        <input id="f-photo" type="file" accept="image/*" capture="environment" onChange={(e) => void onPhoto(e)} />
        <span className="hint">Seule l’empreinte SHA-256 est transmise et scellée avec le constat ; le fichier reste sur le terminal.</span>
        {hashing && <p className="small muted">{tr('field.hashing')}</p>}
        {v.photoHash && <p className="small"><Icon name="lock" size={14} /> SHA-256 <span className="mono hash">{v.photoHash}</span> · {v.photoName} · {Math.round(v.photoSize / 1024)} Ko</p>}
      </div>
      {objectId && (
        <div className="field">
          <label className="label" htmlFor="f-occ">{tr('field.occupancy')}</label>
          <select id="f-occ" value={v.occupancy} onChange={(e) => draft.setValue((d) => ({ ...d, occupancy: e.target.value }))}>
            <option value="">{tr('field.choose')}</option>
            {OCCUPANCY.map((o) => <option key={o} value={o}>{tr(`occupancy.${o}` as UIKey)}</option>)}
          </select>
        </div>
      )}
      <div className="field">
        <label className="label" htmlFor="f-obs">{tr('field.observations')}</label>
        <textarea id="f-obs" rows={3} value={v.observations} onChange={(e) => draft.setValue((d) => ({ ...d, observations: e.target.value }))} />
        <span className="hint">{tr('field.obsHint')}</span>
      </div>
      <div className="field">
        <label className="label" htmlFor="f-just">Justification si vous êtes loin du point enregistré (facultatif)</label>
        <input id="f-just" value={v.justification} onChange={(e) => draft.setValue((d) => ({ ...d, justification: e.target.value }))} placeholder="Ex. accès par l’arrière de l’îlot" />
      </div>
      <AutosaveBar draft={draft} />
      <button type="button" className="btn btn-primary btn-block" disabled={!canSave} onClick={saveCapture}><Icon name="download" size={18} /> {tr('field.saveCapture')}</button>
    </div>
  );
}

function CounterVisitItem({ cv, onDone }: { cv: CounterVisit; onDone: () => void }) {
  const gps = useGps();
  const [pos, setPos] = useState<{ lat: string; lon: string; accuracy: string } | null>(null);
  const [notes, setNotes] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  async function send(result: 'CONFORME' | 'NON_CONFORME') {
    if (!pos) return;
    try {
      await api(`/v1/terrain/counter-visits/${cv.id}/result`, { method: 'POST', body: { result, notes: notes.trim(), gps: { lat: Number(pos.lat), lon: Number(pos.lon), accuracyM: Number(pos.accuracy) } } });
      onDone();
    } catch (e) { const d = describeError(e); setMsg(d.message); }
  }
  return (
    <li className="list-row list-row-stack">
      <p className="tr-row-title">Contre-visite <span className="mono">{cv.id}</span> · {cv.commune}</p>
      <p className="tr-sub">Point à revoir : {cv.target ? `${cv.target.lat.toFixed(5)}, ${cv.target.lon.toFixed(5)}` : '—'}{cv.objectId ? ` · objet ${cv.objectId}` : ''}. Constatez sans consulter le premier constat.</p>
      {cv.status === 'A_FAIRE' ? (
        <div className="tr-inline-form">
          <div className="row-actions">
            <button type="button" className="btn btn-sm btn-secondary" disabled={gps.busy} onClick={() => gps.locate((p) => setPos(p))}><Icon name="gps" size={16} /> Position</button>
            {pos && <span className="mono small">{pos.lat}, {pos.lon} (± {pos.accuracy} m)</span>}
          </div>
          <GpsQualityLine fix={gps.fix} status={gps.status} targetM={gps.targetM} />
          {gps.err && <p className="err">{gps.err}</p>}
          <label className="label" htmlFor={`cv-${cv.id}`}>Observations</label>
          <textarea id={`cv-${cv.id}`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          {msg && <p className="notice notice-err">{msg}</p>}
          <div className="row-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={!pos || notes.trim().length < 3} onClick={() => void send('CONFORME')}>Conforme</button>
            <button type="button" className="btn btn-sm btn-secondary" disabled={!pos || notes.trim().length < 3} onClick={() => void send('NON_CONFORME')}>Non conforme</button>
          </div>
        </div>
      ) : <StatusBadge tone="good" label="Réalisée" />}
    </li>
  );
}

export default function Field() {
  const { tr, fmtDate, user } = useApp();
  const online = useOnline();
  const me = useApi(() => (user?.roles.includes('R10') ? api<MeResponse>('/v1/terrain/me') : Promise.resolve(null)), [user?.id]);
  const [sel, setSel] = useState<{ missionId: string; objectId: string | null } | null>(null);
  const [queue, setQueue] = useState<Queued[]>(readQueue);
  const [device, setDevice] = useState(() => ({ id: safeGet('mosolo.deviceId') ?? 'dev-terrain-001', key: safeGet('mosolo.deviceKey') ?? 'demo-device-key-001' }));
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = queue.filter((q) => q.state === 'pending');
  const missions = me.data?.missions ?? [];
  const mission = missions.find((m) => m.id === sel?.missionId);
  const open = (m: Mission) => m.status === 'AFFECTEE' || m.status === 'EN_COURS';

  const saveDevice = (d: typeof device) => { setDevice(d); safeSet('mosolo.deviceId', d.id); safeSet('mosolo.deviceKey', d.key); };
  const persist = (next: Queued[]) => { setQueue(next); safeSet(QUEUE_KEY, JSON.stringify(next)); };

  async function sync() {
    setBusy(true); setSyncMsg(null);
    let next = [...queue];
    let sent = 0; let flagged = 0; let refused = 0;
    try {
      // 1. Constats scellés liés à la mission (idempotents : la référence locale sert de clé).
      for (const c of pending) {
        if (!c.missionId) continue;
        const d = c.data;
        try {
          const r = await api<{ finding: Finding; replayed: boolean }>(`/v1/terrain/missions/${c.missionId}/findings`, {
            method: 'POST',
            body: {
              clientRef: c.id, ...(c.objectId ? { objectId: c.objectId } : {}), outcome: d.outcome || 'CONSTATE', observations: d.observations,
              gps: { lat: Number(d.lat), lon: Number(d.lon), accuracyM: Number(d.accuracy || 0) }, ...(d.photoHash ? { photoSha256: d.photoHash } : {}),
              capturedAt: c.observedAt, ...(device.id ? { deviceId: device.id } : {}), ...(d.justification.trim() ? { justification: d.justification.trim() } : {}),
            },
          });
          const f = r.finding;
          const isFlag = f.flags.some((x) => x === 'DISTANCE' || x === 'HORS_ZONE');
          if (isFlag) flagged++; else sent++;
          next = next.map((q) => (q.id === c.id ? { ...q, state: isFlag ? 'flagged' : 'synced', note: f.flagMessage ?? (f.flags.length ? f.flags.map((x) => FLAG_LABEL[x] ?? x).join(', ') : undefined) } : q));
        } catch (e) {
          const de = describeError(e);
          if (de.network) throw e;
          refused++;
          next = next.map((q) => (q.id === c.id ? { ...q, state: 'rejected', note: de.message + (de.code ? ` (${de.code})` : '') } : q));
        }
      }
      persist(next);
      // 2. Attributs observés des objets existants : lot signé par le terminal (conflits conservés, jamais « dernier écrit gagne »).
      const operations = pending.filter((c) => c.objectId).flatMap((c) => {
        const ops: { opId: string; objectId: string; field: string; value: string; observedAt: string }[] = [];
        if (c.data.occupancy) ops.push({ opId: `${c.id}:occupancy`, objectId: c.objectId!, field: 'occupancy', value: c.data.occupancy, observedAt: c.observedAt });
        return ops;
      });
      if (operations.length > 0) {
        const batch = { batchId: uid('LOT'), deviceId: device.id, createdAt: new Date().toISOString(), operations };
        try {
          const signature = await hmacSha256Hex(device.key, JSON.stringify(batch));
          const r = await api<FieldSyncResult>('/v1/field-sync/batches', { method: 'POST', body: batch, headers: { 'x-device-signature': signature } });
          const conflicted = new Set((r.conflicts ?? []).map((x) => x.objectId));
          if (conflicted.size) persist(next.map((q) => (q.objectId && conflicted.has(q.objectId) && q.state !== 'rejected' ? { ...q, state: 'conflict', note: tr('field.conflictNote') } : q)));
        } catch (e) { const de = describeError(e); if (de.network) throw e; }
      }
      setSyncMsg({ ok: refused === 0, text: `${sent} constat(s) transmis, ${flagged} signalé(s) pour vérification, ${refused} refusé(s).` });
      me.reload();
    } catch (e) {
      const d = describeError(e);
      persist(next);
      setSyncMsg({ ok: false, text: d.network ? tr('field.syncOffline') : d.message + (d.code ? ` (${d.code})` : '') });
    } finally { setBusy(false); }
  }

  async function complete(m: Mission) {
    try { await api(`/v1/terrain/missions/${m.id}/complete`, { method: 'POST' }); me.reload(); } catch (e) { setSyncMsg({ ok: false, text: describeError(e).message }); }
  }

  const agent = me.data?.agent;
  return (
    <div className="page page-wide">
      <PageHead eyebrow={tr('field.eyebrow')} title={tr('nav.field')} lead="Missions affectées par votre superviseur, capture hors ligne, constats scellés et synchronisés. Chaque action est géolocalisée." />
      <div className="callout callout-danger callout-strong" role="note">
        <Icon name="cash" size={20} />
        <p><strong>{tr('field.noCash')}</strong> Le contribuable paie lui-même, par les canaux officiels ; aucune quittance n’est émise par l’agent.</p>
      </div>
      {user && !user.roles.includes('R10') && <p className="small muted">Cet écran est celui de l’agent de terrain : choisissez « Agent de terrain Limete (démo) » ou un agent de sous-traitant habilité.</p>}
      {me.loading && <Loading />}
      {me.error !== null && !me.loading && <ErrorState error={me.error} onRetry={me.reload} />}
      {agent && agent.status !== 'HABILITE' && (
        <div className="callout callout-warn" role="note"><Icon name="lock" size={20} /><p>Votre compte est <strong>{agent.status === 'INVITE' ? 'en attente d’habilitation par la régie' : agent.status.toLowerCase()}</strong> : aucune mission ni aucun constat n’est possible.</p></div>
      )}

      <div className="field-layout">
        <section className="section" aria-labelledby="mis-title">
          <div className="section-head"><h2 id="mis-title">{tr('field.missions')}</h2><span className="count">{missions.length}</span></div>
          {me.data && missions.length === 0 && <EmptyState title="Aucune mission affectée." icon="pin">Votre superviseur vous affecte des missions dans votre zone d’habilitation.</EmptyState>}
          {missions.map((m) => (
            <div key={m.id} className="mission">
              <div className="row-between" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <p className="row-title">{m.title}</p>
                <StatusBadge tone={MISSION_STATUS[m.status].tone} label={MISSION_STATUS[m.status].label} />
              </div>
              <p className="small muted"><span className="mono">{m.id}</span> · {m.commune}{m.quartier ? ` / ${m.quartier}` : ''} · {moduleLabel(m.module)} · {tr('field.due', { date: fmtDate(m.dueDate) })}{m.demo ? ' · démo' : ''}</p>
              {m.instructions && <p className="small" style={{ marginTop: 4 }}>{m.instructions}</p>}
              <div style={{ margin: '8px 0' }}><Progress pct={m.progress.objectivePct} label={`${m.progress.findings} / ${m.objectives.findings} constats · ${m.progress.validated} validés`} /></div>
              {open(m) && (
                <ul className="list-rows">
                  {m.objects.map((o) => (
                    <li key={o.id}>
                      <button type="button" className={`list-row list-button ${sel?.objectId === o.id && sel.missionId === m.id ? 'selected' : ''}`} aria-pressed={sel?.objectId === o.id && sel.missionId === m.id} onClick={() => setSel({ missionId: m.id, objectId: o.id })}>
                        <div className="min0">
                          <p className="row-title">{o.category ?? 'Objet'} · <span className="mono">{o.id}</span></p>
                          <p className="small muted">{o.quartier ?? m.quartier ?? m.commune}{o.lat !== undefined ? ` · point ${o.lat.toFixed(4)}, ${o.lon!.toFixed(4)}` : ''}</p>
                        </div>
                        {o.visited ? <StatusBadge tone="good" label="Visité" /> : <StatusBadge tone="neutral" label="À visiter" />}
                      </button>
                    </li>
                  ))}
                  <li>
                    <button type="button" className={`list-row list-button ${sel?.objectId === null && sel.missionId === m.id ? 'selected' : ''}`} aria-pressed={sel?.objectId === null && sel.missionId === m.id} onClick={() => setSel({ missionId: m.id, objectId: null })}>
                      <div className="min0"><p className="row-title">Objet non enregistré</p><p className="small muted">Constat « objet non enregistré » dans la zone (rayon {m.radiusM} m) — aucun effet fiscal avant qualification.</p></div>
                      <Icon name="pin" size={18} />
                    </button>
                  </li>
                </ul>
              )}
              {open(m) && m.progress.findings > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void complete(m)}><Icon name="check" size={16} /> Déclarer la mission terminée</button>}
            </div>
          ))}
        </section>

        <section className="section panel" aria-labelledby="cap-title">
          <div className="section-head"><h2 id="cap-title">{tr('field.capture')}</h2></div>
          {mission && sel ? (
            <>
              <p className="small"><strong>{sel.objectId ?? 'Objet non enregistré'}</strong> · mission <span className="mono">{mission.id}</span> · tolérance GPS {mission.toleranceM} m</p>
              <CaptureForm key={`${mission.id}-${sel.objectId ?? 'n'}`} mission={mission} objectId={sel.objectId} onSaved={() => setQueue(readQueue())} />
            </>
          ) : <EmptyState title={tr('field.pickObject')} icon="pin" />}
        </section>
      </div>

      <section className="section" aria-labelledby="q-title">
        <div className="section-head">
          <h2 id="q-title">{tr('field.queue')}</h2><span className="count">{pending.length}</span>
          <button type="button" className="btn btn-primary" disabled={busy || pending.length === 0} onClick={() => void sync()}>
            <Icon name="sync" size={18} /> {busy ? tr('field.syncing') : tr('field.sync')}
          </button>
        </div>
        {!online && <p className="small muted">{tr('field.offlineQueued')}</p>}
        {syncMsg && <p role={syncMsg.ok ? 'status' : 'alert'} className={syncMsg.ok ? 'notice notice-ok' : 'notice notice-err'}>{syncMsg.text}</p>}
        {queue.length === 0 ? <EmptyState title={tr('field.queueEmpty')} /> : (
          <ul className="list-rows">
            {queue.slice(0, 20).map((c) => (
              <li key={c.id} className="list-row">
                <div className="min0">
                  <p className="row-title"><span className="mono">{c.objectId ?? 'nouvel objet'}</span>{c.missionId ? <> · mission <span className="mono">{c.missionId}</span></> : null}</p>
                  <p className="small muted">{fmtDate(c.observedAt, true)} · {c.data.outcome ? OUTCOME_LABEL[c.data.outcome] : '—'}{c.data.photoHash ? ' · photo scellée' : ''}{c.data.lat ? ' · GPS' : ''}</p>
                  {c.note && <p className={c.state === 'flagged' ? 'tr-flag' : 'small'}>{c.state === 'flagged' && <Icon name="gps" size={16} />} {c.note}</p>}
                </div>
                <StatusBadge tone={STATE[c.state].tone} label={STATE[c.state].label} />
              </li>
            ))}
          </ul>
        )}
        <details className="device-box">
          <summary>{tr('field.device')}</summary>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="dev-id">{tr('field.deviceId')}</label><input id="dev-id" className="mono" value={device.id} onChange={(e) => saveDevice({ ...device, id: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="dev-key">{tr('field.deviceKey')}</label><input id="dev-key" className="mono" type="password" value={device.key} onChange={(e) => saveDevice({ ...device, key: e.target.value })} /></div>
          </div>
          <p className="small muted">{tr('field.deviceHint')}</p>
          {me.data && me.data.devices.length > 0 && <p className="small">Terminaux enrôlés : {me.data.devices.map((d) => `${d.id} (${d.status === 'ACTIF' ? 'actif' : 'révoqué'})`).join(', ')}</p>}
        </details>
      </section>

      {(me.data?.counterVisits.length ?? 0) > 0 && (
        <section className="section" aria-labelledby="cv-title">
          <div className="section-head"><h2 id="cv-title">Contre-visites de contrôle qualité</h2><span className="count">{me.data!.counterVisits.filter((c) => c.status === 'A_FAIRE').length}</span></div>
          <ul className="list-rows">{me.data!.counterVisits.map((c) => <CounterVisitItem key={c.id} cv={c} onDone={me.reload} />)}</ul>
        </section>
      )}

      {me.data?.badge && agent && (
        <section className="section" aria-labelledby="bd-title">
          <div className="section-head"><h2 id="bd-title">Mon badge</h2></div>
          <BadgeCard badge={me.data.badge} name={agent.displayName} structure={agent.structure} />
          <p className="small muted" style={{ marginTop: 8 }}>Présentez ce badge à chaque visite. Toute personne peut le vérifier sans compte ; aucun téléphone ni adresse n’est affiché.</p>
        </section>
      )}
      <ExampleNotice text="Missions et objets de démonstration : données fictives." />
    </div>
  );
}
