/**
 * Tableau de bord de la régie des taxes (module 43) — droits, taxes et redevances urbaines de la DGTK :
 *  - recettes par taxe (patente, publicité, stationnement, domaine public, autres) : liquidé, confirmé, rapproché ;
 *  - autorisations : échéances et renouvellements (titres du moteur de titres § 19A, autorisations publicitaires § 11B) ;
 *  - contrôles : résultats (contrôles de titres, contrôles du stationnement, inspections publicitaires) ;
 *  - indicateurs : recettes par taxe ; renouvellements à temps (renouvellement émis avant l'échéance du titre ou de
 *    l'autorisation renouvelé).
 * Périmètre limité à la compétence de la régie : la direction et les cadres de la DGTK (ou les autorités provinciales).
 */
import type { MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, kinshasaDay } from '../../core/clock.js';
import { forbidden } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { isConfirmed, isReconciled } from '../pilotage/ladder.js';
import { CurrencyTotals } from '../pilotage/money.js';
import type { PilotageService } from '../pilotage/service.js';
import { pctNum } from './common.js';

export const REGIE_TAXES_ENTITY = 'DGTK';
/** Familles de taxes : rattachement par le code de la règle (registre juridique) — table de lecture, sans taux. */
export const TAX_FAMILIES = [
  { code: 'PATENTE', label: 'Patente', pattern: /PATENTE|(^|-)PAT(-|$)/ },
  { code: 'PUBLICITE', label: 'Publicité', pattern: /PUB/ },
  { code: 'STATIONNEMENT', label: 'Stationnement', pattern: /PARK|STAT/ },
  { code: 'DOMAINE_PUBLIC', label: 'Domaine public (marchés, étals, occupation, voirie)', pattern: /DOMAINE|VOIRIE|MARCHE|ETAL|OCCUP/ },
] as const;
/** Ordre de rattachement : le domaine public avant la publicité (« DOMAINE-PUBLIC » contient « PUB »). */
const MATCH_ORDER = ['PATENTE', 'DOMAINE_PUBLIC', 'PUBLICITE', 'STATIONNEMENT'] as const;
export function taxFamilyOf(ruleCode: string): string {
  const code = ruleCode.toUpperCase();
  return MATCH_ORDER.find((c) => TAX_FAMILIES.find((f) => f.code === c)!.pattern.test(code)) ?? 'AUTRES';
}
const PROVINCE_ROLES = ['R01', 'R02', 'R03', 'R05', 'R22', 'R23'];

type Titres = { credentials?: { all(): { id: string; typeCode: string; entity: string; state: string; validUntil: string; issuedAt: string; renewsId?: string }[] }; controls?: { all(): { result: string; at: string; module?: string }[] } };
type Publicite = { requests?: { all(): { id: string; status: string; periodTo: string; submittedAt: string; renewsId?: string; decision?: { at: string } }[] }; inspections?: { all(): { finding: string; observedAt: string }[] } };
type Parking = { checks?: { all(): { light: string; at: string }[] } };

export function regieTaxes(ctx: AppContext, pil: PilotageService, user: User, q: { period?: string; from?: string; to?: string }) {
  authorize(user, 'decision:regie-taxes.read');
  if (!user.roles.some((r) => PROVINCE_ROLES.includes(r)) && user.entity !== REGIE_TAXES_ENTITY) {
    throw forbidden('OUT_OF_COMPETENCE', 'Tableau réservé à la régie des taxes (DGTK) : périmètre limité à la compétence.');
  }
  const { filters } = pil.filtersFor(user, { ...q, entity: REGIE_TAXES_ENTITY });
  filters.entity = REGIE_TAXES_ENTITY;
  const facts = pil.facts();
  const today = kinshasaDay(facts.asOf);
  const inPeriod = (ts?: string) => !!ts && (!filters.from || kinshasaDay(ts) >= filters.from) && (!filters.to || kinshasaDay(ts) <= filters.to);
  const obligations = new Map(facts.obligations.map((o) => [o.id, o]));
  const fam = new Map<string, { assessed: CurrencyTotals; confirmed: CurrencyTotals; reconciled: CurrencyTotals; obligations: number; payments: number }>();
  const row = (k: string) => { let r = fam.get(k); if (!r) fam.set(k, (r = { assessed: new CurrencyTotals(), confirmed: new CurrencyTotals(), reconciled: new CurrencyTotals(), obligations: 0, payments: 0 })); return r; };
  for (const o of facts.obligations) {
    if (o.cancelled || o.entity !== REGIE_TAXES_ENTITY || !inPeriod(o.createdAt)) continue;
    const r = row(taxFamilyOf(o.ruleCode)); r.assessed.add(o.amount); r.obligations++;
  }
  for (const o of facts.orders) {
    if (o.entity !== REGIE_TAXES_ENTITY) continue;
    const ob = obligations.get(o.obligationId);
    const k = taxFamilyOf(ob?.ruleCode ?? '');
    if (isConfirmed(o) && inPeriod(o.confirmedAt)) { row(k).confirmed.add(o.amount); row(k).payments++; }
    if (isReconciled(o) && inPeriod(o.reconciledAt)) row(k).reconciled.add(o.amount);
  }
  const byTax = [...TAX_FAMILIES.map((f) => ({ code: f.code as string, label: f.label as string })), { code: 'AUTRES', label: 'Autres droits et redevances de la régie' }].map((f) => {
    const r = fam.get(f.code);
    return { ...f, obligations: r?.obligations ?? 0, payments: r?.payments ?? 0, assessed: r?.assessed.toJSON() ?? [], confirmed: r?.confirmed.toJSON() ?? [], reconciled: r?.reconciled.toJSON() ?? [] };
  });

  // Autorisations : titres de la régie et autorisations publicitaires — échéances et renouvellements.
  const titres = ctx.ext.titres as Titres | undefined;
  const creds = (titres?.credentials?.all() ?? []).filter((c) => c.entity === REGIE_TAXES_ENTITY);
  const pub = ctx.ext.publicite as Publicite | undefined;
  const requests = pub?.requests?.all() ?? [];
  const soon = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * DAY_MS).toISOString().slice(0, 10);
  const renewals: { onTime: boolean }[] = [];
  const credById = new Map(creds.map((c) => [c.id, c]));
  for (const c of creds) {
    if (!c.renewsId) continue;
    const prev = credById.get(c.renewsId);
    if (prev) renewals.push({ onTime: c.issuedAt <= prev.validUntil });
  }
  const reqById = new Map(requests.map((r) => [r.id, r]));
  for (const r of requests) {
    if (!r.renewsId) continue;
    const prev = reqById.get(r.renewsId);
    if (prev) renewals.push({ onTime: r.submittedAt.slice(0, 10) <= prev.periodTo });
  }
  const granted = requests.filter((r) => r.status === 'ACCORDEE');
  const authorizations = {
    titres: {
      total: creds.length, active: creds.filter((c) => c.state === 'EMIS' && c.validUntil >= facts.asOf).length,
      expiringIn30Days: creds.filter((c) => c.state === 'EMIS' && c.validUntil.slice(0, 10) >= today && c.validUntil.slice(0, 10) <= soon).length,
      expired: creds.filter((c) => c.validUntil < facts.asOf && !creds.some((n) => n.renewsId === c.id)).length,
      renewals: creds.filter((c) => !!c.renewsId).length,
    },
    publicite: {
      granted: granted.length, active: granted.filter((r) => r.periodTo >= today).length,
      expiringIn30Days: granted.filter((r) => r.periodTo >= today && r.periodTo <= soon).length,
      expired: granted.filter((r) => r.periodTo < today && !requests.some((n) => n.renewsId === r.id)).length,
      renewals: requests.filter((r) => !!r.renewsId).length, pending: requests.filter((r) => ['DEPOSEE', 'COMPLEMENT_DEMANDE', 'PROPOSEE'].includes(r.status)).length,
    },
  };
  // Contrôles : résultats (aucune sanction automatique : constats soumis à revue).
  const tally = (xs: string[]) => { const m = new Map<string, number>(); xs.forEach((x) => m.set(x, (m.get(x) ?? 0) + 1)); return [...m.entries()].map(([result, count]) => ({ result, count })); };
  const controls = {
    titres: tally((titres?.controls?.all() ?? []).filter((c) => inPeriod(c.at)).map((c) => c.result)),
    stationnement: tally(((ctx.ext.parking as Parking | undefined)?.checks?.all() ?? []).filter((c) => inPeriod(c.at)).map((c) => c.light)),
    publicite: tally((pub?.inspections?.all() ?? []).filter((c) => inPeriod(c.observedAt)).map((c) => c.finding)),
  };
  const onTime = renewals.filter((r) => r.onTime).length;
  const totalRec = (k: 'reconciled') => byTax.reduce((a, t) => { t[k].forEach((m: MoneyJSON) => a.add(m)); return a; }, new CurrencyTotals()).toJSON();
  ctx.audit.append({ actor: actorOf(user), action: 'decision.regie_taxes.viewed', resourceType: 'dashboard', resourceId: 'regie-taxes', details: { filters } });
  return {
    entity: REGIE_TAXES_ENTITY, generatedAt: facts.asOf, filters, aggregatesOnly: true,
    rule: 'Périmètre limité à la compétence de la régie des taxes ; rattachement d’une recette à une taxe par le code de sa règle (registre juridique).',
    byTax, authorizations, controls,
    indicators: [
      { code: 'RECETTES_PAR_TAXE', label: 'Recettes rapprochées de la régie', measured: true, value: totalRec('reconciled').map((m) => `${m.amount} ${m.currency}`).join(' · ') || '0', unit: '' },
      renewals.length
        ? { code: 'RENOUVELLEMENTS_A_TEMPS', label: 'Renouvellements à temps', measured: true, value: pctNum(onTime, renewals.length), unit: '%', basis: { onTime, total: renewals.length } }
        : { code: 'RENOUVELLEMENTS_A_TEMPS', label: 'Renouvellements à temps', measured: false, value: null, unit: '%', reason: 'Aucun renouvellement de titre ni d’autorisation enregistré : pas encore mesurable.' },
    ],
  };
}
