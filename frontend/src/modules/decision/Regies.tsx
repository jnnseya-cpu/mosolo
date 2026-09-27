/**
 * Tableaux de bord des régies — module 42 (régie fiscale : assiette, liquidation, recouvrement, contentieux,
 * performance) et module 43 (régie des taxes : recettes par taxe, autorisations, contrôles). Périmètre limité à la
 * compétence de la régie ; lecture seule : affectation des zones et validation des campagnes par leurs circuits.
 */
import type { MoneyJSON } from '@mosolo/shared';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { Section } from '../pilotage/shared';
import { Ecran, Indicateurs, montants, pct, useVue, type Indicator } from './commun';

interface Grp { key: string; obligations: number; assessed: MoneyJSON[]; paid: MoneyJSON[]; reconciled: MoneyJSON[] }
interface Fiscale {
  entity: string; rule: string; indicators: Indicator[];
  assessment: { byRevenue: Grp[]; byCommune: Grp[] };
  recovery: { arrears: { band: string; count: number; amounts: MoneyJSON[] }[]; campaigns: { id: string; code: string; label: string; status: string; period: string; dueDate: string; validation: string }[]; campaignsToValidate: number; link: string };
  litigation: { open: number; decided: number; beyondDelay: number; decisionDelayDays: number; byDecision: { decision: string; count: number }[] };
  performance: { note: string; zones: { commune: string; lots: number; missions: number; open: number; overdue: number; agents: number }[]; agents: { agentId: string; name: string; missions: number; findings: number; validated: number; rejected: number; validationPct: string | null }[]; teams: { team: string; agents: number; findings: number; validated: number }[]; link: string };
}

const grpCols = (label: string) => [
  { key: 'k', label, primary: true, render: (g: Grp) => g.key },
  { key: 'n', label: 'Obligations', num: true, render: (g: Grp) => g.obligations },
  { key: 'a', label: 'Liquidé', num: true, render: (g: Grp) => montants(g.assessed) },
  { key: 'p', label: 'Payé', num: true, render: (g: Grp) => montants(g.paid) },
  { key: 'r', label: 'Rapproché', num: true, render: (g: Grp) => montants(g.reconciled) },
];

export function RegieFiscale() {
  const q = useVue<Fiscale>('/v1/decision/regie-fiscale');
  return (
    <Ecran eyebrow="Pilotage et décision · module 42" title="Tableau de bord de la régie fiscale" lead="Assiette, liquidation, recouvrement et contentieux de la régie ; périmètre limité à la compétence de la régie." q={q}>
      {(d) => (<>
        <Section title={`Indicateurs — ${d.entity}`} sub={d.rule}><Indicateurs items={d.indicators} /></Section>
        <Section title="Assiette et liquidation par recette"><DataTable caption="Par recette" rows={d.assessment.byRevenue} rowKey={(g) => g.key} columns={grpCols('Recette (règle)')} /></Section>
        <Section title="Assiette et liquidation par commune"><DataTable caption="Par commune" rows={d.assessment.byCommune} rowKey={(g) => g.key} columns={grpCols('Commune')} /></Section>
        <Section title="Recouvrement — arriérés" sub="Aucune pénalité automatique : relance selon le calendrier, décision humaine.">
          <DataTable caption="Arriérés" rows={d.recovery.arrears} rowKey={(a) => a.band} columns={[
            { key: 'b', label: 'Ancienneté (jours)', primary: true, render: (a) => a.band },
            { key: 'n', label: 'Obligations', num: true, render: (a) => a.count },
            { key: 'm', label: 'Montants', num: true, render: (a) => montants(a.amounts) },
          ]} />
        </Section>
        <Section title={`Campagnes (${d.recovery.campaignsToValidate} à valider)`} sub="La validation des campagnes se fait à deux personnes dans « Campagnes et calendrier ».">
          <DataTable caption="Campagnes" rows={d.recovery.campaigns} rowKey={(c) => c.id} empty={<p className="muted">Aucune campagne.</p>} columns={[
            { key: 'c', label: 'Campagne', primary: true, render: (c) => `${c.code} — ${c.label}` },
            { key: 's', label: 'Statut', render: (c) => c.status },
            { key: 'v', label: 'Validation', render: (c) => <StatusBadge tone={c.validation === 'VALIDEE' ? 'good' : c.validation === 'A_VALIDER' ? 'warning' : 'neutral'} label={c.validation === 'VALIDEE' ? 'Validée' : c.validation === 'A_VALIDER' ? 'À valider' : 'Non proposée'} /> },
            { key: 'e', label: 'Échéance', render: (c) => c.dueDate },
          ]} />
          <p className="small"><a href={d.recovery.link}>Ouvrir les campagnes</a></p>
        </Section>
        <Section title="Contentieux" sub={`Délai de décision : ${d.litigation.decisionDelayDays} jours.`}>
          <p>Recours ouverts : <strong>{d.litigation.open}</strong> · décidés : <strong>{d.litigation.decided}</strong> · au-delà du délai : <strong>{d.litigation.beyondDelay}</strong></p>
          <p className="small muted">{d.litigation.byDecision.map((b) => `${b.decision} : ${b.count}`).join(' · ') || 'Aucune décision.'}</p>
        </Section>
        <Section title="Zones affectées et suivi des agents" sub={d.performance.note}>
          <DataTable caption="Zones" rows={d.performance.zones} rowKey={(z) => z.commune} columns={[
            { key: 'c', label: 'Commune', primary: true, render: (z) => z.commune },
            { key: 'l', label: 'Lots ouverts', num: true, render: (z) => z.lots },
            { key: 'm', label: 'Missions (ouvertes / en retard)', num: true, render: (z) => `${z.missions} (${z.open} / ${z.overdue})` },
            { key: 'a', label: 'Agents', num: true, render: (z) => z.agents },
          ]} />
          <DataTable caption="Agents" rows={d.performance.agents} rowKey={(a) => a.agentId} columns={[
            { key: 'n', label: 'Agent', primary: true, render: (a) => a.name },
            { key: 'm', label: 'Missions', num: true, render: (a) => a.missions },
            { key: 'f', label: 'Constats validés / rejetés', num: true, render: (a) => `${a.validated} / ${a.rejected}` },
            { key: 'p', label: 'Taux de validation', num: true, render: (a) => pct(a.validationPct) },
          ]} />
          <DataTable caption="Équipes" rows={d.performance.teams} rowKey={(t) => t.team} columns={[
            { key: 't', label: 'Équipe', primary: true, render: (t) => t.team },
            { key: 'a', label: 'Agents', num: true, render: (t) => t.agents },
            { key: 'v', label: 'Constats validés / total', num: true, render: (t) => `${t.validated} / ${t.findings}` },
          ]} />
          <p className="small"><a href={d.performance.link}>Affecter les zones et suivre les agents (supervision terrain)</a></p>
        </Section>
      </>)}
    </Ecran>
  );
}

interface Taxes {
  entity: string; rule: string; indicators: Indicator[];
  byTax: { code: string; label: string; obligations: number; payments: number; assessed: MoneyJSON[]; confirmed: MoneyJSON[]; reconciled: MoneyJSON[] }[];
  authorizations: { titres: Record<string, number>; publicite: Record<string, number> };
  controls: Record<string, { result: string; count: number }[]>;
}

const AUTH_LABELS: Record<string, string> = { total: 'Total', active: 'Actives', expiringIn30Days: 'Échéance sous 30 jours', expired: 'Échues non renouvelées', renewals: 'Renouvellements', granted: 'Accordées', pending: 'En instruction' };

export function RegieTaxes() {
  const q = useVue<Taxes>('/v1/decision/regie-taxes');
  return (
    <Ecran eyebrow="Pilotage et décision · module 43" title="Tableau de bord de la régie des taxes" lead="Droits, taxes et redevances urbaines ; périmètre limité à la compétence de la régie." q={q}>
      {(d) => (<>
        <Section title={`Indicateurs — ${d.entity}`} sub={d.rule}><Indicateurs items={d.indicators} /></Section>
        <Section title="Recettes par taxe">
          <DataTable caption="Recettes par taxe" rows={d.byTax} rowKey={(t) => t.code} columns={[
            { key: 't', label: 'Taxe', primary: true, render: (t) => t.label },
            { key: 'a', label: 'Liquidé', num: true, render: (t) => montants(t.assessed) },
            { key: 'c', label: 'Confirmé', num: true, render: (t) => montants(t.confirmed) },
            { key: 'r', label: 'Rapproché', num: true, render: (t) => montants(t.reconciled) },
          ]} />
        </Section>
        <Section title="Autorisations — échéances et renouvellements">
          {(['titres', 'publicite'] as const).map((k) => (
            <p key={k}><strong>{k === 'titres' ? 'Titres' : 'Autorisations publicitaires'}</strong> : {Object.entries(d.authorizations[k]).map(([x, n]) => `${AUTH_LABELS[x] ?? x} ${n}`).join(' · ')}</p>
          ))}
        </Section>
        <Section title="Contrôles — résultats" sub="Constats soumis à revue ; aucune sanction automatique.">
          {Object.entries(d.controls).map(([k, rows]) => <p key={k}><strong>{k === 'titres' ? 'Titres' : k === 'stationnement' ? 'Stationnement' : 'Publicité'}</strong> : {rows.map((r) => `${r.result} ${r.count}`).join(' · ') || 'aucun contrôle sur la période'}</p>)}
        </Section>
      </>)}
    </Ecran>
  );
}
