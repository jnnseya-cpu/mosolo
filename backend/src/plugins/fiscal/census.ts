/**
 * Méthode de recensement massif (§ 17.4) : chaque donnée porte une provenance, un niveau de confiance, une date de
 * vérification et un responsable de validation ; les vagues 0 à 5 sont l'état de maturité de l'objet, avec des
 * transitions journalisées et un indicateur de couverture par vague. Aucune vague n'a d'effet fiscal avant la vague 4,
 * qui n'est atteinte que par une obligation issue d'une règle validée (ACTIVE).
 */
import { isRuleExecutable } from '@mosolo/shared';
import type { User } from '../../core/auth.js';
import { badRequest, conflict, unprocessable } from '../../core/errors.js';
import { authorize, definePolicy, GRANTS } from '../../core/policy.js';
import type { CensusStage, DataProvenance, FiscalObject, ProvenanceSource } from '../../modules/objects/service.js';
import { actorOf, type FiscalDeps } from './common.js';

const { always, inTerritory } = GRANTS;
definePolicy('fiscal:census.read', { R06: always, R07: always, R11: always, R22: always, R09: inTerritory('minimal'), R10: inTerritory('minimal') });
definePolicy('fiscal:census.advance', { R06: always, R07: always, R11: always, R09: inTerritory('full') });
definePolicy('fiscal:provenance.record', { R06: always, R07: always, R11: always, R09: inTerritory('full'), R10: inTerritory('full') });

export const CENSUS_STAGE_LABELS: Record<CensusStage, { label: string; target: string; output: string }> = {
  0: { label: 'Préparation', target: 'Découpage des zones et import des données existantes', output: 'Carte de référence, doublons, zones blanches' },
  1: { label: 'Détection', target: 'Tout objet visible ou déclaré', output: 'Objet provisoire avec preuve minimale' },
  2: { label: 'Qualification', target: 'Usage, dimensions, activité, statut', output: 'Fiche complète et score de confiance' },
  3: { label: 'Rattachement', target: 'Personne ou organisation', output: 'Relation juridique vérifiée ou à confirmer' },
  4: { label: 'Fiscalisation', target: 'Règles validées uniquement', output: 'Obligations calculées et expliquées' },
  5: { label: 'Entretien', target: 'Ouvertures, fermetures, mutations', output: 'Registre continuellement actualisé' },
};

const CONFIDENCE_OF: Record<string, DataProvenance['confidence']> = { VERIFIE: 'ELEVEE', OBSERVE: 'MOYENNE', DECLARE: 'MOYENNE', CONTESTE: 'FAIBLE' };

/** Vague d'un objet : celle enregistrée, sinon déduite de son état (jamais au-delà de ce que les données prouvent). */
export function stageOf(d: FiscalDeps, o: FiscalObject): CensusStage {
  if (o.censusStage !== undefined) return o.censusStage;
  if (o.importedFrom && o.status !== 'VALIDE') return 0;
  const hasRuleObligation = d.ctx.assessment.obligations.find((x) => x.objectId === o.id && x.status !== 'ANNULEE').some((x) => {
    const r = d.ctx.rules.rules.get(x.ruleId);
    return !!r && isRuleExecutable(r, new Date(x.createdAt)).ok;
  });
  if (hasRuleObligation) return 4;
  if (o.taxpayerId) return 3;
  if (o.status === 'VALIDE') return 2;
  return 1;
}

/** Provenance affichée par champ : explicite si enregistrée, sinon déduite du statut probant de l'objet. */
export function provenanceView(o: FiscalObject): Record<string, DataProvenance & { inferred: boolean }> {
  const out: Record<string, DataProvenance & { inferred: boolean }> = {};
  const inferredSource: ProvenanceSource = o.importedFrom ? 'E_DGRK' : o.probativeStatus === 'DECLARE' ? 'AUTO_DECLARATION' : 'MISSION_TERRAIN';
  for (const k of Object.keys(o.attributes)) {
    if (k === 'demo') continue;
    const p = o.provenance?.[k];
    out[k] = p ? { ...p, inferred: false } : {
      source: inferredSource, confidence: CONFIDENCE_OF[o.probativeStatus] ?? 'FAIBLE', recordedAt: o.createdAt,
      ...(o.validatedAt ? { verifiedAt: o.validatedAt } : {}), ...(o.validatedBy ? { verifiedBy: o.validatedBy } : {}), inferred: true,
    };
  }
  return out;
}

export class CensusService {
  constructor(private readonly d: FiscalDeps) {}

  /** Passage de vague : une vague à la fois (sauf entretien), conditions vérifiées, motif et journal. */
  advance(user: User, objectId: string, input: { to: CensusStage; reason: string }): FiscalObject {
    const o = this.d.ctx.objects.get(objectId);
    authorize(user, 'fiscal:census.advance', { communes: [o.commune] });
    const from = stageOf(this.d, o);
    const to = input.to;
    if (to === from) throw conflict('SAME_STAGE', `Objet déjà en vague ${to}.`);
    if (to < from && to !== 5) throw unprocessable('STAGE_BACKWARD', 'Une vague ne recule pas : une correction passe par le circuit des corrections d’objet.');
    if (to > from + 1 && to !== 5) throw unprocessable('STAGE_SKIPPED', `Passage de la vague ${from} à ${to} impossible : une vague à la fois.`);
    if (to >= 2 && o.status !== 'VALIDE') throw unprocessable('STAGE_CONDITION', 'Qualification : l’objet doit être validé (fiche complète vérifiée par une personne distincte).');
    if (to >= 3 && !o.taxpayerId) throw unprocessable('STAGE_CONDITION', 'Rattachement : une relation juridique validée (redevable) est requise.');
    const { censusStage: _recorded, ...raw } = o;
    if (to === 4 && stageOf(this.d, raw) < 4) {
      throw unprocessable('STAGE_CONDITION', 'Fiscalisation : seule une obligation issue d’une règle validée (ACTIVE) fait passer l’objet en vague 4.');
    }
    if (to === 5 && from < 4) throw unprocessable('STAGE_CONDITION', 'Entretien : l’objet doit d’abord être fiscalisé.');
    const at = this.d.nowIso();
    const out = this.d.ctx.objects.setCensusMeta(o.id, { censusStage: to, censusHistory: [...(o.censusHistory ?? []), { at, from, to, by: user.id, reason: input.reason }] });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'fiscal.census.stage_changed', resourceType: 'fiscal_object', resourceId: o.id, details: { from, to, reason: input.reason } });
    return out;
  }

  /** Enregistre la provenance vérifiée d'une donnée (jamais une modification de la valeur déclarée). */
  recordProvenance(user: User, objectId: string, input: { field: string; source: ProvenanceSource; sourceLabel?: string; confidence: DataProvenance['confidence']; verifiedAt?: string }): FiscalObject {
    const o = this.d.ctx.objects.get(objectId);
    authorize(user, 'fiscal:provenance.record', { communes: [o.commune] });
    if (!(input.field in o.attributes)) throw badRequest('UNKNOWN_FIELD', `Donnée inconnue sur l’objet : ${input.field}`);
    const at = this.d.nowIso();
    const p: DataProvenance = { source: input.source, confidence: input.confidence, recordedAt: at, ...(input.sourceLabel ? { sourceLabel: input.sourceLabel } : {}), verifiedAt: input.verifiedAt ?? at.slice(0, 10), verifiedBy: user.id };
    const out = this.d.ctx.objects.setCensusMeta(o.id, { provenance: { ...(o.provenance ?? {}), [input.field]: p } });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'fiscal.provenance.recorded', resourceType: 'fiscal_object', resourceId: o.id, details: { field: input.field, source: input.source, confidence: input.confidence } });
    return out;
  }

  /** Indicateur de couverture par vague (et par commune). */
  coverage(user: User, commune?: string) {
    authorize(user, 'fiscal:census.read', commune ? { communes: [commune] } : {});
    const objs = this.d.ctx.objects.objects.all().filter((o) => (!commune || o.commune === commune) && (!user.territory || user.territory.includes(o.commune)));
    const byStage = new Map<CensusStage, number>([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]]);
    const byCommune: Record<string, Record<string, number>> = {};
    for (const o of objs) {
      const s = stageOf(this.d, o);
      byStage.set(s, (byStage.get(s) ?? 0) + 1);
      (byCommune[o.commune] ??= { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<string, number>)[String(s)]! += 1;
    }
    const total = objs.length;
    return {
      total,
      stages: [...byStage.entries()].map(([stage, count]) => ({ stage, ...CENSUS_STAGE_LABELS[stage], count, pct: total ? Math.round((count * 1000) / total) / 10 : 0, atLeast: objs.filter((o) => stageOf(this.d, o) >= stage).length })),
      byCommune,
      imported: objs.filter((o) => !!o.importedFrom).length,
      withExplicitProvenance: objs.filter((o) => Object.keys(o.provenance ?? {}).length > 0).length,
    };
  }
}
