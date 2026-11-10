/**
 * Partage légal des recettes (§ 27.1, § 29.2, § 30.6 ; § 10A.3 « partage transparent ») — DISTINCT de la clé du § 37A.
 *
 * Clés légales entre la province, les entités territoriales décentralisées (ETD) et, le cas échéant, le pouvoir
 * central : chaque clé est une RÈGLE du registre juridique (fiche versionnée, quatre visas, source certifiée). Tant
 * que la fiche n'est pas ACTIVE et certifiée, AUCUNE part n'est calculée (statut A_VERIFIER : assiette seulement).
 * Aucun taux n'est présumé : la table de taux de la fiche certifiée fait foi. Aucune entité ne modifie une clé
 * (changement = nouvelle version de la fiche au registre). Calcul uniquement sur recettes RAPPROCHÉES (niveau 9) et,
 * pour la part « comptabilisée », sur les écritures du grand livre (niveau 10) ; aucun virement n'est émis.
 *
 * Le cadre des incitations de performance (§ 27.1) est un REGISTRE : aucune incitation n'est calculée ni versée ici.
 */
import { isRuleExecutable, Money, type CurrencyCode, type MoneyJSON, type RoleCode, type RuleSheet } from '@mosolo/shared';
import type { AppContext } from '../../../context.js';
import type { User } from '../../../core/auth.js';
import { kinshasaDay } from '../../../core/clock.js';
import { canonicalJson, sha256Hex } from '../../../core/crypto.js';
import { conflict, notFound } from '../../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../../core/repository.js';
import { ext } from '../../types.js';
import { isReconciled, periodRange } from '../ladder.js';
import { allocate, type SliceDef } from '../repartition/model.js';
import type { PilotageService } from '../service.js';

export type ShareBeneficiary = 'PROVINCE' | 'ETD' | 'POUVOIR_CENTRAL';
export const BENEFICIARY_LABELS: Record<ShareBeneficiary, string> = {
  PROVINCE: 'Ville-Province de Kinshasa', ETD: 'Entité territoriale décentralisée (commune du fait générateur)', POUVOIR_CENTRAL: 'Pouvoir central',
};

export interface LegalShareKey {
  code: string;
  label: string;
  /** Catégories de recettes couvertes (§ 6.11). */
  categories: string[];
  /** Parts : clé de la table de taux de la fiche ; une seule part reçoit le solde et les arrondis. */
  parts: { beneficiary: ShareBeneficiary; rateKey: string; remainder: boolean }[];
  legalReference: string;
}

/** Clés légales versées au registre (fiches A_VERIFIER, table de taux vide tant que l'acte n'est pas lu et certifié). */
export const LEGAL_SHARE_KEYS: LegalShareKey[] = [
  {
    code: 'CLE-PARTAGE-INTERET-COMMUN', label: 'Partage des taxes d’intérêt commun entre la province et les ETD', categories: ['INTERET_COMMUN'],
    parts: [{ beneficiary: 'ETD', rateKey: 'part_etd', remainder: false }, { beneficiary: 'PROVINCE', rateKey: 'part_province', remainder: true }],
    legalReference: 'Loi n° 18/004 du 13 mars 2018 (nomenclature des impôts, droits, taxes et redevances des provinces et des ETD) — articles relatifs à la répartition [À VÉRIFIER]',
  },
  {
    code: 'CLE-PARTAGE-RECETTES-PARTAGEES', label: 'Partage des recettes partagées (province, ETD, pouvoir central)', categories: ['PARTAGEE'],
    parts: [{ beneficiary: 'POUVOIR_CENTRAL', rateKey: 'part_pouvoir_central', remainder: false }, { beneficiary: 'ETD', rateKey: 'part_etd', remainder: false }, { beneficiary: 'PROVINCE', rateKey: 'part_province', remainder: true }],
    legalReference: 'Constitution (art. 175) et loi de répartition applicable ; Loi n° 18/004 du 13 mars 2018 — articles relatifs à la répartition [À VÉRIFIER]',
  },
];

/** Fiche du registre juridique correspondant à une clé : position de travail, non exécutable (A_VERIFIER). */
export function keySheet(k: LegalShareKey): RuleSheet {
  return {
    id: `rule-${k.code.toLowerCase()}-v1`, code: k.code, version: 1, revenueCategory: 'ACTE_REQUIS', label: k.label,
    legalInstrumentIds: [], articles: [`${k.legalReference}`], competentAuthority: 'Assemblée provinciale / Gouvernement provincial (acte requis)', administeringEntity: 'MINFIN',
    taxableEvent: 'Recette rapprochée (niveau 9 de l’échelle du § 26.1)', liableParty: 'Sans objet (partage de recettes publiques)',
    baseDefinition: `Recettes rapprochées des catégories ${k.categories.join(', ')} ; commune du fait générateur pour la part des ETD`,
    formula: `recettes_rapprochees * (${k.parts.map((p) => p.rateKey).join(' + ')}) / 100`, rateTable: {}, currency: 'CDF', rounding: 'DOWN',
    periodicity: 'MENSUELLE', dueRule: 'Après rapprochement, selon l’acte de répartition [À VÉRIFIER]', exemptions: [], penalties: [], effectiveFrom: '2026-01-01',
    beneficiaryAccountAlias: 'Sans objet (aucun virement émis par la plateforme)', appealPath: 'Comité juridique et tarifaire (§ 10A.3)',
    status: 'A_VERIFIER', sourceVerification: 'AUCUNE', approvals: [],
    sourceReference: 'Cahier des exigences — § 27.1 (clés légales versionnées), § 29.2, § 30.6',
    readingNote: 'Taux NON renseignés : la lecture certifiée de l’acte de répartition fixe la table de taux (nouvelle version, quatre visas). Aucune part n’est calculée avant.',
  };
}

export interface ShareLine {
  keyCode: string; ruleId: string; ruleVersion: number; revenueCode: string; commune: string; currency: CurrencyCode;
  base: { reconciled: MoneyJSON; recorded: MoneyJSON; payments: number };
  shares: { beneficiary: ShareBeneficiary; entity: string; pct: string; reconciled: MoneyJSON; recorded: MoneyJSON }[];
}

export interface ShareCalculation {
  id: string; period: string; from: string; to: string; calculatedBy: string; calculatedAt: string; lines: ShareLine[];
  keys: { code: string; ruleId: string; version: number; rateTable: Record<string, string> }[];
  notCalculable: { code: string; reason: string; base: MoneyJSON[] }[];
  contentSha256: string; disbursement: 'AUCUN';
}

export type IncentiveStatus = 'A_VERIFIER' | 'ACTE_ENREGISTRE';
/** Cadre d'incitation de performance (§ 27.1) : tous les éléments exigés, sans aucun versement. */
export interface IncentiveFramework {
  id: string; code: string; label: string; legalBasis: string; approvedFormula: string; conditions: string; cap: string;
  antiGamingControl: string; taxTreatment: string; approvalCircuit: string; accounting: string; status: IncentiveStatus;
  recordedBy: string; recordedAt: string; act?: { reference: string; by: string; at: string }; payout: 'AUCUN';
}

const pctOf = (rate: string) => /^\d{1,3}(\.\d{1,4})?$/.test(rate) ? rate : null;

export class PartageLegalService {
  readonly calculations = new InMemoryAppendOnlyRepository<ShareCalculation>();
  readonly incentives = new InMemoryRepository<IncentiveFramework>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {
    // Fiches des clés versées au registre juridique (une fois) : A_VERIFIER, jamais exécutables en l'état.
    for (const k of LEGAL_SHARE_KEYS) {
      if (!ctx.rules.rules.find((r) => r.code === k.code).length) ctx.rules.rules.insert({ ...keySheet(k), createdAt: ctx.clock.now().toISOString(), sample: true });
    }
  }

  private get pil(): PilotageService { return ext<PilotageService>(this.ctx, 'pilotage'); }
  private now() { return this.ctx.clock.now().toISOString(); }

  /** Version exécutable (ACTIVE, certifiée, quatre visas, en vigueur) de la fiche d'une clé, sinon le motif. */
  activeRule(code: string): { rule: RuleSheet } | { reason: string } {
    const versions = this.ctx.rules.list().filter((r) => r.code === code).sort((a, b) => b.version - a.version);
    if (!versions.length) return { reason: 'Fiche absente du registre juridique.' };
    const at = this.ctx.clock.now();
    const rule = versions.find((r) => isRuleExecutable(r, at).ok);
    if (!rule) { const r = isRuleExecutable(versions[0]!, at); return { reason: `Clé non exécutable (${r.ok ? '' : r.reason}) : statut A_VERIFIER tant que l’acte n’est pas certifié.` }; }
    return { rule };
  }

  /** Entité qui reçoit une part : ETD = commune du fait générateur ; « lieu non établi » ⇒ part ETD non attribuée. */
  private entityOf(b: ShareBeneficiary, commune: string): string {
    return b === 'ETD' ? `ETD-${commune}` : b === 'PROVINCE' ? 'PROVINCE-KINSHASA' : 'POUVOIR-CENTRAL';
  }

  keysView(user: User) {
    authorize(user, 'legalshares:read', { communes: user.territory ?? [] });
    return {
      notice: 'Clés légales distinctes de la clé du § 37A. Aucune entité ne modifie une clé : tout changement est une nouvelle version de la fiche (quatre visas).',
      keys: LEGAL_SHARE_KEYS.map((k) => {
        const a = this.activeRule(k.code);
        const versions = this.ctx.rules.list().filter((r) => r.code === k.code).map((r) => ({ id: r.id, version: r.version, status: r.status, sourceVerification: r.sourceVerification, rateTable: r.rateTable, executable: isRuleExecutable(r, this.ctx.clock.now()).ok }));
        return { ...k, beneficiaries: k.parts.map((p) => ({ ...p, label: BENEFICIARY_LABELS[p.beneficiary] })), status: 'rule' in a ? 'ACTIVE' : 'A_VERIFIER', ...('reason' in a ? { reason: a.reason } : { ruleId: a.rule.id, ruleVersion: a.rule.version }), versions };
      }),
    };
  }

  /**
   * Calcul (POST /v1/legal-shares:calculate) : par clé, code de recette, commune et devise ; assiette rapprochée et
   * assiette comptabilisée ; parts tronquées, solde et arrondis à la part désignée (même arithmétique que le § 37A).
   */
  calculate(user: User, input: { period: string }) {
    authorize(user, 'legalshares:calculate');
    const { from, to } = periodRange(input.period);
    const facts = this.pil.facts();
    const excluded = new Set(this.ctx.payments.orders.all().filter((o) => o.status === 'REMBOURSE' || o.status === 'CONTREPASSE').map((o) => o.id));
    const ruleOf = new Map(facts.obligations.map((o) => [o.id, o.ruleCode]));
    const lines: ShareLine[] = []; const keys: ShareCalculation['keys'] = []; const notCalculable: ShareCalculation['notCalculable'] = [];
    for (const k of LEGAL_SHARE_KEYS) {
      type Cell = { rec: bigint; bk: bigint; n: number };
      const cells = new Map<string, Cell>();
      const cell = (rc: string, c: string, cur: CurrencyCode) => { const key = `${rc}|${c}|${cur}`; const x = cells.get(key) ?? { rec: 0n, bk: 0n, n: 0 }; cells.set(key, x); return x; };
      for (const o of facts.orders) {
        if (!k.categories.includes(o.category) || !isReconciled(o) || excluded.has(o.id)) continue;
        const d = kinshasaDay(o.reconciledAt!);
        if (d < from || d > to) continue;
        const x = cell(ruleOf.get(o.obligationId) ?? 'INCONNU', o.commune, o.amount.currency); x.rec += Money.fromJSON(o.amount).minor; x.n++;
      }
      for (const r of facts.recorded) {
        if (!k.categories.includes(r.category) || excluded.has(r.orderId)) continue;
        const d = kinshasaDay(r.at);
        if (d < from || d > to) continue;
        const o = facts.orders.find((x) => x.id === r.orderId);
        cell(ruleOf.get(o?.obligationId ?? '') ?? 'INCONNU', r.commune, r.amount.currency).bk += Money.fromJSON(r.amount).minor;
      }
      const a = this.activeRule(k.code);
      if ('reason' in a) {
        const byCur = new Map<CurrencyCode, bigint>();
        for (const [key, x] of cells) { const cur = key.split('|')[2] as CurrencyCode; byCur.set(cur, (byCur.get(cur) ?? 0n) + x.rec); }
        notCalculable.push({ code: k.code, reason: a.reason, base: [...byCur.entries()].map(([c, v]) => Money.fromMinor(v, c).toJSON()) });
        continue;
      }
      const rates = k.parts.map((p) => ({ ...p, pct: pctOf(a.rule.rateTable[p.rateKey] ?? '') }));
      const missing = rates.filter((r) => !r.remainder && r.pct === null).map((r) => r.rateKey);
      if (missing.length) { notCalculable.push({ code: k.code, reason: `Table de taux incomplète : ${missing.join(', ')}.`, base: [] }); continue; }
      // Réutilise l'arithmétique exacte de la clé du § 37A (parts tronquées, solde à la part désignée).
      const nonRem = rates.filter((r) => !r.remainder).reduce((s, r) => s + Number(r.pct), 0);
      if (nonRem > 100) { notCalculable.push({ code: k.code, reason: 'Somme des parts supérieure à 100 %.', base: [] }); continue; }
      const remPct = (Math.round((100 - nonRem) * 10_000) / 10_000).toString();
      // Conversion justifiée : tranches construites dynamiquement depuis l'acte ; champs complétés plus loin (calcul).
      const slices = rates.map((r) => ({ code: r.beneficiary, label: r.beneficiary, pct: r.remainder ? remPct : r.pct!, flow: 'FLUX_2', remainder: r.remainder, rateKey: r.rateKey, calcul: '' })) as unknown as SliceDef[];
      keys.push({ code: k.code, ruleId: a.rule.id, version: a.rule.version, rateTable: a.rule.rateTable });
      for (const [key, x] of cells) {
        const [revenueCode, commune, cur] = key.split('|') as [string, string, CurrencyCode];
        const rec = allocate(Money.fromMinor(x.rec, cur), slices); const bk = allocate(Money.fromMinor(x.bk, cur), slices);
        lines.push({
          keyCode: k.code, ruleId: a.rule.id, ruleVersion: a.rule.version, revenueCode, commune, currency: cur,
          base: { reconciled: Money.fromMinor(x.rec, cur).toJSON(), recorded: Money.fromMinor(x.bk, cur).toJSON(), payments: x.n },
          shares: rates.map((r, i) => ({ beneficiary: r.beneficiary, entity: this.entityOf(r.beneficiary, commune), pct: slices[i]!.pct, reconciled: rec[i]!.amount.toJSON(), recorded: bk[i]!.amount.toJSON() })),
        });
      }
    }
    const content = { period: input.period, from, to, lines, keys, notCalculable };
    const calc = this.calculations.append({ id: this.ids.next('PARTAGE'), ...content, calculatedBy: user.id, calculatedAt: this.now(), contentSha256: sha256Hex(canonicalJson(content)), disbursement: 'AUCUN' });
    this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'legal_shares.calculated', resourceType: 'legal_share_calculation', resourceId: calc.id, details: { period: input.period, lines: lines.length, keys: keys.map((x) => `${x.code}@${x.version}`), contentSha256: calc.contentSha256 } });
    return this.view(user, calc);
  }

  /** Vue d'un calcul filtrée au périmètre : une commune (ETD) ne voit que ses propres parts ; aucun nom de contribuable. */
  view(user: User, c: ShareCalculation) {
    const territory = user.roles.includes('R08') && user.territory?.length ? user.territory : null;
    const lines = territory ? c.lines.filter((l) => territory.includes(l.commune)).map((l) => ({ ...l, shares: l.shares.filter((s) => s.beneficiary === 'ETD') })) : c.lines;
    const totals = new Map<string, { beneficiary: ShareBeneficiary; entity: string; currency: CurrencyCode; reconciled: bigint; recorded: bigint }>();
    for (const l of lines) for (const s of l.shares) {
      const k = `${s.entity}|${l.currency}`;
      const t = totals.get(k) ?? { beneficiary: s.beneficiary, entity: s.entity, currency: l.currency, reconciled: 0n, recorded: 0n };
      t.reconciled += Money.fromJSON(s.reconciled).minor; t.recorded += Money.fromJSON(s.recorded).minor; totals.set(k, t);
    }
    return {
      ...c, lines, scope: territory ? `ETD : ${territory.join(', ')}` : 'Toutes les entités',
      byEntity: [...totals.values()].map((t) => ({ beneficiary: t.beneficiary, label: BENEFICIARY_LABELS[t.beneficiary], entity: t.entity, currency: t.currency, calculatedOnReconciled: Money.fromMinor(t.reconciled, t.currency).toJSON(), calculatedOnRecorded: Money.fromMinor(t.recorded, t.currency).toJSON() })),
      notice: 'Parts calculées sur recettes rapprochées et comptabilisées ; aucun virement n’est émis par la plateforme (le Trésor exécute selon les procédures publiques).',
    };
  }

  list(user: User) {
    authorize(user, 'legalshares:read', { communes: user.territory ?? [] });
    return { items: this.calculations.all().slice(-50).reverse().map((c) => this.view(user, c)) };
  }

  get(user: User, id: string) {
    authorize(user, 'legalshares:read', { communes: user.territory ?? [] });
    const c = this.calculations.get(id);
    if (!c) throw notFound('CALCULATION_NOT_FOUND', 'Calcul inconnu.');
    return this.view(user, c);
  }

  // ————————————————————————— cadre des incitations de performance (§ 27.1) —————————————————————————

  recordIncentive(user: User, input: Omit<IncentiveFramework, 'id' | 'status' | 'recordedBy' | 'recordedAt' | 'act' | 'payout'>) {
    authorize(user, 'legalshares:incentive.record');
    if (this.incentives.findOne((x) => x.code === input.code)) throw conflict('DUPLICATE_CODE', 'Code déjà utilisé.');
    const f = this.incentives.insert({ id: this.ids.next('INCIT'), ...input, status: 'A_VERIFIER', recordedBy: user.id, recordedAt: this.now(), payout: 'AUCUN' });
    this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'legal_shares.incentive.recorded', resourceType: 'incentive_framework', resourceId: f.id, details: { code: f.code } });
    return f;
  }

  /** Enregistrement de l'acte (base légale) par un juriste ou l'autorité de publication, distinct de l'auteur. Aucun versement. */
  recordIncentiveAct(user: User, id: string, reference: string) {
    authorize(user, 'legalshares:incentive.act');
    const f = this.incentives.get(id);
    if (!f) throw notFound('INCENTIVE_NOT_FOUND', 'Cadre inconnu.');
    if (f.status !== 'A_VERIFIER') throw conflict('ALREADY_RECORDED', 'Acte déjà enregistré.');
    assertDistinctPerson(user.id, [f.recordedBy], 'L’acte est enregistré par une personne distincte de l’auteur du cadre.');
    const out = this.incentives.update({ ...f, status: 'ACTE_ENREGISTRE', act: { reference, by: user.id, at: this.now() } });
    this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'legal_shares.incentive.act_recorded', resourceType: 'incentive_framework', resourceId: id, details: { reference } });
    return out;
  }

  incentivesView(user: User) {
    authorize(user, 'legalshares:read', { communes: user.territory ?? [] });
    return {
      notice: 'Registre seulement : aucune incitation n’est calculée ni versée par ce module ; les commissions des agents relèvent de leur propre circuit.',
      required: ['Base légale', 'Formule approuvée', 'Conditions', 'Plafond', 'Contrôle anti-optimisation', 'Traitement fiscal', 'Circuit d’approbation', 'Comptabilisation'],
      items: this.incentives.all(),
    };
  }
}

export const LEGAL_SHARE_READERS: RoleCode[] = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R08', 'R13', 'R14', 'R15', 'R16', 'R17', 'R18', 'R22', 'R23', 'R24'];
