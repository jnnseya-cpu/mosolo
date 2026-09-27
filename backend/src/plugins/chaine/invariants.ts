/**
 * Invariants de la chaîne opératoire : aucun maillon ne peut être sauté.
 *   - pas de quittance sans paiement confirmé (et pas de quittance définitive sans rapprochement) ;
 *   - pas de paiement sans obligation liquidée ;
 *   - pas d'obligation sans règle validée (version ACTIVE, quatre approbations distinctes) ;
 *   - pas de règle active sans texte juridique en vigueur.
 * Les services refusent déjà chacun de ces sauts par l'API ; ce contrôle relit les dépôts eux-mêmes pour détecter un
 * enregistrement forgé ou importé hors des circuits (restauration, accès direct à la base). Il lève des alertes
 * (examen humain) et n'a AUCUN effet automatique : ni annulation, ni sanction.
 */
import { Money, REQUIRED_APPROVALS, type RoleCode } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { kinshasaDate } from '../../core/clock.js';
import type { RuleRecord } from '../../modules/rules/service.js';
import type { MaillonCode } from './model.js';

export type RuptureCode =
  | 'QUITTANCE_SANS_PAIEMENT_CONFIRME'
  | 'QUITTANCE_DEFINITIVE_SANS_RAPPROCHEMENT'
  | 'PAIEMENT_SANS_OBLIGATION_LIQUIDEE'
  | 'OBLIGATION_SANS_REGLE_VALIDEE'
  | 'REGLE_ACTIVE_SANS_TEXTE_EN_VIGUEUR';

export const RUPTURE_LABELS: Record<RuptureCode, { label: string; maillon: MaillonCode; severity: 'HIGH' | 'CRITICAL' }> = {
  QUITTANCE_SANS_PAIEMENT_CONFIRME: { label: 'Quittance sans paiement confirmé', maillon: 'QUITTANCER', severity: 'CRITICAL' },
  QUITTANCE_DEFINITIVE_SANS_RAPPROCHEMENT: { label: 'Quittance définitive sans règlement rapproché', maillon: 'QUITTANCER', severity: 'CRITICAL' },
  PAIEMENT_SANS_OBLIGATION_LIQUIDEE: { label: 'Paiement sur une obligation non liquidée', maillon: 'PAYER', severity: 'CRITICAL' },
  OBLIGATION_SANS_REGLE_VALIDEE: { label: 'Obligation sans règle validée (version ACTIVE)', maillon: 'CALCULER', severity: 'HIGH' },
  REGLE_ACTIVE_SANS_TEXTE_EN_VIGUEUR: { label: 'Règle active sans texte juridique en vigueur', maillon: 'QUALIFIER', severity: 'HIGH' },
};

export interface Rupture {
  code: RuptureCode;
  label: string;
  maillon: MaillonCode;
  severity: 'HIGH' | 'CRITICAL';
  resourceType: 'receipt' | 'payment_order' | 'obligation' | 'rule';
  resourceId: string;
  detail: string;
}

/** Statuts d'ordre qui supposent une confirmation prestataire préalable. */
const CONFIRMED_LIKE = new Set(['CONFIRME', 'REGLE', 'RAPPROCHE', 'CONTESTE', 'CONTREPASSE', 'REMBOURSE', 'DOUBLON']);
const IN_FORCE = new Set(['EN_VIGUEUR', 'MODIFIE']);

/** Motif pour lequel une règle n'a pas (ou plus) de texte en vigueur ; `null` : fondement valable. */
export function legalTextProblem(ctx: AppContext, rule: RuleRecord, today = kinshasaDate(ctx.clock.now())): string | null {
  if (!rule.legalInstrumentIds.length) return 'aucune référence de texte juridique';
  for (const id of rule.legalInstrumentIds) {
    const inst = ctx.rules.instrument(id);
    if (!inst) return `instrument ${id} inconnu du registre juridique`;
    if (IN_FORCE.has(inst.status)) continue;
    if (inst.status === 'ABROGE' && inst.abrogatedOn && inst.abrogatedOn > today) continue;
    return `instrument ${id} au statut ${inst.status}${inst.abrogatedOn ? ` (abrogé le ${inst.abrogatedOn})` : ''}`;
  }
  if (rule.sourceVerification !== 'OFFICIEL_CERTIFIE') return `source non certifiée (${rule.sourceVerification})`;
  return null;
}

/** Motif pour lequel une règle n'est pas validée (quatre visas distincts) ; `null` : validée. */
export function approvalProblem(rule: RuleRecord): string | null {
  const roles = new Set(rule.approvals.map((a) => a.role));
  const people = new Set(rule.approvals.map((a) => a.userId));
  if (!REQUIRED_APPROVALS.every((r) => roles.has(r)) || people.size < REQUIRED_APPROVALS.length) {
    return `visas incomplets (${rule.approvals.length}/${REQUIRED_APPROVALS.length}, ${people.size} personne(s) distincte(s))`;
  }
  return null;
}

/** Index des événements du journal d'audit utiles aux invariants (lecture seule). */
function auditIndex(ctx: AppContext) {
  const confirmed = new Set<string>();
  const issued = new Set<string>();
  for (const r of ctx.audit.list({ action: 'payment.confirmed', limit: Number.MAX_SAFE_INTEGER }).items) if (r.resourceId) confirmed.add(r.resourceId);
  for (const r of ctx.audit.list({ action: 'assessment.', limit: Number.MAX_SAFE_INTEGER }).items) {
    if ((r.action === 'assessment.issued' || r.action === 'assessment.rectified') && r.resourceId) issued.add(r.resourceId);
  }
  return { confirmed, issued };
}

/** Relit tous les dépôts et renvoie les maillons sautés (aucun effet de bord). */
export function scanRuptures(ctx: AppContext): Rupture[] {
  const out: Rupture[] = [];
  const add = (code: RuptureCode, resourceType: Rupture['resourceType'], resourceId: string, detail: string) =>
    out.push({ code, ...RUPTURE_LABELS[code], resourceType, resourceId, detail });
  const idx = auditIndex(ctx);
  const today = kinshasaDate(ctx.clock.now());

  // Quittances : paiement confirmé (prestataire, journal) puis, pour la définitive, règlement rapproché.
  for (const r of ctx.receipts.receipts.all()) {
    const o = ctx.payments.orders.get(r.paymentOrderId);
    if (!o) add('QUITTANCE_SANS_PAIEMENT_CONFIRME', 'receipt', r.id, `Quittance ${r.number} : ordre de paiement ${r.paymentOrderId} introuvable.`);
    else if (!o.confirmedAt || !CONFIRMED_LIKE.has(o.status)) add('QUITTANCE_SANS_PAIEMENT_CONFIRME', 'receipt', r.id, `Quittance ${r.number} : paiement ${o.paymentReference} au statut ${o.status}, jamais confirmé par le prestataire.`);
    else if (!idx.confirmed.has(o.id)) add('QUITTANCE_SANS_PAIEMENT_CONFIRME', 'receipt', r.id, `Quittance ${r.number} : aucune confirmation signée du prestataire au journal d'audit pour ${o.paymentReference}.`);
    else if (r.obligationId !== o.obligationId) add('QUITTANCE_SANS_PAIEMENT_CONFIRME', 'receipt', r.id, `Quittance ${r.number} : obligation ${r.obligationId} différente de celle du paiement (${o.obligationId}).`);
    else if (r.status === 'DEFINITIVE' && !o.reconciledAt) add('QUITTANCE_DEFINITIVE_SANS_RAPPROCHEMENT', 'receipt', r.id, `Quittance ${r.number} définitive alors que le paiement ${o.paymentReference} n'est pas rapproché (statut ${o.status}).`);
  }

  // Paiements : toute référence porte sur une obligation réellement liquidée (émise, écriture de constatation, journal).
  for (const o of ctx.payments.orders.all()) {
    const ob = ctx.assessment.obligations.get(o.obligationId);
    if (!ob) { add('PAIEMENT_SANS_OBLIGATION_LIQUIDEE', 'payment_order', o.id, `Paiement ${o.paymentReference} : obligation ${o.obligationId} introuvable.`); continue; }
    const problems: string[] = [];
    if (ob.trace.simulate || ob.trace.nonOpposable) problems.push('simulation non opposable');
    if (!idx.issued.has(ob.id)) problems.push('émission absente du journal d’audit');
    if (!Money.fromJSON(ob.amount).isZero() && !(ob.ledgerEntryId && ctx.ledger.get(ob.ledgerEntryId))) problems.push('aucune écriture de constatation au grand livre');
    if (problems.length) add('PAIEMENT_SANS_OBLIGATION_LIQUIDEE', 'payment_order', o.id, `Paiement ${o.paymentReference} sur l'obligation ${ob.id} non liquidée : ${problems.join(', ')}.`);
  }

  // Obligations : règle du registre, même version, ACTIVE et exécutable à la liquidation, visas complets.
  for (const ob of ctx.assessment.obligations.all()) {
    const rule = ctx.rules.rules.get(ob.ruleId);
    const problems: string[] = [];
    if (!rule) problems.push(`règle ${ob.ruleId} absente du registre`);
    else {
      if (rule.code !== ob.ruleCode || rule.version !== ob.ruleVersion) problems.push(`version figée ${ob.ruleCode} v${ob.ruleVersion} ≠ registre ${rule.code} v${rule.version}`);
      const ap = approvalProblem(rule);
      if (ap) problems.push(ap);
    }
    if (ob.trace.ruleStatus !== 'ACTIVE') problems.push(`règle au statut ${ob.trace.ruleStatus} à la liquidation`);
    if (!ob.trace.executable) problems.push(`règle non exécutable à la liquidation${ob.trace.executabilityReason ? ` (${ob.trace.executabilityReason})` : ''}`);
    if (problems.length) add('OBLIGATION_SANS_REGLE_VALIDEE', 'obligation', ob.id, `Obligation ${ob.id} : ${problems.join(' ; ')}.`);
  }

  // Règles actives : texte juridique en vigueur.
  for (const rule of ctx.rules.rules.find((r) => r.status === 'ACTIVE')) {
    const p = legalTextProblem(ctx, rule, today);
    if (p) add('REGLE_ACTIVE_SANS_TEXTE_EN_VIGUEUR', 'rule', rule.id, `Règle ${rule.code} v${rule.version} ACTIVE : ${p}.`);
  }
  return out;
}

/**
 * Contrôle complet : détection puis alerte (une par rupture et par ressource, jamais répétée) à l'anti-fraude,
 * à la sécurité et à l'audit interne. Aucun effet automatique sur les dossiers.
 */
export function checkChainInvariants(ctx: AppContext, notifyRoles: RoleCode[] = ['R22']) {
  const ruptures = scanRuptures(ctx);
  let raised = 0;
  const alerts: string[] = [];
  for (const r of ruptures) {
    const a = ctx.alerts.raiseOnce(`chaine:${r.code}:${r.resourceType}:${r.resourceId}`, {
      type: 'CHAINE_MAILLON_SAUTE', severity: r.severity, source: 'chaine-operatoire', detail: `${r.label} — ${r.detail}`,
      context: { code: r.code, maillon: r.maillon, resourceType: r.resourceType, resourceId: r.resourceId }, notifyRoles,
    });
    if (a) { raised++; alerts.push(a.id); }
  }
  const counts = Object.fromEntries((Object.keys(RUPTURE_LABELS) as RuptureCode[]).map((c) => [c, ruptures.filter((r) => r.code === c).length])) as Record<RuptureCode, number>;
  return { scannedAt: ctx.clock.now().toISOString(), total: ruptures.length, counts, ruptures, alertsRaised: raised, alertIds: alerts, automaticEffect: 'AUCUN' as const };
}
