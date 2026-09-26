/**
 * Assistant WhatsApp officiel (§ 11.4.4, § H.14 « Assistant WhatsApp », ARB-64) — pour les habitants qui ont WhatsApp
 * mais pas l'application MOSOLO :
 * - consentement préalable EXPLICITE (réponse « OUI »), retirable à tout moment (« STOP ») ; rien n'est envoyé avant ;
 * - vérifier n'importe quelle preuve par son code (ticket, place, pass, certificat, quittance, badge…) ;
 * - trouver un point de paiement agréé ; savoir comment payer : **renvoi vers l'USSD officiel ou l'application,
 *   jamais de lien de paiement** (anti-hameçonnage) ; **aucun montant nominatif**, aucun avis obligatoire ;
 * - rappels non nominatifs (« vous avez N échéance(s) ») sur consentement ; signalement d'un faux agent.
 * Français et lingala (textes lingala à faire valider par la cellule linguistique avant production).
 */
import type { AppContext } from '../../context.js';
import { InMemoryRepository } from '../../core/repository.js';
import { ext } from '../types.js';
import type { CanauxService } from '../canaux/service.js';
import { PILOT_COMMUNES, USSD_CODE_LABEL } from '../canaux/model.js';
import type { IntegriteService } from '../integrite/service.js';
import { PAYABLE_STATUSES } from '../../modules/assessment/service.js';
import type { PreuvesService, ProofResult } from './service.js';

export type WaLang = 'fr' | 'ln';
type Node = 'CONSENT' | 'MENU' | 'VERIFY' | 'POINTS' | 'REPORT' | 'LANG';

export interface WaConversation {
  id: string; // numéro WhatsApp (E.164)
  lang: WaLang;
  node: Node;
  consentAt?: string;
  withdrawnAt?: string;
  reminders: boolean;
  lastAt: string;
  messages: number;
}

const T: Record<WaLang, Record<string, string>> = {
  fr: {
    hello: 'Bonjour, ceci est l’assistant OFFICIEL de la Ville de Kinshasa — KINSHASA MOSOLO (compte certifié).',
    consent: 'Pour continuer, répondez OUI : vous acceptez de recevoir des messages MOSOLO sur WhatsApp (sans montant ni donnée sensible). Répondez STOP à tout moment pour arrêter.',
    consentOk: 'Merci, votre consentement est enregistré.',
    stop: 'C’est noté : vous ne recevrez plus de message MOSOLO sur WhatsApp. Écrivez OUI pour réactiver. Vous pouvez toujours utiliser l’USSD ou le guichet.',
    menu: 'Menu — répondez par un chiffre :\n1. Vérifier un ticket, une place, une quittance ou un badge\n2. Où payer (points agréés)\n3. Comment payer\n4. Rappels d’échéance : {rem}\n5. Signaler un faux agent ou une demande d’espèces\n6. Lokota / Langue\n0. Arrêter (STOP)',
    askCode: 'Envoyez le code imprimé sous le QR (ex. STAxxxxxxx, EVT-2026-00001-W, Q26…). Le résultat est calculé à l’heure du serveur.',
    askCommune: 'Choisissez la commune :',
    howPay: `Pour payer : composez ${USSD_CODE_LABEL} (gratuit) ou utilisez l’application MOSOLO, ou présentez votre référence au guichet bancaire ou chez un point agréé. MOSOLO n’envoie JAMAIS de lien de paiement : ignorez tout lien reçu. Aucun agent ne reçoit d’espèces.`,
    remOn: 'activés', remOff: 'désactivés',
    remToggledOn: 'Rappels activés : vous recevrez un rappel avant chaque échéance, sans montant. Le détail se consulte par USSD ou dans l’application.',
    remToggledOff: 'Rappels désactivés.',
    remNone: 'Aucun compte MOSOLO n’est rattaché à ce numéro : les rappels ne peuvent pas être activés. Inscrivez-vous au guichet ou par USSD.',
    remCount: 'Vous avez {n} échéance(s) en cours. Consultez le détail par {ussd} ou dans l’application — aucun montant n’est envoyé sur WhatsApp.',
    askReport: 'Décrivez les faits en une phrase (lieu, heure, ce qui a été demandé). Écrivez ANONYME au début pour rester anonyme.',
    reportOk: 'Signalement {ref} enregistré. Code de suivi : {code}. Merci.',
    unknown: 'Je n’ai pas compris. Répondez par un chiffre du menu, ou envoyez directement un code à vérifier.',
    langAsk: 'Langue / Lokota :\n1. Français\n2. Lingala',
    langOk: 'Langue : français.',
    back: 'Écrivez MENU pour revenir au menu.',
  },
  ln: {
    hello: 'Mbote, oyo ezali mosungi ya SOLO ya Engumba Kinshasa — KINSHASA MOSOLO (compte certifié).',
    consent: 'Mpo na kokoba, zongisa OUI : ondimi kozwa bansango ya MOSOLO na WhatsApp (kozanga motuya ya mbongo). Zongisa STOP ntango nyonso mpo na kotelemisa.',
    consentOk: 'Matondi, ndingisa na yo ekomami.',
    stop: 'Eyebani : okozwa lisusu nsango ya MOSOLO na WhatsApp te. Koma OUI mpo na kozongisa. Okoki kaka kosalela USSD to guichet.',
    menu: 'Menu — zongisa na motango :\n1. Kotala tike, esika, quittance to badge\n2. Esika ya kofuta (points agréés)\n3. Ndenge ya kofuta\n4. Bokundoli : {rem}\n5. Koyebisa agent ya lokuta to oyo asengi mbongo\n6. Lokota / Langue\n0. Kotelemisa (STOP)',
    askCode: 'Tinda code oyo ekomami na nse ya QR (ndakisa STAxxxxxxx, EVT-2026-00001-W, Q26…).',
    askCommune: 'Pona commune :',
    howPay: `Mpo na kofuta : bosala ${USSD_CODE_LABEL} (ofele) to application MOSOLO, to lakisa référence na yo na banque to na point agréé. MOSOLO etindaka NATANGU lien ya kofuta te. Agent moko te azwaka mbongo na maboko.`,
    remOn: 'efungwami', remOff: 'ekangami',
    remToggledOn: 'Bokundoli efungwami : okozwa bokundoli liboso ya mokolo ya kofuta, kozanga motuya ya mbongo.',
    remToggledOff: 'Bokundoli ekangami.',
    remNone: 'Compte MOSOLO moko te ekangami na nimero oyo. Komisa nkombo na guichet to na USSD.',
    remCount: 'Ozali na {n} échéance(s). Tala makambo na {ussd} to na application — motuya ya mbongo etindamaka na WhatsApp te.',
    askReport: 'Limbola likambo na fraze moko (esika, ngonga, nini esengamaki). Koma ANONYME na ebandeli mpo nkombo na yo eyebana te.',
    reportOk: 'Likambo {ref} ekomami. Code ya kolanda : {code}. Matondi.',
    unknown: 'Nasosoli te. Zongisa na motango ya menu, to tinda code oyo olingi kotala.',
    langAsk: 'Langue / Lokota :\n1. Français\n2. Lingala',
    langOk: 'Lokota : lingala.',
    back: 'Koma MENU mpo na kozonga na menu.',
  },
};

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ''));

export class WhatsAppAssistant {
  readonly conversations = new InMemoryRepository<WaConversation>();

  constructor(private readonly ctx: AppContext, private readonly preuves: PreuvesService) {}

  private taxpayerByPhone(msisdn: string) {
    const digits = msisdn.replace(/\D/g, '');
    return this.ctx.taxpayers.taxpayers.findOne((t) => !!t.phone && t.phone.replace(/\D/g, '').endsWith(digits.slice(-9)));
  }

  private audit(c: WaConversation, action: string, details: Record<string, unknown> = {}) {
    this.ctx.audit.append({ actor: { kind: 'public', id: `whatsapp:••${c.id.slice(-4)}` }, action, resourceType: 'whatsapp_conversation', resourceId: `••${c.id.slice(-4)}`, details });
  }

  private menu(c: WaConversation): string[] {
    c.node = 'MENU';
    return [fill(T[c.lang].menu!, { rem: c.reminders ? T[c.lang].remOn! : T[c.lang].remOff! })];
  }

  /** Réponse à un message entrant ; renvoie les messages à envoyer (jamais de lien de paiement). */
  handle(from: string, text: string): { replies: string[]; consent: boolean; lang: WaLang } {
    const now = this.ctx.clock.now().toISOString();
    const raw = text.trim();
    const cmd = raw.toUpperCase();
    let c = this.conversations.get(from);
    if (!c) {
      c = this.conversations.insert({ id: from, lang: 'fr', node: 'CONSENT', reminders: false, lastAt: now, messages: 0 });
    }
    c.lastAt = now;
    c.messages += 1;
    const t = T[c.lang];
    const out = (replies: string[]) => {
      this.conversations.update(c!);
      return { replies: replies.map(stripLinks), consent: !!c!.consentAt && !c!.withdrawnAt, lang: c!.lang };
    };

    if (cmd === 'STOP' || cmd === 'ARRET' || cmd === 'ARRÊT' || (c.node === 'MENU' && cmd === '0')) {
      c.withdrawnAt = now; c.reminders = false; c.node = 'CONSENT';
      this.audit(c, 'whatsapp.consent.withdrawn');
      return out([t.stop!]);
    }
    const consented = !!c.consentAt && !c.withdrawnAt;
    if (!consented) {
      if (cmd === 'OUI' || cmd === 'YES' || cmd === 'IYO' || cmd === 'EE') {
        c.consentAt = now; delete c.withdrawnAt;
        this.audit(c, 'whatsapp.consent.given');
        return out([t.consentOk!, ...this.menu(c)]);
      }
      if (cmd === 'LINGALA' || cmd === 'LN') c.lang = 'ln';
      // Aucun contenu n'est servi avant le consentement explicite.
      return out([T[c.lang].hello!, T[c.lang].consent!]);
    }

    if (cmd === 'MENU' || cmd === 'BONJOUR' || cmd === 'MBOTE' || cmd === 'HI' || cmd === 'SALUT') return out(this.menu(c));

    switch (c.node) {
      case 'MENU': {
        if (cmd === '1') { c.node = 'VERIFY'; return out([t.askCode!]); }
        if (cmd === '2') { c.node = 'POINTS'; return out([`${t.askCommune}\n${PILOT_COMMUNES.map((n, i) => `${i + 1}. ${n}`).join('\n')}`]); }
        if (cmd === '3') return out([t.howPay!, t.back!]);
        if (cmd === '4') {
          const tp = this.taxpayerByPhone(c.id);
          if (!tp) return out([t.remNone!, t.back!]);
          c.reminders = !c.reminders;
          this.audit(c, c.reminders ? 'whatsapp.reminders.enabled' : 'whatsapp.reminders.disabled');
          const n = this.ctx.assessment.byTaxpayer(tp.id).filter((o) => PAYABLE_STATUSES.includes(o.status)).length;
          return out([c.reminders ? t.remToggledOn! : t.remToggledOff!, ...(c.reminders ? [fill(t.remCount!, { n, ussd: USSD_CODE_LABEL })] : []), t.back!]);
        }
        if (cmd === '5') { c.node = 'REPORT'; return out([t.askReport!]); }
        if (cmd === '6') { c.node = 'LANG'; return out([t.langAsk!]); }
        // Un code envoyé directement depuis le menu est vérifié.
        if (raw.length >= 6 && /\d/.test(raw) && !/\s/.test(raw)) return out([this.verifyText(raw, c), t.back!]);
        return out([t.unknown!, ...this.menu(c)]);
      }
      case 'VERIFY':
        c.node = 'MENU';
        return out([this.verifyText(raw, c), t.back!]);
      case 'POINTS': {
        const commune = PILOT_COMMUNES[Number(cmd) - 1] ?? PILOT_COMMUNES.find((n) => n.toUpperCase() === cmd);
        c.node = 'MENU';
        if (!commune) return out([t.unknown!, ...this.menu(c)]);
        const pts = ext<CanauxService>(this.ctx, 'canaux').points.publicList(commune).filter((p) => p.status === 'ACTIF').slice(0, 5);
        const lines = pts.length ? pts.map((p) => `• ${p.name} — ${p.address} (${p.hours})`) : ['—'];
        return out([`${commune} :\n${lines.join('\n')}`, t.back!]);
      }
      case 'REPORT': {
        c.node = 'MENU';
        const integ = this.ctx.ext.integrite as IntegriteService | undefined;
        if (!integ || raw.length < 5) return out([t.unknown!, ...this.menu(c)]);
        const r = integ.fromSms({ from: c.id, text: raw });
        return out([fill(t.reportOk!, { ref: r.reference, code: r.trackingCode }), t.back!]);
      }
      case 'LANG':
        c.lang = cmd === '2' ? 'ln' : 'fr';
        return out([T[c.lang].langOk!, ...this.menu(c)]);
      default:
        return out(this.menu(c));
    }
  }

  private verifyText(code: string, c: WaConversation): string {
    const r: ProofResult = this.preuves.resolve(code, `wa:${c.id}`, 'WHATSAPP');
    // Canal tiers non souverain : aucun montant (§ 11.4.4) — le texte SMS n'en contient pas.
    const lines = [this.preuves.smsText(r).replace(/^MOSOLO: /, '')];
    const icon = !r.found ? '❓' : r.validity?.band === 'VERT' || r.validity?.band === 'PERMANENT' ? '🟢' : r.validity?.band === 'AMBRE' ? '🟠' : '🔴';
    return `${icon} ${lines.join('\n')}`;
  }
}

/** Un message WhatsApp MOSOLO ne contient jamais de lien (anti-hameçonnage, ARB-64). */
export function stripLinks(s: string): string {
  return s.replace(/https?:\/\/\S+/gi, '[lien retiré]').replace(/\bwww\.\S+/gi, '[lien retiré]');
}
