/**
 * Contrôle technique et vignette sécurisée (module 82 — n° 59 du catalogue du maître d'ouvrage du 27/09/2026).
 *
 * - Procès-verbal STRUCTURÉ : un champ par point de l'arrêté du 12 novembre 2025 (conforme / non conforme + note),
 *   résultat, centre, inspecteur, dates, échéance. Transmis par l'interface du centre AU MOMENT de l'établissement
 *   (au-delà du délai paramétré : refus, jamais de ressaisie ultérieure) ; immuable (une rectification est un nouveau
 *   procès-verbal qui remplace l'ancien, avec motif).
 * - Échéances : même règle de validité que les titres (50 % / 1 %, heure du serveur) ; rappels « ambre » par le
 *   catalogue de communication commun.
 * - Vignettes sécurisées : autocollants numérotés (lot remis à un centre dans la limite de son quota, attribution à une
 *   plaque sur procès-verbal favorable, annulation, révocation). Numéro inconnu ⇒ faux par construction. La vignette
 *   FISCALE reste le titre VIG du moteur de titres : les deux lignes ne sont jamais agrégées.
 * - Mode courtoisie : paramètre daté par catégorie et commune, décidé par l'autorité compétente et journalisé ; pendant
 *   la courtoisie, aucun constat ni procès-verbal de vignette n'est créé.
 */
import { isRuleExecutable, type MoneyJSON } from '@mosolo/shared';
import { validityView } from '../../core/validity.js';
import type { User } from '../../core/auth.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import { hmacSha256Hex, safeEqualHex } from '../../core/crypto.js';
import { enginePrincipal, paymentState } from '../parking/support.js';
import type { CentresService } from './centres.js';
import { addDays, type VcDeps } from './common.js';
import type { DomaineService } from './domaine.js';
import {
  CT_POINTS, PV_TRANSMISSION_MAX_MINUTES, VEHICLE_CATEGORIES, type CourtesyPeriod, type CtPoint, type CtPointResult, type CtResult, type ProcesVerbal, type SecureSticker, type StickerLot,
  type VehicleCategory,
  RULE_CODES,
} from './model.js';

export interface VehicleRecord { id: string; plate: string; category: VehicleCategory; objectId?: string; taxpayerId?: string; commune?: string; source: 'OBJET_MOSOLO' | 'REGISTRE_RFCK' | 'CENTRE'; updatedAt: string }
/**
 * Redevance de contrôle technique liée au rendez-vous (30/09/2026) : liquidée à la prise de rendez-vous par la fiche
 * ACTIVE du registre (RFCK-REDEVANCE-CT), payée par le circuit commun (référence, monnaie mobile, QR, USSD, banque,
 * carte, point agréé, BitriPay ou KODA) vers le compte public — JAMAIS en espèces au centre. Sans fiche ACTIVE : aucun
 * montant (« acte requis »), le rendez-vous suit son cours comme avant.
 */
export interface AppointmentFee {
  status: 'LIQUIDEE' | 'ACTE_REQUIS' | 'VEHICULE_A_RATTACHER';
  obligationId?: string; amount?: MoneyJSON; legalReference?: string; reason?: string;
}
export interface Appointment { id: string; plate: string; centreId: string; date: string; taxpayerId: string; status: 'DEMANDE' | 'CONFIRME' | 'ANNULE'; createdAt: string; confirmedBy?: string; fee?: AppointmentFee }

/** Chiffre de contrôle (Luhn mod 10) d'un numéro de vignette sécurisée. */
function checkDigit(digits: string): string {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return String((10 - (sum % 10)) % 10);
}
export function stickerNumber(year: string, serial: number): string {
  const s = String(serial).padStart(7, '0');
  return `VTS-${year}-${s}${checkDigit(`${year}${s}`)}`;
}
export function stickerWellFormed(n: string): boolean {
  const m = /^VTS-(\d{4})-(\d{7})(\d)$/.exec(n);
  return !!m && checkDigit(`${m[1]}${m[2]}`) === m[3];
}

export class CtService {
  readonly vehicles = new InMemoryRepository<VehicleRecord>();
  readonly pvs = new InMemoryAppendOnlyRepository<ProcesVerbal>();
  /** Chaînage des remplacements (le procès-verbal original reste intact dans le journal). */
  private readonly superseded = new Map<string, string>();
  readonly stickers = new InMemoryRepository<SecureSticker>();
  readonly lots = new InMemoryRepository<StickerLot>();
  readonly courtesy = new InMemoryRepository<CourtesyPeriod>();
  readonly appointments = new InMemoryRepository<Appointment>();
  private serial = 0;

  constructor(private readonly d: VcDeps, private readonly centres: CentresService, private readonly domaine: DomaineService) {}

  // ——— Registre des véhicules (objet véhicule du socle + registre RFCK) ———

  /** Véhicule connu par la plaque : fiche du registre, sinon objet VEHICULE du socle (immatriculation / plaque). */
  vehicle(plateIn: string): VehicleRecord | null {
    const plate = this.d.plate(plateIn);
    const r = this.vehicles.findOne((v) => v.plate === plate);
    if (r) return r;
    const o = this.d.ctx.objects.objects.find((x) => x.category === 'VEHICULE').find((x) => {
      const p = x.attributes['immatriculation'] ?? x.attributes['plaque'];
      return typeof p === 'string' && this.d.plate(p) === plate;
    });
    if (!o) return null;
    const cat = typeof o.attributes['categorie_ct'] === 'string' && (VEHICLE_CATEGORIES as readonly string[]).includes(o.attributes['categorie_ct'] as string) ? o.attributes['categorie_ct'] as VehicleCategory : 'PARTICULIER';
    return { id: `OBJ:${o.id}`, plate, category: cat, objectId: o.id, ...(o.taxpayerId ? { taxpayerId: o.taxpayerId } : {}), commune: o.commune, source: 'OBJET_MOSOLO', updatedAt: o.createdAt };
  }

  upsertVehicle(input: Omit<VehicleRecord, 'id' | 'updatedAt'>): VehicleRecord {
    const plate = this.d.plate(input.plate);
    const cur = this.vehicles.findOne((v) => v.plate === plate);
    if (cur) return this.vehicles.update({ ...cur, ...input, plate, updatedAt: this.d.now() });
    return this.vehicles.insert({ ...input, plate, id: this.d.ids.next('VEH', 5), updatedAt: this.d.now() });
  }

  // ——— Procès-verbaux ———

  activePvs(): ProcesVerbal[] {
    return this.pvs.all().filter((p) => !this.superseded.has(p.id));
  }

  submitPv(user: User, input: {
    centreId: string; plate: string; category: VehicleCategory; inspecteur: string; startedAt: string; endedAt: string; points: Record<string, CtPointResult>;
    result: CtResult; echeance: string; supersedes?: string; rectificationReason?: string;
  }, opts: { channel?: ProcesVerbal['channel']; demo?: boolean; skipDelay?: boolean } = {}): ProcesVerbal {
    authorize(user, 'vc:pv.submit');
    this.centres.assertMember(user, input.centreId);
    const centre = this.centres.assertCanOperate(input.centreId, 'CONTROLE_TECHNIQUE', input.category);
    const missing = CT_POINTS.filter((k) => !input.points[k] || typeof input.points[k]!.conforme !== 'boolean');
    if (missing.length) throw unprocessable('PV_INCOMPLET', `Points de l’arrêté non renseignés : ${missing.join(', ')}.`, { missing });
    const extra = Object.keys(input.points).filter((k) => !(CT_POINTS as readonly string[]).includes(k));
    if (extra.length) throw badRequest('PV_POINT_INCONNU', `Point hors arrêté : ${extra.join(', ')}.`);
    const started = Date.parse(input.startedAt); const ended = Date.parse(input.endedAt); const now = this.d.ctx.clock.now().getTime();
    if (!(started <= ended)) throw unprocessable('PV_DATES', 'Fin du contrôle antérieure à son début.');
    if (ended > now + 60_000) throw unprocessable('PV_DATES', 'Contrôle daté dans le futur.');
    // Transmis à l'établissement : au-delà du délai, le procès-verbal n'est pas ressaisi (fraude par antidatage).
    if (!opts.skipDelay && now - ended > PV_TRANSMISSION_MAX_MINUTES * 60_000) {
      this.d.audit(user, 'vc.pv.late_refused', 'proces_verbal', input.plate, { centreId: input.centreId, endedAt: input.endedAt }, 'DENIED');
      throw unprocessable('PV_TRANSMISSION_TARDIVE', `Procès-verbal transmis plus de ${PV_TRANSMISSION_MAX_MINUTES} min après le contrôle : aucune ressaisie ultérieure n’est admise.`);
    }
    if (input.echeance <= input.endedAt.slice(0, 10)) throw unprocessable('PV_ECHEANCE', 'Échéance antérieure ou égale à la date du contrôle.');
    let prev: ProcesVerbal | undefined;
    if (input.supersedes) {
      prev = this.pvs.get(input.supersedes);
      if (!prev) throw notFound('PV_INCONNU', `Procès-verbal inconnu : ${input.supersedes}`);
      if (prev.centreId !== input.centreId) throw forbidden('PV_AUTRE_CENTRE', 'Seul le centre qui a établi le procès-verbal peut le rectifier.');
      if (this.superseded.has(prev.id)) throw conflict('PV_DEJA_REMPLACE', 'Procès-verbal déjà remplacé.');
      if (!input.rectificationReason) throw unprocessable('MOTIF_REQUIS', 'Motif de rectification requis.');
    }
    const plate = this.d.plate(input.plate);
    const nonConformes = CT_POINTS.filter((k) => !input.points[k]!.conforme);
    const incoherence = input.result === 'FAVORABLE' && nonConformes.length ? `Résultat favorable malgré ${nonConformes.length} point(s) non conforme(s) : ${nonConformes.join(', ')}.` : undefined;
    const today = this.d.today();
    const todays = this.activePvs().filter((p) => p.centreId === centre.id && p.transmittedAt.slice(0, 10) === today).length;
    const id = this.d.ids.next('PV-CT', 6);
    const pv = this.pvs.append({
      id, number: `PV-${centre.id}-${id.slice(-6)}`, plate, category: input.category, centreId: centre.id, inspecteur: input.inspecteur, startedAt: input.startedAt, endedAt: input.endedAt,
      points: Object.fromEntries(CT_POINTS.map((k) => [k, { conforme: input.points[k]!.conforme, ...(input.points[k]!.note ? { note: input.points[k]!.note } : {}) }])) as Record<CtPoint, CtPointResult>,
      result: input.result, echeance: input.echeance, transmittedAt: this.d.now(), transmittedBy: user.id, channel: opts.channel ?? 'API_CENTRE',
      ...(prev ? { supersedes: prev.id, rectificationReason: input.rectificationReason } : {}), ...(incoherence ? { incoherence } : {}), ...(opts.demo ? { demo: true } : {}),
    });
    if (prev) this.superseded.set(prev.id, pv.id);
    const known = this.vehicle(plate);
    this.upsertVehicle({ plate, category: input.category, ...(known?.objectId ? { objectId: known.objectId } : {}), ...(known?.taxpayerId ? { taxpayerId: known.taxpayerId } : {}), ...(known?.commune ? { commune: known.commune } : {}), source: known?.source ?? 'CENTRE' });
    if (incoherence) this.d.ctx.alerts.raise({ type: 'PV_CT_INCOHERENT', severity: 'MEDIUM', source: 'vehicules-controle', detail: `${pv.number} : ${incoherence}`, context: { pvId: pv.id, centreId: centre.id } });
    if (centre.quotas.inspectionsParJour > 0 && todays + 1 > centre.quotas.inspectionsParJour) {
      this.d.ctx.alerts.raise({ type: 'CENTRE_QUOTA_JOURNALIER', severity: 'MEDIUM', source: 'vehicules-controle', detail: `${centre.name} : ${todays + 1} contrôles transmis aujourd’hui pour un quota de ${centre.quotas.inspectionsParJour}. Examen humain.`, context: { centreId: centre.id } });
    }
    this.d.audit(user, prev ? 'vc.pv.rectified' : 'vc.pv.transmitted', 'proces_verbal', pv.id, { plate, centreId: centre.id, result: pv.result, echeance: pv.echeance, supersedes: prev?.id ?? null, nonConformes });
    return pv;
  }

  /** Dernier procès-verbal en vigueur d'une plaque et son état de validité. */
  status(plateIn: string) {
    const plate = this.d.plate(plateIn);
    const pv = this.activePvs().filter((p) => p.plate === plate).sort((a, b) => b.endedAt.localeCompare(a.endedAt))[0];
    if (!pv) return { plate, state: 'AUCUN_CONTROLE' as const, label: 'Aucun contrôle technique enregistré', pv: null, validity: null, sticker: null };
    const sticker = this.stickers.findOne((s) => s.pvId === pv.id && s.status === 'ATTRIBUEE') ?? null;
    if (pv.result === 'DEFAVORABLE') return { plate, state: 'DEFAVORABLE' as const, label: 'Contrôle défavorable — contre-visite requise', pv, validity: null, sticker };
    const validity = validityView(pv.endedAt.slice(0, 10), pv.echeance, this.d.ctx.clock.now());
    const state = validity.band === 'EXPIRE' ? 'ECHU' as const : validity.band === 'AMBRE' || validity.band === 'ROUGE' ? 'BIENTOT_ECHU' as const : 'A_JOUR' as const;
    const label = state === 'ECHU' ? `Échu depuis le ${pv.echeance}` : state === 'BIENTOT_ECHU' ? `À jour — échéance proche (${pv.echeance})` : `À jour jusqu’au ${pv.echeance}`;
    return { plate, state, label, pv, validity, sticker };
  }

  listPvs(user: User, filter: { plate?: string; centreId?: string } = {}) {
    authorize(user, user.roles.includes('R34') ? 'vc:pv.submit' : 'vc:read');
    const scope = user.roles.includes('R34') ? user.entity : filter.centreId;
    return this.pvs.all()
      .filter((p) => (!scope || p.centreId === scope) && (!filter.plate || p.plate === this.d.plate(filter.plate)))
      .map((p) => (this.superseded.has(p.id) ? { ...p, supersededBy: this.superseded.get(p.id)! } : p))
      .sort((a, b) => b.transmittedAt.localeCompare(a.transmittedAt));
  }

  // ——— Vignettes sécurisées ———

  issueLot(user: User, input: { centreId: string; quantity: number }, opts: { demo?: boolean } = {}): StickerLot {
    authorize(user, 'vc:sticker.lot.issue');
    const c = this.centres.assertCanOperate(input.centreId, 'EMISSION_VIGNETTES');
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw badRequest('QUANTITE', 'Quantité entière positive attendue.');
    const inStock = this.stickers.find((s) => s.centreId === c.id && s.status === 'EN_STOCK').length;
    if (inStock + input.quantity > c.quotas.stockVignettes) {
      this.d.audit(user, 'vc.sticker.lot_refused', 'centre_agree', c.id, { inStock, requested: input.quantity, quota: c.quotas.stockVignettes }, 'DENIED');
      throw unprocessable('QUOTA_STOCK_DEPASSE', `Stock du centre : ${inStock} en stock + ${input.quantity} demandées > quota de ${c.quotas.stockVignettes}.`);
    }
    const year = this.d.today().slice(0, 4);
    const lotId = this.d.ids.next('LOT-VTS', 5);
    const numbers: string[] = [];
    for (let i = 0; i < input.quantity; i++) {
      const number = stickerNumber(year, ++this.serial);
      numbers.push(number);
      this.stickers.insert({ id: number, number, lotId, centreId: c.id, status: 'EN_STOCK', ...(opts.demo ? { demo: true } : {}) });
    }
    const lot = this.lots.insert({ id: lotId, centreId: c.id, first: numbers[0]!, last: numbers.at(-1)!, quantity: input.quantity, issuedBy: user.id, issuedAt: this.d.now(), ...(opts.demo ? { demo: true } : {}) });
    this.d.audit(user, 'vc.sticker.lot_issued', 'lot_vignettes', lot.id, { centreId: c.id, first: lot.first, last: lot.last, quantity: lot.quantity });
    return lot;
  }

  sticker(number: string): SecureSticker {
    const s = this.stickers.get(number.trim().toUpperCase());
    if (!s) throw notFound('VIGNETTE_INCONNUE', `Numéro de vignette inconnu : ${number} (faux par construction).`);
    return s;
  }

  assignSticker(user: User, input: { number: string; pvId: string }): SecureSticker & { qr: string } {
    authorize(user, 'vc:sticker.assign');
    const s = this.sticker(input.number);
    this.centres.assertMember(user, s.centreId);
    this.centres.assertCanOperate(s.centreId, 'EMISSION_VIGNETTES');
    if (s.status !== 'EN_STOCK') {
      this.d.audit(user, 'vc.sticker.duplicate_refused', 'vignette_securisee', s.number, { status: s.status, plate: s.plate ?? null }, 'DENIED');
      this.d.ctx.alerts.raise({ type: 'VIGNETTE_DOUBLON', severity: 'HIGH', source: 'vehicules-controle', detail: `Tentative de réattribution de la vignette ${s.number} (statut ${s.status}).`, context: { number: s.number, centreId: s.centreId }, actor: { kind: 'user', id: user.id, roles: user.roles } });
      throw conflict('VIGNETTE_DEJA_UTILISEE', `Vignette ${s.number} non disponible (statut ${s.status}) : une vignette n’est attribuée qu’une fois.`);
    }
    const pv = this.pvs.get(input.pvId);
    if (!pv || this.superseded.has(pv.id)) throw notFound('PV_INCONNU', 'Procès-verbal inconnu ou remplacé.');
    if (pv.centreId !== s.centreId) throw forbidden('PV_AUTRE_CENTRE', 'La vignette est attribuée par le centre qui a établi le procès-verbal.');
    if (pv.result !== 'FAVORABLE') throw unprocessable('PV_DEFAVORABLE', 'Aucune vignette sur un contrôle défavorable.');
    if (this.stickers.findOne((x) => x.pvId === pv.id && x.status === 'ATTRIBUEE')) throw conflict('PV_DEJA_VIGNETTE', 'Ce procès-verbal porte déjà une vignette.');
    const out = this.stickers.update({ ...s, status: 'ATTRIBUEE', plate: pv.plate, pvId: pv.id, attributedAt: this.d.now(), attributedBy: user.id });
    this.d.audit(user, 'vc.sticker.assigned', 'vignette_securisee', s.number, { plate: pv.plate, pvId: pv.id, centreId: s.centreId });
    return { ...out, qr: this.stickerQr(out) };
  }

  /**
   * QR SIGNÉ de la vignette technique (30/09/2026) : adresse du domaine officiel + signature (numéro et plaque) ; une
   * photocopie du QR d'une autre vignette, ou un QR fabriqué, ne porte pas une signature valable pour ce véhicule.
   */
  private stickerSig(number: string, plate: string): string {
    return hmacSha256Hex(`vignette-technique|${this.d.ctx.secrets.auditHmacKey}`, `${number}|${plate}`).slice(0, 20);
  }
  stickerQr(s: SecureSticker): string {
    return `${this.domaine.verifyUrl('ct', s.number)}?s=${s.plate ? this.stickerSig(s.number, s.plate) : ''}`;
  }

  /** Vignette vue sur un autre véhicule : signalée (vérification publique « signalée »), alerte, dossier titres. */
  flagStickerCopy(user: User, s: SecureSticker, observedPlate: string, caseId?: string): SecureSticker {
    const out = this.stickers.update({ ...s, suspectedCopy: { at: this.d.now(), observedPlate, by: user.id, ...(caseId ? { caseId } : {}) } });
    this.d.audit(user, 'vc.sticker.copy_suspected', 'vignette_securisee', s.number, { plate: s.plate ?? null, observedPlate, caseId: caseId ?? null }, 'DENIED');
    return out;
  }

  cancelSticker(user: User, number: string, reason: string, mode: 'ANNULEE' | 'REVOQUEE'): SecureSticker {
    authorize(user, mode === 'ANNULEE' ? 'vc:sticker.cancel' : 'vc:sticker.revoke');
    const s = this.sticker(number);
    if (mode === 'ANNULEE') this.centres.assertMember(user, s.centreId);
    if (s.status === 'ANNULEE' || s.status === 'REVOQUEE') throw conflict('VIGNETTE_ETAT', `Vignette déjà ${s.status.toLowerCase()}.`);
    const out = this.stickers.update({ ...s, status: mode, cancelledAt: this.d.now(), cancelledBy: user.id, cancelReason: reason });
    this.centres.revocationVersion++;
    this.d.audit(user, mode === 'ANNULEE' ? 'vc.sticker.cancelled' : 'vc.sticker.revoked', 'vignette_securisee', s.number, { reason, plate: s.plate ?? null });
    return out;
  }

  /** Liste de révocation signée (vignettes annulées ou révoquées, centres suspendus) pour les terminaux de contrôle. */
  revocationList() {
    const doc = {
      kind: 'MOSOLO_VIGNETTES_TECHNIQUES_REVOCATIONS', version: this.centres.revocationVersion, generatedAt: this.d.now(),
      stickers: this.stickers.find((s) => s.status === 'ANNULEE' || s.status === 'REVOQUEE').map((s) => ({ number: s.number, status: s.status, at: s.cancelledAt })).sort((a, b) => a.number.localeCompare(b.number)),
      suspendedCentres: this.centres.centres.find((c) => c.status === 'SUSPENDU').map((c) => ({ id: c.id, publicCode: c.publicCode, at: c.suspension?.at })),
    };
    const sig = this.d.ctx.receipts.signDocument(Buffer.from(JSON.stringify(doc)));
    return { ...doc, signature: sig.signature, keyId: sig.keyId, algorithm: sig.algorithm, sha256: sig.sha256 };
  }

  /**
   * Vérification publique d'une vignette technique (numéro ou QR). Le QR doit pointer vers le domaine officiel : un
   * autre domaine est signalé (alerte) et la vignette n'est pas déclarée authentique par ce canal.
   */
  publicVerify(raw: string) {
    const input = raw.trim();
    let number = input.toUpperCase();
    let domainVerdict: string = 'SAISIE_DIRECTE';
    let sig: string | null = null;
    if (/^https?:\/\//i.test(input)) {
      let url: URL;
      try { url = new URL(input); } catch { return { found: false, authentic: false, state: 'NON_AUTHENTIQUE', message: 'QR illisible.', checkedAt: this.d.now() }; }
      const h = this.domaine.checkHost(url.hostname);
      domainVerdict = h.verdict;
      if (h.verdict === 'DOMAINE_NON_OFFICIEL') {
        this.d.ctx.alerts.raise({ type: 'QR_DOMAINE_NON_OFFICIEL', severity: 'HIGH', source: 'vehicules-controle', detail: `QR de vignette pointant vers un domaine non officiel : ${h.host}.`, context: { host: h.host } });
        this.d.audit(null, 'vc.sticker.foreign_domain', 'vignette_securisee', h.host, { url: input.slice(0, 200) }, 'DENIED');
        return { found: false, authentic: false, state: 'DOMAINE_NON_OFFICIEL', message: `Ce QR ne pointe pas vers le domaine officiel de vérification (${this.domaine.domain.host}) : vignette douteuse, signalez-la.`, officialDomain: this.domaine.domain.host, checkedAt: this.d.now() };
      }
      const m = /\/v\/ct\/([^/?#]+)/.exec(url.pathname);
      number = decodeURIComponent(m?.[1] ?? '').toUpperCase();
      sig = url.searchParams.get('s');
    }
    const s = this.stickers.get(number);
    if (!s) {
      this.d.audit(null, 'vc.sticker.unknown_verified', 'vignette_securisee', number.slice(0, 40), { wellFormed: stickerWellFormed(number) }, 'FAILURE');
      return { found: false, authentic: false, state: 'NON_AUTHENTIQUE', message: 'Numéro inconnu du registre des vignettes sécurisées : vignette fausse par construction.', checkedAt: this.d.now() };
    }
    const centre = this.centres.centres.get(s.centreId);
    const base = { found: true, number: s.number, centre: centre ? { name: centre.name, publicCode: centre.publicCode } : null, domainVerdict, checkedAt: this.d.now() };
    if (s.status === 'EN_STOCK') return { ...base, authentic: false, state: 'NON_ATTRIBUEE', message: 'Vignette authentique mais jamais attribuée à un véhicule : ne vaut pas contrôle.' };
    if (s.status !== 'ATTRIBUEE') return { ...base, authentic: false, state: s.status, message: s.status === 'REVOQUEE' ? 'Vignette révoquée.' : 'Vignette annulée.' };
    // Signature du QR (30/09/2026) : fausse ⇒ copie ou fabrication (alerte) ; absente ⇒ ancienne vignette, à confirmer.
    if (sig !== null && sig !== '' && !safeEqualHex(sig, this.stickerSig(s.number, s.plate!))) {
      this.d.ctx.alerts.raise({ type: 'VIGNETTE_QR_FALSIFIE', severity: 'HIGH', source: 'vehicules-controle', detail: `QR de la vignette ${s.number} avec une signature invalide : copie ou fabrication.`, context: { number: s.number } });
      return { ...base, authentic: false, state: 'NON_AUTHENTIQUE', message: 'Signature du QR invalide : copie ou fabrication de vignette. Signalez-la.' };
    }
    if (s.suspectedCopy) return { ...base, authentic: false, state: 'SIGNALEE', message: 'Vignette signalée : vue sur un autre véhicule — vérification en cours par l’anti-fraude.' };
    const st = this.status(s.plate!);
    const masked = `${s.plate!.slice(0, 2)}•••${s.plate!.slice(-2)}`;
    return { ...base, authentic: true, state: st.state, plateMasked: masked, echeance: st.pv?.echeance ?? null, validity: st.validity, message: sig ? st.label : `${st.label} (QR sans signature : ancienne vignette — le numéro est contrôlé au registre)` , qrSigne: !!sig };
  }

  // ——— Mode courtoisie ———

  decideCourtesy(user: User, input: { categories: VehicleCategory[]; communes: string[]; from: string; to: string; authority: string; decisionRef: string; reason: string }, opts: { exemple?: boolean } = {}): CourtesyPeriod {
    authorize(user, 'vc:courtesy.decide');
    if (input.to < input.from) throw unprocessable('DATES', 'Fin antérieure au début.');
    const p = this.courtesy.insert({ id: this.d.ids.next('COURT', 4), ...input, decidedBy: user.id, decidedAt: this.d.now(), ...(opts.exemple ? { exemple: true } : {}) });
    this.d.audit(user, 'vc.courtesy.decided', 'mode_courtoisie', p.id, { ...input });
    return p;
  }

  endCourtesy(user: User, id: string, reason: string): CourtesyPeriod {
    authorize(user, 'vc:courtesy.decide');
    const p = this.courtesy.get(id);
    if (!p) throw notFound('COURTOISIE_INCONNUE', `Période inconnue : ${id}`);
    const out = this.courtesy.update({ ...p, to: this.d.today(), endedEarly: { by: user.id, at: this.d.now(), reason } });
    this.d.audit(user, 'vc.courtesy.ended', 'mode_courtoisie', id, { reason });
    return out;
  }

  /** Période de courtoisie applicable (catégorie et commune), à la date du serveur. */
  courtesyFor(category: VehicleCategory | undefined, commune: string | undefined, day = this.d.today()): CourtesyPeriod | null {
    return this.courtesy.find((p) => p.from <= day && day <= p.to && (!p.endedEarly || p.endedEarly.at.slice(0, 10) >= day)
      && (p.categories.length === 0 || (!!category && p.categories.includes(category)))
      && (p.communes.length === 0 || (!!commune && p.communes.includes(commune))))[0] ?? null;
  }

  // ——— Rappels « ambre » ———

  runReminders(user: User | null) {
    if (user) authorize(user, 'vc:reminders.run');
    let sent = 0;
    const notified: string[] = [];
    for (const v of this.vehicles.all()) {
      const st = this.status(v.plate);
      if (st.state !== 'BIENTOT_ECHU' || !v.taxpayerId) continue;
      const tp = this.d.ctx.taxpayers.taxpayers.get(v.taxpayerId);
      if (!tp) continue;
      this.d.ctx.comms.publish('permit.expiring', [taxpayerRecipient(tp)], { titre: `Contrôle technique ${v.plate}`, date: st.pv!.echeance, reference: st.pv!.number }, { entity: 'RFCK' });
      sent++; notified.push(v.plate);
    }
    this.d.audit(user, 'vc.reminders.run', 'controle_technique', 'echeances', { sent });
    return { sent, plates: notified };
  }

  // ——— Rendez-vous (couche usager) ———

  book(user: User, input: { plate: string; centreId: string; date: string }): Appointment {
    const v = this.vehicle(input.plate);
    const taxpayerId = v?.taxpayerId ?? user.taxpayerId;
    authorize(user, 'vc:vehicle.own', { ...(taxpayerId ? { taxpayerId } : {}) });
    if (!taxpayerId) throw unprocessable('VEHICULE_NON_RATTACHE', 'Véhicule non rattaché à votre compte.');
    this.centres.assertCanOperate(input.centreId, 'CONTROLE_TECHNIQUE', v?.category);
    if (input.date < this.d.today()) throw unprocessable('DATE_PASSEE', 'Date passée.');
    const id = this.d.ids.next('RDV', 5);
    const fee = this.liquidateFee(taxpayerId, v?.objectId, id);
    const a = this.appointments.insert({ id, plate: this.d.plate(input.plate), centreId: input.centreId, date: input.date, taxpayerId, status: 'DEMANDE', createdAt: this.d.now(), fee });
    this.d.audit(user, 'vc.appointment.requested', 'rendez_vous_ct', a.id, { centreId: a.centreId, date: a.date, fee: fee.status, obligationId: fee.obligationId ?? null });
    return this.appointmentView(a);
  }

  /** Liquidation de la redevance par la fiche ACTIVE (moteur de liquidation, jamais un montant saisi). */
  private liquidateFee(taxpayerId: string, objectId: string | undefined, appointmentId: string): AppointmentFee {
    const now = this.d.ctx.clock.now();
    const versions = this.d.ctx.rules.list().filter((r) => r.code === RULE_CODES.redevanceCt).sort((a, b) => b.version - a.version);
    const rule = versions.find((r) => isRuleExecutable(r, now).ok);
    if (!rule) return { status: 'ACTE_REQUIS', reason: versions.length ? `Aucune version ACTIVE de la redevance (dernière : v${versions[0]!.version} ${versions[0]!.status}) : aucun montant tant que l'acte n'est pas certifié.` : 'Fiche de redevance absente du registre.' };
    if (!objectId) return { status: 'VEHICULE_A_RATTACHER', reason: 'Véhicule à rattacher à votre compte (objet véhicule) avant liquidation de la redevance.' };
    const known: Record<string, string> = { quantite: '1', nombre: '1' };
    const required = this.d.ctx.rules.requiredInputs(rule);
    const missing = required.filter((k) => !(k in known));
    if (missing.length) return { status: 'ACTE_REQUIS', reason: `Donnée requise par la fiche non disponible : ${missing.join(', ')}.` };
    const engine = enginePrincipal('svc-controle-technique', `Liquidation de la redevance — rendez-vous ${appointmentId}`, rule.administeringEntity);
    const r = this.d.ctx.assessment.calculate(engine, { ruleId: rule.id, taxpayerId, objectId, inputs: Object.fromEntries(required.map((k) => [k, known[k]!])), simulate: false });
    return { status: 'LIQUIDEE', obligationId: r.obligation!.id, amount: r.obligation!.amount, legalReference: `${rule.code} v${rule.version} — ${rule.articles.join(' ; ')}` };
  }

  /** Rendez-vous avec l'état RÉEL du paiement de sa redevance (lu dans le grand livre, jamais déclaré par le centre). */
  appointmentView(a: Appointment) {
    const pay = a.fee?.obligationId ? paymentState(this.d.ctx, a.fee.obligationId) : null;
    const paye = !a.fee?.obligationId || (pay !== null && ['PAYE', 'RAPPROCHE'].includes(pay.state));
    return {
      ...a,
      ...(pay ? { feePayment: pay } : {}),
      redevancePayee: paye,
      notice: a.fee?.status === 'LIQUIDEE'
        ? 'Redevance payable depuis « Mon espace » (monnaie mobile, QR, USSD, banque, carte, point agréé, BitriPay ou KODA) vers le compte public. Aucun paiement en espèces au centre : le centre confirme le créneau dès que le paiement est confirmé.'
        : 'Aucune redevance liquidée pour ce rendez-vous (fiche non active) : aucun paiement ne peut vous être demandé au centre.',
    };
  }

  confirmAppointment(user: User, id: string): Appointment {
    authorize(user, 'vc:appointment.confirm');
    const a = this.appointments.get(id);
    if (!a) throw notFound('RDV_INCONNU', `Rendez-vous inconnu : ${id}`);
    this.centres.assertMember(user, a.centreId);
    // Redevance liquidée : le créneau n'est confirmé qu'une fois le paiement confirmé par le circuit commun (30/09/2026).
    if (a.fee?.obligationId && !this.appointmentView(a).redevancePayee) {
      throw conflict('REDEVANCE_NON_PAYEE', 'Redevance de contrôle technique non encore payée : le créneau est confirmé dès la confirmation du paiement (jamais d’encaissement au centre).');
    }
    const out = this.appointments.update({ ...a, status: 'CONFIRME', confirmedBy: user.id });
    this.d.audit(user, 'vc.appointment.confirmed', 'rendez_vous_ct', id, {});
    return out;
  }

  // ——— Indicateurs ———

  indicators() {
    const plates = new Set([...this.vehicles.all().map((v) => v.plate)]);
    const states = [...plates].map((p) => this.status(p).state);
    const upToDate = states.filter((s) => s === 'A_JOUR' || s === 'BIENTOT_ECHU').length;
    const st = this.stickers.all();
    const today = this.d.today();
    return {
      vehiculesConnus: plates.size,
      ctAJour: upToDate,
      ctAJourPct: plates.size ? Math.round((upToDate / plates.size) * 1000) / 10 : null,
      ctBientotEchus: states.filter((s) => s === 'BIENTOT_ECHU').length,
      ctEchus: states.filter((s) => s === 'ECHU').length,
      defavorables: states.filter((s) => s === 'DEFAVORABLE').length,
      procesVerbaux: this.activePvs().length,
      vignettesEnStock: st.filter((s) => s.status === 'EN_STOCK').length,
      vignettesEmises: st.filter((s) => s.status === 'ATTRIBUEE').length,
      vignettesAnnulees: st.filter((s) => s.status === 'ANNULEE' || s.status === 'REVOQUEE').length,
      courtoisieEnCours: this.courtesy.find((p) => p.from <= today && today <= p.to && !p.endedEarly).length,
      prochainesEcheances30j: [...plates].filter((p) => { const s = this.status(p); return !!s.pv && s.pv.echeance >= today && s.pv.echeance <= addDays(today, 30); }).length,
    };
  }
}
