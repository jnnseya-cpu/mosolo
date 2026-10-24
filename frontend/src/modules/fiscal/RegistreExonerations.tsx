/**
 * Registre des exonérations — module 57 : indicateurs (actives, montants, anomalies), échéances et révisions à venir,
 * rappels automatiques envoyés (contribuable et services d'assiette), alertes de concentration (décideur, agent, zone).
 */
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { DataTable } from '../../components/DataTable';
import { hasRole, useRunner } from '../pilotage/planif';
import { Section } from '../pilotage/shared';
import { date, Indicateurs, type Indicator } from '../decision/commun';

interface Registre {
  indicators: Indicator[]; alerts: { dimension: string; key: string; message: string }[];
  reminders: { id: string; exemptionId: string; kind: string; dueDate: string; at: string; notified: string[] }[];
  upcoming: { id: string; kind: string; effectiveStatus: string; validTo: string | null; reviewDate: string }[];
  params: { reminderDays: number; reviewMonths: number; status: string };
}
const KIND: Record<string, string> = { ECHEANCE_PROCHE: 'Échéance proche', EXPIREE: 'Échue', REVISION_DUE: 'Révision due' };

export function RegistreExonerations() {
  const { user } = useApp();
  const allowed = hasRole(user?.roles, 'R06', 'R07', 'R11', 'R12', 'R13', 'R14', 'R22', 'R24');
  const q = useApi(allowed ? () => api<Registre>('/v1/fiscal/exemptions/registre') : null, [user?.id]);
  const r = useRunner(q.reload);
  if (!allowed || !q.data) return null;
  const d = q.data;
  return (
    <div className="dash-grid">
      <Section title="Indicateurs du registre" sub={`Rappel ${d.params.reminderDays} jours avant l’échéance ; révision tous les ${d.params.reviewMonths} mois sans échéance (${d.params.status}).`}>
        <Indicateurs items={d.indicators} />
        {r.msg && <p className={r.msg.ok ? 'notice notice-ok' : 'notice notice-err'} role="status">{r.msg.text}</p>}
        {hasRole(user?.roles, 'R06', 'R07') && <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/fiscal/exemptions/rappels', {}, 'Échéances et révisions vérifiées.')}>Vérifier les échéances maintenant</button>}
      </Section>
      <Section title="Échéances et révisions à venir">
        <DataTable caption="À venir" rows={d.upcoming} rowKey={(x) => x.id} empty={<p className="muted">Aucune exonération active.</p>} columns={[
          { key: 'i', label: 'Décision', primary: true, render: (x) => `${x.id} (${x.kind === 'REMISE' ? 'remise' : 'exonération'})` },
          { key: 's', label: 'Statut effectif', render: (x) => x.effectiveStatus },
          { key: 'e', label: 'Échéance / révision', render: (x) => (x.validTo ? `Échéance ${x.validTo}` : `Révision ${x.reviewDate}`) },
        ]} />
      </Section>
      <Section title="Rappels envoyés automatiquement">
        <DataTable caption="Rappels" rows={d.reminders} rowKey={(x) => x.id} empty={<p className="muted">Aucun rappel.</p>} columns={[
          { key: 'a', label: 'Date', render: (x) => date(x.at) },
          { key: 'e', label: 'Exonération', primary: true, render: (x) => x.exemptionId },
          { key: 'k', label: 'Nature', render: (x) => `${KIND[x.kind] ?? x.kind} (${x.dueDate})` },
          { key: 'n', label: 'Destinataires', num: true, render: (x) => x.notified.length },
        ]} />
      </Section>
    </div>
  );
}
