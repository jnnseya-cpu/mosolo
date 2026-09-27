/**
 * Carte MOSOLO (module 65, § 13A.2, § H.7.2) : identité physique vérifiable des personnes sans téléphone.
 * Numéro de 12 chiffres (dont un chiffre de contrôle Luhn, saisissable au clavier d'un téléphone basique),
 * QR portant un jeton signé Ed25519 sans aucune donnée personnelle, états ACTIVE → BLOQUÉE → RÉVOQUÉE,
 * réémission sous double validation avec révocation de l'ancien QR, code secret stocké uniquement haché (scrypt).
 */
import { generateKeyPairSync, randomBytes, randomInt, scryptSync, sign, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import type { AuditLog } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import type { Clock } from '../../core/clock.js';
import { canonicalJson } from '../../core/crypto.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { CommunicationService } from '../../modules/communications/service.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import type { TaxpayerService } from '../../modules/identity/service.js';
import { initials, type CardReissueRequest, type MosoloCard } from './model.js';

function luhn(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

/** Normalise une saisie (espaces, tirets) ; renvoie null si le chiffre de contrôle est faux. */
export function normalizeCardNumber(raw: string): string | null {
  const d = raw.replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(d)) return null;
  return luhn(d.slice(0, 11)) === Number(d[11]) ? d : null;
}

/** Numéro complet (11 chiffres + chiffre de contrôle) à partir d'un préfixe fixe (données de démonstration). */
export function cardNumberFrom(core11: string): string {
  if (!/^\d{11}$/.test(core11)) throw new Error('11 chiffres attendus');
  return core11 + String(luhn(core11));
}

export function formatCardNumber(n: string): string {
  return `${n.slice(0, 4)} ${n.slice(4, 8)} ${n.slice(8)}`;
}

interface PinRecord {
  id: string;
  salt: string;
  hash: string;
  failures: number;
  lockedUntil?: string;
  setAt: string;
}

export class CardRegistry {
  readonly cards = new InMemoryRepository<MosoloCard>();
  readonly reissues = new InMemoryRepository<CardReissueRequest>();
  /** Codes secrets des canaux USSD/SVI, par contribuable : sel + empreinte scrypt, jamais le code en clair. */
  private readonly pins = new InMemoryRepository<PinRecord>();
  private readonly ids = new IdGenerator();
  private readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly comms: CommunicationService,
    private readonly taxpayers: TaxpayerService,
  ) {
    const pair = generateKeyPairSync('ed25519');
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  private newNumber(): string {
    for (;;) {
      let core = String(randomInt(1, 10));
      for (let i = 0; i < 10; i++) core += String(randomInt(0, 10));
      const n = core + String(luhn(core));
      if (!this.byNumber(n)) return n;
    }
  }

  private token(card: Pick<MosoloCard, 'number' | 'version' | 'commune' | 'issuedAt'>): string {
    const payload = canonicalJson({ n: card.number, v: card.version, c: card.commune, i: card.issuedAt });
    const sig = sign(null, Buffer.from(payload), this.privateKey).toString('base64url');
    return `MC1.${card.number}.${card.version}.${sig}`;
  }

  byNumber(number: string): MosoloCard | undefined {
    return this.cards.findOne((c) => c.number === number);
  }

  activeFor(taxpayerId: string): MosoloCard | undefined {
    return this.cards.findOne((c) => c.taxpayerId === taxpayerId && c.status === 'ACTIVE');
  }

  get(number: string): MosoloCard {
    const clean = normalizeCardNumber(number);
    const c = clean ? this.byNumber(clean) : undefined;
    if (!c) throw notFound('CARD_NOT_FOUND', 'Carte MOSOLO inconnue.');
    return c;
  }

  /** Émission (enrôlement assisté ou réémission) : gratuite ; le QR ne porte qu'un jeton signé. */
  issue(input: { taxpayerId: string; commune: string; photoSha256?: string; enrolmentId?: string; previousCardNumber?: string; issuedBy: string; fixedNumber?: string }): MosoloCard {
    const tp = this.taxpayers.get(input.taxpayerId);
    if (this.activeFor(tp.id)) throw conflict('CARD_ALREADY_ACTIVE', 'Une carte MOSOLO active existe déjà pour ce compte.');
    const number = input.fixedNumber ?? this.newNumber();
    const issuedAt = this.clock.now().toISOString();
    const base = { number, version: 1, commune: input.commune, issuedAt };
    const card = this.cards.insert({
      id: this.ids.next('CARTE'), ...base, taxpayerId: tp.id, iuc: tp.iuc, holderDisplayName: initials(tp.fullName),
      ...(input.photoSha256 ? { photoSha256: input.photoSha256 } : {}), status: 'ACTIVE', issuedBy: input.issuedBy,
      ...(input.enrolmentId ? { enrolmentId: input.enrolmentId } : {}),
      ...(input.previousCardNumber ? { previousCardNumber: input.previousCardNumber } : {}),
      qrToken: this.token(base),
    });
    this.audit.append({
      actor: { kind: 'user', id: input.issuedBy }, action: 'canaux.card.issued', resourceType: 'mosolo_card', resourceId: card.id,
      details: { taxpayerId: tp.id, commune: card.commune, previousCardNumber: input.previousCardNumber ?? null },
    });
    this.comms.publish('account.mosolo_card.issued', [taxpayerRecipient(tp)], { reference: formatCardNumber(number) }, { entity: 'GOUVERNORAT' });
    return card;
  }

  /** Blocage immédiat (perte, vol) : guichet, agent, titulaire (USSD/SVI) ou mandataire. Mesure de protection demandée, pas une sanction. */
  block(actor: { kind: 'user' | 'public'; id: string; roles?: string[] }, number: string, reason: string): MosoloCard {
    const card = this.get(number);
    if (card.status !== 'ACTIVE') throw conflict('CARD_NOT_ACTIVE', `Carte au statut ${card.status} : blocage sans objet.`);
    const updated = this.cards.update({ ...card, status: 'BLOQUEE', blockedAt: this.clock.now().toISOString(), blockedReason: reason });
    this.audit.append({ actor, action: 'canaux.card.blocked', resourceType: 'mosolo_card', resourceId: card.id, details: { reason } });
    this.comms.publish('account.mosolo_card.revoked', [taxpayerRecipient(this.taxpayers.get(card.taxpayerId))], { reference: `••••${card.number.slice(-4)}` }, { entity: 'GOUVERNORAT' });
    return updated;
  }

  requestReissue(user: User, number: string, motif: string): CardReissueRequest {
    authorize(user, 'canaux:card.reissue.request');
    const card = this.get(number);
    if (card.status === 'REVOQUEE') throw conflict('CARD_ALREADY_REVOKED', 'Carte déjà révoquée et réémise.');
    if (this.reissues.findOne((r) => r.cardNumber === card.number && r.status === 'EN_ATTENTE')) {
      throw conflict('REISSUE_ALREADY_PENDING', 'Une demande de réémission est déjà en attente pour cette carte.');
    }
    const req = this.reissues.insert({
      id: this.ids.next('REEM'), cardNumber: card.number, motif, requestedBy: user.id, requestedAt: this.clock.now().toISOString(), status: 'EN_ATTENTE',
    });
    this.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'canaux.card.reissue_requested', resourceType: 'mosolo_card', resourceId: card.id, details: { requestId: req.id, motif } });
    return req;
  }

  /** Seconde validation par une autre personne : l'ancienne carte est RÉVOQUÉE (son QR renvoie « carte révoquée »). */
  approveReissue(user: User, requestId: string): { request: CardReissueRequest; card: MosoloCard } {
    authorize(user, 'canaux:card.reissue.approve');
    const req = this.reissues.get(requestId);
    if (!req) throw notFound('REISSUE_REQUEST_NOT_FOUND', `Demande inconnue : ${requestId}`);
    if (req.status !== 'EN_ATTENTE') throw conflict('REISSUE_ALREADY_DECIDED', 'Demande déjà traitée.');
    assertDistinctPerson(user.id, [req.requestedBy], 'Réémission sous double validation : la personne qui a demandé ne peut pas approuver.');
    const old = this.get(req.cardNumber);
    const now = this.clock.now().toISOString();
    this.cards.update({ ...old, status: 'REVOQUEE', revokedAt: now });
    const card = this.issue({
      taxpayerId: old.taxpayerId, commune: old.commune, ...(old.photoSha256 ? { photoSha256: old.photoSha256 } : {}),
      previousCardNumber: old.number, issuedBy: user.id,
    });
    this.cards.update({ ...this.byNumber(old.number)!, replacedByNumber: card.number });
    const request = this.reissues.update({ ...req, status: 'APPROUVEE', approvedBy: user.id, approvedAt: now, newCardNumber: card.number });
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'canaux.card.reissued', resourceType: 'mosolo_card', resourceId: card.id,
      details: { requestId, previous: old.number.slice(-4), requestedBy: req.requestedBy },
    });
    return { request, card };
  }

  /** Vérification minimale d'un jeton de QR : aucune donnée personnelle, signature contrôlée. */
  verifyToken(token: string): { status: 'CARTE_VALIDE' | 'CARTE_BLOQUEE' | 'CARTE_REVOQUEE' | 'INVALIDE'; message: string; commune?: string; issuedOn?: string } {
    const m = /^MC1\.(\d{12})\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(token.trim());
    const invalid = { status: 'INVALIDE' as const, message: 'QR non reconnu : cette carte n’est pas authentique.' };
    if (!m) return invalid;
    const card = this.byNumber(m[1]!);
    if (!card || String(card.version) !== m[2]) return invalid;
    const payload = canonicalJson({ n: card.number, v: card.version, c: card.commune, i: card.issuedAt });
    // Signature illisible ou mal formée : l'exception vaut refus (QR non authentique).
    let ok: boolean;
    try {
      ok = verify(null, Buffer.from(payload), this.publicKey, Buffer.from(m[3]!, 'base64url'));
    } catch {
      ok = false;
    }
    if (!ok) return invalid;
    if (card.status === 'REVOQUEE') return { status: 'CARTE_REVOQUEE', message: 'Carte révoquée : une nouvelle carte a été émise.' };
    if (card.status === 'BLOQUEE') return { status: 'CARTE_BLOQUEE', message: 'Carte bloquée (perte ou vol déclaré).' };
    return { status: 'CARTE_VALIDE', message: 'Carte MOSOLO authentique et active.', commune: card.commune, issuedOn: card.issuedAt.slice(0, 7) };
  }

  // ---------- Code secret des canaux USSD / SVI ----------

  hasPin(taxpayerId: string): boolean {
    return !!this.pins.get(taxpayerId);
  }

  setPin(taxpayerId: string, pin: string, actor: { kind: 'user' | 'system'; id: string }): void {
    if (!/^\d{4}$/.test(pin) || /^(\d)\1{3}$/.test(pin) || ['1234', '4321', '0000'].includes(pin) && actor.kind !== 'system') {
      throw badRequest('WEAK_PIN', 'Code secret à 4 chiffres, ni répétitif ni suite évidente.');
    }
    this.taxpayers.get(taxpayerId);
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(pin, salt, 32).toString('hex');
    const rec = { id: taxpayerId, salt, hash, failures: 0, setAt: this.clock.now().toISOString() };
    if (this.pins.get(taxpayerId)) this.pins.update(rec);
    else this.pins.insert(rec);
    this.audit.append({ actor, action: 'canaux.pin.set', resourceType: 'taxpayer', resourceId: taxpayerId, details: { stored: 'scrypt' } });
  }

  /** Contrôle du code secret : 3 échecs ⇒ canal verrouillé 15 min pour ce compte (protection, pas sanction). */
  checkPin(taxpayerId: string, pin: string, lockMs: number, maxAttempts: number): 'OK' | 'FAUX' | 'VERROUILLE' | 'ABSENT' {
    const rec = this.pins.get(taxpayerId);
    if (!rec) return 'ABSENT';
    const now = this.clock.now();
    if (rec.lockedUntil && new Date(rec.lockedUntil) > now) return 'VERROUILLE';
    const candidate = scryptSync(pin, rec.salt, 32);
    const ok = /^\d{4}$/.test(pin) && timingSafeEqual(candidate, Buffer.from(rec.hash, 'hex'));
    if (ok) {
      this.pins.update({ ...rec, failures: 0, lockedUntil: undefined });
      return 'OK';
    }
    const failures = rec.failures + 1;
    const locked = failures >= maxAttempts;
    const { lockedUntil: _drop, ...rest } = rec;
    this.pins.update({ ...rest, failures: locked ? 0 : failures, ...(locked ? { lockedUntil: new Date(now.getTime() + lockMs).toISOString() } : {}) });
    return locked ? 'VERROUILLE' : 'FAUX';
  }

  /** Vue d'impression de la carte (agent, guichet, titulaire). */
  view(card: MosoloCard) {
    return {
      number: card.number, numberFormatted: formatCardNumber(card.number), status: card.status, taxpayerId: card.taxpayerId, iuc: card.iuc, commune: card.commune,
      holderDisplayName: card.holderDisplayName, photoSha256: card.photoSha256 ?? null, issuedAt: card.issuedAt, qrToken: card.qrToken,
      previousCardNumber: card.previousCardNumber ?? null, replacedByNumber: card.replacedByNumber ?? null, free: true,
      mention: 'Carte gratuite. Elle identifie la personne ; chaque bien garde sa propre plaque.',
    };
  }

  assertUsable(card: MosoloCard): void {
    if (card.status !== 'ACTIVE') throw unprocessable('CARD_NOT_ACTIVE', card.status === 'REVOQUEE' ? 'Carte révoquée.' : 'Carte bloquée.');
  }
}
