/**
 * Socle (dérogations, extractions, profils, récupération) — visuels (trousse de visualisation, 27/09/2026),
 * dérivés des listes déjà chargées par chaque écran. Le seuil d'extraction affiché est celui servi par le registre
 * (par défaut — à confirmer) ; aucun chiffre n'est inventé.
 */
import type { Tone } from '../../components/StatusBadge';
import { countBy } from '../../lib/aggregate';
import { BarChartViz, ChartGrid, fmtNombre } from '../../components/viz';
import { ActiviteParJour, Barres, barresDe, Etats, etatsDe } from '../plateforme/visuels';
import '../plateforme/visuels.css';

type Map = Record<string, { label: string; tone: Tone } | readonly [string, Tone]>;

export function DerogationsVisuels({ items, statuts }: { items: { status: string; requestedAt: string; lowered: { field: string }[] }[]; statuts: Map }) {
  return (
    <ChartGrid min={280} className="vz-bloc" label="Dérogations — graphiques">
      <Etats title="Dérogations par état" unitLabel="dérogations" items={etatsDe(items, (b) => b.status, statuts, ['DEMANDEE', 'APPROUVEE', 'REFUSEE', 'UTILISEE'])} emptyText="Aucune dérogation"
        note="Quatre yeux : le demandeur ne décide jamais sa propre dérogation." />
      <Barres title="Champs abaissés" serie="Dérogations" rows={barresDe(countBy(items.flatMap((b) => b.lowered.map((l) => ({ f: l.field }))), (x) => x.f))} emptyText="Aucun champ abaissé" />
      <ActiviteParJour className="viz-span-2" title="Demandes de dérogation" series={[{ key: 'd', label: 'Demandes', items: items.map((b) => ({ at: b.requestedAt })) }]} />
    </ChartGrid>
  );
}

export function ExtractionsVisuels({ items, threshold, statuts }: { items: { id: string; status: string; rowsAtRequest: number; requestedAt: string }[]; threshold: number; statuts: Map }) {
  return (
    <ChartGrid min={280} className="vz-bloc" label="Extractions — graphiques">
      <Etats title="Extractions massives par étape" unitLabel="demandes" items={etatsDe(items, (r) => r.status, statuts, ['DEMANDEE', 'VISA_DONNEES', 'APPROUVEE', 'REFUSEE', 'EXPIREE', 'RETIREE'])}
        emptyText="Aucune demande d’extraction massive" note="Demandeur motivé → responsable des données → comité des données." />
      <BarChartViz title="Lignes demandées au regard du seuil" orientation="horizontal" series={[{ key: 'n', label: 'Lignes' }]}
        rows={items.slice(0, 10).map((r) => ({ key: r.id, label: r.id, values: { n: r.rowsAtRequest } }))} format={(v) => fmtNombre(v, 0)}
        reference={{ value: threshold, label: `Seuil ${fmtNombre(threshold, 0)} lignes (par défaut — à confirmer)` }} emptyText="Aucune demande d’extraction massive" />
    </ChartGrid>
  );
}

const ROLE_STATUS_ORDRE = ['EN_INSTRUCTION', 'COMPLEMENT_DEMANDE', 'CONFIRMEE', 'REJETEE'];

export function ProfilsVisuels({ profiles, roles, statuts, titre }: { profiles?: { code: string; label: string; fields: unknown[] }[]; roles?: { status: string; declaredAt: string }[]; statuts: Map; titre: string }) {
  return (
    <ChartGrid min={280} className="vz-bloc" label="Profils — graphiques">
      {roles && <Etats title={titre} unitLabel="déclarations" items={etatsDe(roles, (r) => r.status, statuts, ROLE_STATUS_ORDRE)} emptyText="Aucun rôle déclaré" note="Déclarer un rôle ouvre une instruction : ni propriété ni dette." />}
      {profiles && <Barres title="Questions posées par parcours" subtitle="chaque parcours ne demande que l’utile" serie="Questions" rows={profiles.map((p) => ({ key: p.code, label: p.label, values: { n: p.fields.length } }))} emptyText="Aucun parcours publié" />}
      {roles && roles.length > 0 && <ActiviteParJour title="Déclarations de rôle" series={[{ key: 'r', label: 'Déclarations', items: roles.map((r) => ({ at: r.declaredAt })) }]} />}
    </ChartGrid>
  );
}

export function RecuperationsVisuels({ items }: { items: { status: string; requestedAt: string }[] }) {
  return (
    <ChartGrid min={280} className="vz-bloc" label="Récupérations — graphiques">
      <Etats title="Demandes de récupération par étape" unitLabel="demandes" emptyText="Aucune demande en cours"
        items={etatsDe(items, (r) => r.status, { DEMANDEE: { label: 'Vérification au guichet attendue', tone: 'warning' }, VERIFIEE: { label: 'Identité vérifiée — approbation attendue', tone: 'info' } }, ['DEMANDEE', 'VERIFIEE'])} />
      <ActiviteParJour title="Demandes reçues" series={[{ key: 'r', label: 'Demandes', items: items.map((r) => ({ at: r.requestedAt })) }]} />
    </ChartGrid>
  );
}
