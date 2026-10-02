/**
 * Plateforme (modules 52, 53, 55) — visuels (trousse de visualisation, 27/09/2026) dérivés des vues déjà chargées
 * (/v1/plateforme/partenaires, /administration, /supervision). Les cibles de disponibilité et de latence sont celles
 * servies par le serveur avec leur source ; aucune n'est inventée ici.
 */
import type { Tone } from '../../components/StatusBadge';
import { countBy } from '../../lib/aggregate';
import { BarChartViz, ChartGrid, fmtNombre, GaugeMeter } from '../../components/viz';
import { ActiviteParJour, Barres, barresDe, Etats, etatsDe, nombreDe } from './visuels';
import './visuels.css';

export const CALL_OUTCOME: Record<string, { label: string; tone: Tone }> = {
  OK: { label: 'Réussi', tone: 'good' }, NON_AUTHENTIFIE: { label: 'Non authentifié', tone: 'warning' }, PORTEE_INSUFFISANTE: { label: 'Portée insuffisante', tone: 'warning' },
  HORS_OBJET: { label: 'Hors de l’objet contracté', tone: 'critical' }, QUOTA_DEPASSE: { label: 'Quota dépassé', tone: 'serious' }, MTLS_REQUIS: { label: 'Certificat client requis', tone: 'warning' },
  INTROUVABLE: { label: 'Introuvable', tone: 'neutral' }, ERREUR: { label: 'Erreur', tone: 'critical' },
};
export const CHANGE_STATUS: Record<string, { label: string; tone: Tone }> = {
  DEMANDEE: { label: 'Demandée — avis du comité attendu', tone: 'warning' }, APPROUVEE: { label: 'Approuvée — à exécuter', tone: 'info' },
  REFUSEE: { label: 'Refusée', tone: 'neutral' }, EXECUTEE: { label: 'Exécutée', tone: 'good' }, ECHOUEE: { label: 'Échouée', tone: 'critical' },
};
export const CHANGE_KIND: Record<string, string> = { DEPLOIEMENT: 'Déploiement', RETOUR_ARRIERE: 'Retour arrière', CONFIGURATION: 'Configuration technique' };
export const CLIENT_STATUS: Record<string, string> = { ACTIF: 'Actif', REVOQUE: 'Révoqué', SUSPENDU: 'Suspendu' };
export const INCIDENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  DECLARE: { label: 'Déclaré', tone: 'critical' }, PRIS_EN_CHARGE: { label: 'Pris en charge', tone: 'warning' }, RETABLI: { label: 'Rétabli', tone: 'info' }, CLOS: { label: 'Clos', tone: 'good' },
};
const SEVERITE: Record<string, { label: string; tone: Tone }> = { S1: { label: 'S1 — critique', tone: 'critical' }, S2: { label: 'S2 — majeur', tone: 'serious' }, S3: { label: 'S3 — modéré', tone: 'warning' }, S4: { label: 'S4 — mineur', tone: 'neutral' } };
const CONTRAT: Record<string, { label: string; tone: Tone }> = { PROPOSE: { label: 'Proposé', tone: 'warning' }, ACTIF: { label: 'Actif', tone: 'good' }, SUSPENDU: { label: 'Suspendu', tone: 'critical' }, REFUSE: { label: 'Refusé', tone: 'neutral' } };

export function PartenairesVisuels({ d }: { d: {
  contracts: { status: string }[]; clients: { id: string; label: string; calls: number; errors: number; outOfObject: number }[];
  calls: { at: string; outcome: string; latencyMs: number }[]; deliveries: { status: string }[];
} }) {
  return (
    <ChartGrid min={280} className="vz-bloc" label="Partenaires — graphiques">
      <Etats title="Appels par résultat" unitLabel="appels" items={etatsDe(d.calls, (c) => c.outcome, CALL_OUTCOME, Object.keys(CALL_OUTCOME)).filter((i) => i.count > 0 || i.key === 'OK' || i.key === 'HORS_OBJET')} emptyText="Aucun appel journalisé" />
      <Etats title="Contrats d’interface par statut" unitLabel="contrats" items={etatsDe(d.contracts, (c) => c.status, CONTRAT, ['PROPOSE', 'ACTIF', 'SUSPENDU', 'REFUSE'])} emptyText="Aucun contrat" />
      <BarChartViz className="viz-span-2" title="Appels par client" orientation="horizontal" format={(v) => fmtNombre(v, 0)} emptyText="Aucun client"
        series={[{ key: 'c', label: 'Appels' }, { key: 'e', label: 'Erreurs' }, { key: 'h', label: 'Hors objet' }]}
        rows={d.clients.map((c) => ({ key: c.id, label: c.label, values: { c: c.calls, e: c.errors, h: c.outOfObject } }))} />
      <ActiviteParJour title="Appels des partenaires" series={[{ key: 'a', label: 'Appels', items: d.calls.map((c) => ({ at: c.at })) }]} />
      <Barres title="Livraisons d’événements signés" serie="Livraisons" rows={barresDe(countBy(d.deliveries, (x) => x.status))} emptyText="Aucune livraison" />
    </ChartGrid>
  );
}

export function AdministrationVisuels({ d }: { d: { changes: { status: string; kind: string; environment: string }[]; environments: { id: string; label: string; history: { result: string }[] }[] } }) {
  return (
    <ChartGrid min={280} className="vz-bloc" label="Administration — graphiques">
      <Etats title="Demandes de changement par état" unitLabel="demandes" items={etatsDe(d.changes, (c) => c.status, CHANGE_STATUS, ['DEMANDEE', 'APPROUVEE', 'EXECUTEE', 'ECHOUEE', 'REFUSEE'])} emptyText="Aucune demande" />
      <Barres title="Demandes par nature" serie="Demandes" rows={barresDe(countBy(d.changes, (c) => c.kind), CHANGE_KIND)} emptyText="Aucune demande" />
      <BarChartViz className="viz-span-2" title="Changements appliqués par environnement" orientation="horizontal" format={(v) => fmtNombre(v, 0)}
        series={[{ key: 's', label: 'Réussis' }, { key: 'e', label: 'Échoués' }]}
        rows={d.environments.map((e) => ({ key: e.id, label: e.label, values: { s: e.history.filter((h) => h.result === 'SUCCES').length, e: e.history.filter((h) => h.result === 'ECHEC').length } }))} />
    </ChartGrid>
  );
}

export function SupervisionVisuels({ d }: { d: {
  targets: { availabilityPct: string; source: string }; thresholds: { latencyP95Ms: number; status: string };
  window15: { requests: number; errors5xx: number; availabilityPct: string | null; p95Ms: number | null };
  routes: { method: string; route: string; count: number; errors5xx: number; errors4xx: number }[];
  incidents: { status: string; severity: string; detectedAt: string }[];
} }) {
  const top = [...d.routes].sort((a, b) => b.count - a.count).slice(0, 10);
  return (
    <ChartGrid min={280} className="vz-bloc" label="Supervision — graphiques">
      <GaugeMeter title="Disponibilité — fenêtre glissante" subtitle={`${d.window15.requests} requête(s), ${d.window15.errors5xx} erreur(s) serveur`} value={nombreDe(d.window15.availabilityPct)} unit="%"
        target={nombreDe(d.targets.availabilityPct)} targetLabel={d.targets.source} format={(v) => fmtNombre(v, 2)} min={90}
        reason="Aucune requête dans la fenêtre." />
      <GaugeMeter title="Latence p95 — fenêtre glissante" value={d.window15.p95Ms} unit="ms" target={d.thresholds.latencyP95Ms} better="BAISSE"
        targetLabel={`seuil ${d.thresholds.status}`} format={(v) => fmtNombre(v, 0)} reason="Aucune requête dans la fenêtre." />
      <BarChartViz className="viz-span-2" title="Routes les plus sollicitées" subtitle="10 premières (gabarits)" orientation="horizontal" format={(v) => fmtNombre(v, 0)}
        series={[{ key: 'n', label: 'Requêtes' }, { key: 'e5', label: 'Erreurs 5xx' }, { key: 'e4', label: 'Erreurs 4xx' }]}
        rows={top.map((r) => ({ key: `${r.method} ${r.route}`, label: `${r.method} ${r.route}`, values: { n: r.count, e5: r.errors5xx, e4: r.errors4xx } }))} emptyText="Aucune requête dans la fenêtre" />
      <Etats title="Incidents d’exploitation par étape" unitLabel="incidents" items={etatsDe(d.incidents, (i) => i.status, INCIDENT_STATUS, ['DECLARE', 'PRIS_EN_CHARGE', 'RETABLI', 'CLOS'])} emptyText="Aucun incident" />
      <Etats title="Incidents par sévérité" unitLabel="incidents" items={etatsDe(d.incidents, (i) => i.severity, SEVERITE, ['S1', 'S2', 'S3', 'S4'])} emptyText="Aucun incident" />
    </ChartGrid>
  );
}
