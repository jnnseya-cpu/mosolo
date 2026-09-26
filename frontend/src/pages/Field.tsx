import { useState, type ChangeEvent } from 'react';
import type { MapStatusColor } from '@mosolo/shared';
import { useApp } from '../context';
import { useAutosave } from '../hooks/useAutosave';
import { useOnline } from '../hooks/useOnline';
import { PageHead } from '../components/Shell';
import { MapStatusChip } from '../components/MapStatusChip';
import { AutosaveBar } from '../components/VersionHistory';
import { StatusBadge, type Tone } from '../components/StatusBadge';
import { EmptyState } from '../components/States';
import { Icon } from '../components/Icon';
import { api, describeError, safeGet, safeSet } from '../lib/api';
import { hmacSha256Hex, sha256Hex, uid } from '../lib/crypto';
import type { UIKey } from '../lib/i18n';
import type { FieldSyncResult } from '../lib/types';

/** Missions de démonstration (données locales ; les deux premiers objets existent dans le jeu de démo du backend). */
const MISSIONS: { id: string; title: string; due: string; objects: { id: string; label: string; address: string; status: MapStatusColor }[] }[] = [
  {
    id: 'MIS-LIM-014', title: 'Recensement — Limete / Kingabwa, îlot 14', due: '2027-02-12',
    objects: [
      { id: 'OBJ-DEMO-PARCELLE-01', label: 'Parcelle 600 m² — 1 bâtiment', address: 'Av. de l’Ouganda 27, Kingabwa', status: 'amber' },
      { id: 'OBJ-DEMO-UNITE-01', label: 'Unité locative — rez-de-chaussée', address: 'Av. de l’Ouganda 27, Kingabwa', status: 'blue' },
      { id: 'OBJ-LIM-0142', label: 'Local commercial (déclaré)', address: 'Bd Lumumba 1180, Kingabwa', status: 'grey' },
    ],
  },
  {
    id: 'MIS-LEM-003', title: 'Contrôle ciblé — Lemba / Righini', due: '2027-02-15',
    objects: [
      { id: 'OBJ-LEM-0031', label: 'Immeuble 3 niveaux — 6 unités', address: 'Av. Kimwenza 8, Righini', status: 'red' },
      { id: 'OBJ-LEM-0032', label: 'Parcelle résidentielle', address: 'Av. Kimwenza 10, Righini', status: 'green' },
    ],
  },
];

const OCCUPANCY = ['owner_occupied', 'rented', 'mixed', 'vacant', 'under_construction', 'commercial', 'unknown'] as const;

interface Capture {
  lat: string; lon: string; accuracy: string; gpsAt: string;
  photoHash: string; photoName: string; photoSize: number;
  observations: string; occupancy: string;
}
const EMPTY: Capture = { lat: '', lon: '', accuracy: '', gpsAt: '', photoHash: '', photoName: '', photoSize: 0, observations: '', occupancy: '' };

interface Queued { id: string; objectId: string; observedAt: string; data: Capture; state: 'pending' | 'synced' | 'rejected' | 'conflict'; note?: string }
const QUEUE_KEY = 'mosolo.fieldQueue';
const readQueue = (): Queued[] => { try { return JSON.parse(safeGet(QUEUE_KEY) ?? '[]') as Queued[]; } catch { return []; } };
const STATE_TONE: Record<Queued['state'], Tone> = { pending: 'warning', synced: 'good', rejected: 'critical', conflict: 'serious' };

function CaptureForm({ objectId, onSaved }: { objectId: string; onSaved: () => void }) {
  const { tr } = useApp();
  const draft = useAutosave<Capture>(`field-capture-${objectId}`, EMPTY);
  const v = draft.value;
  const [gpsBusy, setGpsBusy] = useState(false);
  const [gpsErr, setGpsErr] = useState<string | null>(null);
  const [hashing, setHashing] = useState(false);

  function locate() {
    if (!navigator.geolocation) { setGpsErr(tr('field.gpsUnsupported')); return; }
    setGpsBusy(true); setGpsErr(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        draft.setValue((d) => ({ ...d, lat: p.coords.latitude.toFixed(6), lon: p.coords.longitude.toFixed(6), accuracy: String(Math.round(p.coords.accuracy)), gpsAt: new Date(p.timestamp).toISOString() }));
        setGpsBusy(false);
      },
      (e) => { setGpsErr(e.code === 1 ? tr('field.gpsDenied') : tr('field.gpsFailed')); setGpsBusy(false); },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  }
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
    q.unshift({ id: uid('CST'), objectId, observedAt: new Date().toISOString(), data: v, state: 'pending' });
    safeSet(QUEUE_KEY, JSON.stringify(q));
    draft.reset();
    onSaved();
  }
  const acc = Number(v.accuracy);
  const canSave = !!(v.occupancy || v.observations || v.lat || v.photoHash);
  return (
    <div className="form">
      <div className="field">
        <span className="label">{tr('field.gps')}</span>
        <div className="row-actions">
          <button type="button" className="btn btn-secondary" onClick={locate} disabled={gpsBusy}><Icon name="gps" size={18} /> {gpsBusy ? tr('field.locating') : tr('field.locate')}</button>
          {v.lat && <span className="mono small">{v.lat}, {v.lon}</span>}
        </div>
        {v.accuracy && (
          <p className="small">
            {tr('field.accuracy', { m: v.accuracy })}{' '}
            {acc > 30 ? <StatusBadge tone="warning" label={tr('field.accuracyLow')} /> : <StatusBadge tone="good" label={tr('field.accuracyOk')} />}
          </p>
        )}
        {gpsErr && <p className="err">{gpsErr}</p>}
      </div>
      <div className="field">
        <label className="label" htmlFor="f-photo">{tr('field.photo')}</label>
        <input id="f-photo" type="file" accept="image/*" capture="environment" onChange={(e) => void onPhoto(e)} />
        <span className="hint">{tr('field.photoHint')}</span>
        {hashing && <p className="small muted">{tr('field.hashing')}</p>}
        {v.photoHash && <p className="small"><Icon name="lock" size={14} /> SHA-256 <span className="mono hash">{v.photoHash}</span> · {v.photoName} · {Math.round(v.photoSize / 1024)} Ko</p>}
      </div>
      <div className="field">
        <label className="label" htmlFor="f-occ">{tr('field.occupancy')}</label>
        <select id="f-occ" value={v.occupancy} onChange={(e) => draft.setValue((d) => ({ ...d, occupancy: e.target.value }))}>
          <option value="">{tr('field.choose')}</option>
          {OCCUPANCY.map((o) => <option key={o} value={o}>{tr(`occupancy.${o}` as UIKey)}</option>)}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="f-obs">{tr('field.observations')}</label>
        <textarea id="f-obs" rows={4} value={v.observations} onChange={(e) => draft.setValue((d) => ({ ...d, observations: e.target.value }))} />
        <span className="hint">{tr('field.obsHint')}</span>
      </div>
      <AutosaveBar draft={draft} />
      <button type="button" className="btn btn-primary btn-block" disabled={!canSave} onClick={saveCapture}><Icon name="download" size={18} /> {tr('field.saveCapture')}</button>
    </div>
  );
}

export default function Field() {
  const { tr, fmtDate, user } = useApp();
  const online = useOnline();
  const [objectId, setObjectId] = useState<string | null>(null);
  const [queue, setQueue] = useState<Queued[]>(readQueue);
  const [device, setDevice] = useState(() => ({ id: safeGet('mosolo.deviceId') ?? 'dev-terrain-001', key: safeGet('mosolo.deviceKey') ?? 'demo-device-key-001' }));
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = queue.filter((q) => q.state === 'pending');
  const obj = MISSIONS.flatMap((m) => m.objects).find((o) => o.id === objectId);

  const saveDevice = (d: typeof device) => { setDevice(d); safeSet('mosolo.deviceId', d.id); safeSet('mosolo.deviceKey', d.key); };

  async function sync() {
    setBusy(true); setSyncMsg(null);
    const createdAt = new Date().toISOString();
    const operations = pending.flatMap((c) => {
      const d = c.data; const ops: { opId: string; objectId: string; field: string; value: string | number; observedAt: string }[] = [];
      const push = (field: string, value: string | number) => { if (value !== '' && value !== 0) ops.push({ opId: `${c.id}:${field}`, objectId: c.objectId, field, value, observedAt: c.observedAt }); };
      push('occupancy', d.occupancy); push('observations', d.observations);
      if (d.lat) { push('gps.lat', Number(d.lat)); push('gps.lon', Number(d.lon)); push('gps.accuracy_m', Number(d.accuracy)); }
      push('photo.sha256', d.photoHash);
      return ops;
    });
    const batch = { batchId: uid('LOT'), deviceId: device.id, createdAt, operations };
    try {
      const signature = await hmacSha256Hex(device.key, JSON.stringify(batch));
      const r = await api<FieldSyncResult>('/v1/field-sync/batches', { method: 'POST', body: batch, headers: { 'x-device-signature': signature } });
      const accepted = new Set(r.accepted ?? []);
      const rejected = new Map((r.rejected ?? []).map((x) => [x.opId.split(':')[0], x.reason]));
      const conflicted = new Set((r.conflicts ?? []).map((c) => c.objectId));
      const next = queue.map((c): Queued => {
        if (c.state !== 'pending') return c;
        if (rejected.has(c.id)) return { ...c, state: 'rejected', note: rejected.get(c.id) };
        if (conflicted.has(c.objectId)) return { ...c, state: 'conflict', note: tr('field.conflictNote') };
        const anyAccepted = [...accepted].some((a) => a.startsWith(`${c.id}:`)) || accepted.size === 0;
        return anyAccepted ? { ...c, state: 'synced' } : c;
      });
      setQueue(next); safeSet(QUEUE_KEY, JSON.stringify(next));
      setSyncMsg({ ok: true, text: tr('field.synced', { a: accepted.size, r: r.rejected?.length ?? 0, c: r.conflicts?.length ?? 0 }) });
    } catch (e) {
      const d = describeError(e);
      setSyncMsg({ ok: false, text: d.network ? tr('field.syncOffline') : d.message + (d.code ? ` (${d.code})` : '') });
    } finally { setBusy(false); }
  }

  return (
    <div className="page">
      <PageHead eyebrow={tr('field.eyebrow')} title={tr('nav.field')} lead={tr('field.lead')} />
      <div className="callout callout-danger callout-strong" role="note">
        <Icon name="cash" size={20} />
        <p><strong>{tr('field.noCash')}</strong></p>
      </div>
      {user && !user.roles.includes('R10') && <p className="small muted">{tr('field.roleHint')}</p>}

      <div className="field-layout">
        <section className="section" aria-labelledby="mis-title">
          <div className="section-head"><h2 id="mis-title">{tr('field.missions')}</h2><span className="tag">{tr('common.exampleShort')}</span></div>
          {MISSIONS.map((m) => (
            <div key={m.id} className="mission">
              <p className="row-title">{m.title}</p>
              <p className="small muted"><span className="mono">{m.id}</span> · {tr('field.due', { date: fmtDate(m.due) })}</p>
              <ul className="list-rows">
                {m.objects.map((o) => (
                  <li key={o.id}>
                    <button type="button" className={`list-row list-button ${objectId === o.id ? 'selected' : ''}`} aria-pressed={objectId === o.id} onClick={() => setObjectId(o.id)}>
                      <div className="min0">
                        <p className="row-title">{o.label}</p>
                        <p className="small muted">{o.address} · <span className="mono">{o.id}</span></p>
                      </div>
                      <MapStatusChip status={o.status} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>

        <section className="section panel" aria-labelledby="cap-title">
          <div className="section-head"><h2 id="cap-title">{tr('field.capture')}</h2></div>
          {obj ? (
            <>
              <p className="small"><strong>{obj.label}</strong> · <span className="mono">{obj.id}</span></p>
              <CaptureForm key={obj.id} objectId={obj.id} onSaved={() => setQueue(readQueue())} />
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
                  <p className="row-title mono">{c.objectId}</p>
                  <p className="small muted">{fmtDate(c.observedAt, true)} · {c.data.occupancy ? tr(`occupancy.${c.data.occupancy}` as UIKey) : '—'}{c.data.photoHash ? ' · photo' : ''}{c.data.lat ? ' · GPS' : ''}</p>
                  {c.note && <p className="small">{c.note}</p>}
                </div>
                <StatusBadge tone={STATE_TONE[c.state]} label={tr(`field.state.${c.state}` as UIKey)} />
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
        </details>
      </section>
    </div>
  );
}
