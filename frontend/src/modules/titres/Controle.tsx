/**
 * Écran du contrôleur (modules 71 et 81) : scan du QR (téléphone, gilet, autocollant, ticket), saisie de la plaque,
 * réponse minimale VALIDE / EXPIRÉ / INVALIDE (couleur + icône + texte + son), constat si négatif — jamais d'amende,
 * jamais d'encaissement. Mode hors ligne : paquet signé (clé publique, révocations, plaques), file locale, lot signé.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { readValidity } from '@mosolo/shared';
import { ValidityCountdown } from '../../components/ValidityCountdown';
import { api, describeError, safeGet, safeSet } from '../../lib/api';
import { hmacSha256Hex, uid } from '../../lib/crypto';
import { playSignal, type ControlView } from './common';
import './titres.css';
import { QrScanner } from '../../components/QrScanner';

type Mode = 'qr' | 'plate' | 'vest';
type Scope = '81' | 'tous';

interface Pack {
  serverTime: string;
  downloadedAt: string;
  publicKeyPem: string;
  revocations: { entries: { id: string; number: string; state: string }[]; generatedAt: string };
  plates: { plates: { plate: string; number: string; validFrom: string; validUntil: string; toleranceMinutes: number; amberMinutes: number }[] };
}
interface QueuedControl { opId: string; token?: string; plate?: string; controlledAt: string; place: { label?: string; lat?: number; lon?: number }; offlineResult: 'VALIDE' | 'INVALIDE' | 'EXPIRE'; note: string }
interface Constat { id: string; reason: string; at: string; status: string; place: { label?: string }; presented: string; duringGrace: boolean }
interface SyncResult { batchId: string; results: { opId: string; offlineResult: string; reconfirmed?: string; divergent?: boolean; rejected?: string; constatId?: string; alreadyUsed?: { at: string } }[]; divergences: number; replayed?: boolean }

const PACK_KEY = 'mosolo.titres.pack';
const QUEUE_KEY = 'mosolo.titres.queue';
const COMMUNES_FALLBACK = ['Kalamu', 'Lemba', 'Limete', 'Gombe'];

function readJson<T>(k: string, d: T): T {
  try { const v = safeGet(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
}
const norm = (p: string) => p.toUpperCase().replace(/[^0-9A-Z]/g, '');

function decodeStatic(token: string): Record<string, unknown> | null {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'MT1') return null;
  try {
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))))) as Record<string, unknown>;
  } catch { return null; }
}

async function verifyStaticOffline(token: string, pem: string): Promise<boolean | null> {
  try {
    const parts = token.trim().split('.');
    const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
    const sig = parts[2]!.replace(/-/g, '+').replace(/_/g, '/');
    const sigBytes = Uint8Array.from(atob(sig + '='.repeat((4 - (sig.length % 4)) % 4)), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sigBytes, new TextEncoder().encode(parts[1]!));
  } catch {
    return null; // Ed25519 non pris en charge par ce navigateur : reconfirmation au retour du réseau.
  }
}

function ResultCard({ r }: { r: ControlView }) {
  const { fmtDate } = useApp();
  const word = r.result === 'VALIDE' ? 'VALIDE' : r.result === 'EXPIRE' ? 'EXPIRÉ' : 'INVALIDE';
  return (
    <section className={`tt-result tt-${r.color}`} role="status" aria-live="assertive" aria-label={`Résultat du contrôle : ${word}`}>
      <div className="tt-result-head">
        <span className="tt-result-icon"><Icon name={r.icon} size={34} /></span>
        <div className="min0">
          <p className="tt-result-word">{word}</p>
          <p className="tt-result-text">{r.text.replace(/^(VALIDE|INVALIDE|EXPIRÉ)\s*—\s*/, '')}</p>
        </div>
      </div>
      {r.offline && <span className="tt-offline-flag"><Icon name="offline" size={13} /> Vérifié hors ligne — sera reconfirmé à la synchronisation</span>}
      {r.nothingToPay && (
        <p className="tt-pay"><Icon name="shieldCheck" size={20} /> Rien à payer. Aucune demande d’argent, aucune sanction : le contrôle est terminé.</p>
      )}
      {r.alreadyUsed && (
        <p className="tt-pay"><Icon name="history" size={20} /> Déjà utilisé le {fmtDate(r.alreadyUsed.at, true)}{r.alreadyUsed.place.label ? ` — ${r.alreadyUsed.place.label}` : ''}.</p>
      )}
      {(r.validFrom ?? r.validity?.from) && (r.validUntil ?? r.validity?.until) && r.result !== 'INVALIDE' && (
        <ValidityCountdown from={r.validFrom ?? r.validity?.from} until={r.validUntil ?? r.validity?.until} label="Validité du titre" />
      )}
      <dl className="kv kv-dense">
        {r.typeLabel && <div><dt>Titre</dt><dd>{r.typeLabel}{r.prefix ? ` · ${r.prefix}` : ''}</dd></div>}
        {r.plate && <div><dt>Plaque</dt><dd className="mono">{r.plate}</dd></div>}
        {r.zone && <div><dt>Lieu de rattachement</dt><dd>{r.zone}</dd></div>}
        {r.driverVerified !== undefined && r.driverVerified !== null && <div><dt>Conducteur</dt><dd>{r.driverVerified ? 'Enregistré et affecté à cette moto' : 'Non vérifié pour cette moto'}</dd></div>}
        <div><dt>Heure de référence</dt><dd>{fmtDate(r.serverTime, true)} (serveur)</dd></div>
      </dl>
      {r.constat && (
        <div className="callout callout-warn" style={{ margin: 0 }}>
          <Icon name="file" size={18} />
          <p><strong>Constat {r.constat.id} ouvert.</strong> {r.constat.notice} N’encaissez rien : l’usager paie uniquement par téléphone, USSD ou point agréé.</p>
        </div>
      )}
    </section>
  );
}

export default function Controle() {
  const { user, fmtDate } = useApp();
  const [mode, setMode] = useState<Mode>('qr');
  const [scope, setScope] = useState<Scope>('81');
  const [value, setValue] = useState('');
  const [scan, setScan] = useState(false);
  const communes = user?.territory?.length ? user.territory : COMMUNES_FALLBACK;
  const [commune, setCommune] = useState(communes[0] ?? 'Kalamu');
  const [placeLabel, setPlaceLabel] = useState('');
  const [gps, setGps] = useState<{ lat: number; lon: number } | null>(null);
  const [result, setResult] = useState<ControlView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine);
  const [pack, setPack] = useState<Pack | null>(() => readJson<Pack | null>(PACK_KEY, null));
  const [queue, setQueue] = useState<QueuedControl[]>(() => readJson<QueuedControl[]>(QUEUE_KEY, []));
  const [device, setDevice] = useState(() => ({ id: safeGet('mosolo.titres.deviceId') ?? 'dev-rakapay-01', key: safeGet('mosolo.titres.deviceKey') ?? 'demo-device-key-rakapay-01' }));
  const [sync, setSync] = useState<SyncResult | null>(null);
  const constats = useApi(() => api<Constat[]>(`/v1/titres/constats${scope === '81' ? '?module=81' : ''}`), [user?.id, scope, result?.controlId]);

  useEffect(() => { if (user?.territory?.length && !user.territory.includes(commune)) setCommune(user.territory[0]!); }, [user, commune]);
  useEffect(() => { safeSet(QUEUE_KEY, JSON.stringify(queue)); }, [queue]);
  useEffect(() => {
    const on = () => setOffline(false); const off = () => setOffline(true);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const place = useMemo(() => ({ commune, ...(placeLabel.trim() ? { label: placeLabel.trim() } : {}), ...(gps ?? {}) }), [commune, placeLabel, gps]);
  const isController = !!user?.roles.some((r) => ['R10', 'R11', 'R35'].includes(r));

  const locate = () => navigator.geolocation?.getCurrentPosition((p) => setGps({ lat: Number(p.coords.latitude.toFixed(5)), lon: Number(p.coords.longitude.toFixed(5)) }), () => setErr('Position indisponible : indiquez le lieu.'));

  async function controlOnline(v: string) {
    const payload = v.trim();
    const decoded = payload.startsWith('MT1.') ? decodeStatic(payload) : null;
    let body: Record<string, unknown>;
    let url = scope === '81' ? '/v1/rakapay/wewa/controles' : '/v1/titres/controles';
    if (mode === 'plate') body = { plate: payload, place };
    else if (mode === 'vest' || decoded?.k === 'GILET') { body = { vest: payload, place }; url = '/v1/rakapay/wewa/controles'; }
    else if (decoded?.k === 'AUTOCOLLANT') { body = { sticker: payload, place }; url = '/v1/rakapay/wewa/controles'; }
    else body = scope === '81' ? { qr: payload, place } : payload.startsWith('MD1.') || payload.startsWith('MT1.') ? { qr: payload, place } : { code: payload, place };
    return api<ControlView>(url, { method: 'POST', body });
  }

  async function controlOffline(v: string): Promise<ControlView> {
    if (!pack) throw new Error('Aucun paquet hors ligne : téléchargez-le avant de partir sur le terrain.');
    const offset = new Date(pack.serverTime).getTime() - new Date(pack.downloadedAt).getTime();
    const now = Date.now() + offset;
    const base = { controlId: uid('HL'), serverTime: new Date(now).toISOString(), offline: true, nothingToPay: false, signal: 'DISTINCT' };
    const payload = v.trim();
    const decoded = payload.startsWith('MT1.') ? decodeStatic(payload) : null;
    let plate: string | undefined; let token: string | undefined; let found: Pack['plates']['plates'][number] | undefined; let invalid: string | undefined;
    if (mode === 'plate') plate = norm(payload);
    else if (decoded?.k === 'AUTOCOLLANT' && typeof decoded.p === 'string') plate = decoded.p;
    else if (decoded && typeof decoded.id === 'string') {
      token = payload;
      const sig = await verifyStaticOffline(payload, pack.publicKeyPem);
      if (sig === false) invalid = 'QR non authentique (signature invalide)';
      else if (pack.revocations.entries.some((e) => e.id === decoded.id)) invalid = 'Titre révoqué, suspendu, remplacé ou déjà utilisé';
      else found = { plate: String(decoded.p ?? ''), number: String(decoded.n), validFrom: String(decoded.f), validUntil: String(decoded.u), toleranceMinutes: 0, amberMinutes: 120 };
    } else invalid = mode === 'vest' || decoded?.k === 'GILET' ? 'Gilet : lisez la plaque ou l’autocollant hors ligne' : 'QR dynamique : contrôle en ligne uniquement';
    if (plate) found = pack.plates.plates.filter((p) => p.plate === plate).sort((a, b) => b.validUntil.localeCompare(a.validUntil))[0];
    let res: ControlView;
    if (invalid || !found) {
      res = { ...base, result: 'INVALIDE', status: 'INVALIDE', color: 'noir', icon: 'ban', text: `INVALIDE — ${invalid ?? 'aucun titre actif connu hors ligne'}`, ...(plate ? { plate } : {}) };
    } else {
      const from = new Date(found.validFrom).getTime(); const until = new Date(found.validUntil).getTime();
      const left = Math.round((until - now) / 1000);
      // Règle unique 50 % / 1 %, à l'heure serveur (`now` = heure du paquet signé + temps écoulé).
      const band = readValidity(found.validFrom, found.validUntil, now).band;
      const [st, color, icon] = band === 'ROUGE' || band === 'EXPIRE' ? ['CRITIQUE', 'rouge', 'alert'] : band === 'AMBRE' ? ['BIENTOT_EXPIRE', 'ambre', 'alert'] : ['VALIDE', 'vert', 'check'];
      if (now < from) res = { ...base, result: 'INVALIDE', status: 'PAS_ENCORE_ACTIF', color: 'gris', icon: 'clock', text: 'PAS ENCORE ACTIF' };
      else if (now > until + found.toleranceMinutes * 60_000) res = { ...base, result: 'EXPIRE', status: 'EXPIRE', color: 'rouge', icon: 'x', text: 'EXPIRÉ' };
      else res = { ...base, result: 'VALIDE', status: st, color, icon, text: `VALIDE jusqu’au ${fmtDate(found.validUntil, true)}`, nothingToPay: true, signal: 'COURT', remainingSeconds: left };
      res = { ...res, ...(found.plate ? { plate: found.plate } : {}), typeLabel: found.number, validFrom: found.validFrom, validUntil: found.validUntil };
    }
    if (plate || token) {
      setQueue((q) => [...q, { opId: uid('op'), ...(token ? { token } : { plate: plate! }), controlledAt: new Date(now).toISOString(), place: { ...(place.label ? { label: place.label } : {}), ...(gps ?? {}) }, offlineResult: res.result, note: res.text }]);
    }
    return res;
  }

  const submit = useCallback(async (e?: FormEvent, override?: string) => {
    e?.preventDefault();
    const v = (override ?? value).trim();
    if (!v) return;
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = offline ? await controlOffline(v) : await controlOnline(v);
      setResult(r);
      playSignal(r.signal);
    } catch (ex) {
      setErr(describeError(ex).message);
    } finally { setBusy(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, offline, mode, scope, place, pack]);

  async function downloadPack() {
    setErr(null);
    try {
      const p = await api<Omit<Pack, 'downloadedAt'>>(`/v1/titres/hors-ligne/paquet?deviceId=${encodeURIComponent(device.id)}${scope === '81' ? '&module=81' : ''}`);
      const full = { ...p, downloadedAt: new Date().toISOString() };
      setPack(full); safeSet(PACK_KEY, JSON.stringify(full));
    } catch (ex) { setErr(describeError(ex).message); }
  }

  async function syncQueue() {
    setErr(null);
    try {
      const batch = { batchId: uid('LOT-CTL'), deviceId: device.id, createdAt: new Date().toISOString(), controls: queue.map(({ note: _n, ...c }) => c) };
      const signature = await hmacSha256Hex(device.key, JSON.stringify(batch));
      const r = await api<SyncResult>('/v1/titres/controles/lots', { method: 'POST', body: batch, headers: { 'x-device-signature': signature } });
      setSync(r); setQueue([]); constats.reload();
    } catch (ex) { setErr(describeError(ex).message); }
  }

  const onCode = useCallback((c: string) => { setScan(false); setValue(c); void submit(undefined, c); }, [submit]);
  const saveDevice = (d: typeof device) => { setDevice(d); safeSet('mosolo.titres.deviceId', d.id); safeSet('mosolo.titres.deviceKey', d.key); };

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Contrôle des titres · modules 71 · 81" title="Contrôle terrain" lead="Scanner le QR (téléphone, gilet, autocollant, ticket) ou saisir la plaque. Réponse minimale : valide, expiré ou invalide — sans nom ni adresse." >
        <span className={`tt-offline-flag`}><Icon name={offline ? 'offline' : 'antenna'} size={13} /> {offline ? 'Hors ligne' : 'En ligne'}</span>
      </PageHead>
      <ExampleNotice text="Démonstration : titres, plaques et gilets fictifs. Le contrôleur constate ; il n’encaisse jamais et n’inflige aucune amende." />
      {!isController && <div className="callout callout-info"><Icon name="info" size={18} /><p>Écran réservé aux contrôleurs habilités (agents de terrain, contrôleurs). Choisissez « Contrôleur RakaPay Kalamu–Lemba (démo) » dans l’en-tête.</p></div>}

      <div className="tt-ctl-grid">
        <div className="stack">
          <section className="panel" aria-labelledby="tt-ctl">
            <div className="panel-head">
              <div><h2 className="panel-title" id="tt-ctl"><Icon name="qr" size={18} /> Contrôler</h2><p className="panel-sub">Heure de référence : serveur (jamais l’horloge du terminal)</p></div>
              <div className="seg seg-sm" role="group" aria-label="Service contrôlé">
                <button type="button" aria-pressed={scope === '81'} onClick={() => setScope('81')}><Icon name="moto" size={14} /> Wewa</button>
                <button type="button" aria-pressed={scope === 'tous'} onClick={() => setScope('tous')}><Icon name="ticket" size={14} /> Tickets et autres</button>
              </div>
            </div>
            <form className="form" onSubmit={(e) => void submit(e)}>
              <div className="seg tt-mode" role="group" aria-label="Ce qui est présenté">
                <button type="button" aria-pressed={mode === 'qr'} onClick={() => setMode('qr')}><Icon name="qr" size={16} /> QR / code</button>
                <button type="button" aria-pressed={mode === 'plate'} onClick={() => setMode('plate')}><Icon name="car" size={16} /> Plaque</button>
                <button type="button" aria-pressed={mode === 'vest'} onClick={() => { setMode('vest'); setScope('81'); }}><Icon name="user" size={16} /> Gilet</button>
                <button type="button" aria-pressed={offline} onClick={() => setOffline((o) => !o)}><Icon name="offline" size={16} /> Hors ligne</button>
              </div>
              {mode === 'plate' ? (
                <div className="field">
                  <label className="label" htmlFor="tt-val">Plaque</label>
                  <input id="tt-val" className="tt-plate-input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="KN-M 20417" autoComplete="off" autoCapitalize="characters" />
                </div>
              ) : (
                <div className="field">
                  <label className="label" htmlFor="tt-val">{mode === 'vest' ? 'Contenu du QR du gilet ou numéro de gilet' : 'Contenu du QR ou code court'}</label>
                  <textarea id="tt-val" className="tt-token-input" value={value} onChange={(e) => setValue(e.target.value)} placeholder={mode === 'vest' ? 'W-KAL-0001 ou MT1.…' : 'MD1.… (téléphone), MT1.… (papier, autocollant), WEW…'} rows={3} />
                  {scan ? <QrScanner onResult={(raw) => { setScan(false); onCode(raw); }} onClose={() => setScan(false)} /> : <button type="button" className="btn btn-secondary" onClick={() => setScan(true)}><Icon name="camera" size={18} /> Lire avec la caméra</button>}
                </div>
              )}
              <div className="tt-inline-fields">
                <div className="field">
                  <label className="label" htmlFor="tt-commune">Commune du contrôle</label>
                  <select id="tt-commune" value={commune} onChange={(e) => setCommune(e.target.value)}>{communes.map((c) => <option key={c}>{c}</option>)}</select>
                </div>
                <div className="field">
                  <label className="label" htmlFor="tt-lieu">Lieu</label>
                  <input id="tt-lieu" value={placeLabel} onChange={(e) => setPlaceLabel(e.target.value)} placeholder="Rond-point, avenue, arrêt…" />
                </div>
              </div>
              <div className="btn-row">
                <button type="button" className="btn btn-ghost btn-sm" onClick={locate}><Icon name="gps" size={16} /> {gps ? `${gps.lat}, ${gps.lon}` : 'Joindre la position'}</button>
              </div>
              <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy || !value.trim()}><Icon name="shieldCheck" size={18} /> {busy ? 'Vérification…' : offline ? 'Vérifier hors ligne' : 'Vérifier'}</button>
            </form>
            {err && <p className="notice notice-err" role="alert" style={{ marginTop: 12 }}>{err}</p>}
          </section>
          {result && <ResultCard r={result} />}
        </div>

        <aside className="stack">
          <section className="panel" aria-labelledby="tt-off">
            <div className="panel-head"><div><h2 className="panel-title" id="tt-off"><Icon name="offline" size={18} /> Mode hors ligne</h2><p className="panel-sub">Paquet signé : clé publique, révocations, plaques actives</p></div></div>
            <dl className="kv kv-dense">
              <div><dt>Paquet</dt><dd>{pack ? `Téléchargé le ${fmtDate(pack.downloadedAt, true)} · ${pack.plates.plates.length} plaques · ${pack.revocations.entries.length} révocations` : 'Aucun'}</dd></div>
              <div><dt>Contrôles en attente</dt><dd>{queue.length}</dd></div>
            </dl>
            <details className="device-box">
              <summary>Terminal enrôlé</summary>
              <div className="form" style={{ marginTop: 8 }}>
                <div className="field"><label className="label" htmlFor="tt-dev">Identifiant du terminal</label><input id="tt-dev" className="mono" value={device.id} onChange={(e) => saveDevice({ ...device, id: e.target.value })} /></div>
                <div className="field"><label className="label" htmlFor="tt-key">Clé du terminal (démo)</label><input id="tt-key" className="mono" type="password" value={device.key} onChange={(e) => saveDevice({ ...device, key: e.target.value })} /></div>
              </div>
            </details>
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void downloadPack()} disabled={offline}><Icon name="download" size={16} /> Télécharger le paquet</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void syncQueue()} disabled={offline || queue.length === 0}><Icon name="sync" size={16} /> Synchroniser ({queue.length})</button>
            </div>
            {queue.length > 0 && (
              <ul className="tt-queue" style={{ marginTop: 12 }}>
                {queue.map((q) => <li key={q.opId}><span className="mono">{q.plate ?? `${q.token!.slice(0, 18)}…`}</span><span>{q.offlineResult} · {fmtDate(q.controlledAt, true)}</span></li>)}
              </ul>
            )}
            {sync && (
              <div className="result-card" style={{ marginTop: 12 }}>
                <p className="small"><strong>Lot {sync.batchId}</strong> — {sync.results.length} contrôle(s) reconfirmé(s), {sync.divergences} divergence(s).</p>
                <ul className="tt-queue">
                  {sync.results.map((r) => (
                    <li key={r.opId}>
                      <span>{r.rejected ? `Rejeté : ${r.rejected}` : `Hors ligne ${r.offlineResult} → serveur ${r.reconfirmed}`}</span>
                      {r.divergent ? <StatusBadge tone="warning" label={r.alreadyUsed ? 'Déjà utilisé ailleurs' : 'Divergence'} /> : !r.rejected && <StatusBadge tone="good" label="Confirmé" />}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="panel" aria-labelledby="tt-cst">
            <div className="panel-head"><h2 className="panel-title" id="tt-cst"><Icon name="file" size={18} /> Mes constats</h2>{constats.data && <span className="count">{constats.data.length}</span>}</div>
            {constats.loading ? <Loading /> : constats.error ? <ErrorState error={constats.error} onRetry={constats.reload} /> : !constats.data?.length ? (
              <EmptyState title="Aucun constat" icon="check">Un contrôle négatif ouvre un constat à instruire, sans montant.</EmptyState>
            ) : (
              <ul className="list-rows">
                {constats.data.slice(0, 8).map((k) => (
                  <li key={k.id} className="list-row">
                    <div className="min0"><p className="row-title">{k.id}</p><p className="small muted">{k.reason} · {k.place.label ?? '—'} · {fmtDate(k.at, true)}</p></div>
                    <div className="row-side">
                      {k.duringGrace && <StatusBadge tone="info" label="Période de grâce" />}
                      <StatusBadge tone={k.status === 'OUVERT' ? 'warning' : 'neutral'} label={k.status === 'OUVERT' ? 'À instruire' : k.status === 'CLASSE' ? 'Classé' : 'Transmis'} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="small muted" style={{ marginTop: 8 }}>Un constat n’est ni une amende ni une dette : une personne habilitée décide, avec motif, et l’usager peut contester.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
