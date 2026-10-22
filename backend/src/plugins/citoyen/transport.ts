/**
 * Module 12 — Autorisations de transport (Spécification fonctionnelle ; § 11.1 verticale Mobilité, § 19A).
 *
 * La demande et la décision motivée restent celles de la verticale Mobilité (démarche « Demander une autorisation de
 * transport », certificat TRP vérifiable par QR, condition « vignette valide » du moteur de dépendances). Ce service
 * ajoute le registre des licences de transport :
 *  - catégories : taxi, bus, minibus, moto-taxi, poids lourd ;
 *  - validité GÉOGRAPHIQUE (communes, corridor) et HORAIRE, évaluées à l'heure du serveur ;
 *  - carte conducteur rattachée au véhicule et à l'autorisation (QR signé, vérification publique minimale) ;
 *  - autorisation SANS RÈGLE PUBLIÉE IMPOSSIBLE : la licence reste « en attente de règle » (non opposable, grise au
 *    contrôle) tant qu'aucune règle ACTIVE du registre ne la fonde ;
 *  - contrôle par plaque ou QR : couleur (règle 50 % / 1 %) et temps restant, zone, horaire, vignette, carte ;
 *  - suspension UNIQUEMENT par décision motivée à deux personnes (proposition puis approbation), levée de même ;
 *  - renouvellement : rappel (phase ambre) et demande de renouvellement depuis l'application.
 * La taxe journalière des transports passe par la billetterie (module 76) sous réserve de base légale (J28).
 */
import { isRuleExecutable, normalizePlate } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { actorOf } from '../../core/audit.js';
import { kinshasaDate } from '../../core/clock.js';
import { hmacSha256Hex, checkChar } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, evaluate, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { validityView } from '../../core/validity.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import { COMMUNES } from '../../reference/kinshasa.js';
import { statusAt } from '../titres/validity.js';
import { fiscalOf, parDefaut, pct, titresOf, verticalesOf } from './common.js';

const { always, ownTaxpayer, mandant, inTerritory } = GRANTS;
definePolicy('citoyen:transport.gerer', { R06: always, R07: always, R11: always });
definePolicy('citoyen:transport.suspendre.proposer', { R07: always, R11: always });
definePolicy('citoyen:transport.suspendre.approuver', { R06: always, R07: always });
definePolicy('citoyen:transport.controler', { R06: always, R07: always, R11: always, R09: inTerritory('minimal'), R10: inTerritory('minimal') });
definePolicy('citoyen:transport.lire', { R30: ownTaxpayer, R31: mandant, R06: always, R07: always, R11: always, R22: always, R24: always, R01: always, R05: always });

export const CATEGORIES_TRANSPORT = ['TAXI', 'BUS', 'MINIBUS', 'MOTO_TAXI', 'POIDS_LOURD'] as const;
export type CategorieTransport = (typeof CATEGORIES_TRANSPORT)[number];
export const CATEGORIE_LIBELLE: Record<CategorieTransport, string> = { TAXI: 'Taxi', BUS: 'Bus', MINIBUS: 'Minibus', MOTO_TAXI: 'Moto-taxi', POIDS_LOURD: 'Poids lourd' };
/** Règle (registre) et titre (catalogue § 19A.4) fondant chaque licence. */
const FONDEMENT: Record<CategorieTransport, { regle: string; titre: string }> = {
  TAXI: { regle: 'LIC-TAXI', titre: 'LIC-TAXI' }, BUS: { regle: 'LIC-BUS', titre: 'LIC-BUS' }, MINIBUS: { regle: 'LIC-BUS', titre: 'LIC-BUS' },
  MOTO_TAXI: { regle: 'LIC-MOTO', titre: 'LIC-MOTO' }, POIDS_LOURD: { regle: 'LIC-POIDS-LOURD', titre: 'LIC-POIDS-LOURD' },
};

/** Fenêtre de rappel avant échéance (phase ambre des licences, § 19A.4 : 7 jours indicatifs) — à confirmer. */
export const RAPPEL_RENOUVELLEMENT_JOURS = parDefaut(7, 'Catalogue § 19A.4 — seuil d’ambre indicatif des licences');

export interface AutorisationTransport {
  id: string;
  certificatCode: string;
  categorie: CategorieTransport;
  plaque: string;
  vehiculeObjectId?: string;
  titulaireTaxpayerId: string;
  zones: string[];
  corridor?: string;
  horaires: { debut: string; fin: string };
  validFrom: string;
  validUntil: string;
  statut: 'EN_ATTENTE_REGLE' | 'ACTIVE' | 'SUSPENDUE' | 'RETIREE';
  regle?: { code: string; version: number };
  conditions: { code: string; label: string; met: boolean }[];
  suspension?: { proposee: { par: string; at: string; motif: string; decisionRef: string; action: 'SUSPENDRE' | 'LEVER' }; approuvee?: { par: string; at: string } };
  renouvelle?: string;
  rappelEnvoyeLe?: string;
  historique: { at: string; par: string; action: string; motif?: string }[];
  creeePar: string;
  creeeLe: string;
}

export interface CarteConducteur {
  id: string;
  numero: string;
  conducteurTaxpayerId: string;
  permisSha256: string;
  autorisationId: string;
  plaque: string;
  validUntil: string;
  statut: 'ACTIVE' | 'RETIREE';
  signature: string;
  emiseLe: string;
  emisePar: string;
}

export interface ControleTransport {
  id: string;
  at: string;
  par: string;
  plaque: string;
  commune: string;
  autorisationId: string | null;
  couleur: 'VERT' | 'AMBRE' | 'ROUGE' | 'GRIS';
  resultat: string;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class TransportService {
  readonly autorisations = new InMemoryRepository<AutorisationTransport>();
  readonly cartes = new InMemoryRepository<CarteConducteur>();
  readonly controles = new InMemoryAppendOnlyRepository<ControleTransport>();
  private readonly ids = new IdGenerator();
  private readonly cle: string;

  constructor(private readonly ctx: AppContext) {
    this.cle = hmacSha256Hex(ctx.secrets.auditHmacKey, 'mosolo:transport:carte-conducteur:v1');
  }

  private now() { return this.ctx.clock.now(); }
  private iso() { return this.now().toISOString(); }

  /** Règle ACTIVE du registre fondant la catégorie (sinon : autorisation non opposable). */
  regleActive(categorie: CategorieTransport) {
    const code = FONDEMENT[categorie].regle;
    return this.ctx.rules.list().filter((r) => r.code === code && isRuleExecutable(r, this.now()).ok).sort((a, b) => b.version - a.version)[0];
  }

  enregistrer(user: User, input: { certificatCode: string; categorie: CategorieTransport; plaque: string; zones: string[]; corridor?: string; horaires: { debut: string; fin: string }; renouvelle?: string }) {
    authorize(user, 'citoyen:transport.gerer');
    const vx = verticalesOf(this.ctx);
    const cert = vx?.certificates.get(input.certificatCode.trim().toUpperCase());
    if (!cert || cert.kind !== 'AUTORISATION_TRANSPORT') throw notFound('CERTIFICAT_INCONNU', 'Certificat d’autorisation de transport (TRP) introuvable : la décision motivée de la verticale Mobilité précède l’enregistrement.');
    if (vx!.certificateStatus(cert) === 'REVOQUE') throw conflict('CERTIFICAT_REVOQUE', 'Certificat révoqué.');
    if (this.autorisations.findOne((a) => a.certificatCode === cert.code && a.statut !== 'RETIREE')) throw conflict('DEJA_ENREGISTREE', 'Cette autorisation est déjà enregistrée.');
    const plaque = normalizePlate(input.plaque);
    if (plaque.length < 4) throw badRequest('INVALID_PLATE', 'Plaque illisible.');
    for (const z of input.zones) if (!COMMUNES.includes(z as (typeof COMMUNES)[number])) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${z}`);
    if (!HHMM.test(input.horaires.debut) || !HHMM.test(input.horaires.fin)) throw badRequest('HORAIRES_INVALIDES', 'Horaires HH:MM attendus.');
    // Condition « vignette valide » (moteur de dépendances) : bloquante seulement si l'acte est publié et activé.
    const fiscal = fiscalOf(this.ctx);
    const dep = fiscal ? fiscal.dependencies.evaluate('AUTORISATION_TRANSPORT', cert.taxpayerId, { plate: plaque }) : null;
    if (dep?.blocked) throw unprocessable('DEPENDANCE_NON_SATISFAITE', 'Autorisation conditionnée à la vignette valide (règle bloquante) : condition non remplie.', { conditions: dep.conditions });
    const regle = this.regleActive(input.categorie);
    const at = this.iso();
    const a = this.autorisations.insert({
      id: this.ids.next('ATR'), certificatCode: cert.code, categorie: input.categorie, plaque, ...(cert.objectId ? { vehiculeObjectId: cert.objectId } : {}),
      titulaireTaxpayerId: cert.taxpayerId, zones: input.zones, ...(input.corridor ? { corridor: input.corridor } : {}), horaires: input.horaires,
      validFrom: cert.validFrom, validUntil: cert.validUntil ?? `${this.now().getUTCFullYear()}-12-31`,
      statut: regle ? 'ACTIVE' : 'EN_ATTENTE_REGLE', ...(regle ? { regle: { code: regle.code, version: regle.version } } : {}),
      conditions: (dep?.conditions ?? []).map((c) => ({ code: c.code, label: `${c.label} — ${c.mode === 'INFORMATIF' ? 'informatif' : 'obligatoire'}`, met: c.satisfied })),
      ...(input.renouvelle ? { renouvelle: input.renouvelle } : {}),
      historique: [{ at, par: user.id, action: regle ? 'ENREGISTREE_ACTIVE' : 'ENREGISTREE_EN_ATTENTE_DE_REGLE' }], creeePar: user.id, creeeLe: at,
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'transport.authorization.registered', resourceType: 'transport_authorization', resourceId: a.id, details: { certificat: cert.code, categorie: a.categorie, statut: a.statut, zones: a.zones } });
    return this.vue(a);
  }

  /** Activation après publication d'une règle ACTIVE (sinon refus : autorisation sans règle publiée impossible). */
  activer(user: User, id: string) {
    authorize(user, 'citoyen:transport.gerer');
    const a = this.get(id);
    if (a.statut !== 'EN_ATTENTE_REGLE') throw conflict('ETAT_INVALIDE', `Autorisation au statut ${a.statut}.`);
    const regle = this.regleActive(a.categorie);
    if (!regle) throw unprocessable('REGLE_NON_PUBLIEE', `Autorisation sans règle publiée impossible : aucune règle ACTIVE « ${FONDEMENT[a.categorie].regle} » au registre.`);
    const out = this.autorisations.update({ ...a, statut: 'ACTIVE', regle: { code: regle.code, version: regle.version }, historique: [...a.historique, { at: this.iso(), par: user.id, action: 'ACTIVEE' }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'transport.authorization.activated', resourceType: 'transport_authorization', resourceId: id, details: { regle: regle.code, version: regle.version } });
    return this.vue(out);
  }

  get(id: string): AutorisationTransport {
    const a = this.autorisations.get(id);
    if (!a) throw notFound('AUTORISATION_INCONNUE', `Autorisation inconnue : ${id}`);
    return a;
  }

  vue(a: AutorisationTransport) {
    const validite = validityView(a.validFrom, a.validUntil, this.now());
    return {
      ...a, categorieLibelle: CATEGORIE_LIBELLE[a.categorie], validite,
      opposable: a.statut === 'ACTIVE',
      mention: a.statut === 'EN_ATTENTE_REGLE' ? `Non opposable : aucune règle ACTIVE « ${FONDEMENT[a.categorie].regle} » au registre (autorisation sans règle publiée impossible).` : null,
      cartes: this.cartes.find((c) => c.autorisationId === a.id).map((c) => ({ numero: c.numero, statut: c.statut, validUntil: c.validUntil })),
      taxeJournaliere: 'Titre journalier via la billetterie (module 76) — acte requis (J28), aucun montant.',
    };
  }

  liste(user: User) {
    if (user.roles.some((r) => r === 'R30' || r === 'R31')) {
      const tps = [user.taxpayerId, ...(user.mandants ?? [])].filter((x): x is string => !!x);
      return this.autorisations.find((a) => tps.includes(a.titulaireTaxpayerId) && !!evaluate(user, 'citoyen:transport.lire', { taxpayerId: a.titulaireTaxpayerId })).map((a) => this.vue(a));
    }
    authorize(user, 'citoyen:transport.lire');
    return this.autorisations.all().map((a) => this.vue(a));
  }

  // ─────────────── Carte conducteur ───────────────

  emettreCarte(user: User, autorisationId: string, input: { conducteurTaxpayerId: string; permisRef: string }) {
    authorize(user, 'citoyen:transport.gerer');
    const a = this.get(autorisationId);
    if (a.statut === 'RETIREE') throw conflict('AUTORISATION_RETIREE', 'Autorisation retirée.');
    this.ctx.taxpayers.get(input.conducteurTaxpayerId);
    if (this.cartes.findOne((c) => c.autorisationId === a.id && c.conducteurTaxpayerId === input.conducteurTaxpayerId && c.statut === 'ACTIVE')) throw conflict('CARTE_EXISTANTE', 'Ce conducteur a déjà une carte active pour cette autorisation.');
    const seq = this.ids.next('CCD', 5).split('-').pop()!;
    const year = this.now().getUTCFullYear();
    const numero = `CCD-${year}-${seq}-${checkChar(`CCD${year}${seq}`)}`;
    const permisSha256 = hmacSha256Hex(this.cle, input.permisRef.trim().toUpperCase());
    const c = this.cartes.insert({
      id: numero, numero, conducteurTaxpayerId: input.conducteurTaxpayerId, permisSha256, autorisationId: a.id, plaque: a.plaque, validUntil: a.validUntil,
      statut: 'ACTIVE', signature: this.signer(numero, a.plaque, a.validUntil), emiseLe: this.iso(), emisePar: user.id,
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'transport.driver_card.issued', resourceType: 'driver_card', resourceId: numero, details: { autorisation: a.id, plaque: a.plaque } });
    const tp = this.ctx.taxpayers.taxpayers.get(input.conducteurTaxpayerId);
    if (tp) this.ctx.comms.publish('permit.issued', [taxpayerRecipient(tp)], { reference: numero, validUntil: c.validUntil }, { entity: 'DGIPK' });
    return { numero: c.numero, plaque: c.plaque, validUntil: c.validUntil, qr: `MOSOLO-CCD|${c.numero}|${c.signature}` };
  }

  private signer(numero: string, plaque: string, until: string) {
    return hmacSha256Hex(this.cle, `${numero}|${plaque}|${until}`).slice(0, 24);
  }

  /** Vérification publique minimale d'une carte conducteur (ni nom, ni permis). */
  verifierCarte(numero: string, signature?: string) {
    const c = this.cartes.get(numero.trim().toUpperCase());
    if (!c) return { numero, authentique: false, message: 'Aucune carte ne correspond à ce numéro.' };
    const a = this.autorisations.get(c.autorisationId);
    const authentique = signature ? signature === c.signature : true;
    const validite = validityView(null, c.validUntil, this.now());
    const valide = c.statut === 'ACTIVE' && a?.statut === 'ACTIVE' && validite.band !== 'EXPIRE';
    this.ctx.audit.append({ actor: { kind: 'public', id: 'verification-publique' }, action: 'transport.driver_card.checked', resourceType: 'driver_card', resourceId: c.numero });
    return {
      numero: c.numero, authentique, plaqueMasquee: `${c.plaque.slice(0, 2)}•••${c.plaque.slice(-2)}`, categorie: a ? CATEGORIE_LIBELLE[a.categorie] : null,
      statut: c.statut === 'RETIREE' ? 'RETIREE' : a?.statut ?? 'INCONNUE', valide, validite,
      message: valide ? 'Carte authentique et en cours de validité.' : a?.statut === 'EN_ATTENTE_REGLE' ? 'Carte authentique ; autorisation non opposable (règle non publiée).' : 'Carte non valide.',
    };
  }

  // ─────────────── Contrôle ───────────────

  controler(user: User, input: { plaque?: string; qr?: string; commune: string }) {
    if (!COMMUNES.includes(input.commune as (typeof COMMUNES)[number])) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${input.commune}`);
    authorize(user, 'citoyen:transport.controler', { communes: [input.commune] });
    let plaque = input.plaque ? normalizePlate(input.plaque) : '';
    let carte: CarteConducteur | undefined;
    if (input.qr) {
      const [pfx, numero, sig] = input.qr.trim().split('|');
      if (pfx !== 'MOSOLO-CCD' || !numero) throw badRequest('QR_ILLISIBLE', 'QR de carte conducteur illisible.');
      carte = this.cartes.get(numero);
      if (!carte || carte.signature !== sig) throw forbidden('QR_NON_AUTHENTIQUE', 'QR non authentique.');
      plaque = carte.plaque;
    }
    if (plaque.length < 4) throw badRequest('INVALID_PLATE', 'Plaque ou QR requis.');
    const now = this.now();
    const a = this.autorisations.find((x) => x.plaque === plaque && x.statut !== 'RETIREE').sort((x, y) => y.validUntil.localeCompare(x.validUntil))[0];
    const heure = new Date(now.getTime() + 3_600_000).toISOString().slice(11, 16); // heure de Kinshasa (UTC+1)
    const titres = titresOf(this.ctx);
    const vig = titres ? titres.byPlate(plaque, '11').filter((c) => c.typeCode === 'VIG-ANNUELLE') : [];
    const vigType = titres?.types.findOne((t) => t.code === 'VIG-ANNUELLE');
    const vignette = vig.length
      ? { exigible: true, valide: vig.some((c) => ['VALIDE', 'BIENTOT_EXPIRE', 'CRITIQUE'].includes(statusAt(c, now).status)), texte: statusAt(vig[0]!, now).text }
      : { exigible: vigType?.legalAct?.status !== 'ACTE_REQUIS', valide: false, texte: vigType?.legalAct?.status === 'ACTE_REQUIS' ? 'Vignette non exigible : acte requis (J3).' : 'Aucune vignette enregistrée pour cette plaque.' };
    let couleur: ControleTransport['couleur'] = 'GRIS';
    let resultat = 'Aucune autorisation de transport enregistrée pour cette plaque.';
    let detail: Record<string, unknown> = {};
    if (a) {
      const v = validityView(a.validFrom, a.validUntil, now);
      const dansZone = a.zones.length === 0 || a.zones.includes(input.commune);
      const dansHoraire = a.horaires.debut <= a.horaires.fin ? heure >= a.horaires.debut && heure <= a.horaires.fin : heure >= a.horaires.debut || heure <= a.horaires.fin;
      const carteOk = carte ? carte.statut === 'ACTIVE' && carte.autorisationId === a.id : null;
      if (a.statut === 'EN_ATTENTE_REGLE') { couleur = 'GRIS'; resultat = 'Autorisation enregistrée, non opposable : aucune règle publiée.'; }
      else if (a.statut === 'SUSPENDUE') { couleur = 'ROUGE'; resultat = `SUSPENDUE — ${a.suspension?.proposee.motif ?? 'décision motivée'}`; }
      else if (v.band === 'EXPIRE') { couleur = 'ROUGE'; resultat = 'Autorisation échue.'; }
      else if (!dansZone) { couleur = 'ROUGE'; resultat = `Hors zone autorisée (${a.zones.join(', ')}).`; }
      else if (!dansHoraire) { couleur = 'ROUGE'; resultat = `Hors plage horaire (${a.horaires.debut}–${a.horaires.fin}).`; }
      else if (carteOk === false) { couleur = 'ROUGE'; resultat = 'Carte conducteur non valide pour ce véhicule.'; }
      else { couleur = v.band === 'VERT' ? 'VERT' : v.band === 'PAS_ACTIF' ? 'GRIS' : v.band === 'ROUGE' ? 'ROUGE' : 'AMBRE'; resultat = v.text; }
      detail = { autorisation: { id: a.id, categorie: CATEGORIE_LIBELLE[a.categorie], statut: a.statut, zones: a.zones, corridor: a.corridor ?? null, horaires: a.horaires }, validite: v, dansZone, dansHoraire, carte: carte ? { numero: carte.numero, valide: carteOk } : null };
    }
    const ctl = this.controles.append({ id: this.ids.next('CTR', 8), at: now.toISOString(), par: user.id, plaque, commune: input.commune, autorisationId: a?.id ?? null, couleur, resultat });
    this.ctx.audit.append({ actor: actorOf(user), action: 'transport.control.performed', resourceType: 'vehicle_plate', resourceId: plaque, details: { commune: input.commune, couleur, autorisation: a?.id ?? null } });
    return {
      controle: ctl.id, plaque, couleur, resultat, heureServeur: now.toISOString(), heureKinshasa: heure, vignette, ...detail,
      notice: 'Réponse minimale (ni nom ni adresse). Aucune sanction décidée par le système : un constat éventuel est instruit par une personne habilitée.',
    };
  }

  // ─────────────── Suspension motivée (deux personnes) ───────────────

  proposerSuspension(user: User, id: string, input: { action: 'SUSPENDRE' | 'LEVER'; motif: string; decisionRef: string }) {
    authorize(user, 'citoyen:transport.suspendre.proposer');
    const a = this.get(id);
    if (input.action === 'SUSPENDRE' && a.statut !== 'ACTIVE' && a.statut !== 'EN_ATTENTE_REGLE') throw conflict('ETAT_INVALIDE', `Autorisation au statut ${a.statut}.`);
    if (input.action === 'LEVER' && a.statut !== 'SUSPENDUE') throw conflict('ETAT_INVALIDE', 'Seule une autorisation suspendue peut être levée.');
    if (a.suspension && !a.suspension.approuvee) throw conflict('PROPOSITION_EN_ATTENTE', 'Une proposition attend déjà une approbation.');
    const out = this.autorisations.update({ ...a, suspension: { proposee: { par: user.id, at: this.iso(), motif: input.motif, decisionRef: input.decisionRef, action: input.action } }, historique: [...a.historique, { at: this.iso(), par: user.id, action: `${input.action}_PROPOSEE`, motif: input.motif }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'transport.suspension.proposed', resourceType: 'transport_authorization', resourceId: id, details: { action: input.action, motif: input.motif, decisionRef: input.decisionRef } });
    return this.vue(out);
  }

  approuverSuspension(user: User, id: string, input: { approuver: boolean; motif: string }) {
    authorize(user, 'citoyen:transport.suspendre.approuver');
    const a = this.get(id);
    const p = a.suspension?.proposee;
    if (!p || a.suspension?.approuvee) throw conflict('AUCUNE_PROPOSITION', 'Aucune proposition en attente.');
    assertDistinctPerson(user.id, [p.par], 'La décision est approuvée par une personne distincte de celle qui l’a proposée.');
    const at = this.iso();
    if (!input.approuver) {
      const { suspension: _s, ...rest } = a;
      void _s;
      const out = this.autorisations.update({ ...rest, historique: [...a.historique, { at, par: user.id, action: `${p.action}_REJETEE`, motif: input.motif }] });
      return this.vue(out);
    }
    const statut: AutorisationTransport['statut'] = p.action === 'SUSPENDRE' ? 'SUSPENDUE' : (this.regleActive(a.categorie) ? 'ACTIVE' : 'EN_ATTENTE_REGLE');
    const out = this.autorisations.update({ ...a, statut, suspension: { proposee: p, approuvee: { par: user.id, at } }, historique: [...a.historique, { at, par: user.id, action: p.action === 'SUSPENDRE' ? 'SUSPENDUE' : 'SUSPENSION_LEVEE', motif: input.motif }] });
    this.ctx.audit.append({ actor: actorOf(user), action: p.action === 'SUSPENDRE' ? 'transport.authorization.suspended' : 'transport.authorization.reinstated', resourceType: 'transport_authorization', resourceId: id, details: { motif: p.motif, decisionRef: p.decisionRef, approuvePar: user.id } });
    const tp = this.ctx.taxpayers.taxpayers.get(a.titulaireTaxpayerId);
    if (tp) this.ctx.comms.publish(p.action === 'SUSPENDRE' ? 'permit.suspended' : 'permit.renewed', [taxpayerRecipient(tp)], { reference: a.certificatCode }, { entity: 'DGIPK' });
    return this.vue(out);
  }

  // ─────────────── Renouvellement ───────────────

  /** Rappels (phase ambre) : une fois par autorisation, dans la fenêtre avant échéance. */
  rappels(): number {
    const now = this.now();
    const fenetre = RAPPEL_RENOUVELLEMENT_JOURS.valeur * 86_400_000;
    let n = 0;
    for (const a of this.autorisations.find((x) => x.statut === 'ACTIVE' && !x.rappelEnvoyeLe)) {
      const until = validityView(a.validFrom, a.validUntil, now);
      if (until.remainingSeconds !== null && until.remainingSeconds > 0 && until.remainingSeconds * 1000 <= fenetre) {
        this.autorisations.update({ ...a, rappelEnvoyeLe: now.toISOString() });
        const tp = this.ctx.taxpayers.taxpayers.get(a.titulaireTaxpayerId);
        if (tp) this.ctx.comms.publish('permit.expiring', [taxpayerRecipient(tp)], { reference: a.certificatCode }, { entity: 'DGIPK' });
        this.ctx.audit.append({ actor: { kind: 'system', id: 'transport' }, action: 'transport.renewal.reminder_sent', resourceType: 'transport_authorization', resourceId: a.id });
        n++;
      }
    }
    return n;
  }

  /** Demande de renouvellement depuis l'application : nouvelle démarche de la verticale Mobilité (instruction humaine). */
  demanderRenouvellement(user: User, id: string) {
    const a = this.get(id);
    authorize(user, 'citoyen:transport.lire', { taxpayerId: a.titulaireTaxpayerId });
    const vx = verticalesOf(this.ctx);
    if (!vx || !a.vehiculeObjectId) throw unprocessable('RENOUVELLEMENT_GUICHET', 'Renouvellement au guichet : véhicule non rattaché à l’autorisation.');
    const service = a.categorie;
    const demande = vx.submitCase(user, 'mobilite', {
      type: 'DEMANDE_AUTORISATION_TRANSPORT', taxpayerId: a.titulaireTaxpayerId, objectId: a.vehiculeObjectId,
      details: { service, itineraire: a.corridor ?? a.zones.join(', ') }, documents: [],
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'transport.renewal.requested', resourceType: 'transport_authorization', resourceId: a.id, details: { demande: demande.id } });
    return { demande: demande.id, autorisation: a.id, notice: 'Demande de renouvellement déposée : instruction et décision motivée par une personne habilitée.' };
  }

  /** Indicateurs du module 12. */
  indicateurs() {
    const all = this.autorisations.all();
    const now = this.now();
    const actives = all.filter((a) => a.statut === 'ACTIVE' && validityView(a.validFrom, a.validUntil, now).band !== 'EXPIRE');
    const ctl = this.controles.all().filter((c) => c.autorisationId);
    const conformes = ctl.filter((c) => c.couleur === 'VERT' || c.couleur === 'AMBRE');
    const renouvelees = all.filter((a) => a.renouvelle);
    const aTemps = renouvelees.filter((a) => { const prev = this.autorisations.get(a.renouvelle!); return !!prev && kinshasaDate(new Date(a.creeeLe)) <= prev.validUntil; });
    return {
      autorisationsActives: { valeur: actives.length, enAttenteDeRegle: all.filter((a) => a.statut === 'EN_ATTENTE_REGLE').length, suspendues: all.filter((a) => a.statut === 'SUSPENDUE').length },
      tauxConformiteControles: ctl.length ? { valeur: pct(conformes.length, ctl.length), numerateur: conformes.length, denominateur: ctl.length } : { valeur: null, raison: 'Aucun contrôle d’autorisation enregistré.' },
      renouvellementsATemps: renouvelees.length ? { valeur: pct(aTemps.length, renouvelees.length), numerateur: aTemps.length, denominateur: renouvelees.length } : { valeur: null, raison: 'Aucun renouvellement enregistré.' },
    };
  }
}
