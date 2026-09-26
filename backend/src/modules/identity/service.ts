/** Identité des contribuables (ch. 9) : inscription, identifiant unique du contribuable (IUC), préférences. */
import { RESIDENTIAL_SITUATIONS, type LanguageCode, type ResidentialSituation, type VerificationLevel } from '@mosolo/shared';
import type { AuditLog } from '../../core/audit.js';
import type { Clock } from '../../core/clock.js';
import { checkChar, randomCode } from '../../core/crypto.js';
import { conflict, notFound } from '../../core/errors.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { CommunicationService, RecipientPrefs } from '../communications/service.js';
import { taxpayerRecipient } from './recipients.js';

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
}

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

  register(input: { phone: string; fullName: string; language: LanguageCode; situation: ResidentialSituation; email?: string }, fixedId?: string): Taxpayer {
    const phone = input.phone.replace(/[\s-]/g, '');
    if (this.taxpayers.findOne((t) => t.phone === phone)) {
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
