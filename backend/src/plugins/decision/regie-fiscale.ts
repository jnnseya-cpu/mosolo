/**
 * Tableau de bord de la régie fiscale (module 42) — assiette, liquidation, recouvrement et contentieux de la DGIPK,
 * calculé sur les données RÉELLES du socle (mêmes faits que le pilotage) :
 *  - assiette et liquidation par recette (code de règle) et par commune : liquidé, payé, rapproché ;
 *  - recouvrement : arriérés par ancienneté, campagnes (statut, validation à deux personnes, lien vers le circuit) ;
 *  - contentieux : recours ouverts, décidés, délai moyen et recours au-delà du délai de décision (§ 22) ;
 *  - performance des agents et des équipes : zones affectées (lots, missions par commune), constats validés / rejetés
 *    (résultats vérifiables, jamais de surveillance intrusive) ;
 *  - indicateurs : taux de recouvrement (payé / exigible) ; délai de contentieux (dépôt → décision).
 * Périmètre limité à la compétence de la régie : la direction et les cadres d'une régie ne voient que leur régie ;
 * les autorités provinciales choisissent la régie. Aucune capacité d'édition : l'affectation des zones et la
 * validation des campagnes passent par leurs circuits existants (terrain, campagnes), signalés par des liens.
 */
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, kinshasaDay } from '../../core/clock.js';
import { badRequest, forbidden } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { APPEAL_PROCEDURE } from '../../modules/appeals/procedure.js';
import { isReconciled, matchesDims } from '../pilotage/ladder.js';
import { CurrencyTotals } from '../pilotage/money.js';
import type { PilotageService } from '../pilotage/service.js';
import { pctNum } from './common.js';

/** Régies fiscales connues (compétence d'assiette et de recouvrement des impôts) ; la régie des taxes a son tableau (43). */
export const REGIES_FISCALES = ['DGIPK'] as const;
const PROVINCE_ROLES = ['R01', 'R02', 'R03', 'R05', 'R22', 'R23'];

type Campaign = { id: string; code: string; label: string; entity: string; status: string; period: string; dueDate: string; communes: string[]; launch?: { proposedBy: string; approvedBy?: string } };
type Terrain = {
  lots?: { all(): { id: string; commune: string; quartiers: string[]; module: string; status: string; subcontractorId?: string; maxAgents: number; periodEnd: string }[] };
  missions?: { all(): { id: string; commune: string; status: string; dueDate: string; assignedAgentId?: string; entity?: string }[] };
  findings?: { all(): { agentId: string; status: string; commune: string }[] };
  agents?: { all(): { id: string; entity: string; status: string; subcontractorId?: string; habilitation?: { communes: string[] } }[] };
};

export function regieFiscale(ctx: AppContext, pil: PilotageService, user: User, q: { entity?: string; period?: string; from?: string; to?: string; commune?: string }) {
  authorize(user, 'decision:regie-fiscale.read');
  const province = user.roles.some((r) => PROVINCE_ROLES.includes(r));
  const entity = province ? (q.entity ?? REGIES_FISCALES[0]) : user.entity;
  if (!province && q.entity && q.entity !== user.entity) throw forbidden('OUT_OF_COMPETENCE', 'Périmètre limité à la compétence de votre régie (module 42).');
  if (!(REGIES_FISCALES as readonly string[]).includes(entity)) {
    if (province) throw badRequest('NOT_A_FISCAL_REGIE', `${entity} n’est pas une régie fiscale (${REGIES_FISCALES.join(', ')}).`);
    throw forbidden('OUT_OF_COMPETENCE', 'Tableau réservé à la direction et aux cadres d’une régie fiscale : périmètre limité à la compétence de la régie.');
  }
  const { filters } = pil.filtersFor(user, { ...(q.period ? { period: q.period } : {}), ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}), ...(q.commune ? { commune: q.commune } : {}), ...(province ? { entity } : {}) });
  filters.entity = entity;
  const facts = pil.facts();
  const today = kinshasaDay(facts.asOf);
  const inPeriod = (ts?: string) => !!ts && (!filters.from || kinshasaDay(ts) >= filters.from) && (!filters.to || kinshasaDay(ts) <= filters.to);
  const obs = facts.obligations.filter((o) => !o.cancelled && matchesDims(o, filters));
  const obIds = new Set(obs.map((o) => o.id));

  // Assiette et liquidation par recette et par commune.
  type Row = { key: string; obligations: number; assessed: CurrencyTotals; paid: CurrencyTotals; reconciled: CurrencyTotals };
  const group = (keyOf: (o: (typeof obs)[number]) => string) => {
    const m = new Map<string, Row>();
    const row = (k: string) => { let r = m.get(k); if (!r) m.set(k, (r = { key: k, obligations: 0, assessed: new CurrencyTotals(), paid: new CurrencyTotals(), reconciled: new CurrencyTotals() })); return r; };
    const byId = new Map(obs.map((o) => [o.id, o]));
    for (const o of obs) if (inPeriod(o.createdAt)) { const r = row(keyOf(o)); r.obligations++; r.assessed.add(o.amount); }
    for (const p of facts.orders) {
      const o = byId.get(p.obligationId);
      if (!o) continue;
      if (p.confirmedAt && inPeriod(p.confirmedAt) && ['CONFIRME', 'REGLE', 'RAPPROCHE', 'CONTESTE'].includes(p.status)) row(keyOf(o)).paid.add(p.amount);
      if (isReconciled(p) && inPeriod(p.reconciledAt)) row(keyOf(o)).reconciled.add(p.amount);
    }
    return [...m.values()].sort((a, b) => a.key.localeCompare(b.key, 'fr')).map((r) => ({ key: r.key, obligations: r.obligations, assessed: r.assessed.toJSON(), paid: r.paid.toJSON(), reconciled: r.reconciled.toJSON() }));
  };
  const byRevenue = group((o) => o.ruleCode);
  const byCommune = group((o) => o.commune);

  // Recouvrement : arriérés par ancienneté (échus, non payés, non contestés).
  const bands = [{ code: '0-30', max: 30 }, { code: '31-90', max: 90 }, { code: '91-365', max: 365 }, { code: '365+', max: Number.POSITIVE_INFINITY }];
  const arrears = bands.map((b, i) => {
    const min = i === 0 ? 0 : bands[i - 1]!.max + 1;
    const t = new CurrencyTotals(); let n = 0;
    for (const o of obs) {
      if (o.paidAt || o.contested || o.dueDate >= today) continue;
      const late = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${o.dueDate}T00:00:00Z`)) / DAY_MS);
      if (late >= min && late <= b.max) { t.add(o.amount); n++; }
    }
    return { band: b.code, count: n, amounts: t.toJSON() };
  });
  const campaignsSvc = ctx.ext.campagnes as { campaigns?: { all(): Campaign[] } } | undefined;
  const campaigns = (campaignsSvc?.campaigns?.all() ?? []).filter((c) => c.entity === entity).map((c) => ({
    id: c.id, code: c.code, label: c.label, status: c.status, period: c.period, dueDate: c.dueDate, communes: c.communes.length,
    validation: c.launch?.approvedBy ? 'VALIDEE' : c.status === 'LANCEMENT_PROPOSE' ? 'A_VALIDER' : 'NON_PROPOSEE',
  }));

  // Contentieux : recours sur les obligations de la régie.
  const appeals = facts.appeals.filter((a) => obIds.has(a.obligationId));
  const decided = appeals.filter((a) => a.decidedAt);
  const days = decided.map((a) => (Date.parse(a.decidedAt!) - Date.parse(a.submittedAt)) / DAY_MS);
  const limit = APPEAL_PROCEDURE.decisionDelayDays;
  const litigation = {
    open: appeals.length - decided.length, decided: decided.length,
    beyondDelay: appeals.filter((a) => !a.decidedAt && (Date.parse(facts.asOf) - Date.parse(a.submittedAt)) / DAY_MS > limit).length,
    decisionDelayDays: limit,
    byDecision: [...decided.reduce((m, a) => m.set(a.decision ?? '—', (m.get(a.decision ?? '—') ?? 0) + 1), new Map<string, number>())].map(([decision, count]) => ({ decision, count })),
  };

  // Performance des agents et des équipes ; zones affectées (lots et missions par commune).
  const terrain = ctx.ext.terrain as Terrain | undefined;
  const agents = (terrain?.agents?.all() ?? []).filter((a) => a.entity === entity || (!!a.subcontractorId && (terrain?.lots?.all() ?? []).some((l) => l.subcontractorId === a.subcontractorId)));
  const agentIds = new Set(agents.map((a) => a.id));
  const inCommune = (c: string) => (!filters.commune || filters.commune === c) && (!filters.communes || filters.communes.includes(c));
  const missions = (terrain?.missions?.all() ?? []).filter((m) => inCommune(m.commune));
  const findings = (terrain?.findings?.all() ?? []).filter((f) => inCommune(f.commune));
  const zones = new Map<string, { commune: string; lots: number; missions: number; open: number; overdue: number; agents: Set<string> }>();
  const zone = (c: string) => { let z = zones.get(c); if (!z) zones.set(c, (z = { commune: c, lots: 0, missions: 0, open: 0, overdue: 0, agents: new Set() })); return z; };
  for (const l of terrain?.lots?.all() ?? []) if (l.status === 'OUVERT' && inCommune(l.commune)) zone(l.commune).lots++;
  for (const m of missions) {
    const z = zone(m.commune); z.missions++;
    if (!['TERMINEE', 'ANNULEE'].includes(m.status)) { z.open++; if (m.dueDate < today) z.overdue++; }
    if (m.assignedAgentId) z.agents.add(m.assignedAgentId);
  }
  const perAgent = new Map<string, { missions: number; findings: number; validated: number; rejected: number }>();
  const ag = (id: string) => { let a = perAgent.get(id); if (!a) perAgent.set(id, (a = { missions: 0, findings: 0, validated: 0, rejected: 0 })); return a; };
  missions.forEach((m) => { if (m.assignedAgentId && agentIds.has(m.assignedAgentId)) ag(m.assignedAgentId).missions++; });
  findings.forEach((f) => { if (!agentIds.has(f.agentId)) return; const a = ag(f.agentId); a.findings++; if (f.status === 'VALIDE') a.validated++; if (f.status === 'REJETE') a.rejected++; });
  const teams = new Map<string, { team: string; agents: number; findings: number; validated: number }>();
  for (const a of agents) {
    const k = a.subcontractorId ?? `${entity} (équipe interne)`;
    const t = teams.get(k) ?? { team: k, agents: 0, findings: 0, validated: 0 };
    t.agents++; t.findings += perAgent.get(a.id)?.findings ?? 0; t.validated += perAgent.get(a.id)?.validated ?? 0;
    teams.set(k, t);
  }

  // Indicateurs : taux de recouvrement (obligations exigibles payées / exigibles) ; délai moyen de contentieux.
  const due = obs.filter((o) => !o.contested && o.dueDate <= today && (!filters.from || o.dueDate >= filters.from) && (!filters.to || o.dueDate <= filters.to));
  const paidDue = due.filter((o) => !!o.paidAt).length;
  const meanDays = days.length ? (days.reduce((a, b) => a + b, 0) / days.length).toFixed(1) : null;
  ctx.audit.append({ actor: actorOf(user), action: 'decision.regie_fiscale.viewed', resourceType: 'dashboard', resourceId: `regie-fiscale:${entity}`, details: { filters } });
  return {
    entity, generatedAt: facts.asOf, filters, aggregatesOnly: true, financialEdit: false,
    rule: 'Périmètre limité à la compétence de la régie ; lecture seule : l’affectation des zones et la validation des campagnes passent par leurs circuits (terrain, campagnes à deux personnes).',
    assessment: { byRevenue, byCommune },
    recovery: { arrears, campaigns, campaignsToValidate: campaigns.filter((c) => c.validation === 'A_VALIDER').length, link: '/recouvrement/campagnes' },
    litigation,
    performance: {
      note: 'Résultats vérifiables (missions, constats validés ou rejetés à la revue) ; aucune surveillance intrusive, aucun classement public.',
      zones: [...zones.values()].map((z) => ({ commune: z.commune, lots: z.lots, missions: z.missions, open: z.open, overdue: z.overdue, agents: z.agents.size })).sort((a, b) => a.commune.localeCompare(b.commune, 'fr')),
      agents: [...perAgent.entries()].map(([agentId, a]) => ({ agentId, name: ctx.users.get(agentId)?.name ?? agentId, ...a, validationPct: pctNum(a.validated, a.validated + a.rejected) })),
      teams: [...teams.values()],
      link: '/terrain/supervision',
    },
    indicators: [
      due.length
        ? { code: 'TAUX_RECOUVREMENT', label: 'Taux de recouvrement (exigible payé)', measured: true, value: pctNum(paidDue, due.length), unit: '%', basis: { paid: paidDue, due: due.length } }
        : { code: 'TAUX_RECOUVREMENT', label: 'Taux de recouvrement (exigible payé)', measured: false, value: null, unit: '%', reason: 'Aucune obligation exigible dans le périmètre et la période.' },
      meanDays !== null
        ? { code: 'DELAI_CONTENTIEUX', label: 'Délai moyen de contentieux (dépôt → décision)', measured: true, value: meanDays, unit: 'jours', basis: { decided: decided.length, legalDelayDays: limit } }
        : { code: 'DELAI_CONTENTIEUX', label: 'Délai moyen de contentieux (dépôt → décision)', measured: false, value: null, unit: 'jours', reason: 'Aucun recours décidé dans le périmètre : pas encore mesurable.' },
    ],
  };
}
