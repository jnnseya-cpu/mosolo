/**
 * Moteur des canaux sans Internet : USSD (module 6) et SVI (module 64), mêmes parcours.
 * Menus numérotés courts ; consulter, payer (référence du circuit commun), vérifier une quittance, mes quittances,
 * points de paiement, carte perdue, langue. Aucune donnée sensible complète à l'écran (AC-INC-03) : ni nom, ni
 * historique détaillé ; montants seulement après code secret. Journal de session : la saisie du code est masquée.
 */
import { isLanguageCode, LANGUAGES, Money, type LanguageCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { hmacSha256Hex, randomSecret } from '../../core/crypto.js';
import { ApiError, conflict, notFound } from '../../core/errors.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import type { CardRegistry } from './cards.js';
import { normalizeCardNumber } from './cards.js';
import {
  MAX_PIN_ATTEMPTS, PIN_LOCK_MS, PILOT_COMMUNES, SESSION_TIMEOUT_MS, maskMsisdn,
  type ChannelSession, type ScreenOut, type SessionChannel, type SessionJournalEntry,
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
  { key: '3', label: 'Vérifier une quittance', voice: 'vérifier une quittance' },
  { key: '4', label: 'Mes quittances', voice: 'entendre vos dernières quittances' },
  { key: '5', label: 'Points de paiement', voice: 'connaître les points de paiement agréés' },
  { key: '6', label: 'Langue', voice: 'changer de langue' },
  { key: '7', label: 'Carte perdue / volée', voice: 'bloquer une carte perdue ou volée' },
];
const BACK: Opt[] = [{ key: '9', label: 'Menu', voice: 'revenir au menu' }, { key: '0', label: 'Quitter', voice: 'quitter' }];

export class ChannelEngine {
  readonly sessions = new InMemoryRepository<ChannelSession>();
  readonly journal = new InMemoryAppendOnlyRepository<SessionJournalEntry>();
  private readonly ids = new IdGenerator();
  private readonly pepper = randomSecret();
  referencesIssued = 0;

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
    const tp = this.ctx.taxpayers.taxpayers.findOne((t) => t.phone === msisdn);
    const session = this.sessions.insert({
      id: this.ids.next(channel === 'USSD' ? 'USSD' : 'SVI', 8), channel, msisdnHash: hmacSha256Hex(this.pepper, msisdn).slice(0, 32),
      msisdnMasked: maskMsisdn(msisdn), lang: lang && isLanguageCode(lang) ? lang : (tp?.language ?? 'fr'), node: 'MAIN', data: {},
      ...(tp ? { taxpayerId: tp.id } : {}), authenticated: false, status: 'ACTIVE', startedAt: now, lastActivityAt: now, steps: 0,
    });
    this.ctx.audit.append({
      actor: { kind: 'public', id: `canal-${channel.toLowerCase()}` }, action: 'canaux.session.started', resourceType: 'channel_session', resourceId: session.id,
      details: { channel, msisdnMasked: session.msisdnMasked, knownSubscriber: !!tp },
    });
    return this.emit(session, null, this.mainMenu(true));
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
    const masked = s.node === 'PIN' ? '••••' : input;
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

  private mainMenu(welcome = false): Screen {
    return {
      node: 'MAIN', title: welcome ? 'MOSOLO - service gratuit' : 'MOSOLO - menu', options: [...MAIN_OPTIONS, { key: '0', label: 'Quitter', voice: 'quitter' }],
      ...(welcome ? { voiceLines: ['Bienvenue sur MOSOLO, service gratuit de la Ville de Kinshasa. Aucun agent ne vous demandera d’espèces.'] } : {}),
    };
  }

  private goodbye(): Screen {
    return { node: 'FIN', title: 'Merci. MOSOLO est gratuit. Aucun agent ne vous demandera d’espèces.', end: true };
  }

  private route(s: ChannelSession, input: string): Screen {
    if (input === '0' && !['PIN', 'ID_CARD', 'VERIFY_INPUT'].includes(s.node)) return this.goodbye();
    if (input === '9' && !['PIN', 'ID_CARD', 'VERIFY_INPUT'].includes(s.node)) return this.mainMenu();
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
        return this.onPointsCommune(input);
      case 'LANG':
        return this.onLang(s, input);
      case 'CARD_LOST_CONFIRM':
        return this.onCardLost(s, input);
      default:
        return this.mainMenu();
    }
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
        return { node: 'VERIFY_INPUT', title: 'Saisissez le code de la quittance ou le code court du reçu', inputHint: 'Saisissez le code sur votre clavier, puis validez.' };
      case '4':
        return this.requireAuth(s, 'RECEIPTS');
      case '5':
        return { node: 'POINTS_COMMUNE', title: 'Choisissez la commune', options: [...PILOT_COMMUNES.map((c, i) => ({ key: String(i + 1), label: c, voice: `la commune de ${c}` })), ...BACK] };
      case '6':
        return { node: 'LANG', title: 'Langue / Lokota', options: LANG_ORDER.map((l, i) => ({ key: String(i + 1), label: LANGUAGES[l].nativeName, voice: LANGUAGES[l].name })) };
      case '7':
        return this.requireAuth(s, 'CARD_LOST');
      default:
        return this.invalid(this.mainMenu());
    }
  }

  private requireAuth(s: ChannelSession, intent: string): Screen {
    if (s.authenticated) return this.goIntent(s, intent);
    this.sessions.update({ ...s, pendingIntent: intent });
    if (s.taxpayerId) return { node: 'PIN', title: 'Saisissez votre code secret (4 chiffres)', inputHint: 'Saisissez votre code secret à quatre chiffres.' };
    return { node: 'ID_CARD', title: 'Saisissez le numéro de votre carte MOSOLO (12 chiffres)', inputHint: 'Saisissez les douze chiffres de votre carte MOSOLO.' };
  }

  private onCard(s: ChannelSession, input: string): Screen {
    const n = normalizeCardNumber(input);
    const card = n ? this.cards.byNumber(n) : undefined;
    if (!card) return { node: 'ID_CARD', title: 'Numéro de carte incorrect. Saisissez à nouveau les 12 chiffres', inputHint: 'Numéro incorrect. Saisissez à nouveau les douze chiffres.' };
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
      const dues = this.points.payableObligations(tpId);
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
      const dues = this.points.payableObligations(tpId).slice(0, 3);
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
      const rs = this.ctx.receipts.byTaxpayer(tpId).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)).slice(0, 3);
      if (rs.length === 0) return { node: 'RECEIPTS', title: 'Aucune quittance.', options: BACK };
      const label = (st: string) => (st === 'DEFINITIVE' ? 'VALIDE' : st === 'PROVISOIRE' ? 'EN ATTENTE' : st);
      return {
        node: 'RECEIPTS', title: 'Dernières quittances',
        lines: rs.map((r) => `…${r.code.slice(-6)} ${label(r.status)} ${ussdAmount(r.amount)}`),
        voiceLines: rs.map((r) => `Quittance terminant par ${spell(r.code.slice(-6))}, ${label(r.status).toLowerCase()}, ${moneyToFrenchWords(r.amount)}, du ${shortDate(r.paidAt)}.`),
        options: BACK,
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
    const o = this.ctx.assessment.get(obligationId);
    this.sessions.update({ ...s, data: { ...s.data, selected: obligationId } });
    return {
      node: 'PAY_CONFIRM', title: `Payer ${ussdAmount(o.amount)} (${o.ruleCode}) ?`,
      voiceLines: [`Vous allez obtenir une référence pour payer ${moneyToFrenchWords(o.amount)}.`],
      options: [{ key: '1', label: 'Confirmer', voice: 'confirmer' }, { key: '2', label: 'Annuler', voice: 'annuler' }],
    };
  }

  private onPayConfirm(s: ChannelSession, input: string): Screen {
    if (input === '2') return this.mainMenu();
    if (input !== '1' || !s.data.selected) return this.invalid(this.mainMenu());
    const order = issueOrReuseReference(this.ctx, s.taxpayerId!, s.data.selected, s.channel === 'USSD' ? 'USSD' : 'MOBILE_MONEY');
    this.referencesIssued += 1;
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

  private onVerify(s: ChannelSession, input: string): Screen {
    let out: VerifyOutcome;
    try {
      out = this.verifyCode(input, `msisdn:${s.msisdnHash}`, s.channel);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) return { node: 'VERIFY_RESULT', title: 'Trop de vérifications. Réessayez plus tard.', end: true };
      throw e;
    }
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
    return { node: 'FIN', title: 'Carte bloquée. Réémission gratuite au guichet MOSOLO.', end: true };
  }

  // ---------- Consultation ----------

  sessionView(s: ChannelSession) {
    const { msisdnHash: _h, data: _d, ...rest } = s;
    return { ...rest, journal: this.journal.find((j) => j.sessionId === s.id) };
  }
}

