/**
 * Module 5 — Portail web public (Spécification fonctionnelle ; § 27.3, § 12A.1).
 *
 *  - Simulateurs (impôt foncier, IRL, vignette, patente) calculés sur les RÈGLES DU REGISTRE, sans enregistrer de donnée
 *    personnelle : seules la famille et la règle utilisées sont comptées (indicateur « simulations »). Une règle ACTIVE
 *    donne un montant INDICATIF ; une fiche « À VÉRIFIER » ne donne qu'une ILLUSTRATION NON OPPOSABLE ; sans règle
 *    (acte requis), la simulation est indisponible — jamais un taux inventé.
 *  - Information : guides par profil, textes applicables, calendrier fiscal (issu des fiches de règles), points de paiement.
 *  - Protection anti-robots : défi de calcul (preuve de travail SHA-256) à usage unique, exigé sur les formulaires publics
 *    (inscription, récupération de compte, simulation) — sans traceur ni service tiers.
 *  - Mesure d'audience anonyme (visites par page et par jour, sans cookie ni adresse) pour les indicateurs du module.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { ENROLMENT_PROFILES, isRuleExecutable, Money, type RuleSheet } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { kinshasaDate } from '../../core/clock.js';
import { ApiError, badRequest, notFound } from '../../core/errors.js';
import { InMemoryRepository } from '../../core/repository.js';
import { parDefaut, pct, titresOf } from './common.js';

export const FAMILLES_SIMULATION = ['IMPOT_FONCIER', 'IRL', 'VIGNETTE', 'PATENTE'] as const;
export type FamilleSimulation = (typeof FAMILLES_SIMULATION)[number];

const FAMILLE: Record<FamilleSimulation, { libelle: string; prefixes: string[]; titre?: string; acte: string }> = {
  IMPOT_FONCIER: { libelle: 'Impôt foncier', prefixes: ['IF-', 'DEMO-IF'], acte: 'Fiches IF du registre (Annexe B)' },
  IRL: { libelle: 'Impôt sur les revenus locatifs (IRL)', prefixes: ['IRL-'], acte: 'Fiches IRL du registre (Annexe B)' },
  VIGNETTE: { libelle: 'Vignette automobile', prefixes: ['VIG-'], titre: 'VIG-ANNUELLE', acte: 'J3 — barèmes véhicules à certifier' },
  PATENTE: { libelle: 'Patente', prefixes: ['PAT-'], titre: 'PAT-ANNUELLE', acte: 'J1 — taxe d’intérêt commun à certifier' },
};

/** Difficulté du défi anti-robots (bits nuls en tête de l'empreinte) — valeur par défaut à confirmer. */
export const DIFFICULTE_DEFI = parDefaut(12, 'Spécification fonctionnelle, module 5 — protection anti-robots');
const DUREE_DEFI_MS = 5 * 60_000;

/** Formulaires publics protégés par le défi (méthode + chemin exact). */
const PROTEGES: { method: string; path: string }[] = [
  { method: 'POST', path: '/v1/registrations' },
  { method: 'POST', path: '/v1/public/enrolement/recuperations' },
  { method: 'POST', path: '/v1/public/simulations' },
];

/** Vérifications publiques comptées (actions d'audit des routes publiques de vérification). */
export const ACTIONS_VERIFICATION = ['receipt.verified', 'titres.status.checked', 'object.plate.public_check', 'proof.verified', 'clearance.checked'];

interface Defi { id: string; sel: string; difficulte: number; expiresAt: string; usedAt?: string }
interface Visite { id: string; jour: string; page: string; nombre: number; /** Instant et rang dans le journal d'audit de la première visite comptée (début de mesure). */ premiereA?: string; premiereSeq?: number }

export const PAGES_PUBLIQUES = ['accueil', 'informations', 'simulateurs', 'verifier', 'transparence', 'points-de-paiement', 'inscription'] as const;

export class PortailPublicService {
  readonly defis = new InMemoryRepository<Defi>();
  readonly visites = new InMemoryRepository<Visite>();
  /** Activation du défi : désactivé sous les tests (sauf MOSOLO_ANTI_ROBOT=on), actif ailleurs sauf MOSOLO_ANTI_ROBOT=off. */
  antiRobot: boolean;

  constructor(private readonly ctx: AppContext, env: NodeJS.ProcessEnv = process.env) {
    const flag = (env.MOSOLO_ANTI_ROBOT ?? '').trim().toLowerCase();
    this.antiRobot = flag === 'off' ? false : flag === 'on' ? true : !env.VITEST;
  }

  // ─────────────── Défi anti-robots ───────────────

  nouveauDefi() {
    const now = this.ctx.clock.now();
    for (const d of this.defis.find((x) => new Date(x.expiresAt).getTime() < now.getTime() - DUREE_DEFI_MS)) this.defis.update({ ...d, usedAt: d.usedAt ?? d.expiresAt });
    const d = this.defis.insert({ id: `DEF-${randomBytes(9).toString('base64url')}`, sel: randomBytes(16).toString('hex'), difficulte: DIFFICULTE_DEFI.valeur, expiresAt: new Date(now.getTime() + DUREE_DEFI_MS).toISOString() });
    return { id: d.id, sel: d.sel, difficulte: d.difficulte, algorithme: 'SHA-256(sel:nonce) — bits nuls en tête', expiresAt: d.expiresAt, parametre: DIFFICULTE_DEFI };
  }

  /** Vérifie `x-mosolo-defi: <id>:<nonce>` ; usage unique. */
  verifierDefi(valeur: string | undefined): void {
    if (!valeur) throw new ApiError(428, 'DEFI_REQUIS', 'Protection anti-robots : demandez un défi (GET /v1/public/defi) et joignez sa solution (en-tête x-mosolo-defi).');
    const [id, nonce] = valeur.split(':');
    const d = id ? this.defis.get(id) : undefined;
    if (!d || !nonce || nonce.length > 40) throw new ApiError(428, 'DEFI_INVALIDE', 'Défi inconnu ou solution illisible : demandez un nouveau défi.');
    if (d.usedAt) throw new ApiError(428, 'DEFI_DEJA_UTILISE', 'Ce défi a déjà servi : demandez-en un nouveau.');
    if (this.ctx.clock.now().getTime() > new Date(d.expiresAt).getTime()) throw new ApiError(428, 'DEFI_EXPIRE', 'Défi expiré : demandez-en un nouveau.');
    if (!solutionValide(d.sel, nonce, d.difficulte)) throw new ApiError(428, 'DEFI_NON_RESOLU', 'Solution du défi incorrecte.');
    this.defis.update({ ...d, usedAt: this.ctx.clock.now().toISOString() });
  }

  /** Garde des formulaires publics (appelée avant chaque requête). */
  garde(req: FastifyRequest): void {
    if (!this.antiRobot) return;
    const path = req.url.split('?')[0];
    if (!PROTEGES.some((p) => p.method === req.method && p.path === path)) return;
    // Un agent authentifié (guichet, enrôlement assisté) n'est pas un robot : le défi vise le public anonyme.
    if (req.user) return;
    const v = req.headers['x-mosolo-defi'];
    this.verifierDefi(Array.isArray(v) ? v[0] : v);
  }

  // ─────────────── Mesure d'audience anonyme ───────────────

  visite(page: string) {
    if (!(PAGES_PUBLIQUES as readonly string[]).includes(page)) throw badRequest('PAGE_INCONNUE', 'Page publique inconnue.');
    const jour = kinshasaDate(this.ctx.clock.now());
    const id = `${jour}:${page}`;
    const v = this.visites.get(id);
    if (v) this.visites.update({ ...v, nombre: v.nombre + 1 });
    else this.visites.insert({ id, jour, page, nombre: 1, premiereA: this.ctx.clock.now().toISOString(), premiereSeq: this.ctx.audit.list({ limit: 1 }).total });
    return { enregistre: true };
  }

  // ─────────────── Simulateurs ───────────────

  private regles(famille: FamilleSimulation): RuleSheet[] {
    const f = FAMILLE[famille];
    const latest = new Map<string, RuleSheet>();
    for (const r of this.ctx.rules.list()) {
      if (!f.prefixes.some((p) => r.code.startsWith(p))) continue;
      if (['ABROGEE', 'ARCHIVEE', 'EXPIREE', 'BROUILLON'].includes(r.status)) continue;
      const prev = latest.get(r.code);
      // Priorité à la version exécutable, puis à la plus récente.
      const exec = (x: RuleSheet) => isRuleExecutable(x, this.ctx.clock.now()).ok;
      if (!prev || (exec(r) && !exec(prev)) || (exec(r) === exec(prev) && r.version > prev.version)) latest.set(r.code, r);
    }
    return [...latest.values()];
  }

  catalogue() {
    return {
      familles: FAMILLES_SIMULATION.map((famille) => {
        const f = FAMILLE[famille];
        const regles = this.regles(famille).map((r) => ({
          code: r.code, version: r.version, libelle: r.label, statut: r.status, base: r.baseDefinition, entrees: this.ctx.rules.requiredInputs(r),
          rangs: [...new Set(Object.keys(r.rateTable).filter((k) => k.includes(':')).map((k) => Number(k.split(':')[1])))].sort(),
          nature: this.nature(r),
        }));
        const titre = f.titre ? titresOf(this.ctx)?.types.findOne((t) => t.code === f.titre) : undefined;
        return {
          famille, libelle: f.libelle, regles,
          disponible: regles.length > 0,
          motifIndisponible: regles.length ? null : `Aucune règle publiée au registre pour ${f.libelle.toLowerCase()} — ${f.acte}${titre ? ` (titre ${titre.code} : ${titre.legalAct?.status ?? 'ACTE_REQUIS'})` : ''}. Aucun montant n’est simulé sans règle.`,
        };
      }),
      avertissement: 'Simulation sans enregistrement de données personnelles. Le montant simulé n’est ni un avis ni une dette : seule une liquidation sur une règle ACTIVE crée une obligation.',
    };
  }

  private nature(r: RuleSheet): 'INDICATIF' | 'ILLUSTRATION_NON_OPPOSABLE' | 'INDISPONIBLE' {
    if (isRuleExecutable(r, this.ctx.clock.now()).ok) return 'INDICATIF';
    if (r.status === 'A_VERIFIER' || r.status === 'PUBLIEE' || r.status === 'APPROUVEE') return 'ILLUSTRATION_NON_OPPOSABLE';
    return 'INDISPONIBLE';
  }

  simuler(input: { famille: FamilleSimulation; regle?: string; rang?: number; entrees: Record<string, string> }) {
    const regles = this.regles(input.famille);
    if (!regles.length) {
      this.compterSimulation(input.famille, null, 'INDISPONIBLE');
      const c = this.catalogue().familles.find((f) => f.famille === input.famille)!;
      return { famille: input.famille, nature: 'INDISPONIBLE' as const, montant: null, motif: c.motifIndisponible, avertissement: this.catalogue().avertissement };
    }
    const r = input.regle ? regles.find((x) => x.code === input.regle) : regles[0];
    if (!r) throw notFound('REGLE_INCONNUE', `Règle inconnue pour ${input.famille} : ${input.regle}`);
    const nature = this.nature(r);
    if (nature === 'INDISPONIBLE') {
      this.compterSimulation(input.famille, r.code, nature);
      return { famille: input.famille, regle: { code: r.code, version: r.version, statut: r.status }, nature, montant: null, motif: `Règle au statut ${r.status} : aucune simulation.`, avertissement: this.catalogue().avertissement };
    }
    const rang = input.rang ?? 1;
    const ev = this.ctx.rules.evaluate(r, input.entrees, rang);
    const montant = Money.of(ev.value, r.currency, r.rounding).toJSON();
    this.compterSimulation(input.famille, r.code, nature);
    return {
      famille: input.famille, nature, montant,
      regle: { code: r.code, version: r.version, libelle: r.label, statut: r.status, formule: r.formula, base: r.baseDefinition, articles: r.articles, source: r.sourceVerification, voieDeRecours: r.appealPath },
      rang, entrees: ev.inputs, taux: ev.rates,
      mention: nature === 'INDICATIF'
        ? `Montant indicatif calculé sur la règle ACTIVE ${r.code} v${r.version}${(r as { demo?: boolean }).demo ? ' (règle fictive de démonstration, non opposable)' : ''}.`
        : `Illustration NON OPPOSABLE : fiche ${r.code} v${r.version} au statut ${r.status} (source : ${r.sourceVerification}) — taux à vérifier, aucune obligation.`,
      avertissement: this.catalogue().avertissement,
    };
  }

  private compterSimulation(famille: string, regle: string | null, nature: string) {
    this.ctx.audit.append({ actor: { kind: 'public', id: 'portail-public' }, action: 'portail.simulation.computed', resourceType: 'simulation', resourceId: famille, details: { regle, nature } });
  }

  // ─────────────── Information ───────────────

  informations() {
    const rules = this.ctx.rules.list().filter((r) => !['BROUILLON', 'ARCHIVEE'].includes(r.status));
    const instruments = this.ctx.rules.instruments.all();
    const calendrier = rules
      .filter((r) => ['ACTIVE', 'PUBLIEE', 'A_VERIFIER'].includes(r.status) && r.revenueCategory !== 'ACTE_REQUIS')
      .map((r) => ({ regle: r.code, version: r.version, libelle: r.label, periodicite: r.periodicity, echeance: r.dueRule, dateEffet: r.effectiveFrom, statut: r.status, aVerifier: r.status !== 'ACTIVE' }))
      .sort((a, b) => a.libelle.localeCompare(b.libelle, 'fr'));
    return {
      guides: ENROLMENT_PROFILES.map((p) => ({
        profil: p.code, libelle: p.label, obligations: p.obligations, pieces: p.fields.map((f) => f.label), nifAttendu: p.nifExpected,
        rappel: 'Déclarer un profil ouvre une instruction : ni propriété ni dette. Inscription et démarches gratuites ; aucun agent n’encaisse d’espèces.',
      })),
      textes: {
        instruments: instruments.map((i) => ({ id: i.id, titre: i.title, statut: i.status, abrogeLe: i.abrogatedOn ?? null, demo: !!i.demo })),
        regles: rules.map((r) => ({ code: r.code, version: r.version, libelle: r.label, statut: r.status, articles: r.articles, source: r.sourceVerification })),
      },
      calendrier: { echeances: calendrier, mention: 'Échéances issues des fiches du registre ; une fiche non ACTIVE porte une échéance à vérifier, sans effet.' },
      pointsDePaiement: { route: '/v1/public/payment-points', ecran: '/points-de-paiement' },
    };
  }

  // ─────────────── Indicateurs du module 5 ───────────────

  indicateurs() {
    const visites = this.visites.all();
    const total = visites.reduce((s, v) => s + v.nombre, 0);
    const parPage = Object.fromEntries(PAGES_PUBLIQUES.map((p) => [p, visites.filter((v) => v.page === p).reduce((s, v) => s + v.nombre, 0)]));
    const simulations = this.ctx.audit.list({ action: 'portail.simulation.computed', limit: 1 }).total;
    const verifications = ACTIONS_VERIFICATION.reduce((s, a) => s + this.ctx.audit.list({ action: a, limit: 1 }).total, 0);
    // Conversion : seules les inscriptions faites depuis le premier jour de mesure des visites sont rapportées aux
    // visites (même période) — sinon le taux dépasserait 100 % en mélangeant l'historique et la mesure récente.
    const premiere = [...visites].sort((a, b) => (a.premiereSeq ?? 0) - (b.premiereSeq ?? 0))[0];
    const debutMesure = premiere ? premiere.premiereA ?? `${premiere.jour}T00:00:00.000+01:00` : null;
    const toutes = this.ctx.audit.list({ action: 'account.registration.requested', limit: 100_000 }).items;
    const inscriptions = premiere ? toutes.filter((r) => r.seq > (premiere.premiereSeq ?? 0)).length : 0;
    return {
      visites: { valeur: total, parPage },
      simulations: { valeur: simulations },
      verifications: { valeur: verifications, actions: ACTIONS_VERIFICATION },
      conversionInscription: total > 0
        ? { valeur: pct(inscriptions, total), numerateur: inscriptions, denominateur: total, depuis: debutMesure, inscriptionsAvantMesure: toutes.length - inscriptions }
        : { valeur: null, numerateur: inscriptions, denominateur: 0, raison: 'Aucune visite mesurée sur la période : conversion non mesurée.' },
    };
  }
}

/** La solution est valide si SHA-256(sel:nonce) commence par `difficulte` bits nuls. */
export function solutionValide(sel: string, nonce: string, difficulte: number): boolean {
  const h = createHash('sha256').update(`${sel}:${nonce}`).digest();
  let bits = 0;
  for (const byte of h) {
    if (byte === 0) { bits += 8; if (bits >= difficulte) return true; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits >= difficulte;
}

/** Résolution (tests, clients sans WebCrypto) : premier nonce valide. */
export function resoudreDefi(sel: string, difficulte: number): string {
  for (let n = 0; n < 50_000_000; n++) if (solutionValide(sel, String(n), difficulte)) return String(n);
  throw new Error('Défi non résolu');
}
