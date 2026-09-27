/**
 * Espace de l'annonceur / exploitant — KIN PUB CONTROL : mes dispositifs (plaque QR), déclaration, demande
 * d'autorisation en ligne (pièces par empreinte), avis au redevable et paiement, dossiers de contrôle et contestation.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { QrCode } from '../../components/QrCode';
import { StatusBadge } from '../../components/StatusBadge';
import { ValidityCountdown } from '../../components/ValidityCountdown';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { sha256Hex } from '../../lib/crypto';
import { DemoTag, ErrorLine, GpsField, Money, parsePosition, PAYMENT_STATE, PayButton, PhotoHashes, useAction } from '../parking/shared';
import { AD_TYPE, CASE_STATUS, DEVICE_STATUS, FINDING, LIGHTING, PIECE, PLACEMENT, REQUEST_STATUS, RIGHTS, VEHICLE_KIND, type AuthRequest, type Case, type Device, type Notice } from './types';
import '../parking/parking.css';
import { AdvertiserVisuels } from './visuels';

type Tab = 'devices' | 'declare' | 'requests' | 'notices' | 'cases';

export default function AdvertiserSpace() {
  const { user } = useApp();
  const [tab, setTab] = useState<Tab>('devices');
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);
  const ok = !!user?.taxpayerId;
  const devices = useApi(ok ? () => api<{ items: Device[] }>('/v1/publicite/devices/mine').then((r) => r.items) : null, [user?.id, tick]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="MOSOLO Advertising · KIN PUB CONTROL" title="Mes dispositifs publicitaires"
        lead="Déclarez vos supports, demandez et renouvelez vos autorisations en ligne, consultez vos avis et payez par les canaux officiels. Chaque support porte une plaque QR vérifiable par tous.">
        <button type="button" className="btn btn-secondary btn-sm" onClick={refresh}><Icon name="refresh" size={16} /> Actualiser</button>
      </PageHead>
      {!ok ? (
        <EmptyState title="Compte exploitant requis" icon="megaphone">Choisissez « Affiches du Fleuve SARL — exploitant publicitaire (fictif) » dans l’en-tête.</EmptyState>
      ) : (
        <>
          <ExampleNotice text="Le barème de liquidation utilisé est une règle FICTIVE de démonstration publiée par le circuit à quatre visas ; il n’a aucune valeur juridique." />
          <AdvertiserVisuels devices={devices.data ?? undefined} loading={devices.loading} error={devices.error} onRetry={devices.reload} />
          <div className="seg seg-wrap pk-tabs" role="tablist" aria-label="Rubriques">
            {([['devices', 'Mes dispositifs'], ['declare', 'Déclarer un support'], ['requests', 'Autorisations'], ['notices', 'Avis et paiements'], ['cases', 'Contrôles']] as [Tab, string][]).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-pressed={tab === k} aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>
          {tab === 'devices' && (devices.loading && !devices.data ? <Loading /> : devices.error ? <ErrorState error={devices.error} onRetry={devices.reload} /> : <DeviceList items={devices.data ?? []} />)}
          {tab === 'declare' && <DeclareForm onDone={() => { refresh(); setTab('devices'); }} />}
          {tab === 'requests' && <Requests devices={devices.data ?? []} tick={tick} onChange={refresh} />}
          {tab === 'notices' && <Notices tick={tick} onChange={refresh} />}
          {tab === 'cases' && <Cases tick={tick} onChange={refresh} />}
        </>
      )}
    </div>
  );
}

function DeviceList({ items }: { items: Device[] }) {
  const { fmtDate } = useApp();
  if (items.length === 0) return <EmptyState title="Aucun dispositif déclaré" icon="megaphone" />;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <div className="pk-cards pk-cards-2">
      {items.map((d) => (
        <article key={d.id} className="pk-card">
          <div className="pk-card-head">
            <div className="min0"><p className="pk-row-title">{AD_TYPE[d.type] ?? d.type} · {d.reference}</p><p className="pk-sub">{d.address}, {d.quartier} ({d.commune})</p></div>
            <StatusBadge tone={DEVICE_STATUS[d.status].tone} label={DEVICE_STATUS[d.status].label} />
          </div>
          <div className="row-between" style={{ alignItems: 'flex-start' }}>
            <dl className="kv kv-dense min0" style={{ flex: 1 }}>
              <div><dt>Format</dt><dd>{d.widthM} × {d.heightM} m = {d.surfaceM2.replace('.', ',')} m² · {d.faces} face(s)</dd></div>
              <div><dt>Éclairage</dt><dd>{LIGHTING[d.lighting] ?? d.lighting}</dd></div>
              <div><dt>Autorisation</dt><dd>{d.authorization ? `${d.authorization.reference} · jusqu’au ${fmtDate(d.authorization.validUntil)}` : '—'}{d.authorization && <> <ValidityCountdown compact from={d.authorization.validFrom} until={d.authorization.validUntil} blocked={d.status === 'RETIRE' ? 'Retirée' : null} label="Autorisation" /></>}</dd></div>
              <div><dt>Droits</dt><dd><StatusBadge tone={RIGHTS[d.rights].tone} label={RIGHTS[d.rights].label} /></dd></div>
            </dl>
            <QrCode value={`${origin}/publicite/verifier?plaque=${encodeURIComponent(d.qrToken)}`} size={92} alt={`Plaque QR du dispositif ${d.reference}`} />
          </div>
          {d.expiringSoon && <p className="notice notice-err">Autorisation arrivant à échéance : pensez au renouvellement.</p>}
          {d.openCase && <p className="small">Contrôle en cours : dossier {d.openCase.reference} ({FINDING[d.openCase.finding]}).</p>}
        </article>
      ))}
    </div>
  );
}

function DeclareForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ type: 'PANNEAU', widthM: '4.00', heightM: '3.00', faces: 1, lighting: 'NON_ECLAIRE', commune: 'Gombe', quartier: '', address: '', localityRank: 1 });
  // Aucune position par défaut : le support est déclaré à l'endroit relevé, jamais à un point fictif.
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [placement, setPlacement] = useState('SUPPORT_DEDIE');
  const [vehiclePlate, setVehiclePlate] = useState('');
  const [vehicleKind, setVehicleKind] = useState('TAXI');
  const [businessName, setBusinessName] = useState('');
  const act = useAction();
  const mobile = placement === 'VEHICULE';
  const shop = placement === 'FACADE_COMMERCE' || placement === 'DEVANT_COMMERCE';
  function submit(e: FormEvent) {
    e.preventDefault();
    if (photos.length === 0) { act.setError('Au moins une photographie du support est requise.'); return; }
    const pos = parsePosition(lat, lon);
    if (!pos) { act.setError('Position du support obligatoire : localisez-vous ou placez le point sur la carte.'); return; }
    const extra = { placement, ...(mobile ? { vehiclePlate, vehicleKind } : {}), ...(shop && businessName.trim() ? { businessName: businessName.trim() } : {}) };
    void act.run(() => api('/v1/publicite/devices', { method: 'POST', body: { ...f, ...extra, lat: pos.lat, lon: pos.lon, photos } }), onDone);
  }
  return (
    <section className="panel">
      <header className="panel-head"><div><h2 className="panel-title"><Icon name="megaphone" size={18} /> Déclarer un support</h2><p className="panel-sub">La surface est calculée par le serveur ; un identifiant unique et une plaque QR sont attribués.</p></div></header>
      <form className="form" onSubmit={submit}>
        <label className="field"><span className="label">Emplacement</span>
          <select value={placement} onChange={(e) => { setPlacement(e.target.value); if (e.target.value === 'VEHICULE') setF({ ...f, type: 'HABILLAGE_VEHICULE' }); if (e.target.value === 'FACADE_COMMERCE') setF({ ...f, type: 'ENSEIGNE' }); if (e.target.value === 'DEVANT_COMMERCE') setF({ ...f, type: 'CHEVALET' }); }}>
            {Object.entries(PLACEMENT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <span className="hint">Enseignes sur façade ou porte, publicités devant un commerce et publicités sur véhicule sont aussi assujetties.</span>
        </label>
        {mobile && (
          <div className="field-row">
            <label className="field"><span className="label">Plaque du véhicule</span><input className="mono" value={vehiclePlate} onChange={(e) => setVehiclePlate(e.target.value.toUpperCase())} required /></label>
            <label className="field"><span className="label">Véhicule</span><select value={vehicleKind} onChange={(e) => setVehicleKind(e.target.value)}>{Object.entries(VEHICLE_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          </div>
        )}
        {shop && <label className="field"><span className="label">Commerce (nom affiché)</span><input value={businessName} onChange={(e) => setBusinessName(e.target.value)} required /></label>}
        <div className="field-row">
          <label className="field"><span className="label">Type</span><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{Object.entries(AD_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field"><span className="label">Éclairage</span><select value={f.lighting} onChange={(e) => setF({ ...f, lighting: e.target.value })}>{Object.entries(LIGHTING).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </div>
        <div className="field-row">
          <label className="field"><span className="label">Largeur (m)</span><input inputMode="decimal" value={f.widthM} onChange={(e) => setF({ ...f, widthM: e.target.value })} /></label>
          <label className="field"><span className="label">Hauteur (m)</span><input inputMode="decimal" value={f.heightM} onChange={(e) => setF({ ...f, heightM: e.target.value })} /></label>
        </div>
        <div className="field-row">
          <label className="field"><span className="label">Faces</span><select value={f.faces} onChange={(e) => setF({ ...f, faces: Number(e.target.value) })}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          <label className="field"><span className="label">Rang de localité</span><select value={f.localityRank} onChange={(e) => setF({ ...f, localityRank: Number(e.target.value) })}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        </div>
        <div className="field-row">
          <label className="field"><span className="label">Commune</span><input value={f.commune} onChange={(e) => setF({ ...f, commune: e.target.value })} required /></label>
          <label className="field"><span className="label">Quartier</span><input value={f.quartier} onChange={(e) => setF({ ...f, quartier: e.target.value })} required /></label>
        </div>
        <label className="field"><span className="label">Adresse ou repère</span><input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} required /></label>
        {mobile && <p className="small muted">Position : lieu de stationnement habituel du véhicule (la publicité se contrôle ensuite par la plaque, où qu’il soit).</p>}
        <GpsField lat={lat} lon={lon} onChange={(a, b) => { setLat(a); setLon(b); }} />
        <PhotoHashes value={photos} onChange={setPhotos} label="Photographies du support" />
        <ErrorLine error={act.error} />
        <button type="submit" className="btn btn-primary" disabled={act.busy}>{act.busy ? 'Envoi…' : 'Déclarer'}</button>
      </form>
    </section>
  );
}

function Requests({ devices, tick, onChange }: { devices: Device[]; tick: number; onChange: () => void }) {
  const { fmtDate, user } = useApp();
  const list = useApi(() => api<{ items: AuthRequest[] }>('/v1/publicite/authorizations/mine').then((r) => r.items), [user?.id, tick]);
  const eligible = devices.filter((d) => d.status !== 'RETIRE');
  const today = new Date().toISOString().slice(0, 10);
  const nextYear = new Date(Date.now() + 364 * 86_400_000).toISOString().slice(0, 10);
  const [f, setF] = useState({ deviceId: '', from: today, to: nextYear });
  const [pieces, setPieces] = useState<{ kind: string; name: string; sha256: string }[]>([]);
  const [kind, setKind] = useState('PLAN_SITUATION');
  const act = useAction();
  async function addFiles(files: FileList | null) {
    if (!files) return;
    const out = [...pieces];
    for (const file of Array.from(files)) out.push({ kind, name: file.name, sha256: await sha256Hex(await file.arrayBuffer()) });
    setPieces(out);
  }
  return (
    <div className="pk-grid pk-grid-2">
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="file" size={18} /> Mes demandes</h2><p className="panel-sub">Instruction par la régie, décision motivée par une autre personne.</p></div></header>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : (list.data ?? []).length === 0 ? <p className="muted small">Aucune demande.</p> : (
          <div className="pk-cards">
            {(list.data ?? []).map((r) => (
              <article key={r.id} className="pk-card">
                <div className="pk-card-head"><div className="min0"><p className="pk-row-title">{r.reference}</p><p className="pk-sub">{r.device?.reference} · {fmtDate(r.periodFrom)} → {fmtDate(r.periodTo)}</p>{r.status === 'ACCORDEE' && <ValidityCountdown compact from={r.periodFrom} until={r.periodTo} label="Autorisation" />}</div>
                  <StatusBadge tone={REQUEST_STATUS[r.status].tone} label={REQUEST_STATUS[r.status].label} /></div>
                <p className="small muted">{r.pieces.length} pièce(s) : {r.pieces.map((p) => PIECE[p.kind] ?? p.kind).join(', ')}</p>
                {r.history.filter((h) => h.action === 'COMPLEMENT_DEMANDE').slice(-1).map((h) => <p key={h.at} className="small"><strong>Complément demandé :</strong> {h.note}</p>)}
                {r.decision && <p className="small"><strong>Décision :</strong> {r.decision.reason}</p>}
                {r.liquidation && <p className="small">{r.liquidation.status === 'EMISE' ? <>Avis émis : <Money items={r.obligation?.amount} /></> : r.liquidation.note}</p>}
                {r.status === 'COMPLEMENT_DEMANDE' && <Complement id={r.id} onDone={onChange} />}
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="send" size={18} /> Demander une autorisation</h2><p className="panel-sub">Autorisation annuelle. Seule l’empreinte des pièces est transmise dans cette démonstration.</p></div></header>
        {eligible.length === 0 ? <p className="muted small">Déclarez d’abord un support.</p> : (
          <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(() => api('/v1/publicite/authorizations', { method: 'POST', body: { deviceId: f.deviceId || eligible[0]!.id, periodFrom: f.from, periodTo: f.to, pieces } }), () => { setPieces([]); onChange(); }); }}>
            <label className="field"><span className="label">Support</span><select value={f.deviceId || eligible[0]!.id} onChange={(e) => setF({ ...f, deviceId: e.target.value })}>{eligible.map((d) => <option key={d.id} value={d.id}>{d.reference} — {AD_TYPE[d.type]} ({d.commune})</option>)}</select></label>
            <div className="field-row">
              <label className="field"><span className="label">Du</span><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
              <label className="field"><span className="label">Au</span><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
            </div>
            <div className="field">
              <span className="label">Pièces justificatives</span>
              <div className="input-row">
                <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Nature de la pièce">{Object.entries(PIECE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <label className="btn btn-secondary btn-sm pk-file"><Icon name="upload" size={16} /> Joindre<input type="file" className="sr-only" multiple onChange={(e) => void addFiles(e.target.files)} /></label>
              </div>
              {pieces.length > 0 && <ul className="pk-hashes">{pieces.map((p, i) => <li key={p.sha256 + i}><Icon name="file" size={14} /> {PIECE[p.kind]} — {p.name} <span className="mono muted">{p.sha256.slice(0, 12)}…</span></li>)}</ul>}
            </div>
            <ErrorLine error={act.error} />
            <button type="submit" className="btn btn-primary" disabled={act.busy || pieces.length === 0}>{act.busy ? 'Envoi…' : 'Déposer la demande'}</button>
          </form>
        )}
      </section>
    </div>
  );
}

function Complement({ id, onDone }: { id: string; onDone: () => void }) {
  const [msg, setMsg] = useState('');
  const [pieces, setPieces] = useState<{ kind: string; name: string; sha256: string }[]>([]);
  const act = useAction();
  return (
    <form className="form pk-reason" onSubmit={(e) => { e.preventDefault(); void act.run(() => api(`/v1/publicite/authorizations/${id}/pieces`, { method: 'POST', body: { pieces, message: msg } }), onDone); }}>
      <label className="btn btn-secondary btn-sm pk-file"><Icon name="upload" size={16} /> Joindre la pièce demandée
        <input type="file" className="sr-only" onChange={async (e) => { const file = e.target.files?.[0]; if (file) setPieces([{ kind: 'AUTRE', name: file.name, sha256: await sha256Hex(await file.arrayBuffer()) }]); }} /></label>
      {pieces[0] && <p className="small">{pieces[0].name}</p>}
      <label className="field"><span className="label">Message</span><input value={msg} onChange={(e) => setMsg(e.target.value)} /></label>
      <ErrorLine error={act.error} />
      <button type="submit" className="btn btn-primary btn-sm" disabled={act.busy || pieces.length === 0}>Envoyer le complément</button>
    </form>
  );
}

function NoticeCard({ n, onChange }: { n: Notice; onChange: () => void }) {
  const { fmtDate } = useApp();
  return (
    <article className="pk-card">
      <div className="pk-card-head"><div className="min0"><p className="pk-row-title">Avis au redevable — {n.obligationId}</p><p className="pk-sub">{n.source} · {n.label}</p></div>
        <StatusBadge tone={PAYMENT_STATE[n.payment]?.tone ?? 'neutral'} label={PAYMENT_STATE[n.payment]?.label ?? n.payment} /></div>
      <dl className="kv kv-dense">
        <div><dt>Montant</dt><dd><Money items={n.amount} /></dd></div>
        <div><dt>Échéance</dt><dd>{fmtDate(n.dueDate)}</dd></div>
        <div><dt>Base</dt><dd className="mono small">{Object.entries(n.base).map(([k, v]) => `${k} = ${v}`).join(' ; ')}</dd></div>
        <div><dt>Formule et taux</dt><dd className="mono small">{n.formula} — {Object.entries(n.rates).map(([k, v]) => `${k} = ${v}`).join(' ; ')}</dd></div>
        <div><dt>Règle</dt><dd>{n.ruleCode} v{n.ruleVersion} <DemoTag show={n.ruleCode.startsWith('DEMO')} label="Règle fictive" /></dd></div>
        <div><dt>Commune</dt><dd>{n.commune ?? '—'}</dd></div>
        <div><dt>Voie de recours</dt><dd>{n.appealPath}</dd></div>
      </dl>
      {n.payment === 'AUCUNE_REFERENCE' && <PayButton obligationId={n.obligationId} onDone={onChange} />}
    </article>
  );
}

function Notices({ tick, onChange }: { tick: number; onChange: () => void }) {
  const { user } = useApp();
  const list = useApi(() => api<{ items: Notice[] }>('/v1/publicite/obligations/mine').then((r) => r.items), [user?.id, tick]);
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;
  if ((list.data ?? []).length === 0) return <EmptyState title="Aucun avis" icon="file" />;
  return <div className="pk-cards pk-cards-2">{(list.data ?? []).map((n) => <NoticeCard key={n.obligationId} n={n} onChange={onChange} />)}</div>;
}

function Cases({ tick, onChange }: { tick: number; onChange: () => void }) {
  const { fmtDate, user } = useApp();
  const list = useApi(() => api<{ items: Case[] }>('/v1/publicite/cases/mine').then((r) => r.items), [user?.id, tick]);
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;
  return (
    <div className="stack">
      <div className="callout callout-info"><Icon name="shieldCheck" size={18} /><p className="small">Le contrôleur collecte des preuves ; il ne prononce aucune sanction et n’encaisse rien. Vérifiez son badge sur la page publique. Vous pouvez présenter vos observations avant la décision et former un recours ensuite.</p></div>
      {(list.data ?? []).length === 0 ? <EmptyState title="Aucun dossier de contrôle" icon="check" /> : (
        <div className="pk-cards pk-cards-2">
          {(list.data ?? []).map((c) => (
            <article key={c.id} className="pk-card">
              <div className="pk-card-head"><div className="min0"><p className="pk-row-title">{FINDING[c.finding]} · {c.device?.reference}</p><p className="pk-sub">{c.reference} · constat du {fmtDate(c.inspection?.observedAt, true)}</p></div>
                <StatusBadge tone={CASE_STATUS[c.status].tone} label={CASE_STATUS[c.status].label} /></div>
              {c.inspection && <div className="pk-evidence"><span><Icon name="camera" size={14} /> {c.inspection.photos.length} photo(s) scellée(s) · GPS {c.inspection.lat.toFixed(5)}, {c.inspection.lon.toFixed(5)}</span><span>{c.inspection.observations}</span></div>}
              {c.decision && <p className="small"><strong>Décision :</strong> {c.decision.reason} — {c.decision.effect}</p>}
              {c.obligation && <NoticeCard n={{ ...c.obligation, source: `Dossier ${c.reference}` }} onChange={onChange} />}
              <p className="small muted">{c.appealPath}</p>
              {c.contests.map((x) => <p key={x.id} className="small muted">Contestation ({x.stage === 'AVANT_DECISION' ? 'observations' : 'recours'}) : {x.grounds}</p>)}
              {(c.status === 'VERIFIE' || (c.status === 'RETENU' && c.obligation)) && <ContestCase id={c.id} onDone={onChange} />}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function ContestCase({ id, onDone }: { id: string; onDone: () => void }) {
  const [grounds, setGrounds] = useState('');
  const act = useAction();
  return (
    <form className="form pk-reason" onSubmit={(e) => { e.preventDefault(); void act.run(() => api(`/v1/publicite/cases/${id}/contest`, { method: 'POST', body: { grounds } }), onDone); }}>
      <label className="field"><span className="label">Contester</span><textarea rows={2} value={grounds} onChange={(e) => setGrounds(e.target.value)} placeholder="Exposez vos motifs (10 caractères au moins)." /></label>
      <ErrorLine error={act.error} />
      <button type="submit" className="btn btn-secondary btn-sm" disabled={act.busy}>Envoyer</button>
    </form>
  );
}
