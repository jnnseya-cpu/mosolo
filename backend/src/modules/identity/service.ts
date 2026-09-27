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
};

export { RESIDENTIAL_SITUATIONS };

export class TaxpayerService {
  readonly taxpayers = new InMemoryRepository<Taxpayer>();
  private readonly ids = new IdGenerator();

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
      throw conflict('PHONE_ALREADY_REGISTERED', 'Ce numéro est déjà rattaché à un compte. Utilisez la récupération de compte.');
    }
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
    return taxpayer;
  }

  /**
   * Enrôlement assisté (N0-A, § 9.2 et § 13A) : compte créé par un agent habilité ou un guichet, téléphone facultatif.
   * Aucun paiement n'est demandé ni reçu par l'agent.
   */
  registerAssisted(input: { fullName: string; language: LanguageCode; situation: ResidentialSituation; phone?: string }, actor: AuditActor): Taxpayer {
    const phone = (input.phone ?? '').replace(/[\s-]/g, '');
    if (phone !== '' && this.taxpayers.findOne((t) => t.phone === phone)) {
      throw conflict('PHONE_ALREADY_REGISTERED', 'Ce numéro est déjà rattaché à un compte. Utilisez la récupération de compte.');
    }
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
    return this.taxpayers.update({ ...t, phoneVerifiedAt: this.clock.now().toISOString() });
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

export function maskPhone(phone: string): string {
  return phone.length > 4 ? phone.slice(0, 4) + '•'.repeat(Math.max(0, phone.length - 6)) + phone.slice(-2) : '••••';
}
