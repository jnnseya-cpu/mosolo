/**
 * ParkSmart — travail de terrain (décision du maître d'ouvrage du 27/09/2026) :
 *
 * 1. PREUVES PHOTOGRAPHIQUES : quand une plaque est ROUGE, la caméra géolocalisée s'ouvre ; l'agent prend jusqu'à
 *    5 photos (avant, arrière, côté droit, côté gauche avec les abords, une autre). Chaque photo porte, incrustés dans
 *    l'image : date et heure (horloge du serveur), agent, coordonnées GPS et lieu saisi par l'agent. Le serveur vérifie
 *    l'empreinte SHA-256, conserve l'image telle que reçue (jamais modifiable), et note l'écart d'horloge.
 * 2. PÉNALITÉS VISIBLES : tout agent du module stationnement voit les pénalités d'un usager au contrôle ; au-delà de
 *    30 jours sans paiement, tout agent de tout module les voit après un contrôle (registre « sanctions »).
 * 3. COMMISSION DES AGENTS : 10 % des recettes de pénalités et des paiements générés par leurs contrôles, calculés
 *    sur des recettes CONFIRMÉES au compte public, versés par le Trésor : un agent ne touche jamais l'argent de l'usager.
 */
import type { MoneyJSON } from '@mosolo/shared';
import { Money } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { authorize, evaluate } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { actorOf, paymentState, sumByCurrency } from './support.js';
import type { ParkingService, ParkingViolation } from './service.js';

export const EVIDENCE_SLOTS = ['AVANT', 'ARRIERE', 'COTE_DROIT', 'COTE_GAUCHE_ABORDS', 'AUTRE'] as const;
export type EvidenceSlot = (typeof EVIDENCE_SLOTS)[number];
export const SLOT_LABEL: Record<EvidenceSlot, string> = {
  AVANT: 'Avant du véhicule', ARRIERE: 'Arrière du véhicule (plaque)', COTE_DROIT: 'Côté droit', COTE_GAUCHE_ABORDS: 'Côté gauche et abords', AUTRE: 'Autre vue (signalisation, contexte)',
};
export const MAX_PHOTOS_PER_CHECK = 5;
export const MAX_PHOTO_BYTES = 900_000;
/** Délai pour photographier après un contrôle rouge. */
export const PHOTO_WINDOW_MINUTES = 30;
/** Écart d'horloge toléré entre l'heure incrustée et l'heure de réception (au-delà : signalé au vérificateur). */
export const CLOCK_SKEW_WARN_SECONDS = 300;

/** Taux de commission des agents (décision du maître d'ouvrage) — acte requis avant tout versement réel. */
export const AGENT_COMMISSION_PCT = 10;
/** Un paiement de stationnement est attribué à l'agent si la session est créée dans ce délai après son contrôle rouge. */
export const PAYMENT_ATTRIBUTION_MINUTES = 60;
/** Au-delà, une pénalité impayée devient visible des agents de tous les modules après un contrôle. */
export const OVERDUE_VISIBILITY_DAYS = 30;

export interface EvidencePhoto {
  id: string;
  checkId: string;
  plate: string;
  zoneId: string;
  commune: string;
  slot: EvidenceSlot;
  sha256: string;
  mime: 'image/jpeg';
  sizeBytes: number;
  dataBase64: string;
  lat: number;
  lon: number;
  accuracyM: number | null;
  gpsSource: 'GPS' | 'ZONE';
  place: string;
  /** Heure incrustée dans l'image (horloge serveur synchronisée sur l'appareil). */
  stampedAt: string;
  receivedAt: string;
  clockSkewSeconds: number;
  agentId: string;
  agentName: string;
  violationId: string | null;
  supersededBy: string | null;
}

export type PhotoMeta = Omit<EvidencePhoto, 'dataBase64'> & { slotLabel: string; url: string; clockWarning: boolean };

export interface PenaltyLine {
  module: 'STATIONNEMENT' | 'PUBLICITE';
  reference: string;
  nature: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  obligationId: string | null;
  amount: MoneyJSON | null;
  payment: string;
  unpaid: boolean;
  overdueDays: number | null;
  plate?: string;
  zone?: string;
}

export interface EarningLine {
  source: 'PENALITE' | 'PAIEMENT';
  reference: string;
  plate: string;
  zone: string;
  at: string;
  base: MoneyJSON;
  commission: MoneyJSON;
  state: 'EN_ATTENTE' | 'CONFIRMEE' | 'ACQUISE' | 'ANNULEE';
  stateLabel: string;
}

const NATURE_LABEL: Record<string, string> = {
  NON_PAIEMENT: 'Stationnement non payé', DEPASSEMENT: 'Dépassement de durée', STATIONNEMENT_INTERDIT: 'Stationnement interdit',
  PLACE_RESERVEE: 'Place réservée occupée', DOUBLE_FILE: 'Double file',
};
const DAY_MS = 86_400_000;
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

export class ParkingField {
  readonly photos = new InMemoryRepository<EvidencePhoto>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly svc: ParkingService) {}

  // ------------------------------------------------------------------ Preuves photographiques

  meta(p: EvidencePhoto): PhotoMeta {
    const { dataBase64: _omit, ...rest } = p;
    return { ...rest, slotLabel: SLOT_LABEL[p.slot], url: `/v1/parking/evidence-photos/${p.id}`, clockWarning: p.clockSkewSeconds > CLOCK_SKEW_WARN_SECONDS };
  }

  activeForCheck(checkId: string): EvidencePhoto[] {
    return this.photos.find((p) => p.checkId === checkId && !p.supersededBy);
  }

  upload(user: User, input: {
    checkId: string; slot: EvidenceSlot; imageBase64: string; sha256: string; lat: number; lon: number; accuracyM?: number;
    gpsSource: 'GPS' | 'ZONE'; place: string; stampedAt: string;
  }): PhotoMeta {
    const check = this.svc.checks.get(input.checkId);
    if (!check) throw notFound('CHECK_NOT_FOUND', 'Contrôle inconnu.');
    if (check.agentId !== user.id) throw forbidden('NOT_CHECK_AGENT', 'Seul l’agent qui a effectué le contrôle peut en photographier le véhicule.');
    if (check.light !== 'ROUGE') throw unprocessable('CHECK_NOT_RED', 'Photos de preuve réservées à un contrôle ROUGE (aucun titre valide).');
    if (!check.zoneId) throw unprocessable('CHECK_WITHOUT_ZONE', 'Le contrôle doit porter sur une zone.');
    const zone = this.svc.getZone(check.zoneId);
    authorize(user, 'parking:violation.record', { communes: [zone.commune] });
    const now = this.svc.now();
    if (now.getTime() - Date.parse(check.at) > PHOTO_WINDOW_MINUTES * 60_000) throw unprocessable('CHECK_TOO_OLD', `Photos à prendre dans les ${PHOTO_WINDOW_MINUTES} minutes du contrôle : refaites un contrôle.`);
    const buf = Buffer.from(input.imageBase64, 'base64');
    if (buf.length === 0 || buf.length > MAX_PHOTO_BYTES) throw badRequest('PHOTO_SIZE', `Photo vide ou trop lourde (${Math.round(MAX_PHOTO_BYTES / 1000)} Ko au plus).`);
    if (!buf.subarray(0, 3).equals(JPEG_MAGIC)) throw badRequest('PHOTO_FORMAT', 'Photo JPEG attendue.');
    const sha = sha256Hex(buf);
    if (sha !== input.sha256.toLowerCase()) throw unprocessable('PHOTO_HASH_MISMATCH', 'Empreinte SHA-256 différente de l’image reçue : photo altérée en transit.');
    if (this.photos.findOne((p) => p.sha256 === sha)) throw conflict('PHOTO_DUPLICATE', 'Cette photo a déjà été versée (une même image ne peut pas servir deux fois).');
    const active = this.activeForCheck(check.id);
    const previous = active.find((p) => p.slot === input.slot);
    if (previous?.violationId) throw conflict('PHOTO_LOCKED', 'Photo déjà jointe à un constat : elle ne peut plus être remplacée.');
    if (!previous && active.length >= MAX_PHOTOS_PER_CHECK) throw unprocessable('PHOTO_LIMIT', `${MAX_PHOTOS_PER_CHECK} photos au plus par contrôle.`);
    const skew = Math.round(Math.abs(now.getTime() - Date.parse(input.stampedAt)) / 1000);
    const id = this.ids.next('PKP');
    const photo = this.photos.insert({
      id, checkId: check.id, plate: check.plate, zoneId: zone.id, commune: zone.commune, slot: input.slot, sha256: sha, mime: 'image/jpeg', sizeBytes: buf.length,
      dataBase64: buf.toString('base64'), lat: input.lat, lon: input.lon, accuracyM: input.accuracyM ?? null, gpsSource: input.gpsSource, place: input.place,
      stampedAt: input.stampedAt, receivedAt: now.toISOString(), clockSkewSeconds: Number.isFinite(skew) ? skew : 999_999, agentId: user.id, agentName: user.name,
      violationId: null, supersededBy: null,
    });
    // Reprise d'une vue : l'ancienne photo reste conservée (jamais effacée), marquée remplacée.
    if (previous) this.photos.update({ ...previous, supersededBy: id });
    this.ctx.audit.append({
      actor: actorOf(user), action: 'parking.evidence.photo.received', resourceType: 'parking_evidence_photo', resourceId: id,
      details: { checkId: check.id, plate: check.plate, slot: input.slot, sha256: sha, bytes: buf.length, gpsSource: input.gpsSource, clockSkewSeconds: photo.clockSkewSeconds, replaces: previous?.id ?? null },
    });
    return this.meta(photo);
  }

  /** Photos désignées pour un constat : même agent, même contrôle, même plaque, non déjà jointes. */
  claimForViolation(user: User, photoIds: string[], checkId: string | undefined, plate: string): EvidencePhoto[] {
    if (!checkId) throw badRequest('CHECK_REQUIRED', 'Les photos de preuve se rattachent à un contrôle : checkId requis.');
    const uniq = [...new Set(photoIds)];
    if (uniq.length === 0 || uniq.length > MAX_PHOTOS_PER_CHECK) throw badRequest('PHOTO_COUNT', `1 à ${MAX_PHOTOS_PER_CHECK} photos.`);
    return uniq.map((id) => {
      const p = this.photos.get(id);
      if (!p) throw notFound('PHOTO_NOT_FOUND', `Photo inconnue : ${id}`);
      if (p.agentId !== user.id || p.checkId !== checkId || p.plate !== plate) throw unprocessable('PHOTO_MISMATCH', 'Photo d’un autre contrôle, d’une autre plaque ou d’un autre agent.');
      if (p.supersededBy) throw unprocessable('PHOTO_SUPERSEDED', 'Photo remplacée par une prise plus récente.');
      if (p.violationId) throw conflict('PHOTO_ALREADY_USED', 'Photo déjà jointe à un constat.');
      return p;
    });
  }

  link(photos: EvidencePhoto[], violationId: string): void {
    for (const p of photos) this.photos.update({ ...p, violationId });
  }

  /** Lecture d'une photo : l'agent auteur tant qu'elle n'est pas jointe ; ensuite, les lecteurs du constat (dont l'usager). */
  read(user: User, id: string): { mime: string; data: Buffer; sha256: string } {
    const p = this.photos.get(id);
    if (!p) throw notFound('PHOTO_NOT_FOUND', 'Photo inconnue.');
    if (p.violationId) {
      const v = this.svc.violations.get(p.violationId)!;
      authorize(user, 'parking:violation.read', { taxpayerId: v.holderTaxpayerId ?? undefined, communes: [v.commune], entity: 'DGTK' });
    } else if (p.agentId !== user.id && !evaluate(user, 'parking:violation.verify', { communes: [p.commune] })) {
      throw forbidden('FORBIDDEN', 'Photo non encore jointe à un constat : visible de son auteur et du superviseur.');
    }
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.evidence.photo.viewed', resourceType: 'parking_evidence_photo', resourceId: id, details: { violationId: p.violationId } });
    return { mime: p.mime, data: Buffer.from(p.dataBase64, 'base64'), sha256: p.sha256 };
  }

  photosOfViolation(violationId: string): PhotoMeta[] {
    return this.photos.find((p) => p.violationId === violationId).sort((a, b) => EVIDENCE_SLOTS.indexOf(a.slot) - EVIDENCE_SLOTS.indexOf(b.slot)).map((p) => this.meta(p));
  }

  // ------------------------------------------------------------------ Pénalités d'un usager

  private overdueDays(v: ParkingViolation, unpaid: boolean): number | null {
    if (!unpaid || !v.decision) return null;
    return Math.floor((this.svc.now().getTime() - Date.parse(v.decision.at)) / DAY_MS);
  }

  /** Toutes les pénalités (constats en cours et retenus) d'un usager, par plaque et par titulaire — vue du module. */
  penaltiesFor(subject: { plate?: string | null; taxpayerId?: string | null }): PenaltyLine[] {
    const plate = subject.plate ? this.svc.plate(subject.plate) : null;
    const plates = new Set<string>(plate ? [plate] : []);
    if (subject.taxpayerId) for (const v of this.svc.vehicles.find((x) => x.taxpayerId === subject.taxpayerId)) plates.add(v.plate);
    return this.svc.violations
      .find((v) => (plates.has(v.plate) || (!!subject.taxpayerId && v.holderTaxpayerId === subject.taxpayerId)) && v.status !== 'REJETE' && v.status !== 'CLASSE')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((v) => {
        const ob = v.decision?.obligationId ? this.ctx.assessment.get(v.decision.obligationId) : null;
        const pay = ob ? paymentState(this.ctx, ob.id).state : 'AUCUNE_REFERENCE';
        const unpaid = !!ob && pay !== 'PAYE' && pay !== 'RAPPROCHE' && ob.status !== 'ANNULEE' && ob.status !== 'SOLDEE';
        return {
          module: 'STATIONNEMENT' as const, reference: v.reference, nature: NATURE_LABEL[v.nature] ?? v.nature, status: v.status, createdAt: v.createdAt,
          decidedAt: v.decision?.at ?? null, obligationId: ob?.id ?? null, amount: ob?.amount ?? v.proposal?.amount ?? null, payment: pay, unpaid,
          overdueDays: this.overdueDays(v, unpaid), plate: v.plate, zone: this.svc.zones.get(v.zoneId)?.name ?? v.zoneId,
        };
      });
  }

  // ------------------------------------------------------------------ Commission des agents (10 %)

  private pct(m: MoneyJSON): MoneyJSON {
    return Money.fromJSON(m).multiply(`${AGENT_COMMISSION_PCT / 100}`).toJSON();
  }

  /**
   * Lignes de commission d'un agent :
   * - PÉNALITÉ : constat de l'agent, vérifié et retenu par deux autres personnes, pénalité émise ;
   * - PAIEMENT : session de stationnement ouverte pour la plaque dans l'heure qui suit un contrôle ROUGE de l'agent
   *   (régularisation provoquée par le contrôle ; une session n'est attribuée qu'une fois, au premier contrôle).
   * État : EN_ATTENTE (non payé) → CONFIRMEE (payé, rapprochement bancaire en cours) → ACQUISE (rapproché au compte
   * public : due par le Trésor) ; ANNULEE si la pénalité est annulée (recours).
   */
  earningsLines(agentId: string): EarningLine[] {
    const lines: EarningLine[] = [];
    const label = { EN_ATTENTE: 'En attente du paiement de l’usager', CONFIRMEE: 'Payé — rapprochement bancaire en cours', ACQUISE: 'Acquise — à verser par le Trésor', ANNULEE: 'Annulée (pénalité annulée)' };
    for (const v of this.svc.violations.find((x) => x.agentId === agentId && x.status === 'RETENU' && !!x.decision?.obligationId)) {
      const ob = this.ctx.assessment.get(v.decision!.obligationId!);
      const pay = paymentState(this.ctx, ob.id).state;
      const state: EarningLine['state'] = ob.status === 'ANNULEE' ? 'ANNULEE' : pay === 'RAPPROCHE' ? 'ACQUISE' : pay === 'PAYE' ? 'CONFIRMEE' : 'EN_ATTENTE';
      lines.push({ source: 'PENALITE', reference: v.reference, plate: v.plate, zone: this.svc.zones.get(v.zoneId)?.name ?? v.zoneId, at: v.decision!.at, base: ob.amount, commission: this.pct(ob.amount), state, stateLabel: label[state] });
    }
    // Attribution des paiements : premier contrôle ROUGE (tous agents) précédant la session dans le délai.
    const reds = this.svc.checks.all().filter((c) => c.light === 'ROUGE' && c.zoneId);
    const now = this.svc.now();
    for (const s of this.svc.sessions.all()) {
      const created = Date.parse(s.createdAt);
      const trigger = reds
        .filter((c) => c.plate === s.plate && c.zoneId === s.zoneId && Date.parse(c.at) <= created && created - Date.parse(c.at) <= PAYMENT_ATTRIBUTION_MINUTES * 60_000)
        .sort((a, b) => a.at.localeCompare(b.at))[0];
      if (!trigger || trigger.agentId !== agentId) continue;
      const d = this.svc.sessionDerived(s, now);
      for (const p of d.payments) {
        const ob = this.ctx.assessment.get(p.obligationId);
        const state: EarningLine['state'] = p.state === 'RAPPROCHE' ? 'ACQUISE' : p.state === 'PAYE' ? 'CONFIRMEE' : 'EN_ATTENTE';
        lines.push({ source: 'PAIEMENT', reference: `${s.ticketCode ?? s.id} · ${p.kind === 'INITIALE' ? 'session' : 'prolongation'}`, plate: s.plate, zone: this.svc.zones.get(s.zoneId)?.name ?? s.zoneId, at: s.createdAt, base: ob.amount, commission: this.pct(ob.amount), state, stateLabel: label[state] });
      }
    }
    return lines.sort((a, b) => b.at.localeCompare(a.at));
  }

  earningsSummary(agentId: string) {
    const lines = this.earningsLines(agentId);
    const by = (st: EarningLine['state']) => sumByCurrency(lines.filter((l) => l.state === st).map((l) => l.commission));
    const month = this.svc.now().toISOString().slice(0, 7);
    return {
      agentId, ratePct: AGENT_COMMISSION_PCT,
      totals: {
        acquise: by('ACQUISE'), confirmee: by('CONFIRMEE'), enAttente: by('EN_ATTENTE'), annulee: by('ANNULEE'),
        base: sumByCurrency(lines.filter((l) => l.state !== 'ANNULEE').map((l) => l.base)),
        ceMois: sumByCurrency(lines.filter((l) => l.state !== 'ANNULEE' && l.at.startsWith(month)).map((l) => l.commission)),
      },
      counts: { penalites: lines.filter((l) => l.source === 'PENALITE').length, paiements: lines.filter((l) => l.source === 'PAIEMENT').length },
      lines,
      rules: [
        `Commission de ${AGENT_COMMISSION_PCT} % : uniquement sur les pénalités issues de vos constats et sur les paiements de stationnement effectués dans l’heure qui suit votre contrôle rouge.`,
        'Calculée sur des recettes arrivées au compte public ; acquise après rapprochement bancaire ; versée par le Trésor (paie). Vous ne recevez jamais d’argent de l’usager.',
        'Une pénalité n’existe qu’après vérification (superviseur) et décision (régie) par deux autres personnes ; annulée sur recours, elle annule la commission.',
        'Taux fixé par décision du maître d’ouvrage : un acte (arrêté) est requis avant tout versement réel.',
      ],
    };
  }
}
