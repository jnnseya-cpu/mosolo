/**
 * Moteur des canaux sans Internet : USSD (module 6) et SVI (module 64), mêmes parcours.
 * Menus numérotés courts ; consulter, payer (référence du circuit commun), vérifier une quittance, mes quittances,
 * points de paiement, carte perdue, langue. Aucune donnée sensible complète à l'écran (AC-INC-03) : ni nom, ni
 * historique détaillé ; montants seulement après code secret. Journal de session : la saisie du code est masquée.
 */
import { randomBytes } from 'node:crypto';
import { isLanguageCode, LANGUAGES, Money, type LanguageCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { hmacSha256Hex, randomSecret } from '../../core/crypto.js';
import { ApiError, conflict, notFound } from '../../core/errors.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import type { CardRegistry } from './cards.js';
import { normalizeCardNumber } from './cards.js';
import {
  MAX_PIN_ATTEMPTS, PIN_LOCK_MS, PILOT_COMMUNES, SESSION_TIMEOUT_MS, maskMsisdn,
  type ChannelOperation, type ChannelSession, type ScreenOut, type SessionChannel, type SessionJournalEntry,
} from './model.js';
import { issueOrReuseReference, type PaymentPointService } from './points.js';
import { moneyToFrenchWords } from './words.js';

export interface VerifyOutcome {
  kind: string;
  status: string;
  message: string;
  amount?: MoneyJSON;
  date?: string;
}

interface Opt {
  key: string;
  label: string;
  /** Formulation vocale : « Pour <voice>, tapez <key>. » */
  voice?: string;
}

interface Screen {
  node: string;
  title: string;
  lines?: string[];
  /** Phrases spécifiques au SVI (montants en toutes lettres, référence épelée). */
  voiceLines?: string[];
  options?: Opt[];
  end?: boolean;
  /** Saisie libre attendue (code, numéro) : consigne vocale. */
  inputHint?: string;
}

const ussdAmount = (m: MoneyJSON) => `${m.currency} ${m.amount}`;
const shortDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const spell = (s: string) => s.replace(/-/g, '').split('').join(' ');

const LANG_ORDER: LanguageCode[] = ['fr', 'ln', 'sw', 'kg', 'lua'];

const MAIN_OPTIONS: Opt[] = [
  { key: '1', label: 'Mon solde et obligations', voice: 'connaître vos obligations' },
  { key: '2', label: 'Payer', voice: 'obtenir une référence de paiement' },
  { key: '3', label: 'Vérifier un code', voice: 'vérifier un ticket, une place, une quittance ou un badge' },
  { key: '4', label: 'Mes quittances', voice: 'entendre vos dernières quittances' },
  { key: '5', label: 'Points de paiement', voice: 'connaître les points de paiement agréés' },
  { key: '6', label: 'Langue', voice: 'changer de langue' },
  { key: '7', label: 'Carte perdue / volée', voice: 'bloquer une carte perdue ou volée' },
  // Contester sans écrit (§ 13A.6), comme le promet l'avis à pictogrammes.
  { key: '8', label: 'Contester', voice: 'contester une obligation, sans écrit' },
];

/** Motifs de contestation par touche (types de réclamation du circuit commun). */
const CONTEST_REASONS: { key: string; type: 'MONTANT_ERRONE' | 'BIEN_NON_DETENU' | 'DOUBLE_IMPOSITION' | 'ACTIVITE_FERMEE' | 'AUTRE'; label: string }[] = [
  { key: '1', type: 'MONTANT_ERRONE', label: 'Montant erroné' },
  { key: '2', type: 'BIEN_NON_DETENU', label: 'Bien qui n’est pas à moi' },
  { key: '3', type: 'DOUBLE_IMPOSITION', label: 'Déjà payé / double imposition' },
  { key: '4', type: 'ACTIVITE_FERMEE', label: 'Activité fermée' },
  { key: '5', type: 'AUTRE', label: 'Autre motif' },
];
/** Inscription gratuite : proposée aux seuls numéros inconnus (module 2). */
const ENROL_OPTION: Opt = { key: '10', label: 'S’inscrire', voice: 'créer votre compte MOSOLO gratuitement' };
const BACK: Opt[] = [{ key: '9', label: 'Menu', voice: 'revenir au menu' }, { key: '0', label: 'Quitter', voice: 'quitter' }];

export class ChannelEngine {
  readonly sessions = new InMemoryRepository<ChannelSession>();
  readonly journal = new InMemoryAppendOnlyRepository<SessionJournalEntry>();
  private readonly ids = new IdGenerator();
  private readonly pepper = randomSecret();
  referencesIssued = 0;
  /**
   * Numéro appelant des sessions d'abonnés INCONNUS, gardé en mémoire vive le temps de la session seulement (jamais
   * dans le journal ni dans le dépôt des sessions) : il sert uniquement à l'inscription gratuite par USSD / SVI
   * (module 2 — démarrer un parcours selon le canal ; le numéro est attesté par le réseau de l'opérateur).
   */
  private readonly appelants = new Map<string, string>();
  enrolmentsCreated = 0;
  private readonly noms = new Map<string, string>();

  constructor(
    private readonly ctx: AppContext,
    private readonly cards: CardRegistry,
    private readonly points: PaymentPointService,
    private readonly verifyCode: (code: string, key: string, channel: string) => VerifyOutcome,
  ) {}

  // ---------- Cycle de session ----------

  start(channel: SessionChannel, msisdnRaw: string, lang?: string): ScreenOut {
    const msisdn = msisdnRaw.replace(/[\s-]/g, '');
    const now = this.ctx.clock.now().toISOString();
    // Compte unique : un même numéro sert toujours le même compte (compte fusionné ⇒ compte conservé).
    const tp = this.ctx.taxpayers.findByPhone(msisdn);
    // Identifiant aléatoire non devinable (128 bits) : la route de saisie n'est pas authentifiée, l'identifiant de
    // session est le seul lien avec l'appelant — un numéro séquentiel permettrait de reprendre la session d'autrui.
    const session = this.sessions.insert({
      id: `${channel === 'USSD' ? 'USSD' : 'SVI'}-${randomBytes(16).toString('base64url')}`, channel, msisdnHash: hmacSha256Hex(this.pepper, msisdn).slice(0, 32),
      msisdnMasked: maskMsisdn(msisdn), lang: lang && isLanguageCode(lang) ? lang : (tp?.language ?? 'fr'), node: 'MAIN', data: {},
      ...(tp ? { taxpayerId: tp.id } : {}), authenticated: false, status: 'ACTIVE', startedAt: now, lastActivityAt: now, steps: 0,
    });
    this.ctx.audit.append({
      actor: { kind: 'public', id: `canal-${channel.toLowerCase()}` }, action: 'canaux.session.started', resourceType: 'channel_session', resourceId: session.id,
      details: { channel, msisdnMasked: session.msisdnMasked, knownSubscriber: !!tp },
    });
    if (!tp && msisdn) this.appelants.set(session.id, msisdn);
    return this.emit(session, null, this.mainMenu(true, !tp));
  }

  input(channel: SessionChannel, sessionId: string, rawInput: string): ScreenOut {
    const s = this.sessions.get(sessionId);
    if (!s || s.channel !== channel) throw notFound('SESSION_NOT_FOUND', 'Session inconnue.');
    if (s.status !== 'ACTIVE') throw conflict('SESSION_CLOSED', 'Session terminée : recomposez le code.');
    const now = this.ctx.clock.now();
    if (now.getTime() - new Date(s.lastActivityAt).getTime() > SESSION_TIMEOUT_MS) {
      this.sessions.update({ ...s, status: 'EXPIREE', endedAt: now.toISOString() });
      throw conflict('SESSION_EXPIRED', 'Session expirée après inactivité : recomposez le code.');
    }
    const input = rawInput.trim().slice(0, 40);
    const masked = s.node === 'PIN' ? '••••' : s.node === 'ENROL_NAME' ? '[nom saisi]' : input;
    let screen: Screen;
    try {
      screen = this.route(s, input);
    } catch (e) {
      if (e instanceof ApiError) screen = { node: 'ERROR', title: `Opération impossible : ${e.message}`.slice(0, 150), options: BACK };
      else throw e;
    }
    return this.emit(this.sessions.get(s.id)!, masked, screen);
  }

  private emit(s: ChannelSession, input: string | null, screen: Screen): ScreenOut {
    const now = this.ctx.clock.now().toISOString();
    const options = screen.options ?? [];
    const text = this.clip([screen.title, ...(screen.lines ?? []), ...options.map((o) => `${o.key}. ${o.label}`)].join('\n'));
    const prompts = [screen.title, ...(screen.voiceLines ?? screen.lines ?? []), ...(screen.inputHint ? [screen.inputHint] : []), ...options.map((o) => `Pour ${o.voice ?? o.label.toLowerCase()}, tapez ${o.key}.`)];
    const updated = this.sessions.update({
      ...s, node: screen.node, lastActivityAt: now, steps: s.steps + 1,
      ...(screen.end ? { status: 'TERMINEE' as const, endedAt: now } : {}),
    });
    this.journal.append({
      id: this.ids.next('JRN', 8), sessionId: s.id, channel: s.channel, seq: updated.steps, at: now, node: screen.node, input,
      output: s.channel === 'USSD' ? text : prompts.join(' | '), end: !!screen.end,
    });
    if (screen.end) {
      this.appelants.delete(s.id);
      this.ctx.audit.append({ actor: { kind: 'public', id: `canal-${s.channel.toLowerCase()}` }, action: 'canaux.session.ended', resourceType: 'channel_session', resourceId: s.id, details: { steps: updated.steps, lastNode: screen.node } });
    }
    return {
      sessionId: s.id, channel: s.channel, lang: updated.lang, text, prompts, options: options.map(({ key, label }) => ({ key, label })),
      end: !!screen.end, translationPending: updated.lang !== 'fr',
    };
  }

  /** Un écran USSD tient en 182 caractères. */
  private clip(t: string): string {
    return t.length <= 182 ? t : `${t.slice(0, 180)}…`;
  }

  // ---------- Écrans ----------

  private mainMenu(welcome = false, inscription = false): Screen {
    return {
      // Écran de 182 caractères : titre court lorsque l'inscription s'ajoute au menu.
      node: 'MAIN', title: inscription ? 'MOSOLO' : welcome ? 'MOSOLO - service gratuit' : 'MOSOLO - menu',
      options: [...MAIN_OPTIONS, ...(inscription ? [ENROL_OPTION] : []), { key: '0', label: 'Quitter', voice: 'quitter' }],
      ...(welcome ? { voiceLines: ['Bienvenue sur MOSOLO, service gratuit de la Ville de Kinshasa. Aucun agent ne vous demandera d’espèces.'] } : {}),
    };
  }

  private goodbye(): Screen {
    return { node: 'FIN', title: 'Merci. MOSOLO est gratuit. Aucun agent ne vous demandera d’espèces.', end: true };
  }

  private route(s: ChannelSession, input: string): Screen {
    if (input === '0' && !['PIN', 'ID_CARD', 'VERIFY_INPUT', 'ENROL_NAME'].includes(s.node)) return this.goodbye();
    if (input === '9' && !['PIN', 'ID_CARD', 'VERIFY_INPUT', 'ENROL_NAME'].includes(s.node)) return this.mainMenu(false, this.appelants.has(s.id));
    switch (s.node) {
      case 'MAIN':
      case 'ERROR':
        return this.onMain(s, input);
      case 'BALANCE':
        return input === '2' ? this.requireAuth(s, 'PAY') : this.invalid(this.mainMenu());
      case 'ID_CARD':
        return this.onCard(s, input);
      case 'PIN':
        return this.onPin(s, input);
      case 'PAY_SELECT':
        return this.onPaySelect(s, input);
      case 'PAY_CONFIRM':
        return this.onPayConfirm(s, input);
      case 'VERIFY_INPUT':
        return this.onVerify(s, input);
      case 'POINTS_COMMUNE':
        this.op(s, 'POINTS');
        return this.onPointsCommune(input);
      case 'LANG':
        return this.onLang(s, input);
      case 'CARD_LOST_CONFIRM':
        return this.onCardLost(s, input);
      case 'CONTEST_SELECT':
        return this.onContestSelect(s, input);
      case 'CONTEST_REASON':
        return this.onContestReason(s, input);
      case 'CONTEST_CONFIRM':
        return this.onContestConfirm(s, input);
      case 'ENROL_NAME':
        return this.onEnrolName(s, input);
      case 'ENROL_CONFIRM':
        return this.onEnrolConfirm(s, input);
      default:
        return this.mainMenu();
    }
  }

  /** Consigne une opération réalisée dans la session (indicateur « opérations réalisées à la voix », module 64). */
  private op(s: ChannelSession, kind: ChannelOperation): void {
    const cur = this.sessions.get(s.id);
    if (cur) this.sessions.update({ ...cur, operations: [...(cur.operations ?? []), kind] });
  }

  private invalid(screen: Screen): Screen {
    return { ...screen, title: `Choix invalide. ${screen.title}` };
  }

  private onMain(s: ChannelSession, input: string): Screen {
    switch (input) {
      case '1':
        return this.requireAuth(s, 'BALANCE');
      case '2':
        return this.requireAuth(s, 'PAY');
      case '3':
        return { node: 'VERIFY_INPUT', title: 'Saisissez le code (ticket, place, quittance, reçu, badge)', inputHint: 'Saisissez le code sur votre clavier, puis validez.' };
      case '4':
        return this.requireAuth(s, 'RECEIPTS');
      case '5':
        return { node: 'POINTS_COMMUNE', title: 'Choisissez la commune', options: [...PILOT_COMMUNES.map((c, i) => ({ key: String(i + 1), label: c, voice: `la commune de ${c}` })), ...BACK] };
      case '6':
        return { node: 'LANG', title: 'Langue / Lokota', options: LANG_ORDER.map((l, i) => ({ key: String(i + 1), label: LANGUAGES[l].nativeName, voice: LANGUAGES[l].name })) };
      case '7':
        return this.requireAuth(s, 'CARD_LOST');
      case '8':
        return this.requireAuth(s, 'CONTEST');
      case ENROL_OPTION.key:
        if (!this.appelants.has(s.id)) return { node: 'MAIN', title: 'Ce numéro a déjà un compte MOSOLO.', options: BACK };
        return { node: 'ENROL_NAME', title: 'Inscription gratuite. Saisissez votre nom complet', inputHint: 'Saisissez votre nom complet sur le clavier, puis validez.' };
      default:
        return this.invalid(this.mainMenu(false, this.appelants.has(s.id)));
    }
  }

  // ---------- Inscription gratuite (module 2 : parcours démarré par USSD ou SVI) ----------

  private onEnrolName(s: ChannelSession, input: string): Screen {
    const name = input.replace(/\s+/g, ' ').trim();
    if (name.length < 3 || /\d/.test(name)) return { node: 'ENROL_NAME', title: 'Nom illisible. Saisissez votre nom complet (lettres)', inputHint: 'Saisissez votre nom complet, en lettres.' };
    // Le nom n'est pas une donnée de navigation : il reste en mémoire vive le temps de la confirmation.
    this.noms.set(s.id, name);
    return {
      node: 'ENROL_CONFIRM', title: `Créer votre compte MOSOLO gratuit pour le ${s.msisdnMasked} ?`,
      lines: ['Déclarer un profil ne crée ni dette ni propriété.'],
      options: [{ key: '1', label: 'Oui, créer', voice: 'confirmer la création de votre compte' }, { key: '2', label: 'Non', voice: 'annuler' }],
    };
  }

  private onEnrolConfirm(s: ChannelSession, input: string): Screen {
    const msisdn = this.appelants.get(s.id);
    const name = this.noms.get(s.id);
    if (input === '2' || !msisdn || !name) { this.noms.delete(s.id); return this.mainMenu(false, !!msisdn); }
    if (input !== '1') return this.invalid({ node: 'ENROL_CONFIRM', title: 'Tapez 1 pour créer, 2 pour annuler', options: [{ key: '1', label: 'Oui' }, { key: '2', label: 'Non' }] });
    const tp = this.ctx.taxpayers.register({ phone: msisdn, fullName: name, language: s.lang, situation: 'other', kind: 'PERSONNE_PHYSIQUE' });
    // Numéro attesté par le réseau de l'opérateur (session ouverte depuis ce numéro) : téléphone vérifié (N0).
    this.ctx.taxpayers.markPhoneVerified(tp.id);
    this.appelants.delete(s.id);
    this.noms.delete(s.id);
    this.enrolmentsCreated += 1;
    // Récapitulatif d'enrôlement par SMS (et dans l'espace) : identifiant du compte, sans lien (module 2).
    this.ctx.comms.publish('account.registration.requested', [taxpayerRecipient(this.ctx.taxpayers.get(tp.id))], { reference: tp.iuc }, { entity: 'GOUVERNORAT' });
    this.sessions.update({ ...this.sessions.get(s.id)!, taxpayerId: tp.id });
    this.ctx.audit.append({
      actor: { kind: 'public', id: `canal-${s.channel.toLowerCase()}` }, action: 'canaux.session.enrolled', resourceType: 'taxpayer', resourceId: tp.id,
      details: { sessionId: s.id, channel: s.channel, consent: 'CONFIRMATION_CLAVIER', level: 'N0' },
    });
    return {
      node: 'ENROL_DONE', end: true, title: `Compte créé. Identifiant ${tp.iuc}`,
      lines: ['Récapitulatif envoyé par SMS. Code secret et carte : guichet MOSOLO, gratuit.'],
      voiceLines: [`Votre compte est créé. Votre identifiant est ${spell(tp.iuc)}. Un récapitulatif vous est envoyé par SMS. L’inscription est gratuite.`],
    };
  }

  private requireAuth(s: ChannelSession, intent: string): Screen {
    if (s.authenticated) return this.goIntent(s, intent);
    this.sessions.update({ ...s, pendingIntent: intent });
    if (s.taxpayerId) return { node: 'PIN', title: 'Saisissez votre code secret (4 chiffres)', inputHint: 'Saisissez votre code secret à quatre chiffres.' };
    return { node: 'ID_CARD', title: 'Saisissez le numéro de votre carte MOSOLO (12 chiffres) ou le numéro de votre objet', inputHint: 'Saisissez les douze chiffres de votre carte MOSOLO, ou le numéro de votre objet.' };
  }

  /**
   * Objet désigné par son numéro (module 64 : « consultation par numéro de carte ou d'objet ») : identifiant de l'objet
   * ou code IGF, saisis au clavier (lettres et séparateurs ignorés à la comparaison). Divulgation minimale : le code
   * secret du titulaire reste exigé avant toute lecture.
   */
  private objectByNumber(input: string): { id: string; taxpayerId: string } | undefined {
    const key = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (key.length < 4) return undefined;
    const digits = key.replace(/[^0-9]/g, '');
    const o = this.ctx.objects.objects.findOne((x) => {
      if (!x.taxpayerId) return false;
      const id = x.id.toUpperCase().replace(/[^0-9A-Z]/g, '');
      const igf = (x.igf?.code ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
      return id === key || (!!igf && igf === key) || (/^\d{6,}$/.test(key) && !!igf && igf.replace(/[^0-9]/g, '') === digits);
    });
    return o?.taxpayerId ? { id: o.id, taxpayerId: o.taxpayerId } : undefined;
  }

  private onCard(s: ChannelSession, input: string): Screen {
    const n = normalizeCardNumber(input);
    const card = n ? this.cards.byNumber(n) : undefined;
    if (!card) {
      const obj = this.objectByNumber(input);
      if (obj && s.pendingIntent !== 'CARD_LOST') {
        this.sessions.update({ ...s, taxpayerId: obj.taxpayerId, data: { ...s.data, objectId: obj.id } });
        return { node: 'PIN', title: 'Objet reconnu. Saisissez le code secret du titulaire (4 chiffres)', inputHint: 'Objet reconnu. Saisissez le code secret à quatre chiffres du titulaire.' };
      }
      return { node: 'ID_CARD', title: 'Numéro de carte ou d’objet incorrect. Saisissez à nouveau', inputHint: 'Numéro incorrect. Saisissez à nouveau les douze chiffres de la carte ou le numéro de l’objet.' };
    }
    if (card.status !== 'ACTIVE' && s.pendingIntent !== 'CARD_LOST') {
      return { node: 'FIN', title: card.status === 'REVOQUEE' ? 'Carte révoquée. Présentez-vous au guichet MOSOLO.' : 'Carte bloquée. Présentez-vous au guichet MOSOLO.', end: true };
    }
    this.sessions.update({ ...s, taxpayerId: card.taxpayerId, cardNumber: card.number });
    return { node: 'PIN', title: 'Saisissez votre code secret (4 chiffres)', inputHint: 'Saisissez votre code secret à quatre chiffres.' };
  }

  private onPin(s: ChannelSession, input: string): Screen {
    const tpId = s.taxpayerId!;
    const r = this.cards.checkPin(tpId, input, PIN_LOCK_MS, MAX_PIN_ATTEMPTS);
    if (r === 'ABSENT') return { node: 'FIN', title: 'Aucun code secret pour ce compte. Activez-le au guichet MOSOLO ou auprès d’un agent.', end: true };
    if (r === 'VERROUILLE') {
      this.ctx.alerts.raise({
        type: 'CHANNEL_PIN_LOCKED', severity: 'MEDIUM', source: `canaux:${s.channel.toLowerCase()}`,
        detail: `Code secret erroné ${MAX_PIN_ATTEMPTS} fois (${s.msisdnMasked}) : canal verrouillé 15 minutes pour ce compte.`,
        context: { sessionId: s.id, taxpayerId: tpId },
      });
      return { node: 'FIN', title: 'Accès bloqué 15 minutes après plusieurs codes erronés.', end: true };
    }
    if (r === 'FAUX') return { node: 'PIN', title: 'Code incorrect. Saisissez votre code secret', inputHint: 'Code incorrect. Saisissez à nouveau votre code secret.' };
    const authed = this.sessions.update({ ...s, authenticated: true });
    this.ctx.audit.append({ actor: { kind: 'public', id: `canal-${s.channel.toLowerCase()}` }, action: 'canaux.session.authenticated', resourceType: 'channel_session', resourceId: s.id, details: { taxpayerId: tpId } });
    return this.goIntent(authed, s.pendingIntent ?? 'BALANCE');
  }

  private goIntent(s: ChannelSession, intent: string): Screen {
    const tpId = s.taxpayerId!;
    if (intent === 'BALANCE') {
      this.op(s, 'CONSULTATION');
      // Consultation par numéro d'objet : les seules obligations de cet objet.
      const objectId = s.data.objectId;
      const dues = this.points.payableObligations(tpId).filter((d) => !objectId || this.ctx.assessment.obligations.get(d.obligationId)?.objectId === objectId);
      if (dues.length === 0) return { node: 'BALANCE', title: 'Aucune somme à payer à ce jour.', options: BACK };
      const totals = new Map<string, Money>();
      for (const d of dues) {
        const cur = totals.get(d.amount.currency);
        totals.set(d.amount.currency, cur ? cur.add(Money.fromJSON(d.amount)) : Money.fromJSON(d.amount));
      }
      const sums = [...totals.values()].map((m) => m.toJSON());
      const next = dues.map((d) => d.dueDate).sort()[0]!;
      return {
        node: 'BALANCE', title: `${dues.length} obligation(s) à payer`,
        lines: [`Total : ${sums.map(ussdAmount).join(' + ')}`, `Prochaine échéance : ${shortDate(next)}`],
        voiceLines: [`Vous avez ${dues.length} obligation${dues.length > 1 ? 's' : ''} à payer, pour un total de ${sums.map(moneyToFrenchWords).join(' et ')}.`, `Prochaine échéance le ${shortDate(next)}.`],
        options: [{ key: '2', label: 'Payer', voice: 'payer' }, ...BACK],
      };
    }
    if (intent === 'PAY') {
      const objectId = s.data.objectId;
      const dues = this.points.payableObligations(tpId).filter((d) => !objectId || this.ctx.assessment.obligations.get(d.obligationId)?.objectId === objectId).slice(0, 3);
      if (dues.length === 0) return { node: 'BALANCE', title: 'Aucune somme à payer à ce jour.', options: BACK };
      const data: Record<string, string> = {};
      dues.forEach((d, i) => { data[`o${i + 1}`] = d.obligationId; });
      this.sessions.update({ ...this.sessions.get(s.id)!, data });
      return {
        node: 'PAY_SELECT', title: 'Choisissez l’obligation à payer',
        options: [...dues.map((d, i) => ({ key: String(i + 1), label: `${d.revenue} ${ussdAmount(d.amount)}`, voice: `payer ${moneyToFrenchWords(d.amount)}` })), ...BACK],
      };
    }
    if (intent === 'RECEIPTS') {
      this.op(s, 'QUITTANCES');
      const rs = this.ctx.receipts.byTaxpayer(tpId).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)).slice(0, 3);
      if (rs.length === 0) return { node: 'RECEIPTS', title: 'Aucune quittance.', options: BACK };
      const label = (st: string) => (st === 'DEFINITIVE' ? 'VALIDE' : st === 'PROVISOIRE' ? 'EN ATTENTE' : st);
      return {
        node: 'RECEIPTS', title: 'Dernières quittances',
        lines: rs.map((r) => `…${r.code.slice(-6)} ${label(r.status)} ${ussdAmount(r.amount)}`),
        // Confirmation vocale (module 64) : montant, objet, période et numéro de quittance.
        voiceLines: rs.map((r) => {
          const ob = this.ctx.assessment.obligations.get(r.obligationId);
          const objet = ob ? `${ob.label}, objet ${spell(ob.objectId.slice(-6))}` : r.revenueCategory;
          const periode = ob ? `période du ${shortDate(ob.createdAt)} à l’échéance du ${shortDate(ob.dueDate)}` : '';
          return `Quittance numéro ${spell(r.number)}, ${label(r.status).toLowerCase()}, ${moneyToFrenchWords(r.amount)}, ${objet}${periode ? `, ${periode}` : ''}, payée le ${shortDate(r.paidAt)}. Code terminant par ${spell(r.code.slice(-6))}.`;
        }),
        options: BACK,
      };
    }
    if (intent === 'CONTEST') {
      const dues = this.points.payableObligations(tpId).slice(0, 3);
      if (dues.length === 0) return { node: 'BALANCE', title: 'Aucune obligation à contester. Au guichet MOSOLO, un agent peut aussi vous aider.', options: BACK };
      const data: Record<string, string> = {};
      dues.forEach((d, i) => { data[`c${i + 1}`] = d.obligationId; });
      this.sessions.update({ ...this.sessions.get(s.id)!, data });
      return {
        node: 'CONTEST_SELECT', title: 'Quelle obligation contestez-vous ?',
        voiceLines: ['Vous pouvez contester sans écrit. Votre contestation sera enregistrée à votre nom et instruite par un agent.'],
        options: [...dues.map((d, i) => ({ key: String(i + 1), label: `${d.revenue} ${ussdAmount(d.amount)}`, voice: `contester ${moneyToFrenchWords(d.amount)}, ${d.revenue}` })), ...BACK],
      };
    }
    if (intent === 'CARD_LOST') {
      const card = s.cardNumber ? this.cards.byNumber(s.cardNumber) : this.cards.activeFor(tpId);
      if (!card || card.status !== 'ACTIVE') return { node: 'BALANCE', title: 'Aucune carte active à bloquer.', options: BACK };
      this.sessions.update({ ...this.sessions.get(s.id)!, cardNumber: card.number });
      return { node: 'CARD_LOST_CONFIRM', title: `Bloquer la carte ••••${card.number.slice(-4)} ?`, options: [{ key: '1', label: 'Oui, bloquer', voice: 'confirmer le blocage' }, { key: '2', label: 'Non', voice: 'annuler' }] };
    }
    return this.mainMenu();
  }

  private onPaySelect(s: ChannelSession, input: string): Screen {
    const obligationId = s.data[`o${input}`];
    if (!obligationId) return this.invalid(this.goIntent(s, 'PAY'));
    // Montant annoncé = montant de l'ordre qui sera émis (solde restant ou référence active), jamais le total initial.
    const due = this.points.payableObligations(s.taxpayerId!).find((d) => d.obligationId === obligationId);
    if (!due) return { node: 'BALANCE', title: 'Cette obligation n’est plus à payer.', options: BACK };
    this.sessions.update({ ...s, data: { ...s.data, selected: obligationId } });
    return {
      node: 'PAY_CONFIRM', title: `Payer ${ussdAmount(due.amount)} (${due.revenue}) ?`,
      voiceLines: [`Vous allez obtenir une référence pour payer ${moneyToFrenchWords(due.amount)}.`],
      options: [{ key: '1', label: 'Confirmer', voice: 'confirmer' }, { key: '2', label: 'Annuler', voice: 'annuler' }],
    };
  }

  private onPayConfirm(s: ChannelSession, input: string): Screen {
    if (input === '2') return this.mainMenu();
    if (input !== '1' || !s.data.selected) return this.invalid(this.mainMenu());
    const order = issueOrReuseReference(this.ctx, s.taxpayerId!, s.data.selected, s.channel === 'USSD' ? 'USSD' : 'MOBILE_MONEY');
    this.referencesIssued += 1;
    this.op(s, 'REFERENCE');
    this.ctx.audit.append({
      actor: { kind: 'public', id: `canal-${s.channel.toLowerCase()}` }, action: 'canaux.session.reference_issued', resourceType: 'payment_order', resourceId: order.id,
      details: { sessionId: s.id, paymentReference: order.paymentReference },
    });
    return {
      node: 'PAY_DONE', end: true, title: `Référence ${order.paymentReference}`,
      lines: [`Montant ${ussdAmount(order.amount)}`, `Valable jusqu'au ${shortDate(order.expiresAt)}`, 'Payez par Mobile Money ou chez un point agréé. Aucun agent ne demande d’espèces.'],
      voiceLines: [
        `Votre référence de paiement est : ${spell(order.paymentReference)}. Je répète : ${spell(order.paymentReference)}.`,
        `Montant : ${moneyToFrenchWords(order.amount)}, valable jusqu’au ${shortDate(order.expiresAt)}.`,
        'Payez par monnaie mobile ou chez un point de paiement agréé. Aucun agent ne vous demandera d’espèces.',
      ],
    };
  }

  private onContestSelect(s: ChannelSession, input: string): Screen {
    const obligationId = s.data[`c${input}`];
    if (!obligationId) return this.invalid(this.goIntent(s, 'CONTEST'));
    this.sessions.update({ ...s, data: { ...s.data, contest: obligationId } });
    return { node: 'CONTEST_REASON', title: 'Motif de la contestation', options: [...CONTEST_REASONS.map((r) => ({ key: r.key, label: r.label, voice: r.label.toLowerCase() })), ...BACK] };
  }

  private onContestReason(s: ChannelSession, input: string): Screen {
    const r = CONTEST_REASONS.find((x) => x.key === input);
    if (!r || !s.data.contest) return this.invalid(this.mainMenu());
    this.sessions.update({ ...s, data: { ...s.data, contestType: r.type } });
    const summary = `Contestation de l’obligation se terminant par ${s.data.contest.slice(-6)} — motif : ${r.label.toLowerCase()}.`;
    return {
      node: 'CONTEST_CONFIRM', title: `Confirmer : ${r.label} ?`,
      lines: ['Enregistrée à votre nom, sans écrit. Un agent vous rappellera si besoin.'],
      voiceLines: [`Résumé : ${summary}`, 'Elle sera enregistrée à votre nom, sans écrit, et instruite par un agent. Aucun paiement n’est demandé.'],
      options: [{ key: '1', label: 'Confirmer', voice: 'confirmer la contestation' }, { key: '2', label: 'Annuler', voice: 'annuler' }],
    };
  }

  private onContestConfirm(s: ChannelSession, input: string): Screen {
    if (input === '2') return this.mainMenu();
    const type = CONTEST_REASONS.find((r) => r.type === s.data.contestType)?.type;
    if (input !== '1' || !s.data.contest || !type || !s.authenticated) return this.invalid(this.mainMenu());
    // Principal de canal : la session authentifiée par code secret vaut identification ; la touche vaut consentement.
    const principal = { kind: 'user' as const, id: `canal-${s.channel.toLowerCase()}:${s.id}`, name: `${s.channel} MOSOLO`, roles: [], entity: 'PUBLIC' };
    const appeal = this.ctx.appeals.submit(principal, {
      obligationId: s.data.contest, type,
      grounds: `Contestation sans écrit par ${s.channel} (${CONTEST_REASONS.find((r) => r.type === type)!.label}) — session ${s.id}, confirmée par touche après lecture du résumé.`,
    }, { channel: s.channel === 'USSD' ? 'USSD' : 'SVI', consent: { method: 'CONFIRMATION_CLAVIER', summaryReadBack: true, at: this.ctx.clock.now().toISOString(), sessionId: s.id } });
    this.ctx.audit.append({ actor: { kind: 'public', id: `canal-${s.channel.toLowerCase()}` }, action: 'canaux.session.appeal_submitted', resourceType: 'appeal', resourceId: appeal.id, details: { sessionId: s.id, obligationId: s.data.contest, type } });
    this.op(s, 'CONTESTATION');
    const ack = appeal.acknowledgement?.number ?? appeal.id;
    return {
      node: 'CONTEST_DONE', end: true, title: `Contestation enregistrée : ${ack}`,
      lines: ['Aucune mesure pendant l’instruction si l’effet suspensif est accordé. Suivi au guichet ou dans votre espace.'],
      voiceLines: [`Votre contestation est enregistrée. Numéro d’accusé : ${spell(ack)}.`, 'Un agent instruit votre dossier. Aucun paiement n’est demandé pour contester.'],
    };
  }

  private onVerify(s: ChannelSession, input: string): Screen {
    let out: VerifyOutcome;
    try {
      out = this.verifyCode(input, `msisdn:${s.msisdnHash}`, s.channel);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) return { node: 'VERIFY_RESULT', title: 'Trop de vérifications. Réessayez plus tard.', end: true };
      throw e;
    }
    this.op(s, 'VERIFICATION');
    const detail = out.amount ? [`${ussdAmount(out.amount)}${out.date ? ` du ${shortDate(out.date)}` : ''}`] : [];
    return {
      node: 'VERIFY_RESULT', title: `${out.status} : ${out.message}`, lines: detail,
      voiceLines: out.amount ? [`Montant : ${moneyToFrenchWords(out.amount)}${out.date ? `, du ${shortDate(out.date)}` : ''}.`] : [],
      options: BACK,
    };
  }

  private onPointsCommune(input: string): Screen {
    const commune = PILOT_COMMUNES[Number(input) - 1];
    if (!commune) return { node: 'POINTS_COMMUNE', title: 'Choix invalide. Choisissez la commune', options: [...PILOT_COMMUNES.map((c, i) => ({ key: String(i + 1), label: c })), ...BACK] };
    const pts = this.points.publicList(commune).filter((p) => p.status === 'ACTIF').slice(0, 3);
    if (pts.length === 0) return { node: 'POINTS_LIST', title: `Aucun point agréé actif à ${commune}.`, options: BACK };
    return {
      node: 'POINTS_LIST', title: `Points agréés ${commune}`,
      lines: pts.map((p) => `${p.name.slice(0, 34)} ${p.hours}`),
      voiceLines: pts.map((p) => `${p.name}, ${p.address}, ouvert ${p.hours}.`),
      options: BACK,
    };
  }

  private onLang(s: ChannelSession, input: string): Screen {
    const lang = LANG_ORDER[Number(input) - 1];
    if (!lang) return this.invalid(this.mainMenu());
    this.sessions.update({ ...s, lang });
    const screen = this.mainMenu();
    return lang === 'fr' ? screen : { ...screen, voiceLines: [`${LANGUAGES[lang].name} : messages vocaux en cours de validation par des relecteurs natifs ; suite en français.`] };
  }

  private onCardLost(s: ChannelSession, input: string): Screen {
    if (input !== '1' || !s.cardNumber) return this.mainMenu();
    this.cards.block({ kind: 'public', id: `canal-${s.channel.toLowerCase()}:${s.taxpayerId}` }, s.cardNumber, `Perte ou vol déclaré par ${s.channel}`);
    this.op(s, 'BLOCAGE_CARTE');
    return { node: 'FIN', title: 'Carte bloquée. Réémission gratuite au guichet MOSOLO.', end: true };
  }

  // ---------- Consultation ----------

  sessionView(s: ChannelSession) {
    const { msisdnHash: _h, data: _d, ...rest } = s;
    return { ...rest, journal: this.journal.find((j) => j.sessionId === s.id) };
  }
}

