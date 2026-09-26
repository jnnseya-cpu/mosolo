/**
 * Couleurs calculées côté serveur (§ 16.6) — jamais dans l'interface.
 *  - Couche « situation fiscale » : vert régularisé ; ambre partiel, échéance proche ou revue nécessaire ;
 *    rouge en retard APRÈS vérification ; gris non enregistré / données insuffisantes ; bleu litige ou revue formelle.
 *  - Couche « vérification / couverture du recensement » : vert vérifié ; ambre à vérifier ; rouge anomalie ;
 *    gris inconnu ; bleu dossier en instruction.
 * Une couleur rouge n'entraîne aucune mesure : elle signale un dossier à traiter par une personne habilitée.
 */
import type { MapStatusColor } from '@mosolo/shared';
import { PAYABLE_STATUSES } from '../../modules/assessment/service.js';
import type { FiscalObject } from '../../modules/objects/service.js';
import { addDays, type FiscalDeps } from './common.js';
import type { RelationService } from './relations.js';

export interface ColorResult { color: MapStatusColor; label: string; reason: string }

export const SITUATION_LEGEND: Record<MapStatusColor, string> = {
  green: 'Régularisé — aucune obligation exigible impayée',
  amber: 'Paiement partiel, échéance proche ou revue nécessaire',
  red: 'En retard ou non régularisé après vérification',
  grey: 'Non enregistré ou données insuffisantes',
  blue: 'En litige ou en revue formelle',
};

export const COVERAGE_LEGEND: Record<MapStatusColor, string> = {
  green: 'Vérifié (preuves concordantes)',
  amber: 'À vérifier (déclaré ou observé)',
  red: 'Anomalie détectée (écart déclaré / observé, conflit)',
  grey: 'Inconnu — recensé sans rattachement',
  blue: 'Dossier en instruction',
};

/** Seuil « échéance proche » (jours) — [paramètre de démonstration]. */
export const DUE_SOON_DAYS = 30;

export function situationOf(d: FiscalDeps, obj: FiscalObject): ColorResult {
  const today = d.today();
  const obligations = d.ctx.assessment.obligations.find((o) => o.objectId === obj.id && o.status !== 'ANNULEE');
  const mk = (color: MapStatusColor, reason: string): ColorResult => ({ color, label: SITUATION_LEGEND[color], reason });
  if (obj.probativeStatus === 'CONTESTE' || obligations.some((o) => o.status === 'CONTESTEE')) return mk('blue', 'Donnée ou obligation contestée : instruction en cours.');
  if (obj.status !== 'VALIDE' && obligations.length === 0) return mk('grey', 'Objet recensé, non encore validé ni liquidé.');
  const payable = obligations.filter((o) => PAYABLE_STATUSES.includes(o.status));
  const overdue = payable.filter((o) => o.status === 'EN_RETARD' || o.dueDate < today);
  if (overdue.length) {
    return obj.status === 'VALIDE'
      ? mk('red', `${overdue.length} obligation(s) échue(s) non régularisée(s) sur un objet vérifié.`)
      : mk('amber', 'Échéance dépassée sur un objet non vérifié : revue nécessaire avant tout constat.');
  }
  const pendingRecon = payable.filter((o) => d.ctx.payments.byObligation(o.id).some((p) => p.status === 'CONFIRME' || p.status === 'REGLE'));
  if (pendingRecon.length) return mk('amber', 'Paiement confirmé, en attente de rapprochement (quittance provisoire).');
  if (payable.some((o) => o.status === 'PARTIELLEMENT_PAYEE')) return mk('amber', 'Paiement partiel.');
  const soon = addDays(today, DUE_SOON_DAYS);
  if (payable.some((o) => o.dueDate <= soon)) return mk('amber', `Échéance dans moins de ${DUE_SOON_DAYS} jours.`);
  if (obj.status !== 'VALIDE') return mk('amber', 'Objet non encore validé : revue nécessaire.');
  return mk('green', payable.length ? 'Obligations émises, non encore exigibles.' : 'Aucune obligation exigible impayée.');
}

export function coverageOf(d: FiscalDeps, obj: FiscalObject, relations: RelationService): ColorResult {
  const mk = (color: MapStatusColor, reason: string): ColorResult => ({ color, label: COVERAGE_LEGEND[color], reason });
  const rels = relations.ofObject(obj.id);
  const conflicting = Object.keys(obj.observed).filter((k) => k in obj.attributes && String(obj.observed[k]) !== String(obj.attributes[k]));
  if (obj.probativeStatus === 'CONTESTE' || rels.some((r) => r.status === 'CONTESTEE')) return mk('red', 'Conflit ou contestation sur l’objet ou sa propriété.');
  if (conflicting.length) return mk('red', `Écart entre déclaré et observé : ${conflicting.join(', ')}.`);
  if (rels.some((r) => r.status === 'PROPOSEE')) return mk('blue', 'Rattachement proposé, en attente de validation.');
  if (obj.probativeStatus === 'VERIFIE') return mk('green', 'Objet validé par un agent habilité.');
  if (!obj.taxpayerId && !rels.some((r) => r.status === 'VALIDEE')) return mk('grey', 'Recensé sans contribuable rattaché.');
  return mk('amber', obj.probativeStatus === 'OBSERVE' ? 'Observé sur le terrain, à vérifier.' : 'Déclaré, à vérifier.');
}

/** Statut d'occupation (scan agent) : mis en bail / occupé par le propriétaire / non déclaré. */
export function occupancyOf(d: FiscalDeps, obj: FiscalObject): { code: string; label: string } {
  const today = d.today();
  const ids = new Set([obj.id, ...d.ctx.objects.objects.find((o) => o.parentObjectId === obj.id || o.attributes['parcelleId'] === obj.id || o.attributes['batimentId'] === obj.id).map((o) => o.id)]);
  const active = d.ctx.objects.leases.find((l) => ids.has(l.unitObjectId) && l.start <= today && (!l.end || l.end >= today));
  if (active.length) return { code: 'MIS_EN_BAIL', label: `Mis en bail (${active.length} bail/baux déclaré(s))` };
  const occ = obj.attributes['occupation'];
  if (occ === 'PROPRIETAIRE_OCCUPANT') return { code: 'OCCUPE_PAR_LE_PROPRIETAIRE', label: 'Occupé par le propriétaire (déclaré)' };
  if (occ === 'VACANT') return { code: 'VACANT', label: 'Vacant (déclaré)' };
  return { code: 'NON_DECLARE', label: 'Occupation non déclarée' };
}
