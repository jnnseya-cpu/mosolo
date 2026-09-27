import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { api, describeError } from '../../lib/api';
import { onQueueChange, queueKey, readQueue, updateQueue } from '../../lib/offlineQueue';
import { hmacSha256Hex, sha256Hex, uid } from '../../lib/crypto';
import { hasRole, Pictogram } from './shared';
import { GpsQualityLine, MapCheck } from '../../components/GpsQuality';
import { usePreciseGps, type PreciseFix } from '../../lib/geo';
import './canaux.css';

const LANGS = [
  { code: 'fr', label: 'Français' }, { code: 'ln', label: 'Lingála' }, { code: 'sw', label: 'Kiswahili' }, { code: 'kg', label: 'Kikongo' }, { code: 'lua', label: 'Tshilubà' },
];
const OBJECTS = [
  { type: 'PARCELLE', label: 'Parcelle' }, { type: 'LOGEMENT_LOUE', label: 'Logement loué' }, { type: 'COMMERCE', label: 'Commerce / étal' },
  { type: 'VEHICULE', label: 'Véhicule' }, { type: 'PANNEAU', label: 'Panneau' },
];
const ALL_COMMUNES = ['Bandalungwa', 'Barumbu', 'Bumbu', 'Gombe', 'Kalamu', 'Kasa-Vubu', 'Kimbanseke', 'Kinshasa', 'Kintambo', 'Kisenso', 'Lemba', 'Limete', 'Lingwala', 'Makala', 'Maluku', 'Masina', 'Matete', 'Mont-Ngafula', 'Ndjili', 'Ngaba', 'Ngaliema', 'Ngiri-Ngiri', 'Nsele', 'Selembao'];
const DEVICES: Record<string, { id: string; key: string }> = {
  'canaux-agent-enrol': { id: 'dev-canaux-enrol-01', key: 'demo-device-key-canaux-01' },
  'canaux-guichetier': { id: 'dev-canaux-guichet-01', key: 'demo-device-key-canaux-02' },
  'u-agent-terrain': { id: 'dev-terrain-001', key: 'demo-device-key-001' },
};
const QUEUE_KEY = 'mosolo.canaux.enrolQueue';
/** Dossier en file locale : `ownerId` (agent qui l'a saisi) reste sur le terminal, il n'est pas transmis. */
type QueuedRecord = { localId: string; ownerId: string; person: { fullName: string; [k: string]: unknown }; commune: string } & Record<string, unknown>;

interface Draft {
  fullName: string; sex: '' | 'F' | 'M'; birthYear: string; language: string; phone: string; proxyPhone: string; photoSha256: string;
  commune: string; quartier: string; landmark: string; lat: string; lon: string; accuracyM: string;
  objects: Record<string, string>; channel: 'DOMICILE' | 'SITE' | 'GUICHET_MOSOLO'; missionId: string;
  summaryReadAt: string; method: '' | 'VOIX' | 'TEMOIN'; givenAt: string; voiceSha: string; witnessName: string; witnessRelation: string; witnessId: string;
  noPayment: boolean;
}
interface RecordResult { localId: string; outcome: 'CREE' | 'A_REVOIR' | 'REJETE'; reason?: string; detail?: string; enrolmentId?: string; taxpayerId?: string; iuc?: string; cardNumber?: string; replayed?: boolean }
interface Enrolment {
  id: string; status: 'CREE' | 'A_REVOIR' | 'DOUBLON_CONFIRME'; commune: string; quartier: string; channel: string; agentId: string; receivedAt: string; missionId: string;
  person: { fullName: string; language: string }; consent: { method: string; givenAt: string }; duplicateCandidates: { taxpayerId: string; reason: string }[];
  taxpayerId?: string; cardNumber?: string; cardNumberFormatted: string | null;
}

const blank = (commune: string): Draft => ({
  fullName: '', sex: '', birthYear: '', language: 'ln', phone: '', proxyPhone: '', photoSha256: '', commune, quartier: '', landmark: '', lat: '', lon: '', accuracyM: '',
  objects: {}, channel: 'DOMICILE', missionId: `MISSION-${new Date().toISOString().slice(0, 10)}`, summaryReadAt: '', method: '', givenAt: '', voiceSha: '',
  witnessName: '', witnessRelation: '', witnessId: '', noPayment: false,
});

function summaryText(d: Draft): string {
  const objs = Object.keys(d.objects).map((t) => OBJECTS.find((o) => o.type === t)?.label.toLowerCase()).filter(Boolean);
  return `Vous êtes ${d.fullName || '…'}, à ${d.commune}, quartier ${d.quartier || '…'}. Nous enregistrons votre compte MOSOLO gratuit${objs.length ? ` et vous déclarez : ${objs.join(', ')}` : ''}. `
    + 'Une déclaration ne crée aucune dette : elle sera vérifiée. Vous recevrez une carte MOSOLO et un avis. Aucun agent ne peut vous demander d’argent. '
    + 'Vous pourrez contester à tout moment au guichet ou par le serveur vocal, sans écrit. Acceptez-vous ?';
}

export default function AssistedEnrolment() {
  const { user, fmtDate } = useApp();
  const territory = user?.territory?.length ? user.territory : ALL_COMMUNES;
  const [d, setD] = useState<Draft>(() => blank(territory[0] ?? 'Limete'));
  // File propre à l'agent connecté : un autre utilisateur du terminal ne la voit ni ne la synchronise.
  const qKey = queueKey(QUEUE_KEY, user?.id);
  const [queue, setQueue] = useState<QueuedRecord[]>(() => readQueue<QueuedRecord>(qKey));
  useEffect(() => { setQueue(readQueue<QueuedRecord>(qKey)); }, [qKey]);
  useEffect(() => onQueueChange(qKey, () => setQueue(readQueue<QueuedRecord>(qKey))), [qKey]);
  const [device, setDevice] = useState(() => DEVICES[user?.id ?? ''] ?? DEVICES['canaux-agent-enrol']!);
  const [results, setResults] = useState<RecordResult[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = useApi(() => api<Enrolment[]>('/v1/assisted-enrolments'), [user?.id, results]);
  const supervisor = hasRole(user?.roles, 'R09');
  const canEnrol = hasRole(user?.roles, 'R10', 'R12');
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const summary = useMemo(() => summaryText(d), [d]);

  // Toujours relire la file stockée avant d'écrire : un dossier saisi pendant une synchronisation n'est jamais perdu.
  const persist = (fn: (q: QueuedRecord[]) => QueuedRecord[]) => setQueue(updateQueue(qKey, fn));

  function readSummary() {
    try {
      const s = window.speechSynthesis;
      if (s) { s.cancel(); const u = new SpeechSynthesisUtterance(summary); u.lang = 'fr-FR'; s.speak(u); }
    } catch { /* lecture par l'agent */ }
    set('summaryReadAt', new Date().toISOString());
  }

  async function recordVoice() {
    const at = new Date().toISOString();
    setD((x) => ({ ...x, givenAt: at }));
    set('voiceSha', await sha256Hex(`consentement-vocal-simule|${summary}|${at}`));
  }

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    set('photoSha256', await sha256Hex(await file.arrayBuffer()));
  }

  // Position précise du domicile ou du site (cible 10 m) ; un point ajusté sur la carte est enregistré avec une précision prudente de 25 m.
  const pgps = usePreciseGps({ targetM: 10 });
  const applyFix = (f: PreciseFix) => setD((x) => ({ ...x, lat: f.lat.toFixed(6), lon: f.lon.toFixed(6), accuracyM: String(f.accuracy !== null ? Math.max(1, Math.round(f.accuracy)) : 25) }));
  function gps() { pgps.locate(applyFix); }
  useEffect(() => { if (pgps.status === 'denied' || pgps.status === 'unavailable') setErr('Position indisponible : saisissez les coordonnées relevées.'); }, [pgps.status]);

  const ready = d.fullName.trim().length > 1 && d.quartier && d.landmark.length > 2 && d.lat && d.lon && d.summaryReadAt && d.method && d.noPayment
    && (d.method === 'VOIX' ? !!d.voiceSha : !!d.witnessName.trim() && !!d.witnessRelation.trim());

  function enqueue(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!user || !qKey) { setErr('Aucun agent identifié : le dossier ne peut pas être enregistré.'); return; }
    const givenAt = d.method === 'TEMOIN' ? new Date().toISOString() : d.givenAt;
    const rec: QueuedRecord = {
      ownerId: user.id, localId: uid('ENR'), channel: d.channel, missionId: d.missionId, capturedAt: new Date().toISOString(),
      gps: { lat: Number(d.lat), lon: Number(d.lon), accuracyM: Number(d.accuracyM || '25') },
      commune: d.commune, quartier: d.quartier, landmark: d.landmark,
      person: {
        fullName: d.fullName.trim(), language: d.language, ...(d.sex ? { sex: d.sex } : {}), ...(d.birthYear ? { birthYear: Number(d.birthYear) } : {}),
        ...(d.phone ? { phone: d.phone } : {}), ...(d.proxyPhone ? { proxyPhone: d.proxyPhone } : {}), ...(d.photoSha256 ? { photoSha256: d.photoSha256 } : {}),
      },
      declaredObjects: Object.entries(d.objects).map(([type, description]) => ({ type, description: description || 'Déclaré lors de l’enrôlement' })),
      consent: {
        method: d.method, summaryLanguage: d.language, summaryAudioVersion: `resume-enrolement-${d.language}-v0`, summaryReadAt: d.summaryReadAt, givenAt,
        ...(d.method === 'VOIX' ? { voiceRecordingSha256: d.voiceSha } : { witness: { name: d.witnessName, relation: d.witnessRelation, ...(d.witnessId ? { idRef: d.witnessId } : {}) } }),
      },
      noPaymentAttested: d.noPayment,
    };
    persist((q) => [...q, rec]);
    setMsg(`Dossier de ${d.fullName} enregistré sur le terminal (hors ligne). Synchronisez dès que le réseau est disponible.`);
    setD(blank(d.commune));
  }

  async function sync() {
    if (busy || !user) return;
    // Seuls les dossiers saisis par l'agent connecté partent ; ceux d'un autre utilisateur ne sont jamais synchronisés.
    const mine = readQueue<QueuedRecord>(qKey).filter((q) => q.ownerId === user.id);
    if (!mine.length) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const raw = JSON.stringify({ batchId: uid('LOT'), deviceId: device.id, createdAt: new Date().toISOString(), records: mine.map(({ ownerId: _o, ...r }) => r) });
      const signature = await hmacSha256Hex(device.key, raw);
      const r = await api<{ results: RecordResult[] }>('/v1/assisted-enrolments/batches', { method: 'POST', body: JSON.parse(raw), headers: { 'x-device-signature': signature } });
      setResults(r.results);
      // Ne retirer que les dossiers dont le serveur a accusé réception.
      const done = new Set(r.results.map((x) => x.localId));
      persist((q) => q.filter((x) => !done.has(x.localId)));
    } catch (e) {
      setErr(describeError(e).message);
    } finally { setBusy(false); }
  }

  async function review(id: string, decision: 'DISTINCT' | 'DOUBLON') {
    const motif = window.prompt(decision === 'DISTINCT' ? 'Motif (personnes distinctes) :' : 'Motif (doublon confirmé) :');
    if (!motif || motif.trim().length < 10) { setErr('Motif d’au moins 10 caractères requis.'); return; }
    try {
      await api(`/v1/assisted-enrolments/${id}/review`, { method: 'POST', body: { decision, motif } });
      list.reload();
    } catch (e) { setErr(describeError(e).message); }
  }

  // Attention : le corps signé doit être EXACTEMENT celui envoyé ; api() re-sérialise JSON.parse(raw) à l'identique.
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Enrôlement inclusif — module 63" title="Enrôlement assisté" lead="À domicile, sur site ou au guichet MOSOLO, même sans réseau : compte N0-A et carte MOSOLO, après lecture du résumé et consentement. Aucun paiement n’est demandé ni reçu." />
      <ExampleNotice text="Démonstration : personnes fictives. Audio du résumé : version de travail à valider (§ 11.5). Empreinte digitale non ouverte tant que J18 n’est pas certifié (ARB-24)." />
      {!canEnrol && !supervisor && <div className="callout callout-warn">Choisissez un agent d’enrôlement (R10 ou R12) ou un superviseur (R09) dans l’en-tête.</div>}
      <div className="cx-two">
        {canEnrol && (
          <form className="panel form" onSubmit={enqueue} aria-labelledby="cx-enrol-title">
            <header className="panel-head"><h2 className="panel-title" id="cx-enrol-title"><Icon name="user" size={18} /> Nouveau dossier</h2><span className="chip"><Icon name="offline" size={14} /> Hors ligne possible</span></header>

            <fieldset className="field cx-step"><legend className="cx-step-title"><span className="cx-step-n">1</span> Personne</legend>
              <div className="field"><label className="label" htmlFor="cx-name">Nom complet</label><input id="cx-name" value={d.fullName} onChange={(e) => set('fullName', e.target.value)} autoComplete="off" required /></div>
              <div className="field-row">
                <div className="field"><label className="label" htmlFor="cx-sex">Sexe</label><select id="cx-sex" value={d.sex} onChange={(e) => set('sex', e.target.value as Draft['sex'])}><option value="">Non précisé</option><option value="F">Femme</option><option value="M">Homme</option></select></div>
                <div className="field"><label className="label" htmlFor="cx-by">Année de naissance</label><input id="cx-by" inputMode="numeric" value={d.birthYear} onChange={(e) => set('birthYear', e.target.value.replace(/\D/g, '').slice(0, 4))} /></div>
              </div>
              <div className="field-row">
                <div className="field"><label className="label" htmlFor="cx-lang">Langue choisie</label><select id="cx-lang" value={d.language} onChange={(e) => set('language', e.target.value)}>{LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</select></div>
                <div className="field"><label className="label" htmlFor="cx-photo">Photographie</label><input id="cx-photo" type="file" accept="image/*" capture="user" onChange={(e) => void onPhoto(e.target.files?.[0])} /><span className="hint">{d.photoSha256 ? `Empreinte : ${d.photoSha256.slice(0, 12)}…` : 'Seule l’empreinte est transmise dans cette démonstration.'}</span></div>
              </div>
              <div className="field-row">
                <div className="field"><label className="label" htmlFor="cx-phone">Téléphone (facultatif)</label><input id="cx-phone" inputMode="tel" value={d.phone} onChange={(e) => set('phone', e.target.value)} placeholder="Aucun" /></div>
                <div className="field"><label className="label" htmlFor="cx-proxy">Téléphone d’un proche (canal, pas identité)</label><input id="cx-proxy" inputMode="tel" value={d.proxyPhone} onChange={(e) => set('proxyPhone', e.target.value)} /></div>
              </div>
            </fieldset>

            <fieldset className="field cx-step"><legend className="cx-step-title"><span className="cx-step-n">2</span> Lieu (sans adresse formelle)</legend>
              <div className="field-row">
                <div className="field"><label className="label" htmlFor="cx-commune">Commune (zone de l’agent)</label><select id="cx-commune" value={d.commune} onChange={(e) => set('commune', e.target.value)}>{territory.map((c) => <option key={c}>{c}</option>)}</select></div>
                <div className="field"><label className="label" htmlFor="cx-q">Quartier</label><input id="cx-q" value={d.quartier} onChange={(e) => set('quartier', e.target.value)} required /></div>
              </div>
              <div className="field"><label className="label" htmlFor="cx-lm">Repère</label><input id="cx-lm" value={d.landmark} onChange={(e) => set('landmark', e.target.value)} placeholder="Ex. derrière l’école, portail bleu" required /></div>
              <div className="field-row cx-gps">
                <div className="field"><label className="label" htmlFor="cx-lat">Latitude</label><input id="cx-lat" inputMode="decimal" value={d.lat} onChange={(e) => set('lat', e.target.value)} required /></div>
                <div className="field"><label className="label" htmlFor="cx-lon">Longitude</label><input id="cx-lon" inputMode="decimal" value={d.lon} onChange={(e) => set('lon', e.target.value)} required /></div>
              </div>
              <div className="btn-row"><button type="button" className="btn btn-secondary btn-sm" onClick={gps}><Icon name="gps" size={16} /> Relever la position</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setD((x) => ({ ...x, lat: '-4.3689', lon: '15.3561', accuracyM: '15' }))}>Position d’exemple</button></div>
              <GpsQualityLine fix={pgps.fix} status={pgps.status} targetM={pgps.targetM} />
              <MapCheck lat={d.lat ? Number(d.lat) : null} lon={d.lon ? Number(d.lon) : null} accuracy={d.accuracyM ? Number(d.accuracyM) : null} onPick={(y, x) => pgps.pick(y, x, applyFix)} />
              <div className="field"><label className="label" htmlFor="cx-ch">Lieu d’enrôlement</label><select id="cx-ch" value={d.channel} onChange={(e) => set('channel', e.target.value as Draft['channel'])}><option value="DOMICILE">À domicile</option><option value="SITE">Sur site</option><option value="GUICHET_MOSOLO">Guichet MOSOLO</option></select></div>
              <div className="field"><label className="label" htmlFor="cx-mission">Mission</label><input id="cx-mission" className="mono" value={d.missionId} onChange={(e) => set('missionId', e.target.value)} /></div>
            </fieldset>

            <fieldset className="field cx-step"><legend className="cx-step-title"><span className="cx-step-n">3</span> Biens déclarés (à vérifier)</legend>
              <div className="cx-objects">
                {OBJECTS.map((o) => {
                  const on = o.type in d.objects;
                  return (
                    <div key={o.type} className={`cx-object ${on ? 'on' : ''}`}>
                      <label className="check"><input type="checkbox" checked={on} onChange={() => setD((x) => { const n = { ...x.objects }; if (on) delete n[o.type]; else n[o.type] = ''; return { ...x, objects: n }; })} /> <Pictogram code={o.type} size={32} /> {o.label}</label>
                      {on && <input aria-label={`Description : ${o.label}`} value={d.objects[o.type]} onChange={(e) => setD((x) => ({ ...x, objects: { ...x.objects, [o.type]: e.target.value } }))} placeholder="Description courte" />}
                    </div>
                  );
                })}
              </div>
              <p className="hint">Une déclaration ne crée aucune dette : elle ouvre une vérification.</p>
            </fieldset>

            <fieldset className="field cx-step"><legend className="cx-step-title"><span className="cx-step-n">4</span> Résumé lu et consentement</legend>
              <blockquote className="cx-summary">{summary}</blockquote>
              <div className="btn-row">
                <button type="button" className="btn btn-secondary" onClick={readSummary}><Icon name="megaphone" size={16} /> Lire le résumé à voix haute</button>
                {d.summaryReadAt && <StatusBadge tone="good" label={`Lu à ${fmtDate(d.summaryReadAt, true)}`} />}
              </div>
              <div className="radio-list" role="radiogroup" aria-label="Mode de consentement">
                <label className="radio"><input type="radio" name="cx-m" checked={d.method === 'VOIX'} disabled={!d.summaryReadAt} onChange={() => set('method', 'VOIX')} /> Consentement vocal enregistré</label>
                <label className="radio"><input type="radio" name="cx-m" checked={d.method === 'TEMOIN'} disabled={!d.summaryReadAt} onChange={() => set('method', 'TEMOIN')} /> Devant un témoin identifié</label>
                <label className="radio muted"><input type="radio" name="cx-m" disabled /> Empreinte digitale — non ouverte (J18 non certifié, ARB-24)</label>
              </div>
              {d.method === 'VOIX' && (
                <div className="btn-row"><button type="button" className="btn btn-secondary btn-sm" onClick={() => void recordVoice()}><Icon name="phone" size={16} /> Enregistrer « oui » (simulé)</button>
                  {d.voiceSha && <span className="hint mono">Empreinte {d.voiceSha.slice(0, 16)}…</span>}</div>
              )}
              {d.method === 'TEMOIN' && (
                <div className="field-row">
                  <div className="field"><label className="label" htmlFor="cx-wn">Nom du témoin</label><input id="cx-wn" value={d.witnessName} onChange={(e) => set('witnessName', e.target.value)} /></div>
                  <div className="field"><label className="label" htmlFor="cx-wr">Lien (voisin, chef de quartier…)</label><input id="cx-wr" value={d.witnessRelation} onChange={(e) => set('witnessRelation', e.target.value)} /></div>
                </div>
              )}
              <label className="check cx-attest"><input type="checkbox" checked={d.noPayment} onChange={(e) => set('noPayment', e.target.checked)} /> J’atteste n’avoir demandé ni reçu aucun paiement.</label>
            </fieldset>

            <button type="submit" className="btn btn-primary" disabled={!ready}><Icon name="check" size={18} /> Enregistrer le dossier sur le terminal</button>
            {!ready && <p className="hint">Enregistrement impossible sans lecture du résumé, consentement et attestation (toute tentative serait journalisée).</p>}
          </form>
        )}

        <div className="cx-col">
          {canEnrol && (
            <section className="panel" aria-labelledby="cx-queue">
              <header className="panel-head"><h2 className="panel-title" id="cx-queue"><Icon name="sync" size={18} /> File de synchronisation</h2><span className="count">{queue.length}</span></header>
              <details className="device-box"><summary>Terminal enrôlé : <span className="mono">{device.id}</span></summary>
                <div className="field-row">
                  <div className="field"><label className="label" htmlFor="cx-dev">Terminal</label><input id="cx-dev" className="mono" value={device.id} onChange={(e) => setDevice({ ...device, id: e.target.value })} /></div>
                  <div className="field"><label className="label" htmlFor="cx-key">Clé (démo)</label><input id="cx-key" className="mono" type="password" value={device.key} onChange={(e) => setDevice({ ...device, key: e.target.value })} /></div>
                </div>
              </details>
              {queue.length === 0 ? <p className="muted small">Aucun dossier en attente.</p> : (
                <ul className="list-rows compact-rows">{queue.map((r, i) => <li key={r.localId ?? i} className="list-row"><span>{r.person.fullName}</span><span className="muted small">{r.commune}</span></li>)}</ul>
              )}
              <div className="btn-row"><button type="button" className="btn btn-primary" disabled={!queue.length || busy} onClick={() => void sync()}><Icon name="upload" size={16} /> Synchroniser (lot signé)</button>
                {queue.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => persist(() => [])}>Vider</button>}</div>
              {msg && <p className="notice notice-ok">{msg}</p>}
              {err && <p className="notice notice-err" role="alert">{err}</p>}
              {results && (
                <ul className="list-rows cx-results">{results.map((r) => (
                  <li key={r.localId} className="list-row list-row-stack">
                    <div className="row-between">
                      <StatusBadge tone={r.outcome === 'CREE' ? 'good' : r.outcome === 'A_REVOIR' ? 'warning' : 'critical'} label={r.outcome === 'CREE' ? 'Compte N0-A créé' : r.outcome === 'A_REVOIR' ? 'À revoir (doublon possible)' : `Refusé : ${r.reason}`} />
                      {r.cardNumber && <Link className="btn btn-secondary btn-sm" to={`/canaux/carte/${r.cardNumber}`}><Icon name="card" size={16} /> Carte et avis</Link>}
                    </div>
                    {r.detail && <p className="small muted">{r.detail}</p>}
                  </li>
                ))}</ul>
              )}
            </section>
          )}

          <section className="panel" aria-labelledby="cx-files">
            <header className="panel-head"><h2 className="panel-title" id="cx-files"><Icon name="file" size={18} /> Dossiers d’enrôlement</h2></header>
            {list.loading && <Loading />}
            {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} />}
            {list.data && list.data.length === 0 && <EmptyState title="Aucun dossier" />}
            {list.data && list.data.length > 0 && (
              <ul className="list-rows">{list.data.map((e) => (
                <li key={e.id} className="list-row list-row-stack">
                  <div className="row-between">
                    <span className="row-title">{e.person.fullName} <span className="muted small">· {e.commune}, {e.quartier}</span></span>
                    <StatusBadge tone={e.status === 'CREE' ? 'good' : e.status === 'A_REVOIR' ? 'warning' : 'neutral'} label={e.status === 'CREE' ? 'N0-A · carte émise' : e.status === 'A_REVOIR' ? 'À revoir' : 'Doublon confirmé'} />
                  </div>
                  <p className="small muted">{e.id} · consentement {e.consent.method === 'VOIX' ? 'vocal' : 'devant témoin'} le {fmtDate(e.consent.givenAt, true)} · mission {e.missionId}</p>
                  <div className="btn-row">
                    {e.cardNumber && <Link className="btn btn-ghost btn-sm" to={`/canaux/carte/${e.cardNumber}`}><Icon name="card" size={16} /> Carte {e.cardNumberFormatted}</Link>}
                    {supervisor && e.status === 'A_REVOIR' && <>
                      <span className="small">Candidat : {e.duplicateCandidates.map((c) => `${c.taxpayerId} (${c.reason === 'MEME_NOM' ? 'même nom' : 'même téléphone'})`).join(', ')}</span>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void review(e.id, 'DISTINCT')}>Personnes distinctes</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void review(e.id, 'DOUBLON')}>Doublon</button>
                    </>}
                  </div>
                </li>
              ))}</ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
