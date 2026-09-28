/**
 * Module 2 — Contrôle des pièces à l'enrôlement (Spécification fonctionnelle ; § 9, § 13A).
 *
 * Chaque pièce (carte d'identité, passeport, carte d'électeur, permis, NIF, RCCM) est contrôlée côté serveur :
 *  - capture photo (empreinte SHA-256 de l'image : l'image elle-même reste sur l'appareil) ;
 *  - lecture automatique (texte OCR lu sur l'appareil, zone MRZ des passeports) : cohérence avec la saisie ;
 *  - vérification de cohérence : format du numéro, chiffres de contrôle MRZ (norme OACI 9303), date d'expiration à
 *    l'heure du SERVEUR, nom lu ≈ nom déclaré, même numéro déjà présenté par un autre compte ;
 *  - SCORE DE CONFIANCE (0 à 100) expliqué facteur par facteur ; sous le seuil, ou en cas de rapprochement possible,
 *    le dossier est un CAS À RISQUE soumis à revue humaine (jamais un rejet automatique) ;
 *  - RAPPROCHEMENTS proposés avec les identités existantes (même pièce, même téléphone, nom proche) — aucune fusion
 *    automatique : la fusion suit le circuit sur preuve et double validation du module « accès ».
 * Rattachée à un compte, la pièce devient une preuve DÉCLARÉE du registre d'identité (contrôle par une personne
 * distincte, niveaux N1 à N3).
 */
import { createHash } from 'node:crypto';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { actorOf } from '../../core/audit.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { maskPhone } from '../../modules/identity/service.js';
import type { ProofType } from '../acces/model.js';
import { accesOf, norm, parDefaut } from './common.js';

const { always, ownTaxpayer, mandant } = GRANTS;
definePolicy('citoyen:pieces.controler', { R10: always, R12: always, R09: always, R11: always, R07: always, R30: ownTaxpayer, R31: mandant });
definePolicy('citoyen:pieces.revue', { R09: always, R11: always, R07: always, R12: always, R22: always });

export const TYPES_PIECE = ['CARTE_IDENTITE', 'PASSEPORT', 'CARTE_ELECTEUR', 'PERMIS_CONDUIRE', 'NIF', 'RCCM'] as const;
export type TypePiece = (typeof TYPES_PIECE)[number];
/** Correspondance avec les preuves du registre d'identité (module « accès »). */
const PREUVE: Record<TypePiece, ProofType> = { CARTE_IDENTITE: 'PIECE_IDENTITE', PASSEPORT: 'PIECE_IDENTITE', CARTE_ELECTEUR: 'PIECE_IDENTITE', PERMIS_CONDUIRE: 'PIECE_IDENTITE', NIF: 'NIF', RCCM: 'RCCM' };

/** Pondération du score et seuil de revue humaine — valeurs par défaut à confirmer par le maître d'ouvrage. */
export const PONDERATION = parDefaut({ photo: 15, format: 15, lectureAuto: 25, expiration: 20, mrz: 10, unicite: 15 }, 'Spécification fonctionnelle, module 2 — score de confiance');
export const SEUIL_REVUE = parDefaut(70, 'Spécification fonctionnelle, module 2 — cas à risque soumis à revue humaine');

export interface Facteur { code: keyof typeof PONDERATION.valeur; libelle: string; points: number; max: number; detail: string }
export interface ControlePiece {
  id: string;
  type: TypePiece;
  numeroMasque: string;
  numeroEmpreinte: string;
  taxpayerId?: string;
  nomDeclare: string;
  score: number;
  facteurs: Facteur[];
  rapprochements: { taxpayerId: string; iuc: string; nomMasque: string; motifs: string[] }[];
  statut: 'CONFORME' | 'A_REVOIR' | 'VALIDEE' | 'REJETEE' | 'COMPLEMENT_DEMANDE';
  revueHumaine: boolean;
  proofId?: string;
  controlePar: string;
  controleLe: string;
  canal: string;
  decision?: { par: string; at: string; motif: string };
}

const FORMATS: Record<TypePiece, RegExp> = {
  CARTE_IDENTITE: /^[A-Z0-9]{6,20}$/, PASSEPORT: /^[A-Z0-9]{7,9}$/, CARTE_ELECTEUR: /^[A-Z0-9]{8,20}$/, PERMIS_CONDUIRE: /^[A-Z0-9]{5,20}$/,
  NIF: /^[A-Z0-9]{6,20}$/, RCCM: /^[A-Z0-9]{8,30}$/,
};

/** Chiffre de contrôle OACI 9303 (pondération 7, 3, 1). */
export function chiffreControleMrz(s: string): number {
  const w = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const v = c === '<' ? 0 : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55;
    sum += v * w[i % 3]!;
  }
  return sum % 10;
}

/** Ligne 2 d'un passeport (TD3, 44 caractères) : numéro, naissance, expiration et leurs chiffres de contrôle. */
export function lireMrzTd3(ligne2: string) {
  const l = ligne2.replace(/\s/g, '').toUpperCase();
  if (l.length !== 44) return null;
  const champ = (a: number, b: number) => l.slice(a, b);
  const ok = (v: string, c: string) => /\d/.test(c) && chiffreControleMrz(v) === Number(c);
  return {
    numero: champ(0, 9).replace(/</g, ''), numeroOk: ok(champ(0, 9), l[9]!),
    naissance: champ(13, 19), naissanceOk: ok(champ(13, 19), l[19]!),
    expiration: champ(21, 27), expirationOk: ok(champ(21, 27), l[27]!),
  };
}

const empreinte = (type: TypePiece, numero: string) => createHash('sha256').update(`${type}:${numero.trim().toUpperCase().replace(/[\s-]/g, '')}`).digest('hex');
const masque = (n: string) => (n.length <= 4 ? '••••' : `${'•'.repeat(n.length - 4)}${n.slice(-4)}`);
const nomMasque = (n: string) => n.split(/\s+/).map((p) => `${p[0] ?? ''}***`).join(' ');

/** Proximité de deux noms (jetons communs après normalisation), 0 à 1. */
export function proximiteNoms(a: string, b: string): number {
  const ta = new Set(norm(a).split(' ').filter((x) => x.length > 1));
  const tb = new Set(norm(b).split(' ').filter((x) => x.length > 1));
  if (!ta.size || !tb.size) return 0;
  let c = 0;
  for (const t of ta) if (tb.has(t)) c++;
  return c / Math.max(ta.size, tb.size);
}

export class ControlePiecesService {
  readonly controles = new InMemoryRepository<ControlePiece>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {}

  private now() { return this.ctx.clock.now(); }

  controler(user: User, input: {
    type: TypePiece; numero: string; nomDeclare?: string; taxpayerId?: string; telephone?: string; photoSha256?: string;
    dateExpiration?: string; lectureAuto?: { texte?: string; nom?: string; numero?: string; mrzLigne2?: string }; canal?: string;
  }) {
    // Compte unique (28/09/2026) : le titulaire connecté contrôle SA pièce sans ressaisir son nom ni son téléphone ;
    // le nom déclaré et le téléphone du compte sont repris (la pièce est rapprochée du compte, jamais l'inverse).
    if (!input.taxpayerId && user.roles.includes('R30') && user.taxpayerId) input = { ...input, taxpayerId: user.taxpayerId };
    authorize(user, 'citoyen:pieces.controler', input.taxpayerId ? { taxpayerId: input.taxpayerId } : {});
    const compte = input.taxpayerId ? this.ctx.taxpayers.get(input.taxpayerId) : undefined;
    if (!input.nomDeclare && !compte) throw badRequest('NOM_DECLARE_REQUIS', 'Nom déclaré requis quand la pièce n’est rattachée à aucun compte.');
    input = { ...input, nomDeclare: input.nomDeclare ?? compte!.fullName, ...(!input.telephone && compte?.phone ? { telephone: compte.phone } : {}) };
    const nomDeclare: string = input.nomDeclare ?? '';
    const w = PONDERATION.valeur;
    const numero = input.numero.trim().toUpperCase().replace(/[\s-]/g, '');
    const facteurs: Facteur[] = [];
    const add = (code: Facteur['code'], libelle: string, ratio: number, detail: string) => facteurs.push({ code, libelle, points: Math.round(w[code] * ratio), max: w[code], detail });
    add('photo', 'Capture photo de la pièce', input.photoSha256 ? 1 : 0, input.photoSha256 ? 'Empreinte de l’image enregistrée (l’image reste sur l’appareil).' : 'Aucune photo de la pièce.');
    add('format', 'Format du numéro', FORMATS[input.type].test(numero) ? 1 : 0, FORMATS[input.type].test(numero) ? 'Format attendu.' : 'Format inattendu pour ce type de pièce.');
    // Lecture automatique : nom et numéro lus comparés à la saisie.
    const lu = input.lectureAuto;
    const mrz = lu?.mrzLigne2 ? lireMrzTd3(lu.mrzLigne2) : null;
    const numeroLu = (mrz?.numero ?? lu?.numero ?? '').toUpperCase().replace(/[\s-]/g, '');
    const nomLu = lu?.nom ?? lu?.texte ?? '';
    if (!lu) add('lectureAuto', 'Lecture automatique (OCR)', 0, 'Aucune lecture automatique fournie.');
    else {
      const prox = nomLu ? proximiteNoms(nomLu, nomDeclare) : 0;
      const numOk = !!numeroLu && (numeroLu === numero || (lu.texte ?? '').toUpperCase().replace(/[\s-]/g, '').includes(numero));
      add('lectureAuto', 'Lecture automatique (OCR)', (numOk ? 0.5 : 0) + Math.min(prox, 1) * 0.5, `Numéro lu ${numOk ? 'identique' : 'différent ou illisible'} ; nom lu proche à ${Math.round(prox * 100)} %.`);
    }
    // Expiration à l'heure du serveur (jamais l'horloge de l'appareil).
    const exp = input.dateExpiration ?? (mrz ? `20${mrz.expiration.slice(0, 2)}-${mrz.expiration.slice(2, 4)}-${mrz.expiration.slice(4, 6)}` : undefined);
    const valide = exp ? `${exp}T23:59:59.999Z` >= this.now().toISOString() : undefined;
    add('expiration', 'Validité de la pièce', valide === undefined ? (input.type === 'NIF' || input.type === 'RCCM' ? 1 : 0.5) : valide ? 1 : 0,
      valide === undefined ? 'Date d’expiration non fournie.' : valide ? `Valide jusqu’au ${exp} (heure serveur).` : `Expirée le ${exp}.`);
    if (input.type === 'PASSEPORT') {
      add('mrz', 'Chiffres de contrôle MRZ (OACI 9303)', mrz ? [mrz.numeroOk, mrz.naissanceOk, mrz.expirationOk].filter(Boolean).length / 3 : 0, mrz ? `Contrôles : numéro ${mrz.numeroOk ? 'OK' : 'KO'}, naissance ${mrz.naissanceOk ? 'OK' : 'KO'}, expiration ${mrz.expirationOk ? 'OK' : 'KO'}.` : 'Zone MRZ non lue.');
    } else add('mrz', 'Chiffres de contrôle', 1, 'Sans objet pour ce type de pièce.');
    // Unicité : même numéro déjà présenté par un autre compte ⇒ rapprochement.
    const hash = empreinte(input.type, numero);
    const autres = this.controles.find((c) => c.numeroEmpreinte === hash && !!c.taxpayerId && c.taxpayerId !== input.taxpayerId && c.statut !== 'REJETEE');
    add('unicite', 'Unicité du numéro', autres.length ? 0 : 1, autres.length ? 'Numéro déjà présenté par un autre compte.' : 'Numéro inédit.');
    const score = facteurs.reduce((s, f) => s + f.points, 0);
    const rapprochements = this.rapprochements({ nom: nomDeclare, telephone: input.telephone, autres: autres.map((a) => a.taxpayerId!), exclure: input.taxpayerId });
    const risque = score < SEUIL_REVUE.valeur || rapprochements.length > 0;
    let proofId: string | undefined;
    const acces = accesOf(this.ctx);
    if (input.taxpayerId && acces) {
      try { proofId = acces.declareProof(user, input.taxpayerId, { type: PREUVE[input.type], reference: numero, note: `Score de confiance ${score}/100${risque ? ' — cas à risque, revue humaine' : ''}` }).id; } catch { /* preuve déjà en attente : le contrôle reste enregistré */ }
    }
    const c = this.controles.insert({
      id: this.ids.next('CTP'), type: input.type, numeroMasque: masque(numero), numeroEmpreinte: hash, ...(input.taxpayerId ? { taxpayerId: input.taxpayerId } : {}),
      nomDeclare: nomDeclare, score, facteurs, rapprochements, statut: risque ? 'A_REVOIR' : 'CONFORME', revueHumaine: risque, ...(proofId ? { proofId } : {}),
      controlePar: user.id, controleLe: this.now().toISOString(), canal: input.canal ?? (user.roles.includes('R12') ? 'GUICHET' : user.roles.includes('R10') ? 'AGENT' : 'EN_LIGNE'),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'enrolement.piece.controlled', resourceType: 'identity_document', resourceId: c.id, details: { type: c.type, score, revueHumaine: risque, rapprochements: rapprochements.length, taxpayerId: c.taxpayerId ?? null } });
    return { ...c, seuil: SEUIL_REVUE, ponderation: PONDERATION, notice: risque ? 'Cas à risque : revue humaine avant toute élévation de niveau. Aucun rejet automatique.' : 'Pièce cohérente : contrôle final par une personne distincte (registre d’identité).' };
  }

  /** Rapprochements possibles (jamais une fusion) : même pièce, même téléphone, nom proche. */
  rapprochements(q: { nom: string; telephone?: string; autres?: string[]; exclure?: string }) {
    const out = new Map<string, { taxpayerId: string; iuc: string; nomMasque: string; motifs: string[] }>();
    const push = (id: string, motif: string) => {
      if (id === q.exclure) return;
      const t = this.ctx.taxpayers.taxpayers.get(id);
      if (!t || t.status === 'FUSIONNE') return;
      const e = out.get(id) ?? { taxpayerId: id, iuc: t.iuc, nomMasque: nomMasque(t.fullName), motifs: [] };
      if (!e.motifs.includes(motif)) e.motifs.push(motif);
      out.set(id, e);
    };
    for (const id of q.autres ?? []) push(id, 'MEME_PIECE');
    const tel = q.telephone?.replace(/[\s-]/g, '');
    for (const t of this.ctx.taxpayers.taxpayers.all()) {
      if (tel && t.phone === tel) push(t.id, 'MEME_TELEPHONE');
      if (proximiteNoms(t.fullName, q.nom) >= 1) push(t.id, 'NOM_PROCHE');
    }
    return [...out.values()];
  }

  revues(user: User) {
    authorize(user, 'citoyen:pieces.revue');
    return this.controles.find((c) => c.statut === 'A_REVOIR').map((c) => ({ ...c, telephone: undefined, taxpayer: c.taxpayerId ? (() => { const t = this.ctx.taxpayers.taxpayers.get(c.taxpayerId!); return t ? { iuc: t.iuc, nomMasque: nomMasque(t.fullName), telephone: t.phone ? maskPhone(t.phone) : null } : null; })() : null }));
  }

  /** Décision humaine sur un cas à risque ; la validation passe par le contrôle de preuve (personne distincte). */
  decider(user: User, id: string, input: { decision: 'VALIDEE' | 'REJETEE' | 'COMPLEMENT_DEMANDE'; motif: string }) {
    authorize(user, 'citoyen:pieces.revue');
    const c = this.controles.get(id);
    if (!c) throw notFound('CONTROLE_INCONNU', `Contrôle inconnu : ${id}`);
    if (c.statut !== 'A_REVOIR' && c.statut !== 'CONFORME') throw conflict('DEJA_DECIDE', `Contrôle au statut ${c.statut}.`);
    const acces = accesOf(this.ctx);
    if (c.proofId && acces && input.decision !== 'COMPLEMENT_DEMANDE') acces.reviewProof(user, c.proofId, { decision: input.decision, note: input.motif });
    const out = this.controles.update({ ...c, statut: input.decision, decision: { par: user.id, at: this.now().toISOString(), motif: input.motif } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'enrolement.piece.decided', resourceType: 'identity_document', resourceId: id, details: { decision: input.decision, motif: input.motif, proofId: c.proofId ?? null } });
    return out;
  }
}
