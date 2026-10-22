/**
 * Centre de commandement exécutif (module 41, § 26.1) — vue du Gouverneur, du Cabinet et du Secrétariat du Gouvernement,
 * calculée en temps réel sur les données RÉELLES du socle, fondée sur des montants rapprochés :
 *  - échelle des onze états (servie par le pilotage, reprise ici par renvoi) ;
 *  - carte de chaleur par commune, quartier, catégorie et situation (payé, exigible, en retard, contesté) ;
 *  - alertes agrégées : écarts (rapprochement, assignation), fraude (alertes d'intégrité, alertes de sécurité), retards
 *    (obligations échues, exceptions hors délai, instructions et incidents en retard) ;
 *  - décisions : demandes d'explication ou de plan d'action tracées par le circuit des instructions (§ 26.1–26.2) ;
 *  - indicateurs : écart assignation / rapproché, couverture, alertes critiques.
 * Agrégats seulement (aucun nom, aucun identifiant de contribuable) ; AUCUNE capacité d'édition financière.
 */
import { UNATTRIBUTED_COMMUNE, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, kinshasaDay } from '../../core/clock.js';
import { isReconciled, matchesDims, type Filters } from '../pilotage/ladder.js';
import type { PlanificationService } from '../pilotage/planification/service.js';
import type { PilotageService, Query } from '../pilotage/service.js';
import { cdfJson, cdfMinor, pctBig } from './common.js';

export const HEAT_DIMENSIONS = ['commune', 'quartier', 'categorie'] as const;
export type HeatDimension = (typeof HEAT_DIMENSIONS)[number];
export const SITUATIONS = { PAYE: 'Payé', EXIGIBLE: 'Exigible (non échu ou sans retard)', EN_RETARD: 'En retard', CONTESTE: 'Contesté' } as const;
export type Situation = keyof typeof SITUATIONS;

interface Cell { assessed: bigint; reconciled: bigint; overdue: bigint; due: bigint; obligations: number; situations: Record<Situation, { count: number; cdf: bigint }> }
const emptyCell = (): Cell => ({ assessed: 0n, reconciled: 0n, overdue: 0n, due: 0n, obligations: 0, situations: { PAYE: { count: 0, cdf: 0n }, EXIGIBLE: { count: 0, cdf: 0n }, EN_RETARD: { count: 0, cdf: 0n }, CONTESTE: { count: 0, cdf: 0n } } });

type Integrite = { alerts?: { all(): { severity: string; status: string; ruleCode: string; ruleLabel: string }[] }; incidents?: { all(): { status: string; dueAt: string; severity: string }[] } };
const OPEN_ALERT = new Set(['A_EXAMINER', 'EN_EXAMEN', 'CLOTURE_PROPOSEE']);
const EXCEPTION_SLA_MS = 48 * 3_600_000;

export interface AlertItem { family: 'ECARTS' | 'FRAUDE' | 'RETARDS'; severity: 'CRITIQUE' | 'ELEVEE' | 'MOYENNE'; code: string; title: string; detail: string; count: number; link: string }

export function commandCentre(ctx: AppContext, pil: PilotageService, plan: PlanificationService | undefined, user: User, q: Query & { dimension?: HeatDimension }) {
  const { filters, scope } = pil.filtersFor(user, q);
  const facts = pil.facts();
  const today = kinshasaDay(facts.asOf);
  const inPeriod = (ts: string | undefined) => !!ts && (!filters.from || kinshasaDay(ts) >= filters.from) && (!filters.to || kinshasaDay(ts) <= filters.to);
  const objects = new Map(ctx.objects.objects.all().map((o) => [o.id, o]));
  const dim: HeatDimension = q.dimension ?? 'commune';
  const keyOf = (x: { commune: string; category: string; objectId?: string }) => (dim === 'commune' ? x.commune : dim === 'categorie' ? x.category : `${x.commune} › ${(x.objectId && objects.get(x.objectId)?.quartier) || 'quartier non renseigné'}`);
  const cells = new Map<string, Cell>();
  const cell = (k: string) => { let c = cells.get(k); if (!c) cells.set(k, (c = emptyCell())); return c; };
  const cdf = (m: MoneyJSON) => cdfMinor(ctx, m) ?? 0n;

  const obById = new Map(facts.obligations.map((o) => [o.id, o]));
  for (const o of facts.obligations) {
    if (o.cancelled || !matchesDims(o, filters) || !inPeriod(o.createdAt)) continue;
    const c = cell(keyOf(o));
    const v = cdf(o.amount);
    c.assessed += v; c.obligations++;
    const situation: Situation = o.paidAt ? 'PAYE' : o.contested ? 'CONTESTE' : o.dueDate < today ? 'EN_RETARD' : 'EXIGIBLE';
    c.situations[situation].count++; c.situations[situation].cdf += v;
    if (!o.contested && o.dueDate <= today) c.due += v;
    if (situation === 'EN_RETARD') c.overdue += v;
  }
  for (const o of facts.orders) {
    if (!isReconciled(o) || !matchesDims(o, filters) || !inPeriod(o.reconciledAt)) continue;
    const ob = obById.get(o.obligationId);
    cell(keyOf({ commune: o.commune, category: o.category, ...(ob ? { objectId: ob.objectId } : {}) })).reconciled += cdf(o.amount);
  }
  // Couverture : objets validés / objets connus (par commune ou quartier ; sans objet par catégorie de recette).
  const coverage = new Map<string, { total: number; validated: number }>();
  if (dim !== 'categorie') {
    for (const ob of objects.values()) {
      if ((filters.commune && ob.commune !== filters.commune) || (filters.communes && !filters.communes.includes(ob.commune))) continue;
      const k = dim === 'commune' ? ob.commune : `${ob.commune} › ${ob.quartier || 'quartier non renseigné'}`;
      const r = coverage.get(k) ?? { total: 0, validated: 0 };
      r.total++; if (ob.status === 'VALIDE') r.validated++;
      coverage.set(k, r);
    }
  }
  const keys = new Set([...cells.keys(), ...coverage.keys()]);
  const rows = [...keys].map((key) => {
    const c = cells.get(key) ?? emptyCell();
    const cov = coverage.get(key);
    return {
      key, obligations: c.obligations,
      assessedCdf: cdfJson(c.assessed), reconciledCdf: cdfJson(c.reconciled), overdueCdf: cdfJson(c.overdue),
      /** Rapproché / liquidé de la période (contre-valeur indicative) : intensité de la carte. */
      recoveryPct: pctBig(c.reconciled, c.assessed),
      overduePct: pctBig(c.overdue, c.due),
      coveragePct: cov ? pctBig(BigInt(cov.validated), BigInt(cov.total)) : null,
      objects: cov ?? null,
      situations: Object.fromEntries((Object.keys(SITUATIONS) as Situation[]).map((s) => [s, { count: c.situations[s].count, cdf: cdfJson(c.situations[s].cdf) }])),
    };
  }).sort((a, b) => (a.key.startsWith(UNATTRIBUTED_COMMUNE) ? 1 : b.key.startsWith(UNATTRIBUTED_COMMUNE) ? -1 : a.key.localeCompare(b.key, 'fr')));

  const alerts = alertFeed(ctx, pil, plan, user, filters, today, facts.asOf);
  const kpis = pil.computeKpis(filters);
  const pick = (code: string) => kpis.find((k) => k.code === code) ?? null;
  const gap = plan ? safe(() => plan.gapMap(user, q)) : null;
  const gapCertified = !!gap && (gap as { certified: boolean }).certified;
  const indicators = [
    gapCertified
      ? { code: 'ECART_ASSIGNATION_RAPPROCHE', label: 'Écart assignation / rapproché', measured: true, value: (gap as { totals: { ratePct: string | null } }).totals.ratePct, unit: '% réalisé', detail: gap }
      : { code: 'ECART_ASSIGNATION_RAPPROCHE', label: 'Écart assignation / rapproché', measured: false, value: null, unit: '% réalisé', reason: plan ? 'Aucune assignation budgétaire certifiée pour l’exercice (donnée source manquante).' : 'Module de planification non chargé.' },
    { code: 'COUVERTURE', label: 'Couverture (objets validés)', measured: pick('VALIDATION_OBJETS')?.value != null, value: pick('VALIDATION_OBJETS')?.value ?? null, unit: '%', kpi: pick('VALIDATION_OBJETS'), sig: pick('COUVERTURE_SIG') },
    { code: 'ALERTES_CRITIQUES', label: 'Alertes critiques', measured: true, value: String(alerts.critical), unit: 'alertes' },
  ];
  ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'decision.command_centre.viewed', resourceType: 'dashboard', resourceId: 'commandement', details: { filters, dimension: dim } });
  return {
    generatedAt: facts.asOf, scope, filters, aggregatesOnly: true, financialEdit: false,
    rule: 'Agrégats seulement, sans donnée individuelle ; aucun acte financier depuis ce centre : toute décision passe par le circuit tracé des instructions.',
    /** Échelle des onze états (du potentiel estimé au disponible pour affectation), servie par le pilotage. */
    ladder: safe(() => pil.ladder(user, q)),
    heatmap: { dimension: dim, dimensions: HEAT_DIMENSIONS, situations: SITUATIONS, metricNote: 'Intensité = rapproché / liquidé de la période (contre-valeur CDF indicative) ; retard = échu non payé / échu ; couverture = objets validés / objets connus.', rows },
    alerts, indicators,
    decisions: { instructions: plan ? plan.instructionsSummary() : null, kinds: { EXPLICATION: 'Demande d’explication (interpeller un responsable)', PLAN_ACTION: 'Demande de plan d’action' } },
  };
}

function safe<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

/** Alertes agrégées du centre de commandement (écarts, fraude, retards) ; aucune donnée individuelle. */
export function alertFeed(ctx: AppContext, pil: PilotageService, plan: PlanificationService | undefined, user: User, filters: Filters, today: string, asOf: string) {
  const items: AlertItem[] = [];
  const now = Date.parse(asOf);
  // Écarts : exceptions de rapprochement ouvertes.
  const exceptions = ctx.treasury.exceptions.all().filter((e) => e.status !== 'RESOLUE' && e.status !== 'CLASSEE');
  if (exceptions.length) items.push({ family: 'ECARTS', severity: 'ELEVEE', code: 'EXCEPTIONS_RAPPROCHEMENT', title: 'Exceptions de rapprochement ouvertes', detail: `${exceptions.length} exception(s) ouverte(s) entre paiements, relevés et obligations.`, count: exceptions.length, link: '/tresor' });
  const agedExceptions = exceptions.filter((e) => now - Date.parse(e.openedAt) > EXCEPTION_SLA_MS);
  if (agedExceptions.length) items.push({ family: 'RETARDS', severity: 'CRITIQUE', code: 'EXCEPTIONS_HORS_DELAI', title: 'Exceptions hors délai (48 h)', detail: `${agedExceptions.length} exception(s) au-delà du délai de traitement : escalade au comité finances.`, count: agedExceptions.length, link: '/pilotage/salle-controle' });
  // Écarts : assignation certifiée non atteinte (communes sous le réalisé attendu, sans seuil inventé : liste des écarts positifs).
  const gap = plan ? safe(() => plan.gapMap(user, {})) as { certified?: boolean; rows?: { gap: MoneyJSON }[] } | null : null;
  if (gap?.certified) {
    const n = (gap.rows ?? []).filter((r) => Number(r.gap.amount) > 0).length;
    if (n) items.push({ family: 'ECARTS', severity: 'MOYENNE', code: 'ECART_ASSIGNATION', title: 'Assignations non encore atteintes', detail: `${n} ligne(s) commune × recette sous l’assignation certifiée.`, count: n, link: '/pilotage/assignations' });
  }
  // Fraude : alertes d'intégrité ouvertes et alertes de sécurité.
  const integ = ctx.ext.integrite as Integrite | undefined;
  const openFraud = integ?.alerts ? integ.alerts.all().filter((a) => OPEN_ALERT.has(a.status)) : [];
  const fraudCritical = openFraud.filter((a) => a.severity === 'CRITIQUE').length;
  if (openFraud.length) items.push({ family: 'FRAUDE', severity: fraudCritical ? 'CRITIQUE' : 'ELEVEE', code: 'ALERTES_INTEGRITE', title: 'Alertes anti-fraude à examiner', detail: `${openFraud.length} alerte(s) ouverte(s), dont ${fraudCritical} critique(s) ; examen humain, aucun effet automatique.`, count: openFraud.length, link: '/integrite/enquetes' });
  const security = ctx.alerts.alerts.all().filter((a) => now - Date.parse(a.at) <= 30 * DAY_MS);
  const securityCritical = security.filter((a) => a.severity === 'CRITICAL').length;
  if (security.length) items.push({ family: 'FRAUDE', severity: securityCritical ? 'CRITIQUE' : 'ELEVEE', code: 'ALERTES_SECURITE', title: 'Alertes de sécurité et de fraude (30 jours)', detail: `${security.length} alerte(s), dont ${securityCritical} critique(s).`, count: security.length, link: '/audit' });
  // Retards : obligations échues non payées, instructions et incidents en retard.
  const overdue = pil.facts(asOf).obligations.filter((o) => !o.cancelled && !o.paidAt && !o.contested && o.dueDate < today && matchesDims(o, filters)).length;
  if (overdue) items.push({ family: 'RETARDS', severity: 'MOYENNE', code: 'OBLIGATIONS_ECHUES', title: 'Obligations échues non payées', detail: `${overdue} obligation(s) échue(s) sans paiement confirmé : relance selon le calendrier, aucune pénalité automatique.`, count: overdue, link: '/recouvrement' });
  const instr = plan ? plan.instructionsSummary() : null;
  if (instr?.overdue.length) items.push({ family: 'RETARDS', severity: 'ELEVEE', code: 'INSTRUCTIONS_EN_RETARD', title: 'Instructions en retard', detail: `${instr.overdue.length} instruction(s) au-delà de leur échéance.`, count: instr.overdue.length, link: '/pilotage/instructions' });
  const lateIncidents = integ?.incidents ? integ.incidents.all().filter((i) => !['RESOLU', 'CLOS'].includes(i.status) && i.dueAt < asOf).length : 0;
  if (lateIncidents) items.push({ family: 'RETARDS', severity: 'CRITIQUE', code: 'INCIDENTS_EN_RETARD', title: 'Incidents non résolus dans le délai', detail: `${lateIncidents} incident(s) au-delà du délai fixé.`, count: lateIncidents, link: '/integrite/incidents' });
  const critical = items.filter((i) => i.severity === 'CRITIQUE').reduce((a, i) => a + i.count, 0);
  return { items, critical, byFamily: (['ECARTS', 'FRAUDE', 'RETARDS'] as const).map((family) => ({ family, count: items.filter((i) => i.family === family).reduce((a, i) => a + i.count, 0) })) };
}
