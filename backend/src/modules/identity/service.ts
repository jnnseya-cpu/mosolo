/** Identité des contribuables (ch. 9) : inscription, identifiant unique du contribuable (IUC), préférences. */
import { RESIDENTIAL_SITUATIONS, type LanguageCode, type ResidentialSituation, type VerificationLevel } from '@mosolo/shared';
import type { AuditActor, AuditLog } from '../../core/audit.js';
import type { Clock } from '../../core/clock.js';
import { checkChar, randomCode } from '../../core/crypto.js';
import { conflict, notFound } from '../../core/errors.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { CommunicationService, RecipientPrefs } from '../communications/service.js';
import { taxpayerRecipient } from './recipients.js';

/** Nature juridique du titulaire du compte (§ 9.1). Absent = personne physique (comptes antérieurs). */
export type TaxpayerKind = 'PERSONNE_PHYSIQUE' | 'PERSONNE_MORALE';

export interface Taxpayer {
  id: string;
  iuc: string;
  fullName: string;
  phone: string;
  email?: string;
  language: LanguageCode;
  situation: ResidentialSituation;
  verificationLevel: VerificationLevel;
  createdAt: string;
  prefs: RecipientPrefs;
  kind?: TaxpayerKind;
  /** Téléphone vérifié par code à usage unique (N0 effectif). */
  phoneVerifiedAt?: string;
  /** Compte créé par enrôlement assisté (N0-A), éventuellement sans téléphone. */
  assisted?: boolean;
  /** Fusion d'identités (réversible) : le compte absorbé pointe vers le compte conservé. */
  status?: 'ACTIF' | 'FUSIONNE';
  mergedInto?: string;
  /** Compte repris d'un système existant (ex. « e-DGRK ») : lot et référence d'origine (§ 7.5). */
  importedFrom?: { source: string; batchId: string; externalRef: string };
}

export type RegistrationInput = {
  phone: string; fullName: string; language: LanguageCode; situation: ResidentialSituation; email?: string; kind?: TaxpayerKind;
  /** NIF déclaré à l'inscription (facultatif) : clé du compte unique quand il existe (ch. 9) — contrôlé par les gardes anti-doublon. */
  nif?: string;
  /**
   * Situation choisie à l'inscription (propriétaire, locataire, exploitant) : elle OUVRE une revendication à compléter
   * (module 7) ; elle ne définit jamais la personne et ne la relie à personne d'office.
   */
  intention?: 'PROPRIETAIRE' | 'LOCATAIRE' | 'EXPLOITANT' | 'AUCUNE';
  intentions?: ('PROPRIETAIRE' | 'LOCATAIRE' | 'EXPLOITANT')[];
};

/**
 * Crochets du compte unique (ch. 9, ajout du 28/09/2026) : les modules d'extension y branchent leurs contrôles et leurs
 * suites SANS modifier le socle. Une garde anti-doublon lève une erreur pour refuser (et orienter vers la récupération) ;
 * une suite ne peut rien refuser (ses erreurs sont ignorées et le compte reste créé ou vérifié).
 */
export interface TaxpayerHooks {
  /** Gardes appelées avant toute création de compte (inscription, enrôlement assisté, canaux) : NIF, RCCM… */
  duplicateGuards: ((input: { phone: string; fullName: string; nif?: string; kind?: TaxpayerKind }) => void)[];
  /** Suites d'une inscription (ex. intention « propriétaire / locataire » ⇒ revendication à compléter). */
  registered: ((t: Taxpayer, input: Partial<RegistrationInput> & Record<string, unknown>) => void)[];
  /** Suites de la vérification du téléphone (rattachement exact des fiches parallèles portant ce numéro). */
  phoneVerified: ((t: Taxpayer) => void)[];
}

export { RESIDENTIAL_SITUATIONS };

export class TaxpayerService {
  readonly taxpayers = new InMemoryRepository<Taxpayer>();
  private readonly ids = new IdGenerator();
  /** Crochets du compte unique (voir `TaxpayerHooks`). */
  readonly hooks: TaxpayerHooks = { duplicateGuards: [], registered: [], phoneVerified: [] };

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly comms: CommunicationService,
  ) {}

  private newIuc(): string {
    const core = randomCode(8);
    return `KIN-${core}-${checkChar(core)}`;
  }

  register(input: RegistrationInput, fixedId?: string): Taxpayer {
    const phone = input.phone.replace(/[\s-]/g, '');
    if (phone !== '' && this.taxpayers.findOne((t) => t.phone === phone)) {
      // Anti-doublon (§ 9.6) : un numéro, un compte ; la récupération passe par un parcours dédié.
      throw conflict('PHONE_ALREADY_REGISTERED', 'Ce numéro est déjà rattaché à un compte. Utilisez la récupération de compte.', { recovery: RECOVERY_PATH });
    }
    // Gardes du compte unique (NIF, RCCM… branchées par les modules) : même clé ⇒ récupération, jamais un doublon.
    for (const guard of this.hooks.duplicateGuards) guard({ phone, fullName: input.fullName, ...(input.nif ? { nif: input.nif } : {}), ...(input.kind ? { kind: input.kind } : {}) });
    const taxpayer = this.taxpayers.insert({
      id: fixedId ?? this.ids.next('TP'),
      iuc: this.newIuc(),
      fullName: input.fullName.trim(),
      phone,
      ...(input.email ? { email: input.email } : {}),
      language: input.language,
      situation: input.situation,
      // N0 : compte créé, téléphone non encore vérifié par OTP (§ 9.3).
      verificationLevel: 'N0',
      createdAt: this.clock.now().toISOString(),
      prefs: {},
      ...(input.kind ? { kind: input.kind } : {}),
    });
    this.audit.append({
      actor: { kind: 'public', id: 'inscription' },
      action: 'account.registration.requested',
      resourceType: 'taxpayer',
      resourceId: taxpayer.id,
      details: { situation: taxpayer.situation, language: taxpayer.language },
    });
    this.comms.publish('account.registration.received', [taxpayerRecipient(taxpayer)], {}, { entity: 'GOUVERNORAT' });
    this.runAfter(this.hooks.registered, (fn) => fn(taxpayer, input));
    return taxpayer;
  }

  /** Suites des crochets : jamais bloquantes (le compte est créé ou vérifié quoi qu'il arrive). */
  private runAfter<F>(fns: F[], call: (fn: F) => void): void {
    for (const fn of fns) {
      try { call(fn); } catch { /* suite non bloquante : le module la rejouera ou la signalera */ }
    }
  }

  /**
   * Compte unique effectif (ch. 9) : un compte absorbé par une fusion réversible renvoie au compte conservé.
   * Sert aux canaux (USSD, SVI, carte) pour ne jamais recréer ni servir un doublon.
   */
  resolve(id: string): Taxpayer {
    let t = this.get(id);
    for (let i = 0; i < 5 && t.status === 'FUSIONNE' && t.mergedInto; i++) t = this.get(t.mergedInto);
    return t;
  }

  /** Compte actif portant ce téléphone (normalisé), en suivant une éventuelle fusion. */
  findByPhone(phoneRaw: string): Taxpayer | undefined {
    const phone = phoneRaw.replace(/[\s-]/g, '');
    if (!phone) return undefined;
    const t = this.taxpayers.findOne((x) => x.phone === phone && x.status !== 'FUSIONNE') ?? this.taxpayers.findOne((x) => x.phone === phone);
    return t ? this.resolve(t.id) : undefined;
  }

  /**
   * Enrôlement assisté (N0-A, § 9.2 et § 13A) : compte créé par un agent habilité ou un guichet, téléphone facultatif.
   * Aucun paiement n'est demandé ni reçu par l'agent.
   */
  registerAssisted(input: { fullName: string; language: LanguageCode; situation: ResidentialSituation; phone?: string }, actor: AuditActor): Taxpayer {
    const phone = (input.phone ?? '').replace(/[\s-]/g, '');
    if (phone !== '' && this.taxpayers.findOne((t) => t.phone === phone)) {
      throw conflict('PHONE_ALREADY_REGISTERED', 'Ce numéro est déjà rattaché à un compte. Utilisez la récupération de compte.', { recovery: RECOVERY_PATH });
    }
    for (const guard of this.hooks.duplicateGuards) guard({ phone, fullName: input.fullName, kind: 'PERSONNE_PHYSIQUE' });
    const taxpayer = this.taxpayers.insert({
      id: this.ids.next('TP'), iuc: this.newIuc(), fullName: input.fullName.trim(), phone, language: input.language,
      situation: input.situation, verificationLevel: 'N0A', createdAt: this.clock.now().toISOString(), prefs: {},
      kind: 'PERSONNE_PHYSIQUE', assisted: true,
    });
    this.audit.append({
      actor, action: 'account.assisted_enrolment.created', resourceType: 'taxpayer', resourceId: taxpayer.id,
      details: { language: taxpayer.language, withPhone: phone !== '' },
    });
    if (phone !== '') this.comms.publish('account.registration.received', [taxpayerRecipient(taxpayer)], {}, { entity: 'GOUVERNORAT' });
    return taxpayer;
  }

  /** Téléphone vérifié par code à usage unique. */
  markPhoneVerified(id: string): Taxpayer {
    const t = this.get(id);
    const updated = this.taxpayers.update({ ...t, phoneVerifiedAt: this.clock.now().toISOString() });
    // Compte unique : les fiches parallèles portant exactement ce numéro vérifié sont rattachées (jamais sur le nom).
    this.runAfter(this.hooks.phoneVerified, (fn) => fn(updated));
    return updated;
  }

  /** Changement de niveau de vérification, toujours journalisé et notifié au titulaire (§ 9.2, H.4.1). */
  setVerificationLevel(id: string, level: VerificationLevel, actor: AuditActor, reason: string): Taxpayer {
    const t = this.get(id);
    if (t.verificationLevel === level) return t;
    const updated = this.taxpayers.update({ ...t, verificationLevel: level });
    this.audit.append({
      actor, action: 'account.verification.level_changed', resourceType: 'taxpayer', resourceId: id,
      details: { from: t.verificationLevel, to: level, reason },
    });
    this.comms.publish('account.verification.level_upgraded', [taxpayerRecipient(updated)], {}, { entity: 'GOUVERNORAT' });
    return updated;
  }

  /** Provenance d'un compte repris par import (jamais d'écrasement : la première provenance est conservée). */
  setImportedFrom(id: string, importedFrom: NonNullable<Taxpayer['importedFrom']>): Taxpayer {
    const t = this.get(id);
    return t.importedFrom ? t : this.taxpayers.update({ ...t, importedFrom });
  }

  /** État de fusion (réversible) : `mergedInto` null ⇒ compte rétabli. */
  setMergeState(id: string, mergedInto: string | null): Taxpayer {
    const t = this.get(id);
    const { mergedInto: _prev, ...rest } = t;
    return this.taxpayers.update(mergedInto ? { ...rest, status: 'FUSIONNE', mergedInto } : { ...rest, status: 'ACTIF' });
  }

  /**
   * Récupération contrôlée (§ 9.3) : changement du téléphone de connexion décidé en double validation par l'appelant.
   * L'ancien numéro n'est jamais réattribué sans trace ; journalisé et notifié (ancien et nouveau contact).
   */
  changePhone(id: string, phoneRaw: string, actor: AuditActor, reason: string): Taxpayer {
    const t = this.get(id);
    const phone = phoneRaw.replace(/[\s-]/g, '');
    if (phone && this.taxpayers.findOne((x) => x.id !== id && x.phone === phone)) {
      throw conflict('PHONE_ALREADY_REGISTERED', 'Ce numéro est déjà rattaché à un autre compte.');
    }
    const previous = t.phone;
    const { phoneVerifiedAt: _v, ...rest } = t;
    const updated = this.taxpayers.update({ ...rest, phone });
    this.audit.append({ actor, action: 'account.contact.changed', resourceType: 'taxpayer', resourceId: id, details: { channel: 'TELEPHONE', reason, previousMasked: previous ? maskPhone(previous) : null, newMasked: maskPhone(phone) } });
    if (previous) this.comms.publish('account.contact.changed', [taxpayerRecipient(t)], {}, { entity: 'GOUVERNORAT' });
    this.comms.publish('account.contact.changed', [taxpayerRecipient(updated)], {}, { entity: 'GOUVERNORAT' });
    return updated;
  }

  get(id: string): Taxpayer {
    const t = this.taxpayers.get(id);
    if (!t) throw notFound('TAXPAYER_NOT_FOUND', `Contribuable inconnu : ${id}`);
    return t;
  }

  setPreferences(id: string, prefs: RecipientPrefs): Taxpayer {
    const t = this.get(id);
    return this.taxpayers.update({ ...t, prefs: { ...t.prefs, ...prefs } });
  }
}

/** Parcours de récupération de compte (demande, vérification au guichet, approbation par une seconde personne). */
export const RECOVERY_PATH = '/v1/public/enrolement/recuperations';

export function maskPhone(phone: string): string {
  return phone.length > 4 ? phone.slice(0, 4) + '•'.repeat(Math.max(0, phone.length - 6)) + phone.slice(-2) : '••••';
}
