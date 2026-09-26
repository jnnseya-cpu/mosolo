/**
 * Preuves — résolveur universel de codes (§ H.11.5, § 13A, module 68) : un seul point d'entrée pour vérifier toute
 * preuve (ticket, pass, place d'étal, certificat, autorisation publicitaire, quitus, attestation de bail, badge d'agent,
 * quittance, reçu de point agréé, carte MOSOLO, plaque) depuis N'IMPORTE QUEL canal :
 * application, page légère sans JavaScript (2G, téléphone basique), SMS, WhatsApp, USSD, SVI, papier imprimé.
 *
 * - Réponse minimale : ni nom, ni adresse, ni montant nominatif hors quittance ; la plaque d'un véhicule est masquée.
 * - Validité : règle unique 50 % / 1 % (shared/validity.ts), toujours à l'heure du SERVEUR.
 * - Chaque vérification passe par le limiteur anti-énumération du module « canaux » et est journalisée.
 */
import { extractProofCode, formatValidityDuration } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { validityView, type ValidityView } from '../../core/validity.js';
import { ext } from '../types.js';
import type { CanauxService } from '../canaux/service.js';
import type { TitresService } from '../titres/service.js';
import { statusAt } from '../titres/validity.js';
import { MODULE_WEWA, type RakaPayService } from '../rakapay/service.js';
import type { VerticalesService } from '../verticales/service.js';
import type { PubliciteService } from '../publicite/service.js';
import type { FiscalService } from '../fiscal/service.js';
import type { TerrainService } from '../terrain/service.js';
import type { ParkingService } from '../parking/service.js';
import { normalizeShortCode } from '../fiscal/common.js';

export type ProofKind =
  | 'TITRE' | 'PASS_WEWA' | 'TICKET_STATIONNEMENT' | 'PLAQUE_ETAL' | 'PLAQUE_OBJET' | 'CERTIFICAT' | 'PLAQUE_BIEN' | 'QUITUS' | 'ATTESTATION_BAIL'
  | 'BADGE_AGENT' | 'SUPPORT_PUBLICITAIRE' | 'QUITTANCE' | 'RECU_POINT' | 'CARTE' | 'INCONNU';

export type ProofState = 'VALIDE' | 'EXPIRE' | 'PAS_ACTIF' | 'REVOQUE' | 'SUSPENDU' | 'INVALIDE' | 'REMPLACE' | 'EN_ATTENTE' | 'INCONNU';

export interface ProofResult {
  found: boolean;
  kind: ProofKind;
  kindLabel: string;
  code: string;
  authentic: boolean;
  state: ProofState;
  stateLabel: string;
  /** Intitulé lisible : « Ticket de stationnement horaire », « Droit d'étal — Marché central »… */
  title: string;
  /** Informations minimales (commune, zone, plaque masquée…). */
  facts: { label: string; value: string }[];
  validity: ValidityView | null;
  situation?: { color: string; label: string } | null;
  message: string;
  /** Page de vérification (application ou page légère). */
  verifyPath: string;
  checkedAt: string;
  advice: string;
  /** Données propres au support imprimé (QR statique signé quand il existe, préfixe du module). */
  print?: { qrValue: string; prefix: string; pictogram: string };
}

const ADVICE = 'Aucun agent ne demande d’espèces ni de code secret. Payez uniquement par les canaux officiels (USSD, application, banque, point agréé).';

export const KIND_LABEL: Record<ProofKind, string> = {
  TITRE: 'Titre / ticket', TICKET_STATIONNEMENT: 'Ticket de stationnement', PASS_WEWA: 'Pass wewa (moto-taxi)', PLAQUE_ETAL: 'Place d’étal (marché)', PLAQUE_OBJET: 'Plaque d’un objet',
  CERTIFICAT: 'Certificat / autorisation', PLAQUE_BIEN: 'Plaque d’un bien', QUITUS: 'Quitus fiscal', ATTESTATION_BAIL: 'Attestation de bail',
  BADGE_AGENT: 'Badge d’agent', SUPPORT_PUBLICITAIRE: 'Support publicitaire', QUITTANCE: 'Quittance', RECU_POINT: 'Reçu de point agréé',
  CARTE: 'Carte MOSOLO', INCONNU: 'Code inconnu',
};

const STATE_LABEL: Record<ProofState, string> = {
  VALIDE: 'Valide', EXPIRE: 'Expiré', PAS_ACTIF: 'Pas encore actif', REVOQUE: 'Révoqué', SUSPENDU: 'Suspendu', INVALIDE: 'Invalide',
  REMPLACE: 'Remplacé', EN_ATTENTE: 'En attente de paiement', INCONNU: 'Inconnu',
};

/** Masque une plaque de véhicule : « KN-M 20417 » → « KN-M ••417 ». */
export function maskPlate(p: string): string {
  const s = p.trim();
  return s.length <= 4 ? s : `${s.slice(0, Math.max(0, s.length - 5))}••${s.slice(-3)}`;
}

export class PreuvesService {
  constructor(private readonly ctx: AppContext) {}

  private get canaux() { return ext<CanauxService>(this.ctx, 'canaux'); }
  private opt<S>(name: string): S | null { return (this.ctx.ext[name] as S | undefined) ?? null; }

  /** Vérification universelle ; `key` identifie l'appelant pour le limiteur (adresse, numéro d'appel). */
  resolve(rawCode: string, key: string, channel: 'WEB' | 'LITE' | 'SMS' | 'WHATSAPP' | 'USSD' | 'SVI' | 'IMPRIME'): ProofResult {
    // Contenu de QR scanné ou lien collé (SMS, WhatsApp, page légère) : on en extrait le code.
    const code = extractProofCode(rawCode);
    this.canaux.limiter.admit(key, `PREUVE-${channel}`);
    const r = this.lookup(code);
    this.canaux.limiter.record(key, `PREUVE-${channel}`, code.slice(0, 40), r.kind, r.state, !r.found);
    this.ctx.audit.append({ actor: { kind: 'public', id: `verification-${channel.toLowerCase()}` }, action: 'proof.verified', resourceType: 'proof', resourceId: r.found ? `${r.kind}:${r.code}` : 'inconnu', outcome: r.found ? 'SUCCESS' : 'FAILURE', details: { channel, kind: r.kind, state: r.state } });
    return r;
  }

  private base(kind: ProofKind, code: string, over: Partial<ProofResult>): ProofResult {
    const now = this.ctx.clock.now().toISOString();
    const state = over.state ?? 'INCONNU';
    return {
      found: kind !== 'INCONNU', kind, kindLabel: KIND_LABEL[kind], code, authentic: kind !== 'INCONNU', state, stateLabel: STATE_LABEL[state],
      title: KIND_LABEL[kind], facts: [], validity: null, message: '', verifyPath: `/preuve/${encodeURIComponent(code)}`, checkedAt: now, advice: ADVICE,
      ...over,
    } as ProofResult;
  }

  private stateOf(v: ValidityView | null, fallback: ProofState = 'VALIDE'): ProofState {
    if (!v) return fallback;
    if (v.band === 'EXPIRE') return 'EXPIRE';
    if (v.band === 'PAS_ACTIF') return 'PAS_ACTIF';
    return 'VALIDE';
  }

  /** Recherche par forme du code, sans effet de bord sur les registres des modules. */
  lookup(code: string): ProofResult {
    const now = this.ctx.clock.now();
    const up = code.toUpperCase().replace(/\s+/g, ' ').trim();
    const compact = up.replace(/\s+/g, '');

    // 1. Titres (tickets, abonnements, pass, vignettes…) : numéro, code court ou QR statique signé.
    const titres = this.opt<TitresService>('titres');
    if (titres) {
      const payload = code.startsWith('MT1.') ? titres.signer.verifyStatic(code) : null;
      const c = payload && typeof payload.id === 'string'
        ? titres.credentials.get(payload.id)
        : titres.credentials.findOne((x) => x.shortCode === compact || x.number === compact || x.number === up);
      if (c) {
        titres.sync();
        const s = statusAt(c, now);
        const t = titres.types.findOne((x) => x.code === c.typeCode && x.version === c.typeVersion);
        const blocked = s.status === 'INVALIDE' || s.status === 'SUSPENDU';
        const state: ProofState = s.status === 'SUSPENDU' ? 'SUSPENDU' : s.status === 'INVALIDE' ? (c.state === 'REVOQUE' ? 'REVOQUE' : c.state === 'REMPLACE' ? 'REMPLACE' : 'INVALIDE') : s.status === 'EXPIRE' ? 'EXPIRE' : s.status === 'PAS_ENCORE_ACTIF' ? 'PAS_ACTIF' : 'VALIDE';
        const facts = [
          { label: 'Numéro', value: c.number },
          ...(c.place?.label ? [{ label: 'Lieu / zone', value: c.place.label }] : []),
          ...(c.subject?.plate ? [{ label: 'Plaque', value: maskPlate(c.subject.plate) }] : []),
          ...(c.usesTotal ? [{ label: 'Usages restants', value: `${c.usesLeft ?? 0} / ${c.usesTotal}` }] : []),
        ];
        return this.base(c.module === MODULE_WEWA ? 'PASS_WEWA' : 'TITRE', c.shortCode, {
          state, title: t?.label ?? c.typeCode, facts,
          validity: blocked ? null : validityView(c.validFrom, c.validUntil, now),
          message: s.text,
          print: { qrValue: c.staticToken, prefix: t?.prefix ?? c.number.split('-')[0] ?? 'TIT', pictogram: c.module },
        });
      }
    }

    // 1 bis. Stationnement : ticket de session ou de réservation (code aléatoire PKT…).
    const parking = this.opt<ParkingService>('parking');
    if (parking && /^PKT[0-9A-Z]{7}$/.test(compact)) {
      const t = parking.ticketByCode(compact);
      if (t) {
        const v = t.validUntil && (t.state === 'ACTIVE' || t.state === 'EXPIREE' || t.state === 'TERMINEE') ? validityView(t.validFrom, t.validUntil, now) : null;
        const state: ProofState = t.state === 'ANNULEE' ? 'INVALIDE' : t.state === 'EN_ATTENTE' ? 'EN_ATTENTE' : this.stateOf(v, 'EXPIRE');
        return this.base('TICKET_STATIONNEMENT', compact, {
          state, title: t.kind === 'RESERVATION' ? 'Réservation de places de stationnement' : 'Ticket de stationnement',
          facts: [{ label: 'Zone', value: t.zone }, { label: 'Commune', value: t.commune }, ...(t.plate ? [{ label: 'Plaque', value: maskPlate(t.plate) }] : [])],
          validity: v, message: state === 'EN_ATTENTE' ? 'Ticket en attente de paiement : il ne vaut pas titre.' : v ? v.text : 'Ticket non valable.',
          print: { qrValue: compact, prefix: 'PKT', pictogram: 'STATIONNEMENT' },
        });
      }
    }

    // 2. RakaPay : numéro de gilet ou QR statique du gilet / de l'autocollant.
    const rakapay = this.opt<RakaPayService>('rakapay');
    if (rakapay && (/^W-[A-Z]{3}-\d{4}$/.test(compact) || code.startsWith('MT1.'))) {
      const exists = code.startsWith('MT1.') || rakapay.drivers.findOne((d) => d.vestNumber === compact);
      if (exists) {
        const p = rakapay.passengerCheck(code);
        if (p.registered) {
          const pass = 'pass' in p ? p.pass : null;
          const v = pass?.validity && pass.validUntil ? validityView(pass.validFrom ?? null, pass.validUntil, now) : null;
          return this.base('PASS_WEWA', ('vestNumber' in p && p.vestNumber) || compact, {
            state: v ? this.stateOf(v) : 'EXPIRE', title: 'Pass wewa — conducteur de moto-taxi',
            facts: [
              ...('vestNumber' in p && p.vestNumber ? [{ label: 'Gilet', value: p.vestNumber }] : []),
              ...('stationCommune' in p && p.stationCommune ? [{ label: 'Commune de la station', value: p.stationCommune }] : []),
              { label: 'Conducteur enregistré', value: 'driverVerified' in p && p.driverVerified ? 'Oui' : 'À vérifier' },
            ],
            validity: v, message: pass?.text ?? p.message,
          });
        }
      }
    }

    // 3. Verticales : certificats (EVT-, CHT-…) et plaques d'objets (étal, site, embarcation, chantier, NFIU).
    const vx = this.opt<VerticalesService>('verticales');
    if (vx) {
      const cert = vx.certificates.get(compact);
      if (cert) {
        const r = vx.publicCertificate(compact);
        const v = 'validity' in r ? r.validity ?? null : null;
        const revoked = 'statut' in r && r.statut === 'REVOQUE';
        return this.base('CERTIFICAT', compact, {
          authentic: !!('authentique' in r && r.authentique), state: revoked ? 'REVOQUE' : this.stateOf(v), title: ('type' in r && r.type) || 'Certificat',
          facts: [...('verticale' in r && r.verticale ? [{ label: 'Service', value: r.verticale }] : []), ...('commune' in r && r.commune ? [{ label: 'Commune', value: r.commune }] : [])],
          validity: revoked ? null : v, message: r.message ?? '', verifyPath: `/verifier-plaque/${encodeURIComponent(compact)}`,
          print: { qrValue: compact, prefix: compact.split('-')[0] ?? 'CRT', pictogram: cert.vertical },
        });
      }
      const plate = vx.plates.get(compact);
      if (plate) {
        const r = vx.publicPlate(compact) as ReturnType<VerticalesService['publicPlate']> & { titre?: { statut: string; label: string; validFrom: string | null; validUntil: string | null; validity: ValidityView | null } };
        const titre = r.titre;
        const isStall = plate.kind === 'ETAL';
        const v = titre?.validity ?? null;
        const state: ProofState = 'statut' in r && r.statut === 'REMPLACEE' ? 'REMPLACE' : isStall ? (titre ? (titre.statut === 'GRIS' ? 'EN_ATTENTE' : titre.statut === 'AUCUN' ? 'INCONNU' : this.stateOf(v, 'EXPIRE')) : 'INCONNU') : 'VALIDE';
        return this.base(isStall ? 'PLAQUE_ETAL' : 'PLAQUE_OBJET', compact, {
          authentic: !!r.authentique, state: isStall && titre?.statut === 'AUCUN' ? 'EXPIRE' : state,
          stateLabel: isStall ? (titre?.label ?? 'Aucun titre') : STATE_LABEL[state],
          title: ('type' in r && r.type) || 'Plaque', facts: [...('commune' in r && r.commune ? [{ label: 'Commune', value: r.commune }] : []), ...('quartier' in r && r.quartier ? [{ label: 'Quartier', value: r.quartier }] : [])],
          validity: v, situation: 'situation' in r ? r.situation ?? null : null, message: r.message ?? '', verifyPath: `/verifier-plaque/${encodeURIComponent(compact)}`,
          print: { qrValue: compact, prefix: compact.split('-')[0] ?? 'PLQ', pictogram: plate.kind },
        });
      }
    }

    // 4. Badge d'agent de terrain (AG-XXXXXX-C).
    const terrain = this.opt<TerrainService>('terrain');
    if (terrain && /^AG-?[0-9A-Z]{6}-?[0-9A-Z]$/.test(compact)) {
      const r = terrain.publicVerify(compact, undefined, 'WEB');
      if (r.result !== 'INCONNU' && 'badge' in r && r.badge) {
        const v = r.badge.validity ?? (r.result === 'EXPIRE' ? validityView(r.badge.validFrom, r.badge.validUntil, now) : null);
        const state: ProofState = r.result === 'REVOQUE' ? 'REVOQUE' : r.result === 'SUSPENDU' ? 'SUSPENDU' : r.result === 'EXPIRE' ? 'EXPIRE' : 'VALIDE';
        return this.base('BADGE_AGENT', r.badge.shortCode, {
          state, title: `Agent — ${r.badge.displayName}`, facts: [{ label: 'Structure', value: r.badge.structure }, { label: 'Zone', value: r.badge.communes.join(', ') }],
          validity: state === 'VALIDE' || state === 'EXPIRE' ? v : null, message: r.advice, verifyPath: `/verifier-agent/${encodeURIComponent(r.badge.shortCode)}`,
          print: { qrValue: r.badge.shortCode, prefix: 'AG', pictogram: 'AGENT' },
        });
      }
    }

    // 5. Fiscal : quitus, attestation de bail, plaque de bien (code court à 9 caractères avec contrôle).
    const fiscal = this.opt<FiscalService>('fiscal');
    const short = normalizeShortCode(code);
    if (fiscal && short) {
      const q = fiscal.clearances.clearances.findOne((c) => c.shortCode === short);
      if (q) {
        const r = fiscal.clearances.publicCheck(short);
        const v = 'validity' in r ? r.validity ?? null : null;
        const state: ProofState = r.result === 'REVOQUE' ? 'REVOQUE' : r.result === 'EXPIRE' ? 'EXPIRE' : 'VALIDE';
        return this.base('QUITUS', short, {
          state, title: 'Quitus fiscal (informatif)', facts: [...('number' in r && r.number ? [{ label: 'Numéro', value: r.number }] : []), ...('taxpayerRef' in r && r.taxpayerRef ? [{ label: 'Contribuable', value: String(r.taxpayerRef) }] : [])],
          validity: state === 'REVOQUE' ? null : v, message: 'notice' in r ? String(r.notice) : '', verifyPath: `/fiscal/verifier/quitus/${short}`,
          print: { qrValue: `/fiscal/verifier/quitus/${short}?s=${q.signature}`, prefix: 'QTS', pictogram: 'QUITUS' },
        });
      }
      const a = fiscal.clearances.attestations.findOne((x) => x.shortCode === short);
      if (a) {
        const r = fiscal.clearances.publicCheckAttestation(short);
        const v = r.result === 'VALIDE' && 'leaseStart' in r ? validityView(r.leaseStart ?? null, r.leaseEnd ?? null, now) : null;
        return this.base('ATTESTATION_BAIL', short, {
          state: r.result === 'VALIDE' ? this.stateOf(v) : 'REVOQUE', title: 'Attestation de bail enregistré',
          facts: [...('commune' in r && r.commune ? [{ label: 'Commune', value: r.commune }] : []), ...('unitIgf' in r && r.unitIgf ? [{ label: 'Unité', value: r.unitIgf }] : [])],
          validity: v, message: 'notice' in r ? String(r.notice) : '', verifyPath: `/fiscal/verifier/bail/${short}`,
          print: { qrValue: `/fiscal/verifier/bail/${short}`, prefix: 'ATB', pictogram: 'BAIL' },
        });
      }
      const pp = fiscal.properties.plates.findOne((p) => p.shortCode === short);
      if (pp) {
        const r = fiscal.properties.publicCheck(short);
        return this.base('PLAQUE_BIEN', short, {
          state: r.result === 'REMPLACEE' ? 'REMPLACE' : 'VALIDE', stateLabel: r.result === 'REMPLACEE' ? 'Remplacée' : 'Authentique',
          title: 'category' in r ? `Plaque — ${r.category}` : 'Plaque d’un bien',
          facts: [...('nfiu' in r && r.nfiu ? [{ label: 'NFIU', value: r.nfiu }] : []), ...('commune' in r && r.commune ? [{ label: 'Commune', value: r.commune }] : [])],
          situation: 'situation' in r ? r.situation ?? null : null, message: r.message, verifyPath: `/fiscal/verifier/bien/${short}?s=${pp.signature}`,
          print: { qrValue: `/fiscal/verifier/bien/${short}?s=${pp.signature}`, prefix: 'NFIU', pictogram: 'BIEN' },
        });
      }
    }

    // 6. Support publicitaire (jeton de la plaque QR).
    const pub = this.opt<PubliciteService>('publicite');
    if (pub && /^[A-Za-z0-9_-]{16}$/.test(code)) {
      const d = pub.devices.findOne((x) => x.qrToken === code);
      if (d) {
        const r = pub.publicCheck(code);
        const v = r.validity ?? null;
        const state: ProofState = r.status === 'AUTORISE' ? this.stateOf(v) : r.status === 'EXPIRE' ? 'EXPIRE' : r.status === 'RETIRE' ? 'REVOQUE' : 'EN_ATTENTE';
        return this.base('SUPPORT_PUBLICITAIRE', r.reference, {
          state, stateLabel: { AUTORISE: 'Autorisé', EXPIRE: 'Autorisation expirée', RETIRE: 'Retiré', DECLARE: 'Déclaré — non autorisé', NON_DECLARE: 'Non déclaré' }[r.status] ?? r.status,
          title: `Support publicitaire — ${r.type}`, facts: [{ label: 'Référence', value: r.reference }, { label: 'Commune', value: r.commune }, { label: 'Surface', value: `${r.surfaceM2} m² × ${r.faces}` }],
          validity: r.status === 'RETIRE' ? null : v, message: r.notice, verifyPath: `/publicite/verifier?plaque=${encodeURIComponent(code)}`,
          print: { qrValue: code, prefix: 'PUB', pictogram: 'PUBLICITE' },
        });
      }
    }

    // 7. Quittances, reçus de point agréé, cartes MOSOLO (permanents : une quittance ne périme pas).
    const looksReceipt = /^Q[0-9A-Z-]{6,40}$/i.test(compact) || /^[0-9A-Z]{3}-?[0-9A-Z]{3}$/.test(compact) || /^\d{12}$/.test(compact.replace(/-/g, ''));
    if (looksReceipt) {
      const r = this.canaux.verify(compact, `preuves:${compact}`, 'WEB');
      if (r.status !== 'INCONNU') {
        const kind: ProofKind = r.kind === 'CARTE' ? 'CARTE' : r.kind === 'RECU_POINT' ? 'RECU_POINT' : 'QUITTANCE';
        const ok = ['VALIDE', 'DÉFINITIVE', 'PROVISOIRE'].includes(r.status);
        return this.base(kind, compact, {
          state: ok ? 'VALIDE' : r.status === 'BLOQUÉE' ? 'SUSPENDU' : 'REVOQUE', stateLabel: r.status.charAt(0) + r.status.slice(1).toLowerCase(),
          title: KIND_LABEL[kind], facts: [...(r.date ? [{ label: 'Date', value: r.date }] : [])],
          validity: ok ? validityView(null, null, now) : null, message: r.message, verifyPath: kind === 'QUITTANCE' ? `/verifier/${encodeURIComponent(compact)}` : `/preuve/${encodeURIComponent(compact)}`,
          ...(r.amount ? { amount: r.amount } : {}),
        });
      }
    }

    return this.base('INCONNU', code.slice(0, 40), {
      found: false, authentic: false, state: 'INCONNU',
      message: 'Code non reconnu. Vérifiez la saisie (lettres et chiffres). Un document sans code vérifiable n’est pas une preuve : signalez-le.',
    });
  }

  /** Réponse courte (SMS 160 caractères, sans accents pour rester en GSM-7). */
  smsText(r: ProofResult): string {
    const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’]/g, "'").replace(/[—–]/g, '-').replace(/•/g, '*');
    if (!r.found) return strip(`MOSOLO: code ${r.code} inconnu. Verifiez la saisie. Un agent ne demande jamais d'especes.`);
    const v = r.validity;
    let when = '';
    if (v?.band === 'PERMANENT') when = 'sans date de fin';
    else if (v && v.remainingSeconds !== null) {
      const dur = formatValidityDuration(v.remainingSeconds * 1000, false);
      const color = { VERT: 'VERT', AMBRE: 'ORANGE', ROUGE: 'ROUGE', EXPIRE: 'ROUGE', PAS_ACTIF: 'GRIS', PERMANENT: '' }[v.band];
      when = v.band === 'EXPIRE' ? `EXPIRE depuis ${dur}` : v.band === 'PAS_ACTIF' ? 'pas encore actif' : `reste ${dur} (${Math.floor(v.pct ?? 0)}%) ${color}`;
      if (v.until && v.band !== 'EXPIRE') when += ` fin ${kinDate(v.until)}`;
    }
    const txt = `MOSOLO: ${r.kindLabel} ${r.code} ${r.authentic ? '' : 'NON AUTHENTIQUE '}${r.stateLabel.toUpperCase()}${when ? `, ${when}` : ''}. Heure serveur. Zero especes aux agents.`;
    return strip(txt).slice(0, 320);
  }
}

/** « 26/09 21:00 » à l'heure de Kinshasa. */
export function kinDate(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
