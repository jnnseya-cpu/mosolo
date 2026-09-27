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
import { BarChartViz, fmtNombre, KpiTile, StatusDistribution } from '../../components/viz';
import type { Tone } from '../../components/StatusBadge';
import { BarresParDevise, EtatIndicateurs, etatsDe, nombre, Tuiles, TuilesIndicateurs, Visuels } from '../pilotage/visuels';

const entier = (v: number) => fmtNombre(v, 0);
const VALIDATION = { VALIDEE: { label: 'Validée', tone: 'good' as Tone }, A_VALIDER: { label: 'À valider', tone: 'warning' as Tone }, NON_PROPOSEE: { label: 'Non proposée', tone: 'neutral' as Tone } };

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

const NIVEAUX_FISCAUX = [{ key: 'assessed', label: 'Liquidé' }, { key: 'paid', label: 'Payé' }, { key: 'reconciled', label: 'Rapproché' }];

/** Visuels de la régie fiscale (données de la vue, périmètre de la régie). */
function VisuelsFiscale({ d }: { d: Fiscale }) {
  const obligations = d.assessment.byRevenue.reduce((s, g) => s + g.obligations, 0);
  const arrieres = d.recovery.arrears.reduce((s, a) => s + a.count, 0);
  return (
    <>
      <Tuiles label={`Régie fiscale ${d.entity} — chiffres clés`} max={4}>
        <KpiTile hero label="Obligations liquidées" value={obligations} format={entier} state={{ label: 'Constaté', tone: 'info' }} sub={`${d.assessment.byRevenue.length} recette(s) · ${d.assessment.byCommune.length} commune(s)`} />
        <KpiTile label="Obligations en arriéré" value={arrieres} format={entier} state={arrieres > 0 ? { label: 'À relancer', tone: 'warning' } : { label: 'Aucun arriéré', tone: 'good' }} sub="Relance selon le calendrier ; décision humaine" />
        <KpiTile label="Recours ouverts" value={d.litigation.open} format={entier} state={d.litigation.beyondDelay > 0 ? { label: `${d.litigation.beyondDelay} hors délai`, tone: 'critical' } : { label: 'Dans le délai', tone: 'good' }} sub={`Délai de décision : ${d.litigation.decisionDelayDays} jours`} />
        <KpiTile label="Campagnes à valider" value={d.recovery.campaignsToValidate} format={entier} href={d.recovery.link} state={{ label: 'Deux personnes', tone: 'info' }} />
      </Tuiles>
      <TuilesIndicateurs items={d.indicators} label="Indicateurs de la régie fiscale" />
      <Visuels label="Régie fiscale en graphiques">
        <BarresParDevise className="viz-span-2" title="Liquidé, payé et rapproché par recette" series={NIVEAUX_FISCAUX}
          rows={d.assessment.byRevenue.map((g) => ({ key: g.key, label: g.key, values: { assessed: g.assessed, paid: g.paid, reconciled: g.reconciled } }))} />
        <BarresParDevise className="viz-span-2" title="Liquidé, payé et rapproché par commune" series={NIVEAUX_FISCAUX}
          rows={d.assessment.byCommune.map((g) => ({ key: g.key, label: g.key, values: { assessed: g.assessed, paid: g.paid, reconciled: g.reconciled } }))} />
        <BarChartViz title="Arriérés par ancienneté" subtitle="Nombre d’obligations exigibles impayées, par tranche de jours" orientation="vertical" format={entier} emptyText="Aucun arriéré"
          series={[{ key: 'n', label: 'Obligations' }]} rows={d.recovery.arrears.map((a) => ({ key: a.band, label: `${a.band} j`, values: { n: a.count } }))} />
        <StatusDistribution title="Campagnes par état de validation" unitLabel="campagnes" emptyText="Aucune campagne"
          items={etatsDe(d.recovery.campaigns, (c) => c.validation, VALIDATION)} />
        <BarChartViz className="viz-span-2" title="Missions par zone affectée" subtitle="Ouvertes et en retard, par commune" orientation="horizontal" format={entier} emptyText="Aucune zone affectée"
          series={[{ key: 'open', label: 'Ouvertes' }, { key: 'overdue', label: 'En retard' }]} rows={d.performance.zones.map((z) => ({ key: z.commune, label: z.commune, values: { open: z.open, overdue: z.overdue } }))} />
        <BarChartViz className="viz-span-2" title="Constats des agents" subtitle="Validés et rejetés par agent (revue humaine)" orientation="horizontal" format={entier} emptyText="Aucun constat"
          series={[{ key: 'v', label: 'Validés' }, { key: 'r', label: 'Rejetés' }]} rows={d.performance.agents.map((a) => ({ key: a.agentId, label: a.name, values: { v: a.validated, r: a.rejected } }))} />
        <EtatIndicateurs items={d.indicators} />
      </Visuels>
    </>
  );
}

export function RegieFiscale() {
  const q = useVue<Fiscale>('/v1/decision/regie-fiscale');
  return (
    <Ecran eyebrow="Pilotage et décision · module 42" title="Poste de travail — régie fiscale (Tableau de bord de la régie fiscale)" lead="Assiette, liquidation, recouvrement et contentieux de la régie ; périmètre limité à la compétence de la régie." q={q}>
      {(d) => (<>
        <VisuelsFiscale d={d} />
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

const NIVEAUX_TAXES = [{ key: 'assessed', label: 'Liquidé' }, { key: 'confirmed', label: 'Confirmé' }, { key: 'reconciled', label: 'Rapproché' }];
const RESULTATS: Record<string, { label: string; tone: Tone }> = {
  VALIDE: { label: 'Valide', tone: 'good' }, VERT: { label: 'Vert (en règle)', tone: 'good' }, CONFORME: { label: 'Conforme', tone: 'good' },
  NON_DECLARE: { label: 'Non déclaré', tone: 'serious' }, INVALIDE: { label: 'Invalide', tone: 'critical' }, ROUGE: { label: 'Rouge (infraction constatée)', tone: 'critical' }, NON_CONFORME: { label: 'Non conforme', tone: 'critical' },
};
const FAMILLES_CONTROLE: Record<string, string> = { titres: 'Titres', stationnement: 'Stationnement', publicite: 'Publicité' };

/** Visuels de la régie des taxes (données de la vue, périmètre de la régie). */
function VisuelsTaxes({ d }: { d: Taxes }) {
  const cles = ['active', 'expiringIn30Days', 'expired', 'renewals', 'pending'];
  const controles = Object.values(d.controls).flat().reduce((s, r) => s + r.count, 0);
  return (
    <>
      <Tuiles label={`Régie des taxes ${d.entity} — chiffres clés`} max={4}>
        <KpiTile hero label="Obligations émises" value={d.byTax.reduce((s, t) => s + t.obligations, 0)} format={entier} state={{ label: 'Constaté', tone: 'info' }} sub={`${d.byTax.length} famille(s) de taxes`} />
        <KpiTile label="Paiements" value={d.byTax.reduce((s, t) => s + t.payments, 0)} format={entier} state={{ label: 'Confirmé', tone: 'info' }} />
        <KpiTile label="Autorisations à échéance sous 30 jours" value={(d.authorizations.titres.expiringIn30Days ?? 0) + (d.authorizations.publicite.expiringIn30Days ?? 0)} format={entier} state={{ label: 'À renouveler', tone: 'warning' }} />
        <KpiTile label="Contrôles enregistrés" value={controles} format={entier} state={{ label: 'Revue humaine', tone: 'info' }} sub="Aucune sanction automatique" />
      </Tuiles>
      <TuilesIndicateurs items={d.indicators} label="Indicateurs de la régie des taxes" />
      <Visuels label="Régie des taxes en graphiques">
        <BarresParDevise className="viz-span-2" title="Liquidé, confirmé et rapproché par taxe" series={NIVEAUX_TAXES}
          rows={d.byTax.map((t) => ({ key: t.code, label: t.label, values: { assessed: t.assessed, confirmed: t.confirmed, reconciled: t.reconciled } }))} />
        <BarChartViz className="viz-span-2" title="Autorisations — échéances et renouvellements" subtitle="Titres et autorisations publicitaires (nombre)" orientation="horizontal" format={entier}
          series={[{ key: 'titres', label: 'Titres' }, { key: 'publicite', label: 'Publicité' }]}
          rows={cles.filter((k) => d.authorizations.titres[k] !== undefined || d.authorizations.publicite[k] !== undefined).map((k) => ({ key: k, label: AUTH_LABELS[k] ?? k, values: { titres: d.authorizations.titres[k] ?? null, publicite: d.authorizations.publicite[k] ?? null } }))} />
        {Object.entries(d.controls).map(([k, rows]) => (
          <StatusDistribution key={k} title={`Contrôles — ${FAMILLES_CONTROLE[k] ?? k}`} unitLabel="contrôles" emptyText="Aucun contrôle sur la période"
            items={rows.map((r) => ({ key: r.result, label: RESULTATS[r.result]?.label ?? r.result.replace(/_/g, ' ').toLowerCase(), tone: RESULTATS[r.result]?.tone ?? 'neutral', count: r.count }))} />
        ))}
        <EtatIndicateurs items={d.indicators} />
      </Visuels>
    </>
  );
}

const AUTH_LABELS: Record<string, string> = { total: 'Total', active: 'Actives', expiringIn30Days: 'Échéance sous 30 jours', expired: 'Échues non renouvelées', renewals: 'Renouvellements', granted: 'Accordées', pending: 'En instruction' };

export function RegieTaxes() {
  const q = useVue<Taxes>('/v1/decision/regie-taxes');
  return (
    <Ecran eyebrow="Pilotage et décision · module 43" title="Poste de travail — régie des taxes (Tableau de bord de la régie des taxes)" lead="Droits, taxes et redevances urbaines ; périmètre limité à la compétence de la régie." q={q}>
      {(d) => (<>
        <VisuelsTaxes d={d} />
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
