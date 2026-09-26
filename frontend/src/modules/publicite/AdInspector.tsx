/**
 * Inspection de la publicité extérieure — KIN PUB CONTROL : recherche automatique de l'autorisation (référence,
 * plaque QR, texte lu), constat photographique géolocalisé par un inspecteur ACCRÉDITÉ, inventaire et carte,
 * vérification des dossiers par le superviseur (personne distincte). Aucune sanction prononcée par l'application.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { ErrorLine, GpsField, hasRole, MiniMap, PhotoHashes, ReasonForm, useAction } from '../parking/shared';
import { AD_TYPE, CASE_STATUS, DEVICE_STATUS, FINDING, LIGHTING, RIGHTS, type Case, type Device, type DeviceStatus } from './types';
import '../parking/parking.css';

type Tab = 'control' | 'inventory' | 'verify' | 'mine';
interface Lookup { detected: { deviceReferences: string[]; authorizationReferences: string[] }; matches: { id: string; reference: string; type: string; commune: string; address: string; status: DeviceStatus; authorization: { reference: string; validUntil: string } | null; rights: Device['rights'] }[]; notice: string }

export default function AdInspector() {
  const { user } = useApp();
  const isInspector = hasRole(user?.roles, 'R11');
  const isSupervisor = hasRole(user?.roles, 'R09', 'R06', 'R07');
  const [tab, setTab] = useState<Tab>(isInspector ? 'control' : 'inventory');
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);
  const badge = useApi(user ? () => api<{ accredited: boolean; validUntil: string | null; communes: string[]; status: string }>(`/v1/publicite/public/badges/${encodeURIComponent(user.id)}`) : null, [user?.id, tick]);
  if (!isInspector && !isSupervisor) {
    return (
      <div className="page">
        <PageHead eyebrow="KIN PUB CONTROL" title="Inspection de la publicité" />
        <EmptyState title="Écran réservé aux inspecteurs accrédités et superviseurs" icon="lock">Choisissez « Inspectrice publicité accréditée » ou « Superviseur des inspections publicitaires » dans l’en-tête.</EmptyState>
      </div>
    );
  }
  const tabs: [Tab, string][] = [
    ...(isInspector ? [['control', 'Contrôle'] as [Tab, string]] : []),
    ['inventory', 'Inventaire et carte'],
    ...(hasRole(user?.roles, 'R09') ? [['verify', 'Vérification'] as [Tab, string]] : []),
    ['mine', isInspector ? 'Mes constats' : 'Constats'],
  ];
  return (
    <div className="page page-wide">
      <PageHead eyebrow="KIN PUB CONTROL · terrain" title="Inspection de la publicité extérieure"
        lead="Le contrôleur collecte des preuves, l’autorité décide, la technologie trace. Un constat ne peut être ni modifié ni supprimé ; aucun encaissement sur le terrain.">
        {isInspector && badge.data && <StatusBadge tone={badge.data.accredited ? 'good' : 'critical'} icon="shieldCheck" label={badge.data.accredited ? `Accrédité·e jusqu’au ${badge.data.validUntil} (${badge.data.communes.join(', ')})` : 'Non accrédité·e : constat impossible'} />}
      </PageHead>
      <div className="seg seg-wrap pk-tabs" role="tablist" aria-label="Rubriques">
        {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-pressed={tab === k} aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'control' && <Control onDone={refresh} />}
      {tab === 'inventory' && <Inventory tick={tick} />}
      {tab === 'verify' && <Verify tick={tick} onChange={refresh} />}
      {tab === 'mine' && <Constats tick={tick} />}
    </div>
  );
}

function Control({ onDone }: { onDone: () => void }) {
  const { fmtDate } = useApp();
  const [q, setQ] = useState('');
  const [lk, setLk] = useState<Lookup | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [finding, setFinding] = useState('CONFORME');
  const [photos, setPhotos] = useState<string[]>([]);
  const [lat, setLat] = useState('-4.3050');
  const [lon, setLon] = useState('15.3100');
  const [acc, setAcc] = useState<number | undefined>();
  const [obs, setObs] = useState('');
  const [operator, setOperator] = useState('');
  const [nd, setNd] = useState({ type: 'PANNEAU', widthM: '4.00', heightM: '3.00', faces: 1, lighting: 'NON_ECLAIRE', commune: 'Gombe', quartier: '', address: '', localityRank: 1 });
  const [done, setDone] = useState<{ inspection: { reference: string }; case: Case | null } | null>(null);
  const search = useAction();
  const act = useAction();
  function lookup(e: FormEvent) {
    e.preventDefault();
    setDone(null);
    void search.run(() => api<Lookup>(`/v1/publicite/lookup?q=${encodeURIComponent(q)}`), (r) => { setLk(r); setDeviceId(r.matches[0]?.id ?? null); setFinding(r.matches.length ? 'CONFORME' : 'NON_DECLARE'); });
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (photos.length === 0) { act.setError('Au moins une photographie est obligatoire.'); return; }
    const body = {
      finding, photos, lat: Number(lat), lon: Number(lon), observations: obs || 'Constat sur place.',
      ...(acc !== undefined ? { gpsAccuracyM: acc } : {}), ...(q.trim() ? { ocrText: q.trim() } : {}), ...(operator.trim() ? { presumedOperator: operator.trim() } : {}),
      ...(deviceId ? { deviceId } : { newDevice: nd }),
    };
    void act.run(() => api<{ inspection: { reference: string }; case: Case | null }>('/v1/publicite/inspections', { method: 'POST', body }), (r) => { setDone(r); setPhotos([]); setObs(''); onDone(); });
  }
  return (
    <div className="pk-grid pk-grid-2">
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="qr" size={18} /> Rechercher l’autorisation</h2><p className="panel-sub">Référence du support, jeton de la plaque QR, référence d’autorisation ou texte lu sur le panneau (lecture optique).</p></div></header>
        <form className="form" onSubmit={lookup}>
          <label className="field"><span className="label">Texte ou référence</span><textarea rows={2} value={q} onChange={(e) => setQ(e.target.value)} placeholder="ex. PUB-GOM-000001 ou texte lu sur le support" /></label>
          <button type="submit" className="btn btn-primary btn-sm" disabled={search.busy}><Icon name="sort" size={16} /> Rechercher</button>
        </form>
        <ErrorLine error={search.error} />
        {lk && (
          <div className="stack-sm" style={{ marginTop: 12 }}>
            <p className="small muted">{lk.notice}{lk.detected.deviceReferences.length + lk.detected.authorizationReferences.length > 0 ? ` Références repérées : ${[...lk.detected.deviceReferences, ...lk.detected.authorizationReferences].join(', ')}.` : ''}</p>
            {lk.matches.length === 0 ? <p className="notice notice-err">Aucune autorisation trouvée : si le support n’a pas de plaque, il est présumé non enregistré.</p> : (
              <ul className="list-rows">
                {lk.matches.map((m) => (
                  <li key={m.id} className="list-row">
                    <label className="check min0"><input type="radio" name="dev" checked={deviceId === m.id} onChange={() => setDeviceId(m.id)} /> <span><strong>{m.reference}</strong> · {AD_TYPE[m.type]} · {m.address}</span></label>
                    <div className="row-side"><StatusBadge tone={DEVICE_STATUS[m.status].tone} label={DEVICE_STATUS[m.status].label} /><StatusBadge tone={RIGHTS[m.rights].tone} label={RIGHTS[m.rights].label} />{m.authorization && <span className="small">jusqu’au {fmtDate(m.authorization.validUntil)}</span>}</div>
                  </li>
                ))}
                <li className="list-row"><label className="check"><input type="radio" name="dev" checked={deviceId === null} onChange={() => { setDeviceId(null); setFinding('NON_DECLARE'); }} /> Aucun de ces supports (support non enregistré)</label></li>
              </ul>
            )}
          </div>
        )}
      </section>
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="camera" size={18} /> Constat</h2><p className="panel-sub">Photos, position et heure serveur. Un constat non conforme ouvre un dossier transmis au superviseur.</p></div></header>
        {done ? (
          <div className="result-card" role="status">
            <StatusBadge tone="good" label="Constat enregistré" />
            <p className="small">Référence <span className="mono">{done.inspection.reference}</span>{done.case ? <> · dossier <span className="mono">{done.case.reference}</span> transmis pour vérification.</> : ' · aucun dossier (support conforme).'}</p>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setDone(null); setLk(null); setQ(''); }}>Nouveau contrôle</button>
          </div>
        ) : (
          <form className="form" onSubmit={submit}>
            <fieldset className="field"><legend className="label">Constat</legend>
              <div className="seg seg-wrap">{Object.entries(FINDING).filter(([k]) => deviceId !== null || k === 'NON_DECLARE').map(([k, v]) => <button key={k} type="button" aria-pressed={finding === k} onClick={() => setFinding(k)}>{v}</button>)}</div></fieldset>
            {deviceId === null && (
              <div className="stack-sm">
                <p className="small"><strong>Support non enregistré :</strong> décrivez-le pour l’inscrire à l’inventaire.</p>
                <div className="field-row">
                  <label className="field"><span className="label">Type</span><select value={nd.type} onChange={(e) => setNd({ ...nd, type: e.target.value })}>{Object.entries(AD_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                  <label className="field"><span className="label">Éclairage</span><select value={nd.lighting} onChange={(e) => setNd({ ...nd, lighting: e.target.value })}>{Object.entries(LIGHTING).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                </div>
                <div className="field-row">
                  <label className="field"><span className="label">Largeur (m)</span><input value={nd.widthM} onChange={(e) => setNd({ ...nd, widthM: e.target.value })} /></label>
                  <label className="field"><span className="label">Hauteur (m)</span><input value={nd.heightM} onChange={(e) => setNd({ ...nd, heightM: e.target.value })} /></label>
                </div>
                <div className="field-row">
                  <label className="field"><span className="label">Commune</span><input value={nd.commune} onChange={(e) => setNd({ ...nd, commune: e.target.value })} /></label>
                  <label className="field"><span className="label">Quartier</span><input value={nd.quartier} onChange={(e) => setNd({ ...nd, quartier: e.target.value })} /></label>
                </div>
                <label className="field"><span className="label">Adresse ou repère</span><input value={nd.address} onChange={(e) => setNd({ ...nd, address: e.target.value })} /></label>
                <label className="field"><span className="label">Exploitant présumé (mention visible)</span><input value={operator} onChange={(e) => setOperator(e.target.value)} /></label>
              </div>
            )}
            <PhotoHashes value={photos} onChange={setPhotos} />
            <GpsField lat={lat} lon={lon} onChange={(a, b, c) => { setLat(a); setLon(b); if (c !== undefined) setAcc(c); }} />
            <label className="field"><span className="label">Observations</span><textarea rows={3} value={obs} onChange={(e) => setObs(e.target.value)} /></label>
            <ErrorLine error={act.error} />
            <button type="submit" className="btn btn-primary" disabled={act.busy}>{act.busy ? 'Envoi…' : 'Enregistrer le constat'}</button>
          </form>
        )}
      </section>
    </div>
  );
}

function Inventory({ tick }: { tick: number }) {
  const { fmtDate } = useApp();
  const [status, setStatus] = useState<string>('');
  const inv = useApi(() => api<{ items: Device[] }>('/v1/publicite/inventory').then((r) => r.items), [tick]);
  if (inv.loading && !inv.data) return <Loading />;
  if (inv.error) return <ErrorState error={inv.error} onRetry={inv.reload} />;
  const all = inv.data ?? [];
  const rows = all.filter((d) => !status || d.status === status);
  return (
    <div className="stack">
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="pin" size={18} /> Carte des supports</h2><p className="panel-sub">Cercle extérieur : dossier de contrôle ouvert ou échéance proche.</p></div>
          <div className="seg seg-sm seg-wrap">{['', 'AUTORISE', 'DECLARE', 'NON_DECLARE', 'EXPIRE', 'RETIRE'].map((s) => <button key={s || 'all'} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>{s ? DEVICE_STATUS[s as DeviceStatus].label.split(' —')[0] : 'Tous'}</button>)}</div></header>
        <MiniMap caption="Carte des supports publicitaires" height={320}
          points={rows.map((d) => ({ id: d.id, lat: d.lat, lon: d.lon, color: DEVICE_STATUS[d.status].color, label: `${d.reference} — ${DEVICE_STATUS[d.status].label}`, ring: !!d.openCase || d.expiringSoon }))} />
        <div className="pk-legend">{(Object.keys(DEVICE_STATUS) as DeviceStatus[]).map((s) => <span key={s}><i style={{ background: DEVICE_STATUS[s].color }} /> {DEVICE_STATUS[s].label}</span>)}</div>
      </section>
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="table" size={18} /> Inventaire géolocalisé</h2></div></header>
        <DataTable<Device> rows={rows} rowKey={(d) => d.id} caption="Inventaire des supports" empty={<p className="muted small">Aucun support.</p>}
          columns={[
            { key: 'ref', label: 'Référence', primary: true, render: (d) => <span className="mono">{d.reference}</span> },
            { key: 'type', label: 'Type', render: (d) => `${AD_TYPE[d.type]} · ${LIGHTING[d.lighting]}` },
            { key: 'fmt', label: 'Surface × faces', num: true, render: (d) => `${d.surfaceM2.replace('.', ',')} m² × ${d.faces}` },
            { key: 'loc', label: 'Lieu', render: (d) => `${d.commune} · ${d.address}` },
            { key: 'own', label: 'Exploitant', render: (d) => d.owner?.name ?? (d.presumedOperator ? `présumé : ${d.presumedOperator}` : 'non identifié') },
            { key: 'st', label: 'Situation', render: (d) => <StatusBadge tone={DEVICE_STATUS[d.status].tone} label={DEVICE_STATUS[d.status].label} /> },
            { key: 'aut', label: 'Échéance', render: (d) => d.authorization ? fmtDate(d.authorization.validUntil) : '—' },
            { key: 'rights', label: 'Droits', render: (d) => <StatusBadge tone={RIGHTS[d.rights].tone} label={RIGHTS[d.rights].label} /> },
          ]} />
      </section>
    </div>
  );
}

function CaseCard({ c, children }: { c: Case; children?: ReactNode }) {
  const { fmtDate } = useApp();
  return (
    <article className="pk-card">
      <div className="pk-card-head"><div className="min0"><p className="pk-row-title">{FINDING[c.finding]} · {c.device?.reference}</p><p className="pk-sub">{c.reference} · {c.device?.address} ({c.commune}) · inspecteur {c.inspection?.inspectorId}</p></div>
        <StatusBadge tone={CASE_STATUS[c.status].tone} label={CASE_STATUS[c.status].label} /></div>
      {c.inspection && (
        <div className="pk-evidence">
          <span><Icon name="camera" size={14} /> {c.inspection.photos.length} photo(s) · GPS {c.inspection.lat.toFixed(5)}, {c.inspection.lon.toFixed(5)} · {fmtDate(c.inspection.observedAt, true)}</span>
          <span>{c.inspection.observations}</span>
          {c.inspection.presumedOperator && <span>Exploitant présumé : {c.inspection.presumedOperator}</span>}
          {c.inspection.ocrMatches.length > 0 && <span>Lecture optique (proposition) : {c.inspection.ocrMatches.join(', ')}</span>}
        </div>
      )}
      {c.verification && <p className="small"><strong>Vérification ({c.verification.by}) :</strong> {c.verification.note}</p>}
      {c.decision && <p className="small"><strong>Décision ({c.decision.by}) :</strong> {c.decision.reason} — {c.decision.effect}</p>}
      {children}
    </article>
  );
}

function Verify({ tick, onChange }: { tick: number; onChange: () => void }) {
  const list = useApi(() => api<{ items: Case[] }>('/v1/publicite/cases?status=CONSTATE').then((r) => r.items), [tick]);
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;
  if ((list.data ?? []).length === 0) return <EmptyState title="Aucun dossier à vérifier" icon="check" />;
  return (
    <div className="pk-cards pk-cards-2">
      {(list.data ?? []).map((c) => (
        <CaseCard key={c.id} c={c}>
          <div className="pk-grid pk-grid-even">
            <ReasonForm confirmLabel="Confirmer les preuves" placeholder="Note de vérification" onSubmit={(note) => api(`/v1/publicite/cases/${c.id}/verify`, { method: 'POST', body: { confirm: true, note } }).then(onChange)} />
            <ReasonForm confirmLabel="Écarter (qualité)" danger placeholder="Motif du rejet" onSubmit={(note) => api(`/v1/publicite/cases/${c.id}/verify`, { method: 'POST', body: { confirm: false, note } }).then(onChange)} />
          </div>
        </CaseCard>
      ))}
    </div>
  );
}

function Constats({ tick }: { tick: number }) {
  const { fmtDate } = useApp();
  const list = useApi(() => api<{ items: { id: string; reference: string; finding: string; observedAt: string; deviceId: string; photos: string[]; caseId: string | null; observations: string }[] }>('/v1/publicite/inspections').then((r) => r.items), [tick]);
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;
  return (
    <section className="panel">
      <header className="panel-head"><div><h2 className="panel-title"><Icon name="history" size={18} /> Constats enregistrés</h2><p className="panel-sub">Registre en ajout seul : aucune modification ni suppression possible.</p></div></header>
      <ul className="list-rows">
        {(list.data ?? []).map((i) => (
          <li key={i.id} className="list-row">
            <div className="min0"><p className="pk-row-title">{FINDING[i.finding]} · <span className="mono">{i.reference}</span></p><p className="pk-sub">{fmtDate(i.observedAt, true)} · {i.photos.length} photo(s) · {i.observations}</p></div>
            <div className="row-side">{i.caseId ? <StatusBadge tone="warning" label="Dossier ouvert" /> : <StatusBadge tone="good" label="Sans suite" />}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
