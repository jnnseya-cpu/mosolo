/**
 * Contrôle qualité renforcé de la sous-traitance terrain (§ 15A.5, § 15A.7, § 25 « objets fictifs créés pour la
 * rémunération : contrôle qualité indépendant, récupération des sommes ») :
 *  - détection des DOUBLONS (même photo, même objet validé plusieurs fois, nouveaux objets déclarés au même endroit) et
 *    des OBJETS PRÉSUMÉS FICTIFS (contre-visite non conforme, contrôle mystère irrégulier, nouvel objet sans photo ni GPS
 *    mesuré) : présomptions à contre-visiter, jamais une sanction ;
 *  - ROTATION DES ZONES : durée maximale d'un agent (ou d'un sous-traitant) sur une même commune, contrôlée à
 *    l'affectation (alerte ; blocage facultatif, désactivé par défaut) et listée ;
 *  - RÉCUPÉRATION des sommes versées pour des objets fictifs ou des constats frauduleux : proposition du contrôle
 *    qualité (R09/R11), décision d'une autre personne de la régie (R06/R07), puis opération du Trésor
 *    RECUPERATION_SOUS_TRAITANT à quatre yeux (ordre de reversement). Aucun prélèvement automatique.
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS } from '../../core/clock.js';
import { conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { FinancialOperation, OperationInput, TresorService } from '../tresor/service.js';
import { distanceM } from './geo.js';
import type { Finding, Mission } from './model.js';
import type { TerrainService } from './service.js';

/** Deux nouveaux objets déclarés à moins de … mètres l'un de l'autre : doublon présumé — PAR_DEFAUT, à confirmer. */
export const DOUBLON_DISTANCE_M = 15;
/** Durée maximale d'un agent (ou d'un sous-traitant) sur une même commune avant rotation — PAR_DEFAUT, à confirmer. */
export const ROTATION_ZONE_MAX_JOURS = 90;
/** Rotation des zones : bloquer l'affectation au-delà de la durée (sinon alerte seulement) — PAR_DEFAUT : non. */
export const ROTATION_ZONE_BLOCAGE = false;

const { always } = GRANTS;
definePolicy('terrain:qc.read', { R06: always, R07: always, R09: always, R11: always, R17: always, R22: always, R23: always, R24: always });
definePolicy('terrain:clawback.propose', { R09: always, R11: always });
definePolicy('terrain:clawback.decide', { R06: always, R07: always });

export type SuspicionCode = 'PHOTO_EN_DOUBLE' | 'OBJET_VALIDE_EN_DOUBLE' | 'NOUVEAUX_OBJETS_PROCHES' | 'CONTRE_VISITE_NON_CONFORME' | 'CONTROLE_MYSTERE_IRREGULIER' | 'NOUVEL_OBJET_SANS_PREUVE';
export interface Suspicion {
  code: SuspicionCode;
  kind: 'DOUBLON' | 'FICTIF';
  label: string;
  findingIds: string[];
  subcontractorId: string | null;
  agentIds: string[];
  detail: string;
  fingerprint: string;
}

export interface Clawback {
  id: string;
  subcontractorId: string;
  findingIds: string[];
  grounds: 'OBJET_FICTIF' | 'CONSTAT_FRAUDULEUX';
  motif: string;
  evidenceSha256: string[];
  unitPrice: MoneyJSON;
  amount: MoneyJSON;
  contractReference: string;
  status: 'PROPOSEE' | 'DECIDEE' | 'REJETEE' | 'ORDONNEE';
  proposedBy: string;
  proposedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionMotif?: string;
  treasury?: { operationId: string; executedBy: string; executedAt: string };
}

const LABELS: Record<SuspicionCode, string> = {
  PHOTO_EN_DOUBLE: 'Même photo (empreinte) pour plusieurs constats',
  OBJET_VALIDE_EN_DOUBLE: 'Même objet validé plusieurs fois pour une même structure',
  NOUVEAUX_OBJETS_PROCHES: 'Nouveaux objets déclarés au même endroit',
  CONTRE_VISITE_NON_CONFORME: 'Contre-visite non conforme',
  CONTROLE_MYSTERE_IRREGULIER: 'Contrôle mystère irrégulier sur la structure',
  NOUVEL_OBJET_SANS_PREUVE: 'Nouvel objet sans photo ni GPS mesuré',
};

export class TerrainQualityService {
  readonly clawbacks = new InMemoryRepository<Clawback>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly terrain: TerrainService) {}

  private now(): string { return this.ctx.clock.now().toISOString(); }

  /* ------------------------------------------------------------ doublons et objets présumés fictifs */

  suspicions(): Suspicion[] {
    const fs = this.terrain.findings.all();
    const out: Suspicion[] = [];
    const push = (code: SuspicionCode, kind: Suspicion['kind'], group: Finding[], detail: string) => {
      const ids = [...new Set(group.map((f) => f.id))].sort();
      out.push({
        code, kind, label: LABELS[code], findingIds: ids, subcontractorId: group[0]?.subcontractorId ?? null,
        agentIds: [...new Set(group.map((f) => f.agentId))], detail, fingerprint: `TQ:${code}:${ids.join(',')}`,
      });
    };
    const byPhoto = new Map<string, Finding[]>();
    for (const f of fs) if (f.photoSha256) byPhoto.set(f.photoSha256, [...(byPhoto.get(f.photoSha256) ?? []), f]);
    for (const [h, g] of byPhoto) if (g.length > 1) push('PHOTO_EN_DOUBLE', 'DOUBLON', g, `Empreinte ${h.slice(0, 12)}… présente sur ${g.length} constats.`);
    const byObj = new Map<string, Finding[]>();
    for (const f of fs) if (f.objectId && f.status === 'VALIDE' && f.outcome === 'CONSTATE') {
      const k = `${f.subcontractorId ?? 'REGIE'}|${f.objectId}`;
      byObj.set(k, [...(byObj.get(k) ?? []), f]);
    }
    for (const [k, g] of byObj) if (g.length > 1) push('OBJET_VALIDE_EN_DOUBLE', 'DOUBLON', g, `Objet ${k.split('|')[1]} validé ${g.length} fois pour la même structure : un seul livrable rémunérable.`);
    const fresh = fs.filter((f) => f.outcome === 'OBJET_NON_ENREGISTRE' && f.status !== 'REJETE');
    for (let i = 0; i < fresh.length; i++) {
      for (let j = i + 1; j < fresh.length; j++) {
        const a = fresh[i]!;
        const b = fresh[j]!;
        const d = distanceM(a.gps, b.gps);
        if (a.commune === b.commune && d <= DOUBLON_DISTANCE_M) push('NOUVEAUX_OBJETS_PROCHES', 'DOUBLON', [a, b], `Deux nouveaux objets déclarés à ${d} m l’un de l’autre (seuil ${DOUBLON_DISTANCE_M} m, par défaut — à confirmer).`);
      }
    }
    for (const cv of this.terrain.counterVisits.find((c) => c.status === 'REALISEE' && c.result === 'NON_CONFORME')) {
      const f = this.terrain.findings.get(cv.findingId);
      if (f) push('CONTRE_VISITE_NON_CONFORME', 'FICTIF', [f], `Contre-visite ${cv.id} non conforme${cv.notes ? ` : ${cv.notes}` : ''}.`);
    }
    for (const m of this.terrain.mysteryChecks.find((x) => x.result === 'IRREGULARITE' && x.target.kind === 'SOUS_TRAITANT')) {
      const g = fs.filter((f) => f.subcontractorId === m.target.id && f.status === 'VALIDE');
      if (g.length) push('CONTROLE_MYSTERE_IRREGULIER', 'FICTIF', g, `Contrôle mystère ${m.id} irrégulier : constats validés de la structure à contre-visiter par échantillon.`);
    }
    for (const f of fresh) if (!f.photoSha256 && f.gps.source && f.gps.source !== 'GPS') push('NOUVEL_OBJET_SANS_PREUVE', 'FICTIF', [f], `Nouvel objet déclaré sans photo, position ${f.gps.source === 'MANUEL' ? 'saisie à la main' : 'de repli'}.`);
    return out;
  }

  /* ------------------------------------------------------------ rotation des zones */

  /** Série en cours d'un agent sur une commune : date de la première mission de la série (missions affectées, ordre chronologique). */
  private streak(missions: Mission[]): { commune: string; since: string; missions: number } | null {
    const ms = missions.filter((m) => !!m.assignedAt && m.status !== 'ANNULEE').sort((a, b) => a.assignedAt!.localeCompare(b.assignedAt!));
    const last = ms.at(-1);
    if (!last) return null;
    let since = last.assignedAt!;
    let n = 0;
    for (let i = ms.length - 1; i >= 0 && ms[i]!.commune === last.commune; i--) { since = ms[i]!.assignedAt!; n++; }
    return { commune: last.commune, since, missions: n };
  }

  rotation() {
    const now = this.ctx.clock.now().getTime();
    const agents = this.terrain.agents.all().map((a) => {
      const s = this.streak(this.terrain.missions.find((m) => m.assignedAgentId === a.id));
      if (!s) return null;
      const days = Math.floor((now - new Date(s.since).getTime()) / DAY_MS);
      return { kind: 'AGENT' as const, id: a.id, name: a.displayName, subcontractorId: a.subcontractorId ?? null, commune: s.commune, since: s.since, days, missions: s.missions, overdue: days > ROTATION_ZONE_MAX_JOURS };
    }).filter((x): x is NonNullable<typeof x> => !!x);
    const subs = this.terrain.subcontractors.all().flatMap((st) => {
      const lots = this.terrain.lots.find((l) => l.subcontractorId === st.id);
      const communes = [...new Set(lots.map((l) => l.commune))];
      return communes.map((c) => {
        const since = lots.filter((l) => l.commune === c).map((l) => l.periodStart).sort()[0]!;
        const days = Math.floor((now - new Date(`${since}T00:00:00.000Z`).getTime()) / DAY_MS);
        return { kind: 'SOUS_TRAITANT' as const, id: st.id, name: st.name, subcontractorId: st.id, commune: c, since, days, missions: lots.filter((l) => l.commune === c).length, overdue: days > ROTATION_ZONE_MAX_JOURS };
      });
    });
    return { maxDays: ROTATION_ZONE_MAX_JOURS, blocking: ROTATION_ZONE_BLOCAGE, statut: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage', items: [...agents, ...subs].sort((a, b) => b.days - a.days) };
  }

  /** Contrôle à l'affectation d'une mission : alerte (une fois par agent et commune) ; refus seulement si le blocage est activé. */
  checkAssignment(u: User, m: Mission, agentId: string): void {
    const s = this.streak(this.terrain.missions.find((x) => x.assignedAgentId === agentId && x.id !== m.id));
    if (!s || s.commune !== m.commune) return;
    const days = Math.floor((this.ctx.clock.now().getTime() - new Date(s.since).getTime()) / DAY_MS);
    if (days <= ROTATION_ZONE_MAX_JOURS) return;
    this.ctx.alerts.raiseOnce(`TQ:ROTATION:${agentId}:${m.commune}:${s.since}`, {
      type: 'TERRAIN_ROTATION_ZONE_DEPASSEE', severity: 'MEDIUM', source: 'terrain:rotation',
      detail: `L’agent ${agentId} travaille sur ${m.commune} depuis ${days} jours (durée maximale ${ROTATION_ZONE_MAX_JOURS} j, par défaut — à confirmer) : rotation à organiser (§ 15A.5).`,
      context: { agentId, commune: m.commune, since: s.since, days, missionId: m.id, automaticEffect: ROTATION_ZONE_BLOCAGE ? 'AFFECTATION_REFUSEE' : 'AUCUN' }, actor: actorOf(u), notifyRoles: ['R06', 'R22'],
    });
    if (ROTATION_ZONE_BLOCAGE) throw forbidden('ZONE_ROTATION_REQUIRED', `Rotation des zones : l’agent est sur ${m.commune} depuis ${days} jours.`);
  }

  /* ------------------------------------------------------------ récupération des sommes versées */

  proposeClawback(u: User, input: { subcontractorId: string; findingIds: string[]; grounds: Clawback['grounds']; motif: string; evidenceSha256: string[] }): Clawback {
    authorize(u, 'terrain:clawback.propose');
    const st = this.terrain.subcontractors.get(input.subcontractorId);
    if (!st) throw notFound('SUBCONTRACTOR_NOT_FOUND', `Sous-traitant inconnu : ${input.subcontractorId}`);
    if (!st.contract) throw unprocessable('CONTRACT_REQUIRED', 'Prix unitaires du contrat non renseignés : montant à récupérer non calculable.');
    const ids = [...new Set(input.findingIds)];
    for (const id of ids) {
      const f = this.terrain.findings.get(id);
      if (!f || f.subcontractorId !== st.id) throw unprocessable('FINDING_NOT_OF_SUBCONTRACTOR', `Constat ${id} inconnu ou d’une autre structure.`);
      if (f.status !== 'VALIDE') throw unprocessable('FINDING_NOT_PAID', `Constat ${id} au statut ${f.status} : seuls les livrables validés (rémunérés) se récupèrent.`);
      const taken = this.clawbacks.findOne((c) => c.status !== 'REJETEE' && c.findingIds.includes(id));
      if (taken) throw conflict('FINDING_ALREADY_CLAIMED', `Constat ${id} déjà visé par la récupération ${taken.id}.`);
    }
    const unit = st.contract.validatedFinding;
    const c = this.clawbacks.insert({
      id: this.ids.next('RECUP'), subcontractorId: st.id, findingIds: ids, grounds: input.grounds, motif: input.motif, evidenceSha256: input.evidenceSha256,
      unitPrice: unit, amount: Money.fromJSON(unit).multiply(String(ids.length)).toJSON(), contractReference: st.contract.reference,
      status: 'PROPOSEE', proposedBy: u.id, proposedAt: this.now(),
    });
    this.ctx.audit.append({ actor: actorOf(u), action: 'terrain.clawback.proposed', resourceType: 'subcontractor', resourceId: st.id, details: { clawbackId: c.id, findings: ids.length, amount: c.amount, grounds: c.grounds, evidence: c.evidenceSha256 } });
    return c;
  }

  decideClawback(u: User, id: string, input: { approve: boolean; motif: string }): Clawback {
    authorize(u, 'terrain:clawback.decide');
    const c = this.clawbacks.get(id);
    if (!c) throw notFound('CLAWBACK_NOT_FOUND', `Récupération inconnue : ${id}`);
    if (c.status !== 'PROPOSEE') throw conflict('CLAWBACK_ALREADY_DECIDED', `Récupération ${id} déjà ${c.status}.`);
    assertDistinctPerson(u.id, [c.proposedBy], 'Deux personnes : la récupération est décidée par une autre personne que celle qui l’a proposée.');
    const r = this.clawbacks.update({ ...c, status: input.approve ? 'DECIDEE' : 'REJETEE', decidedBy: u.id, decidedAt: this.now(), decisionMotif: input.motif });
    this.ctx.audit.append({ actor: actorOf(u), action: input.approve ? 'terrain.clawback.approved' : 'terrain.clawback.rejected', resourceType: 'subcontractor', resourceId: c.subcontractorId, details: { clawbackId: id, proposedBy: c.proposedBy, motif: input.motif, amount: c.amount } });
    return r;
  }

  /** Lignes négatives de la rémunération indicative : récupérations décidées ou ordonnées. */
  adjustments(subcontractorId: string) {
    return this.clawbacks.find((c) => c.subcontractorId === subcontractorId && (c.status === 'DECIDEE' || c.status === 'ORDONNEE'))
      .map((c) => ({ clawbackId: c.id, status: c.status, findings: c.findingIds.length, amount: Money.fromJSON(c.amount).negate().toJSON(), grounds: c.grounds }));
  }

  /** Passerelle vers le Trésor : opération RECUPERATION_SOUS_TRAITANT (proposition + validation à quatre yeux). */
  attachTreasury(tresor: TresorService): void {
    tresor.attachRecuperation({
      target: (input: OperationInput) => {
        const c = this.clawbacks.get(input.recuperation?.clawbackId ?? '');
        if (!c) throw notFound('CLAWBACK_NOT_FOUND', `Récupération inconnue : ${input.recuperation?.clawbackId}`);
        if (c.status !== 'DECIDEE') throw conflict('CLAWBACK_NOT_DECIDED', `Récupération ${c.id} au statut ${c.status} : décision de la régie requise, ordre unique.`);
        const st = this.terrain.subcontractors.get(c.subcontractorId);
        return { key: `clawback:${c.id}`, label: `Récupération ${c.id} auprès de ${st?.name ?? c.subcontractorId} (${c.findingIds.length} constat(s), contrat ${c.contractReference})`, amount: c.amount };
      },
      executed: (op: FinancialOperation, user: User, at: string) => {
        const c = this.clawbacks.get(op.input.recuperation!.clawbackId)!;
        this.clawbacks.update({ ...c, status: 'ORDONNEE', treasury: { operationId: op.id, executedBy: user.id, executedAt: at } });
        this.ctx.audit.append({ actor: actorOf(user), action: 'terrain.clawback.ordered', resourceType: 'subcontractor', resourceId: c.subcontractorId, details: { clawbackId: c.id, operationId: op.id, amount: c.amount } });
        return { clawbackId: c.id, subcontractorId: c.subcontractorId, amount: c.amount, order: 'ORDRE_DE_REVERSEMENT', note: 'Le sous-traitant reverse la somme ; aucun fonds ne sort du compte public.' };
      },
    });
  }

  board(u: User) {
    authorize(u, 'terrain:qc.read');
    const suspicions = this.suspicions();
    return {
      suspicions, rotation: this.rotation(),
      clawbacks: this.clawbacks.all().sort((a, b) => b.proposedAt.localeCompare(a.proposedAt)),
      params: { duplicateDistanceM: DOUBLON_DISTANCE_M, rotationMaxDays: ROTATION_ZONE_MAX_JOURS, rotationBlocking: ROTATION_ZONE_BLOCAGE, statut: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage' },
      note: 'Présomptions à contre-visiter : aucune sanction ni retenue automatique. Récupération : proposition du contrôle qualité, décision de la régie, ordre du Trésor à quatre yeux.',
    };
  }
}
