/**
 * Surveillance technique (§ 25.1, § 18.4 / H.10, § 40) : empreintes et attestation des appareils (un appareil qui sert
 * plusieurs comptes), plausibilité GPS des actions de terrain, plafonds de références de paiement par canal et par
 * agent, présentés avec les plafonds par point agréé. Alertes seulement : aucune sanction ni révocation automatique.
 */
import { useState } from 'react';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { useApp } from '../../context';
import { hasRole } from './shared';
import './integrite.css';

interface Device { id: string; kind: 'EMPREINTE' | 'TERMINAL'; accounts: { userId: string }[]; lastSeen: string; multiAccounts: boolean; attestation: { status: string; mdmEnrolled: boolean | null; rooted: boolean | null; source: string; updatedBy?: string } }
interface Devices { items: Device[]; max: number; mdm: { note: string } }
interface GpsAnomaly { id: string; userId: string; distanceKm: number; seconds: number; speedKmh: number; maxKmh: number; detectedAt: string; from: { action?: string }; to: { action?: string } }
interface Ceilings { day: string; channels: { channel: string; today: number; alertPerDay: number; maxPerDay: number }[]; agent: { alertPerDay: number; maxPerDay: number }; agents: { userId: string; today: number }[]; points: { id: string; name: string; status: string | null }[]; note: string }

const ATTESTATION: Record<string, [string, Tone]> = {
  NON_ATTESTE: ['Non attesté', 'neutral'], CONFORME: ['Conforme', 'good'], NON_CONFORME: ['Non conforme', 'critical'], INCONNU: ['Inconnu', 'warning'],
};
const fixe = (n: number) => (n > 0 ? String(n) : 'non fixé');

export default function SurveillanceTechnique() {
  const { user, fmtDate } = useApp();
  const allowed = hasRole(user?.roles, 'R28', 'R22', 'R24', 'R09', 'R27');
  const canAttest = hasRole(user?.roles, 'R28', 'R27');
  const devices = useApi(allowed ? () => api<Devices>('/v1/integrite/appareils') : null, [user?.id]);
  const gps = useApi(allowed ? () => api<{ items: GpsAnomaly[]; maxKmh: number }>('/v1/integrite/gps/anomalies') : null, [user?.id]);
  const ceilings = useApi(allowed ? () => api<Ceilings>('/v1/integrite/plafonds-references') : null, [user?.id]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const attest = async (d: Device) => {
    const status = window.prompt('Statut d’attestation (CONFORME, NON_CONFORME, INCONNU)', 'CONFORME')?.trim().toUpperCase();
    if (!status || !['CONFORME', 'NON_CONFORME', 'INCONNU'].includes(status)) return;
    const note = window.prompt('Constat (source MDM ou vérification déclarative)');
    if (!note || note.trim().length < 5) return;
    try {
      await api(`/v1/integrite/appareils/${encodeURIComponent(d.id)}/attestation`, { method: 'POST', body: { status, source: 'DECLARATIF', note: note.trim() } });
      setMsg({ ok: true, text: 'Attestation enregistrée et journalisée.' }); devices.reload();
    } catch (e) { setMsg({ ok: false, text: describeError(e).message }); }
  };

  if (!allowed) return <div className="page"><PageHead eyebrow="Sécurité" title="Surveillance technique" /><EmptyState title="Accès réservé" icon="lock">Réservé à la sécurité, à l’audit, à l’anti-fraude et à la supervision.</EmptyState></div>;
  return (
    <div className="page page-wide ig-page">
      <PageHead eyebrow="Sécurité" title="Surveillance technique (appareils, GPS, plafonds)"
        lead="Signaux explicables à examiner par une personne : appareil partagé entre comptes, déplacement impossible entre deux actions de terrain, volume anormal de références de paiement." />
      {msg && <p className={`notice ${msg.ok ? 'notice-ok' : 'notice-err'}`} role="status">{msg.text}</p>}

      <h2 className="panel-title">Appareils</h2>
      {devices.loading && <Loading />}
      {devices.error !== null && <ErrorState error={devices.error} onRetry={devices.reload} />}
      {devices.data && (
        <>
          <p className="callout callout-info ig-note"><Icon name="phone" size={18} /><span>{devices.data.mdm.note} Seuil : {devices.data.max} compte(s) par appareil (par défaut — à confirmer).</span></p>
          <DataTable rows={devices.data.items} rowKey={(d) => d.id} caption="Appareils" empty={<EmptyState title="Aucun appareil observé" icon="phone" />}
            columns={[
              { key: 'i', label: 'Appareil', primary: true, render: (d) => <><span className="row-title mono small">{d.id}</span><span className="small muted">{d.kind === 'TERMINAL' ? 'Terminal enrôlé' : 'Empreinte de navigateur'}</span></> },
              { key: 'c', label: 'Comptes', render: (d) => <span className="small">{d.accounts.map((a) => a.userId).join(', ') || '—'} {d.multiAccounts && <StatusBadge tone="serious" label="Plusieurs comptes" />}</span> },
              { key: 'a', label: 'Attestation', render: (d) => <StatusBadge tone={(ATTESTATION[d.attestation.status] ?? ['', 'neutral'])[1]} label={(ATTESTATION[d.attestation.status] ?? [d.attestation.status])[0]} /> },
              { key: 'x', label: '', render: (d) => (canAttest ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => void attest(d)}>Attester</button> : null) },
            ]} />
        </>
      )}

      <h2 className="panel-title">Plausibilité GPS</h2>
      {gps.data && (
        <DataTable rows={gps.data.items} rowKey={(g) => g.id} caption="Anomalies GPS" empty={<EmptyState title="Aucun déplacement implausible" icon="gps">Seuil : {gps.data.maxKmh} km/h (par défaut — à confirmer).</EmptyState>}
          columns={[
            { key: 'u', label: 'Agent', primary: true, render: (g) => <><span className="row-title">{g.userId}</span><span className="small muted">{fmtDate(g.detectedAt, true)}</span></> },
            { key: 'd', label: 'Déplacement', render: (g) => <span className="small">{g.distanceKm} km en {g.seconds} s</span> },
            { key: 's', label: 'Vitesse', num: true, render: (g) => `${g.speedKmh} km/h` },
            { key: 'a', label: 'Actions', full: true, render: (g) => <span className="small">{g.from.action ?? '?'} → {g.to.action ?? '?'}</span> },
          ]} />
      )}

      <h2 className="panel-title">Plafonds de références de paiement</h2>
      {ceilings.data && (
        <>
          <p className="callout callout-info ig-note"><Icon name="scale" size={18} /><span>{ceilings.data.note} Agent : alerte {fixe(ceilings.data.agent.alertPerDay)}, plafond {fixe(ceilings.data.agent.maxPerDay)} par jour.</span></p>
          <DataTable rows={ceilings.data.channels} rowKey={(c) => c.channel} caption="Canaux"
            columns={[
              { key: 'c', label: 'Canal', primary: true, render: (c) => <span className="row-title">{c.channel}</span> },
              { key: 't', label: `Références du ${ceilings.data.day}`, num: true, render: (c) => c.today },
              { key: 'a', label: 'Seuil d’alerte', render: (c) => fixe(c.alertPerDay) },
              { key: 'm', label: 'Plafond', render: (c) => fixe(c.maxPerDay) },
            ]} />
          {ceilings.data.agents.length > 0 && <p className="small">Agents du jour : {ceilings.data.agents.map((a) => `${a.userId} (${a.today})`).join(', ')}</p>}
          <p className="small muted">Points agréés soumis à leurs plafonds propres (fiche du point) : {ceilings.data.points.length}.</p>
        </>
      )}
    </div>
  );
}
