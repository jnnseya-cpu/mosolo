/**
 * Service des « Agents IA de recettes » (01/10/2026). Chaque agent CALCULE des propositions à partir des données de
 * la plateforme (ou d'un lot importé et validé par deux personnes) ; une personne habilitée les accepte ou les écarte,
 * sur motif ; tout est journalisé. Aucune sanction, aucune liquidation, aucun enrôlement, aucun tarif n'est décidé
 * ici : les circuits existants (terrain, recouvrement, échéanciers, règles, recours) prennent le relais.
 * Montants : jamais affichés aux agents de terrain ; aucune donnée personnelle dans les propositions (identifiants
 * internes et communes seulement), sauf l'envoi d'un rappel décidé, qui passe par le service de communication.
 */
import { Money, normalizePlate, type CurrencyCode, type MoneyJSON, type RoleCode } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, kinshasaDay } from '../../core/clock.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import { COMMUNES } from '../../reference/kinshasa.js';
import type { Facts } from '../pilotage/facts.js';
import { isReconciled } from '../pilotage/ladder.js';
import { MIN_CONTRIBUTORS } from '../pilotage/transparency.js';
import type { PlanificationService } from '../pilotage/planification/service.js';
import type { PilotageService } from '../pilotage/service.js';
import {
  A_CONFIRMER, AGENTS_RECETTES, DOLEANCE_CATEGORIES, FAMILLES, PARAMETRES as P, SOURCES,
  type AgentRecetteCode, type DoleanceCategorie, type SourceKind,
} from './model.js';

export type StatutProposition = 'PROPOSEE' | 'ACCEPTEE' | 'ECARTEE' | 'REMPLACEE';
export interface Proposition {
  id: string;
  agent: AgentRecetteCode;
  lot: string;
  at: string;
  demandeePar: string;
  titre: string;
  detail: string;
  commune?: string;
  /** Montant en jeu (jamais montré aux agents de terrain). */
  montant?: MoneyJSON;
  /** Rang (les grands d'abord) quand l'agent classe. */
  rang?: number;
  cible?: { type: 'OBJET' | 'CONTRIBUABLE' | 'PAIEMENT' | 'REGLE' | 'OBLIGATION' | 'COMMUNE' | 'AGENT' | 'SOURCE'; id: string };
  /** Position proposée (découverte, tournée). */
  position?: { lat: number; lon: number };
  /** Ce qu'une acceptation déclenche (toujours décrit, jamais caché). */
  effet: string;
  lien?: string;
  statut: StatutProposition;
  decision?: { by: string; at: string; motif: string; resultat?: string };
}

export interface LigneSource { ref: string; lat?: number; lon?: number; commune?: string; plaque?: string; categorie?: string; operateur?: string; observe?: number; libelle?: string }
export interface LotSource {
  id: string; kind: SourceKind; libelle: string; reference: string; lignes: LigneSource[];
  statut: 'A_VALIDER' | 'VALIDE' | 'REJETE'; deposePar: string; deposeLe: string; validation?: { by: string; at: string; motif: string; approuve: boolean };
}

export interface Doleance {
  id: string; reference: string; at: string; auteur: string; commune: string; categorie: DoleanceCategorie; texte: string;
  /** Agent mis en cause (identifiant interne) : jamais informé de l'auteur. */
  agentId?: string;
  service: string; echeance: string; statut: 'OUVERTE' | 'REPONDUE'; reponse?: { by: string; at: string; texte: string };
}

const UNPAID = new Set(['EMISE', 'EXIGIBLE', 'PARTIELLEMENT_PAYEE', 'EN_RETARD']);
const minor = (m: MoneyJSON) => Money.fromJSON(m).minor;
const money = (v: bigint, c: CurrencyCode): MoneyJSON => Money.fromMinor(v, c).toJSON();
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const pct = (a: bigint, b: bigint) => (b > 0n ? Number((a * 1000n) / b) / 10 : null);
const distanceM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const R = 6_371_000; const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r; const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const plateOf = (attrs: Record<string, unknown>) => {
  const v = attrs.immatriculation ?? attrs.plaque ?? attrs.plate;
  return typeof v === 'string' ? normalizePlate(v) : null;
};

export class AgentsRecettesService {
  readonly propositions = new InMemoryRepository<Proposition>();
  readonly sources = new InMemoryRepository<LotSource>();
  readonly doleances = new InMemoryRepository<Doleance>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {}

  private now() { return this.ctx.clock.now().toISOString(); }
  private today() { return kinshasaDay(this.now()); }
  private audit(actor: User | { kind: 'ai'; id: string }, action: string, type: string, id: string, details: Record<string, unknown> = {}) {
    const a = 'roles' in actor ? { kind: 'user' as const, id: actor.id, roles: actor.roles } : { kind: 'system' as const, id: actor.id };
    this.ctx.audit.append({ actor: a, action, resourceType: type, resourceId: id, details });
  }
  private get pil() { return this.ctx.ext.pilotage as PilotageService | undefined; }
  private get planif() { return this.ctx.ext.planification as PlanificationService | undefined; }
  private facts(): Facts | null { return this.pil?.facts() ?? null; }
  private agent(code: string) {
    const a = AGENTS_RECETTES.find((x) => x.code === code);
    if (!a) throw notFound('AGENT_INCONNU', `Agent inconnu : ${code}`);
    return a;
  }

  // ———————————————————————————————————— catalogue et tableau de bord ————————————————————————————————————

  catalogue(user: User) {
    authorize(user, 'agents-recettes:read');
    const parAgent = (code: AgentRecetteCode) => this.propositions.find((p) => p.agent === code && p.statut !== 'REMPLACEE');
    return {
      doctrine: [
        'Plus de recettes de ceux qui devraient déjà payer et ne paient pas, et des fuites — jamais en alourdissant ceux qui paient.',
        'Aucune nouvelle charge sans acte signé : l’IA ne crée aucun impôt.',
        'Les grands d’abord : grandes entreprises, grands contrats, grosses dettes.',
        'Aider avant de punir : rappel, puis échéancier, puis pénalité ; sanctions décidées par une personne ; recours en un clic.',
        'L’IA propose, une personne décide ; données agrégées ; contrôle d’équité mensuel.',
      ],
      familles: Object.entries(FAMILLES).map(([code, f]) => ({ code, ...f })).sort((a, b) => a.ordre - b.ordre),
      agents: AGENTS_RECETTES.map((a) => {
        const ps = parAgent(a.code);
        return { ...a, propositions: { aDecider: ps.filter((p) => p.statut === 'PROPOSEE').length, acceptees: ps.filter((p) => p.statut === 'ACCEPTEE').length, ecartees: ps.filter((p) => p.statut === 'ECARTEE').length } };
      }),
      parametres: { valeurs: P, statut: A_CONFIRMER },
      sources: Object.entries(SOURCES).map(([kind, s]) => ({ kind, ...s, lots: this.sources.find((l) => l.kind === kind).length, valides: this.sources.find((l) => l.kind === kind && l.statut === 'VALIDE').length })),
    };
  }

  liste(user: User, code: string) {
    authorize(user, 'agents-recettes:read');
    const a = this.agent(code);
    const items = this.propositions.find((p) => p.agent === a.code && p.statut !== 'REMPLACEE').sort((x, y) => (x.rang ?? 1e9) - (y.rang ?? 1e9) || (x.at < y.at ? 1 : -1));
    return { agent: a, items };
  }

  /** Lance un agent : remplace ses propositions encore en attente par un nouveau lot. */
  lancer(user: User, code: string) {
    authorize(user, 'agents-recettes:run');
    const a = this.agent(code);
    if (a.mode === 'EXISTANT') throw badRequest('AGENT_EXISTANT', `« ${a.nom} » est un circuit déjà en service : ouvrir ${a.lien ?? 'son écran'}.`);
    if (a.mode === 'SIMULATION') throw badRequest('AGENT_SIMULATION', `« ${a.nom} » est un simulateur : utiliser sa simulation.`);
    const lot = this.ids.next('LOTIA');
    const brut = this.calculer(a.code, user);
    for (const old of this.propositions.find((p) => p.agent === a.code && p.statut === 'PROPOSEE')) this.propositions.update({ ...old, statut: 'REMPLACEE' });
    const at = this.now();
    const items = brut.map((b) => this.propositions.insert({ ...b, id: this.ids.next('PIA'), agent: a.code, lot, at, demandeePar: user.id, statut: 'PROPOSEE' }));
    this.audit({ kind: 'ai', id: `agent:${a.agentIa}` }, 'agents_recettes.propositions', 'agent_recette', a.code, { lot, demandeePar: user.id, nombre: items.length });
    return { agent: a, lot, items, note: items.length ? 'Propositions à décider par une personne habilitée.' : 'Aucune proposition : rien à signaler avec les données disponibles.' };
  }

  decider(user: User, id: string, input: { accepter: boolean; motif: string }) {
    authorize(user, 'agents-recettes:decide');
    const p = this.propositions.get(id);
    if (!p) throw notFound('PROPOSITION_INCONNUE', 'Proposition inconnue.');
    if (p.statut !== 'PROPOSEE') throw conflict('DEJA_DECIDEE', 'Proposition déjà décidée ou remplacée.');
    const motif = input.motif.trim();
    if (motif.length < 10) throw badRequest('MOTIF_REQUIRED', 'Motif d’au moins 10 caractères requis.');
    let resultat: string | undefined;
    if (input.accepter && p.agent === 'RAPPELS' && p.cible?.type === 'CONTRIBUABLE') resultat = this.envoyerRappel(p);
    const out = this.propositions.update({ ...p, statut: input.accepter ? 'ACCEPTEE' : 'ECARTEE', decision: { by: user.id, at: this.now(), motif, ...(resultat ? { resultat } : {}) } });
    this.audit(user, input.accepter ? 'agents_recettes.proposition.acceptee' : 'agents_recettes.proposition.ecartee', 'proposition_ia', p.id, { agent: p.agent, motif, effet: input.accepter ? p.effet : 'aucun', ...(resultat ? { resultat } : {}) });
    return out;
  }

  private envoyerRappel(p: Proposition): string {
    const tp = this.ctx.taxpayers.taxpayers.get(p.cible!.id);
    if (!tp) return 'Contribuable introuvable : aucun envoi.';
    const overdue = p.titre.startsWith('Impayé');
    const d = this.ctx.comms.publish(overdue ? 'obligation.overdue' : 'obligation.due_soon', [taxpayerRecipient(tp)], { amount: p.montant ? `${p.montant.amount} ${p.montant.currency}` : '', reference: p.id }, { entity: 'GOUVERNORAT' });
    return `${d.length} message(s) préparé(s) selon les préférences de la personne (${[...new Set(d.map((x) => x.channel))].join(', ') || 'aucun canal'}).`;
  }

  // ———————————————————————————————————————— calculs des agents ————————————————————————————————————————

  private calculer(code: AgentRecetteCode, user: User): Omit<Proposition, 'id' | 'agent' | 'lot' | 'at' | 'demandeePar' | 'statut'>[] {
    switch (code) {
      case 'DECOUVERTE_CROISEE': return this.decouverte();
      case 'GRANDS_CONTRATS': return this.grandsContrats();
      case 'RAPPELS': return this.rappels();
      case 'ECHEANCIERS': return this.echeanciers();
      case 'ANOMALIES_TERRAIN': return this.anomalies();
      case 'RAPPROCHEMENT': return this.aRapprocher();
      case 'PRIORITE_ARRIERES': return this.arrieres();
      case 'PREVISION_RECETTES': return this.prevision();
      case 'GARDIEN_LEGALITE': return this.legalite();
      case 'OU_VA_ARGENT': return this.ouVaArgentPropositions();
      case 'DOLEANCES': return this.doleancesAlertes();
      case 'HUMEUR': return this.humeurPropositions();
      case 'COPILOTE_TERRAIN': return this.tournee(user, true).arrets.map((a) => ({ titre: `Arrêt ${a.ordre} — ${a.motif}`, detail: `${a.commune}${a.quartier ? ` · ${a.quartier}` : ''}`, commune: a.commune, rang: a.ordre, ...(a.position ? { position: a.position } : {}), cible: a.cible, effet: 'Ajoute l’arrêt à la tournée proposée ; aucune action sans l’agent.', lien: '/agents-recettes/tournee' }));
      case 'EQUITE': return this.equitePropositions();
      default: return [];
    }
  }

  /** Découverte croisée : lignes des lots VALIDÉS absentes du registre (rayon par défaut, plaque inconnue). */
  private decouverte() {
    const objets = this.ctx.objects.objects.all();
    const plaques = new Set(objets.filter((o) => o.category === 'VEHICULE').map((o) => plateOf(o.attributes)).filter((x): x is string => !!x));
    const out: Omit<Proposition, 'id' | 'agent' | 'lot' | 'at' | 'demandeePar' | 'statut'>[] = [];
    for (const lot of this.sources.find((l) => l.statut === 'VALIDE' && SOURCES[l.kind].agent === 'DECOUVERTE_CROISEE')) {
      const cats = new Set(SOURCES[lot.kind].categories);
      for (const l of lot.lignes) {
        if (lot.kind === 'RELEVES_PLAQUES') {
          const pl = l.plaque ? normalizePlate(l.plaque) : '';
          if (!pl || plaques.has(pl)) continue;
          out.push({ titre: `Véhicule non enregistré (plaque relevée ${pl})`, detail: `${SOURCES[lot.kind].libelle} — lot ${lot.reference}, ligne ${l.ref}. Enrôlement à proposer au propriétaire lors du prochain contrôle.`, ...(l.commune ? { commune: l.commune } : {}), cible: { type: 'SOURCE', id: `${lot.id}:${l.ref}` }, effet: 'Ajoute la vérification à la tournée des agents ; aucun enrôlement automatique.', lien: '/terrain' });
          continue;
        }
        const pos = l.lat !== undefined && l.lon !== undefined ? { lat: l.lat, lon: l.lon } : null;
        if (pos) {
          const proche = objets.some((o) => cats.has(o.category) && distanceM(pos, { lat: o.lat, lon: o.lon }) <= P.rayonRapprochementM);
          if (proche) continue;
        }
        out.push({
          titre: `${lot.kind === 'MARCHANDS_MOBILE' ? 'Activité' : 'Bâtiment ou local'} absent du registre`,
          detail: `${SOURCES[lot.kind].libelle} — lot ${lot.reference}, ligne ${l.ref}${l.libelle ? ` (${l.libelle})` : ''}. ${pos ? `Aucun objet du registre à moins de ${P.rayonRapprochementM} m (${A_CONFIRMER}).` : 'Position non fournie : à relever sur le terrain.'}`,
          ...(l.commune ? { commune: l.commune } : {}), ...(pos ? { position: pos } : {}), cible: { type: 'SOURCE', id: `${lot.id}:${l.ref}` },
          effet: 'Ajoute la vérification à la tournée des agents de terrain ; enrôlement seulement après constat par un agent.', lien: '/terrain',
        });
      }
    }
    return out;
  }

  /** Grands contrats : nombre observé par opérateur et catégorie > nombre enregistré. */
  private grandsContrats() {
    const objets = this.ctx.objects.objects.all();
    const out: Omit<Proposition, 'id' | 'agent' | 'lot' | 'at' | 'demandeePar' | 'statut'>[] = [];
    for (const lot of this.sources.find((l) => l.statut === 'VALIDE' && l.kind === 'OBSERVATIONS_OPERATEURS')) {
      for (const l of lot.lignes) {
        if (!l.operateur || !l.observe) continue;
        const tp = this.ctx.taxpayers.taxpayers.get(l.operateur) ?? this.ctx.taxpayers.taxpayers.findOne((t) => t.iuc === l.operateur);
        const enregistres = tp ? objets.filter((o) => o.taxpayerId === tp.id && (!l.categorie || o.category === l.categorie)).length : 0;
        if (l.observe <= enregistres) continue;
        out.push({
          titre: `Écart déclaré / observé : ${l.observe - enregistres} ${l.categorie ?? 'élément(s)'} non déclaré(s)`,
          detail: `Opérateur ${tp ? tp.iuc : l.operateur} : ${l.observe} observé(s), ${enregistres} enregistré(s) — lot ${lot.reference}. Rappel de déclaration puis constat contradictoire.`,
          rang: 0, cible: { type: 'CONTRIBUABLE', id: tp?.id ?? l.operateur },
          effet: 'Ouvre un rappel de déclaration à l’opérateur ; liquidation seulement après constat contradictoire.', lien: '/grands-redevables',
        });
      }
    }
    return out.sort((a, b) => Number(b.titre.match(/(\d+)/)?.[1] ?? 0) - Number(a.titre.match(/(\d+)/)?.[1] ?? 0)).map((x, i) => ({ ...x, rang: i + 1 }));
  }

  private impayesParContribuable() {
    const today = this.today();
    const m = new Map<string, { ids: string[]; total: Map<CurrencyCode, bigint>; plusAncienne: string; enRetard: boolean; commune: string }>();
    for (const o of this.ctx.assessment.obligations.all()) {
      if (!UNPAID.has(o.status) || o.supersededBy) continue;
      const e = m.get(o.taxpayerId) ?? { ids: [] as string[], total: new Map<CurrencyCode, bigint>(), plusAncienne: o.dueDate, enRetard: false, commune: o.attribution?.commune ?? '' };
      e.ids.push(o.id);
      e.total.set(o.amount.currency as CurrencyCode, (e.total.get(o.amount.currency as CurrencyCode) ?? 0n) + minor(o.amount));
      if (o.dueDate < e.plusAncienne) e.plusAncienne = o.dueDate;
      if (o.dueDate < today) e.enRetard = true;
      m.set(o.taxpayerId, e);
    }
    return m;
  }
  private principal(total: Map<CurrencyCode, bigint>): MoneyJSON {
    const [c, v] = [...total.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1))[0] ?? ['CDF' as CurrencyCode, 0n];
    return money(v, c);
  }

  /** Rappels : échéance sous N jours ou dépassée ; un rappel par contribuable, au meilleur moment. */
  private rappels() {
    const today = this.today();
    const limite = kinshasaDay(new Date(Date.parse(`${today}T12:00:00Z`) + P.rappelAvantEcheanceJours * DAY_MS).toISOString());
    const out: Omit<Proposition, 'id' | 'agent' | 'lot' | 'at' | 'demandeePar' | 'statut'>[] = [];
    for (const [tpId, e] of this.impayesParContribuable()) {
      if (e.plusAncienne > limite) continue;
      const tp = this.ctx.taxpayers.taxpayers.get(tpId);
      if (!tp) continue;
      const jour = Number(today.slice(8, 10));
      const moment = e.enRetard ? (jour >= P.jourApresPaie || jour <= 5 ? 'maintenant (période de paie)' : `le ${P.jourApresPaie} du mois (après la paie, ${A_CONFIRMER})`) : 'maintenant (échéance proche)';
      out.push({
        titre: `${e.enRetard ? 'Impayé' : 'Échéance proche'} — ${e.ids.length} obligation(s)`,
        detail: `Langue : ${tp.language} · envoi conseillé : ${moment} · canaux selon les préférences de la personne · lien de paiement et code USSD inclus.`,
        commune: e.commune, montant: this.principal(e.total), cible: { type: 'CONTRIBUABLE', id: tpId },
        effet: 'Accepter envoie le rappel (préférences et consentements respectés).', lien: '/communications',
      });
    }
    return out.sort((a, b) => (minor(b.montant!) > minor(a.montant!) ? 1 : -1));
  }

  /** Échéanciers : retard ancien, aucun échéancier en vigueur ; proposition de N mensualités. */
  private echeanciers() {
    const today = this.today();
    const seuil = kinshasaDay(new Date(Date.parse(`${today}T12:00:00Z`) - P.echeancierRetardMinJours * DAY_MS).toISOString());
    const plans = ((this.ctx.ext.recouvrement as { plans?: { all(): { taxpayerId: string; status?: string }[] } } | undefined)?.plans?.all() ?? []);
    const avecPlan = new Set(plans.filter((p) => !['REFUSE', 'DEFAILLANT', 'CLOS'].includes(p.status ?? '')).map((p) => p.taxpayerId));
    const out: Omit<Proposition, 'id' | 'agent' | 'lot' | 'at' | 'demandeePar' | 'statut'>[] = [];
    for (const [tpId, e] of this.impayesParContribuable()) {
      if (!e.enRetard || e.plusAncienne > seuil || avecPlan.has(tpId)) continue;
      const tot = this.principal(e.total);
      const mens = money(minor(tot) / BigInt(P.echeancierMensualites), tot.currency as CurrencyCode);
      out.push({
        titre: `Échéancier proposé : ${P.echeancierMensualites} mensualités`,
        detail: `Retard depuis le ${e.plusAncienne} ; ${e.ids.length} obligation(s) ; mensualité indicative ${mens.amount} ${mens.currency} (${A_CONFIRMER}). Proposé AVANT toute pénalité.`,
        commune: e.commune, montant: tot, cible: { type: 'CONTRIBUABLE', id: tpId },
        effet: 'Ouvre la proposition dans le circuit des échéanciers du recouvrement ; décision par une personne habilitée.', lien: '/recouvrement',
      });
    }
    return out;
  }

  /** Écarts par zone (taux de recouvrement) et par agent (activité de contrôle) très inférieurs à la médiane. */
  private anomalies() {
    const out: Omit<Proposition, 'id' | 'agent' | 'lot' | 'at' | 'demandeePar' | 'statut'>[] = [];
    const f = this.facts();
    if (f) {
      const liq = new Map<string, bigint>(); const rec = new Map<string, bigint>();
      const parOb = new Map(f.obligations.filter((o) => !o.cancelled && o.dueDate <= this.today()).map((o) => [o.id, o]));
      for (const o of parOb.values()) liq.set(o.commune, (liq.get(o.commune) ?? 0n) + this.cdf(o.amount));
      for (const o of f.orders) { const ob = parOb.get(o.obligationId); if (ob && isReconciled(o)) rec.set(ob.commune, (rec.get(ob.commune) ?? 0n) + this.cdf(o.amount)); }
      const taux = [...liq.entries()].filter(([c]) => (COMMUNES as readonly string[]).includes(c)).map(([c, l]) => ({ c, t: pct(rec.get(c) ?? 0n, l) ?? 0 }));
      const med = median(taux.map((x) => x.t));
      for (const x of taux) if (med > 0 && x.t < med * P.seuilAnomalie) {
        out.push({ titre: `Zone à examiner : ${x.c}`, detail: `Taux de recouvrement ${x.t} % contre une médiane de ${med} % (seuil ${P.seuilAnomalie * 100} % de la médiane, ${A_CONFIRMER}).`, commune: x.c, cible: { type: 'COMMUNE', id: x.c }, effet: 'Ouvre un examen par la supervision ; aucune sanction.', lien: '/terrain/qualite' });
      }
    }
    const controls = ((this.ctx.ext.titres as { controls?: { all(): { controllerId: string; at?: string; createdAt?: string }[] } } | undefined)?.controls?.all() ?? []);
    const depuis = new Date(Date.parse(this.now()) - 30 * DAY_MS).toISOString();
    const parAgent = new Map<string, number>();
    for (const u of this.ctx.users.all().filter((x) => x.roles.some((r) => ['R09', 'R10'].includes(r)))) parAgent.set(u.id, 0);
    for (const c of controls) { const at = c.at ?? c.createdAt ?? ''; if (at >= depuis && parAgent.has(c.controllerId)) parAgent.set(c.controllerId, parAgent.get(c.controllerId)! + 1); }
    const med = median([...parAgent.values()]);
    for (const [id, n] of parAgent) if (med > 0 && n < med * P.seuilAnomalie) {
      out.push({ titre: `Agent à accompagner : ${id}`, detail: `${n} contrôle(s) en 30 jours contre une médiane de ${med} chez ses pairs. Accompagnement d’abord ; toute mesure relève de l’autorité compétente.`, cible: { type: 'AGENT', id }, effet: 'Signale à la hiérarchie ; aucune sanction automatique.', lien: '/terrain/supervision' });
    }
    return out;
  }
  private cdf(m: MoneyJSON): bigint { return m.currency === 'CDF' ? minor(m) : minor(this.ctx.fx.convert(m, 'CDF').amount); }

  /** Paiements confirmés non rapprochés au-delà du délai. */
  private aRapprocher() {
    const limite = new Date(Date.parse(this.now()) - P.rapprochementJours * DAY_MS).toISOString();
    return this.ctx.payments.orders.all()
      .filter((o) => ['CONFIRME', 'REGLE'].includes(o.status) && o.confirmedAt && o.confirmedAt < limite)
      .sort((a, b) => (a.confirmedAt! < b.confirmedAt! ? -1 : 1))
      .map((o, i) => ({
        titre: `Paiement ${o.paymentReference} non rapproché`, detail: `Confirmé le ${kinshasaDay(o.confirmedAt!)} (${o.provider ?? o.channel}) ; délai de ${P.rapprochementJours} jours dépassé : réclamer le relevé au prestataire ou à la banque.`,
        montant: o.amount, rang: i + 1, cible: { type: 'PAIEMENT' as const, id: o.id }, effet: 'Ouvre la réclamation du relevé ; la quittance reste provisoire jusqu’au rapprochement.', lien: '/tresor',
      }));
  }

  /** Arriérés : les grands débiteurs d'abord (montant, puis capacité apparente). */
  private arrieres() {
    const objets = new Map<string, number>();
    for (const o of this.ctx.objects.objects.all()) if (o.taxpayerId) objets.set(o.taxpayerId, (objets.get(o.taxpayerId) ?? 0) + 1);
    const payes = new Map<string, number>();
    for (const o of this.ctx.payments.orders.all()) if (o.status === 'RAPPROCHE') payes.set(o.taxpayerId, (payes.get(o.taxpayerId) ?? 0) + 1);
    return [...this.impayesParContribuable().entries()].filter(([, e]) => e.enRetard)
      .map(([tpId, e]) => ({ tpId, e, tot: this.principal(e.total) }))
      .sort((a, b) => (this.cdf(b.tot) > this.cdf(a.tot) ? 1 : this.cdf(b.tot) < this.cdf(a.tot) ? -1 : (objets.get(b.tpId) ?? 0) - (objets.get(a.tpId) ?? 0)))
      .slice(0, P.arrieresMax)
      .map((x, i) => ({
        titre: `Arriéré n° ${i + 1}`, detail: `${x.e.ids.length} obligation(s) en retard depuis le ${x.e.plusAncienne} · ${objets.get(x.tpId) ?? 0} objet(s) · ${payes.get(x.tpId) ?? 0} paiement(s) rapproché(s) par le passé (capacité apparente).`,
        commune: x.e.commune, montant: x.tot, rang: i + 1, cible: { type: 'CONTRIBUABLE' as const, id: x.tpId },
        effet: 'Ouvre un dossier dans le recouvrement gradué (rappel, échéancier, puis mesure décidée par une personne).', lien: '/recouvrement',
      }));
  }

  /** Prévision : moyenne mobile des 3 derniers mois de recettes rapprochées, par devise. */
  prevision() {
    const f = this.facts();
    if (!f) return [];
    const parMois = new Map<string, Map<CurrencyCode, bigint>>();
    for (const o of f.orders) {
      if (!isReconciled(o)) continue;
      const mois = kinshasaDay(o.reconciledAt!).slice(0, 7);
      const m = parMois.get(mois) ?? new Map(); m.set(o.amount.currency as CurrencyCode, (m.get(o.amount.currency as CurrencyCode) ?? 0n) + minor(o.amount)); parMois.set(mois, m);
    }
    const mois = [...parMois.keys()].sort();
    const devises = [...new Set(mois.flatMap((m) => [...parMois.get(m)!.keys()]))];
    const today = this.today();
    const prochains = Array.from({ length: P.previsionMois }, (_, i) => { const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 + i + 1, 1)); return d.toISOString().slice(0, 7); });
    return devises.flatMap((c) => {
      const serie = mois.map((m) => parMois.get(m)!.get(c) ?? 0n).slice(-3);
      const moy = serie.length ? serie.reduce((a, b) => a + b, 0n) / BigInt(serie.length) : 0n;
      return prochains.map((m, i) => ({
        titre: `Prévision ${m} (${c})`, detail: `Moyenne mobile des ${serie.length} dernier(s) mois rapproché(s) — méthode ${A_CONFIRMER}. Une prévision n’est jamais une recette.`,
        montant: money(moy, c), rang: i + 1, effet: 'Information pour le budget ; aucune écriture.',
      }));
    });
  }

  /** Légalité : règles actives sans texte valide ; obligations ouvertes sur règle non active ; doubles impositions. */
  private legalite() {
    const out: Omit<Proposition, 'id' | 'agent' | 'lot' | 'at' | 'demandeePar' | 'statut'>[] = [];
    const rules = this.ctx.rules.list();
    const instr = this.ctx.rules.instruments;
    for (const r of rules.filter((x) => x.status === 'ACTIVE')) {
      const bad = (r.legalInstrumentIds ?? []).filter((id) => { const i = instr.get(id); return !i || i.status === 'ABROGE'; });
      if (!r.legalInstrumentIds?.length || bad.length) out.push({ titre: `Règle ${r.code} sans base légale valide`, detail: bad.length ? `Texte(s) abrogé(s) ou inconnu(s) : ${bad.join(', ')}.` : 'Aucun texte cité.', cible: { type: 'REGLE', id: r.id }, effet: 'Propose la suspension de la règle par le circuit des règles (deux personnes).', lien: '/registre' });
    }
    const byId = new Map(rules.map((r) => [r.id, r]));
    const vus = new Map<string, string>();
    for (const o of this.ctx.assessment.obligations.all()) {
      if (!UNPAID.has(o.status) || o.supersededBy) continue;
      const r = byId.get(o.ruleId);
      if (r && r.status !== 'ACTIVE') out.push({ titre: `Obligation sur règle non active (${r.code})`, detail: `Règle à l’état ${r.status} ; recouvrement à suspendre jusqu’à vérification.`, commune: o.attribution?.commune ?? '', montant: o.amount, cible: { type: 'OBLIGATION', id: o.id }, effet: 'Propose la suspension du recouvrement de cette obligation ; décision par une personne.', lien: '/recouvrement' });
      const key = `${o.objectId}|${o.ruleCode}|${o.dueDate}`;
      const prev = vus.get(key);
      if (prev) out.push({ titre: `Double imposition possible (${o.ruleCode})`, detail: `Même objet, même règle, même échéance que ${prev}.`, commune: o.attribution?.commune ?? '', montant: o.amount, cible: { type: 'OBLIGATION', id: o.id }, effet: 'Propose l’annulation du doublon par rectification (deux personnes).', lien: '/recouvrement' });
      else vus.set(key, o.id);
    }
    return out;
  }

  // ————————————————————————————————————— simulations (sans proposition) —————————————————————————————————————

  /** Fenêtre de régularisation : montants en jeu, pénalités remises, recouvrement attendu au taux observé. */
  simulerRegularisation(user: User, input: { fenetreJours: number; remisePenalitesPct: number; devise: CurrencyCode }) {
    authorize(user, 'agents-recettes:read');
    const today = this.today();
    let principal = 0n; let penalites = 0n; let dossiers = 0;
    const tps = new Set<string>();
    for (const o of this.ctx.assessment.obligations.all()) {
      if (!UNPAID.has(o.status) || o.supersededBy || o.dueDate >= today || o.amount.currency !== input.devise) continue;
      const penal = /PENAL|AMENDE/i.test(`${o.revenueCategory} ${o.ruleCode} ${o.label}`);
      if (penal) penalites += minor(o.amount); else principal += minor(o.amount);
      dossiers += 1; tps.add(o.taxpayerId);
    }
    // Taux observé : part des obligations échues qui ont été payées après leur échéance.
    const f = this.facts();
    const echues = (f?.obligations ?? []).filter((o) => !o.cancelled && o.dueDate < today);
    const payeesApres = echues.filter((o) => o.paidAt && kinshasaDay(o.paidAt) > o.dueDate).length;
    const enRetardAuMoinsUneFois = echues.filter((o) => !o.paidAt || kinshasaDay(o.paidAt) > o.dueDate).length;
    const taux = enRetardAuMoinsUneFois ? payeesApres / enRetardAuMoinsUneFois : null;
    const remise = (penalites * BigInt(Math.round(input.remisePenalitesPct))) / 100n;
    const attendu = taux === null ? null : (principal * BigInt(Math.round(taux * 1000))) / 1000n;
    this.audit(user, 'agents_recettes.simulation.regularisation', 'simulation', input.devise, { ...input, dossiers });
    return {
      fenetreJours: input.fenetreJours, remisePenalitesPct: input.remisePenalitesPct, devise: input.devise,
      dossiers, contribuables: tps.size, principalEnRetard: money(principal, input.devise), penalitesEnRetard: money(penalites, input.devise), penalitesRemises: money(remise, input.devise),
      tauxObserve: taux === null ? null : Math.round(taux * 1000) / 10,
      recouvrementAttenduBorneBasse: attendu === null ? null : money(attendu, input.devise),
      note: `Borne basse au taux de paiement après échéance observé ; l’effet propre d’une fenêtre (hausse du taux) n’est pas inventé : il sera mesuré après une fenêtre pilote. Toute remise exige un acte. Fenêtre et remise : ${A_CONFIRMER}.`,
    };
  }

  /** Impact d'une variation de tarif sur une règle : par commune et par rang de localité ; alerte sur les rangs modestes. */
  simulerImpact(user: User, input: { ruleCode: string; variationPct: number }) {
    authorize(user, 'agents-recettes:read');
    const obs = this.ctx.assessment.obligations.all().filter((o) => o.ruleCode === input.ruleCode && o.status !== 'ANNULEE' && !o.supersededBy);
    if (!obs.length) throw notFound('AUCUNE_OBLIGATION', `Aucune obligation pour la règle ${input.ruleCode}.`);
    const objets = new Map(this.ctx.objects.objects.all().map((o) => [o.id, o]));
    const parCommune = new Map<string, { n: Set<string>; avant: bigint }>();
    const parRang = new Map<number, { n: Set<string>; avant: bigint }>();
    const c = obs[0]!.amount.currency as CurrencyCode;
    for (const o of obs) {
      if (o.amount.currency !== c) continue;
      const com = o.attribution?.commune ?? 'Non attribuée';
      const rang = objets.get(o.objectId)?.localityRank ?? 0;
      const pc = parCommune.get(com) ?? { n: new Set(), avant: 0n }; pc.n.add(o.taxpayerId); pc.avant += minor(o.amount); parCommune.set(com, pc);
      const pr = parRang.get(rang) ?? { n: new Set(), avant: 0n }; pr.n.add(o.taxpayerId); pr.avant += minor(o.amount); parRang.set(rang, pr);
    }
    const apres = (v: bigint) => (v * BigInt(Math.round(100_00 + input.variationPct * 100))) / 100_00n;
    const lignes = (m: Map<string | number, { n: Set<string>; avant: bigint }>) => [...m.entries()].map(([k, v]) => ({ cle: k, contribuables: v.n.size, avant: money(v.avant, c), apres: money(apres(v.avant), c), hausseMoyenne: money(v.n.size ? (apres(v.avant) - v.avant) / BigInt(v.n.size) : 0n, c) }));
    const modestes = [...parRang.entries()].filter(([r]) => r >= 3).reduce((a, [, v]) => a + v.n.size, 0);
    const total = new Set(obs.map((o) => o.taxpayerId)).size;
    this.audit(user, 'agents_recettes.simulation.impact', 'simulation', input.ruleCode, input);
    return {
      ruleCode: input.ruleCode, variationPct: input.variationPct, devise: c, contribuables: total,
      parCommune: lignes(parCommune as Map<string | number, { n: Set<string>; avant: bigint }>),
      parRang: lignes(parRang as Map<string | number, { n: Set<string>; avant: bigint }>).sort((a, b) => Number(a.cle) - Number(b.cle)),
      alerte: input.variationPct > 0 && modestes > 0 ? `${modestes} contribuable(s) sur ${total} dans des localités de rang 3 ou 4 (les plus modestes) : vérifier leur capacité contributive ; envisager un barème différencié par rang.` : null,
      note: 'Simulation seulement : tout changement de tarif passe par le circuit des règles (quatre visas) et un acte signé.',
    };
  }

  // ———————————————————————————————————————— où va votre argent ————————————————————————————————————————

  /** Page publique : recettes rapprochées par commune (≥ 5 contribuables) et réalisations financées sur acte. */
  ouVaArgent() {
    const f = this.facts();
    const parCommune = new Map<string, { contribuables: Set<string>; montants: Map<CurrencyCode, bigint> }>();
    const obCommune = new Map((f?.obligations ?? []).map((o) => [o.id, o.commune]));
    for (const o of f?.orders ?? []) {
      if (!isReconciled(o)) continue;
      const com = obCommune.get(o.obligationId) ?? o.commune;
      if (!(COMMUNES as readonly string[]).includes(com)) continue;
      const e = parCommune.get(com) ?? { contribuables: new Set(), montants: new Map() };
      e.contribuables.add(o.taxpayerId); e.montants.set(o.amount.currency as CurrencyCode, (e.montants.get(o.amount.currency as CurrencyCode) ?? 0n) + minor(o.amount));
      parCommune.set(com, e);
    }
    const projets = (this.planif?.projects.all() ?? []).filter((p) => ['FINANCE', 'EN_COURS', 'ACHEVE'].includes(p.status) && !p.example);
    const communes = [...COMMUNES].map((com) => {
      const e = parCommune.get(com);
      const publiable = !!e && e.contribuables.size >= MIN_CONTRIBUTORS;
      return {
        commune: com, publiable,
        recettes: publiable ? [...e!.montants.entries()].map(([c, v]) => money(v, c)) : [],
        motif: publiable ? null : `Moins de ${MIN_CONTRIBUTORS} contribuables : non publié (protection des personnes).`,
        realisations: projets.filter((p) => p.communes.includes(com)).map((p) => ({ titre: p.title, statut: p.status, avancement: p.progressPct ?? null, acte: p.funding?.decisionReference ?? null })),
      };
    });
    return { generatedAt: this.now(), communes, note: 'Recettes rapprochées (relevé bancaire) et réalisations financées sur acte budgétaire ; aucune donnée individuelle.' };
  }
  private ouVaArgentPropositions() {
    return this.ouVaArgent().communes.filter((c) => c.publiable && c.realisations.length === 0).map((c) => ({
      titre: `Commune sans réalisation publiée : ${c.commune}`, detail: 'Des recettes y sont collectées mais aucune réalisation financée n’y est encore publiée : montrer un résultat visible renforce l’acceptation de l’impôt.',
      commune: c.commune, cible: { type: 'COMMUNE' as const, id: c.commune }, effet: 'Signale à la direction ; aucune dépense décidée ici.', lien: '/ou-va-votre-argent',
    }));
  }

  // ———————————————————————————————————————————— doléances ————————————————————————————————————————————

  deposerDoleance(user: User, input: { commune: string; categorie: DoleanceCategorie; texte: string; agentId?: string }) {
    authorize(user, 'agents-recettes:doleance.deposer');
    if (!(COMMUNES as readonly string[]).includes(input.commune)) throw badRequest('COMMUNE_INCONNUE', 'Commune inconnue.');
    const cat = DOLEANCE_CATEGORIES[input.categorie];
    const n = this.doleances.count() + 1;
    const d = this.doleances.insert({
      id: this.ids.next('DOL'), reference: `DOL-${this.today().slice(0, 4)}-${String(n).padStart(5, '0')}`, at: this.now(), auteur: user.id, commune: input.commune,
      categorie: input.categorie, texte: input.texte.trim(), ...(input.agentId ? { agentId: input.agentId } : {}), service: cat.service,
      echeance: kinshasaDay(new Date(Date.parse(this.now()) + P.doleanceDelaiJours * DAY_MS).toISOString()), statut: 'OUVERTE',
    });
    this.audit(user, 'agents_recettes.doleance.deposee', 'doleance', d.id, { categorie: d.categorie, commune: d.commune, service: d.service });
    return { ...this.vueAuteur(d), circuit: cat.circuit ?? null };
  }
  private vueAuteur(d: Doleance) { return { id: d.id, reference: d.reference, at: d.at, commune: d.commune, categorie: d.categorie, libelle: DOLEANCE_CATEGORIES[d.categorie].libelle, service: d.service, echeance: d.echeance, statut: d.statut, reponse: d.reponse ? { at: d.reponse.at, texte: d.reponse.texte } : null }; }
  mesDoleances(user: User) {
    authorize(user, 'agents-recettes:doleance.deposer');
    return { items: this.doleances.find((d) => d.auteur === user.id).map((d) => this.vueAuteur(d)), categories: DOLEANCE_CATEGORIES, delaiJours: P.doleanceDelaiJours, statutDelai: A_CONFIRMER };
  }
  listeDoleances(user: User) {
    authorize(user, 'agents-recettes:doleance.traiter');
    const today = this.today();
    // L'auteur n'est jamais montré (protection contre les représailles) ; l'agent mis en cause ne voit pas ses doléances.
    const items = this.doleances.all().filter((d) => d.agentId !== user.id).map((d) => ({ ...this.vueAuteur(d), agentId: d.agentId ?? null, texte: d.texte, enRetard: d.statut === 'OUVERTE' && d.echeance < today }));
    return { items, alertes: this.alertesDoleances() };
  }
  repondreDoleance(user: User, id: string, texte: string) {
    authorize(user, 'agents-recettes:doleance.traiter');
    const d = this.doleances.get(id);
    if (!d) throw notFound('DOLEANCE_INCONNUE', 'Doléance inconnue.');
    if (d.agentId === user.id) throw forbidden('CONFLIT_INTERET', 'L’agent mis en cause ne traite pas la doléance qui le concerne.');
    if (d.statut !== 'OUVERTE') throw conflict('DEJA_REPONDUE', 'Doléance déjà traitée.');
    if (texte.trim().length < 10) throw badRequest('REPONSE_REQUISE', 'Réponse d’au moins 10 caractères.');
    const out = this.doleances.update({ ...d, statut: 'REPONDUE', reponse: { by: user.id, at: this.now(), texte: texte.trim() } });
    this.audit(user, 'agents_recettes.doleance.repondue', 'doleance', d.id, { delaiRespecte: kinshasaDay(this.now()) <= d.echeance });
    return this.vueAuteur(out);
  }
  private alertesDoleances() {
    const depuis = new Date(Date.parse(this.now()) - 30 * DAY_MS).toISOString();
    const recentes = this.doleances.find((d) => d.at >= depuis);
    const alerte = (cle: (d: Doleance) => string | undefined, type: 'COMMUNE' | 'AGENT') => {
      const m = new Map<string, number>();
      for (const d of recentes) { const k = cle(d); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
      const base = type === 'COMMUNE' ? [...COMMUNES].map((c) => m.get(c) ?? 0) : [...m.values()];
      const med = Math.max(1, median(base));
      return [...m.entries()].filter(([, n]) => n >= med * P.doleanceAlerteMultiple && n >= 2).map(([k, n]) => ({ type, id: k, doleances: n, mediane: med }));
    };
    return [...alerte((d) => d.commune, 'COMMUNE'), ...alerte((d) => d.agentId, 'AGENT')];
  }
  private doleancesAlertes() {
    return this.alertesDoleances().map((a) => ({
      titre: a.type === 'COMMUNE' ? `Doléances inhabituelles : ${a.id}` : `Doléances visant l’agent ${a.id}`,
      detail: `${a.doleances} doléance(s) en 30 jours (médiane ${a.mediane}, seuil ×${P.doleanceAlerteMultiple}, ${A_CONFIRMER}).`,
      ...(a.type === 'COMMUNE' ? { commune: a.id } : {}), cible: { type: a.type, id: a.id },
      effet: a.type === 'AGENT' ? 'Signale à l’intégrité ; l’auteur des doléances n’est jamais révélé ; aucune sanction automatique.' : 'Signale à la direction pour réponse dans la commune.', lien: '/agents-recettes',
    }));
  }

  // ———————————————————————————————————— baromètre du mécontentement ————————————————————————————————————

  humeur(user: User) {
    authorize(user, 'agents-recettes:read');
    const depuis = new Date(Date.parse(this.now()) - 30 * DAY_MS).toISOString();
    const doleances = new Map<string, number>();
    for (const d of this.doleances.find((x) => x.at >= depuis)) doleances.set(d.commune, (doleances.get(d.commune) ?? 0) + 1);
    const obCommune = new Map(this.ctx.assessment.obligations.all().map((o) => [o.id, o.attribution?.commune ?? '']));
    const recours = new Map<string, number>();
    for (const a of this.ctx.appeals.appeals.all()) if (a.submittedAt >= depuis) { const c = obCommune.get(a.obligationId) ?? ''; recours.set(c, (recours.get(c) ?? 0) + 1); }
    const sat = (this.planif?.satisfaction.all() ?? []).filter((s) => s.at >= depuis);
    const communes = [...COMMUNES].map((c) => {
      const signaux = (doleances.get(c) ?? 0) + (recours.get(c) ?? 0);
      return { commune: c, doleances: doleances.get(c) ?? 0, recours: recours.get(c) ?? 0, signaux, niveau: signaux >= P.humeurAlerte ? 'ALERTE' : signaux >= P.humeurAttention ? 'ATTENTION' : 'CALME' };
    }).sort((a, b) => b.signaux - a.signaux);
    return {
      periode: '30 derniers jours', communes,
      satisfaction: { reponses: sat.length, noteMoyenne: sat.length ? Math.round((sat.reduce((a, s) => a + s.note, 0) / sat.length) * 10) / 10 : null },
      seuils: { attention: P.humeurAttention, alerte: P.humeurAlerte, statut: A_CONFIRMER },
      note: 'Signaux agrégés par commune (doléances, recours) ; aucun individu suivi, aucune opinion individuelle collectée.',
    };
  }
  private humeurPropositions() {
    return this.humeur({ kind: 'user', id: 'agent:HUMEUR', name: 'agent', roles: ['R01'], entity: 'GOUVERNORAT' } as User).communes.filter((c) => c.niveau !== 'CALME').map((c) => ({
      titre: `${c.niveau === 'ALERTE' ? 'Alerte' : 'Attention'} : ${c.commune}`, detail: `${c.doleances} doléance(s) et ${c.recours} recours en 30 jours. Écouter avant d’agir : réunion avec les autorités locales, explication des charges, réponse aux doléances.`,
      commune: c.commune, cible: { type: 'COMMUNE' as const, id: c.commune }, effet: 'Signale à la direction ; aucune mesure automatique.',
    }));
  }

  // ———————————————————————————————————————— copilote de terrain ————————————————————————————————————————

  /** Tournée du jour : objets impayés et découvertes acceptées dans le territoire de l'agent ; sans montant. */
  tournee(user: User, pourDirection = false) {
    if (!pourDirection) authorize(user, 'agents-recettes:tournee');
    const communes = user.territory?.length ? new Set(user.territory) : null;
    const objets = new Map(this.ctx.objects.objects.all().map((o) => [o.id, o]));
    const impayes = new Map<string, { objetId: string; montantCdf: bigint }>();
    for (const o of this.ctx.assessment.obligations.all()) {
      if (!UNPAID.has(o.status) || o.supersededBy || o.dueDate >= this.today()) continue;
      const e = impayes.get(o.objectId) ?? { objetId: o.objectId, montantCdf: 0n }; e.montantCdf += this.cdf(o.amount); impayes.set(o.objectId, e);
    }
    type Arret = { commune: string; quartier?: string; position?: { lat: number; lon: number }; motif: string; poids: bigint; cible: { type: 'OBJET' | 'SOURCE'; id: string } };
    const candidats: Arret[] = [];
    for (const i of impayes.values()) {
      const o = objets.get(i.objetId);
      if (!o || (communes && !communes.has(o.commune))) continue;
      candidats.push({ commune: o.commune, quartier: o.quartier, position: { lat: o.lat, lon: o.lon }, motif: `Objet impayé à visiter (${o.category})`, poids: i.montantCdf, cible: { type: 'OBJET', id: o.id } });
    }
    for (const p of this.propositions.find((x) => x.agent === 'DECOUVERTE_CROISEE' && x.statut === 'ACCEPTEE')) {
      if (communes && p.commune && !communes.has(p.commune)) continue;
      candidats.push({ commune: p.commune ?? '—', ...(p.position ? { position: p.position } : {}), motif: `Élément découvert à confirmer : ${p.titre}`, poids: 0n, cible: { type: 'SOURCE', id: p.cible?.id ?? p.id } });
    }
    // Les plus gros enjeux d'abord, puis ordre de passage au plus proche voisin.
    const choisis = candidats.sort((a, b) => (b.poids > a.poids ? 1 : b.poids < a.poids ? -1 : 0)).slice(0, P.copiloteArrets);
    const ordre: Arret[] = [];
    const reste = [...choisis];
    let cur = reste.shift();
    while (cur) {
      ordre.push(cur);
      const from = cur.position;
      if (!from) { cur = reste.shift(); continue; }
      let best = -1; let bd = Infinity;
      reste.forEach((r, i) => { if (r.position) { const d = distanceM(from, r.position); if (d < bd) { bd = d; best = i; } } });
      cur = best >= 0 ? reste.splice(best, 1)[0] : reste.shift();
    }
    return {
      agent: user.id, communes: communes ? [...communes] : 'toute la province',
      arrets: ordre.map((a, i) => ({ ordre: i + 1, commune: a.commune, ...(a.quartier ? { quartier: a.quartier } : {}), ...(a.position ? { position: a.position } : {}), motif: a.motif, cible: a.cible })),
      rappel: ['Jamais d’espèces : la personne paie sur son téléphone (monnaie mobile, USSD) ou à un point agréé.', 'Aucun montant affiché à l’agent de terrain.', 'Constat d’abord ; enrôlement et liquidation par les circuits habituels.'],
    };
  }

  // ———————————————————————————————————————— contrôle d'équité ————————————————————————————————————————

  equite(user: User) {
    authorize(user, 'agents-recettes:read');
    const depuis = new Date(Date.parse(this.now()) - 30 * DAY_MS).toISOString();
    const props = this.propositions.find((p) => p.at >= depuis && p.statut !== 'REMPLACEE' && !!p.commune && p.agent !== 'EQUITE' && p.agent !== 'PREVISION_RECETTES');
    const objets = this.ctx.objects.objects.all();
    const lignes = [...COMMUNES].map((c) => {
      const pp = props.filter((p) => p.commune === c).length; const po = objets.filter((o) => o.commune === c).length;
      const partP = props.length ? pp / props.length : 0; const partO = objets.length ? po / objets.length : 0;
      const ratio = partO > 0 ? Math.round((partP / partO) * 100) / 100 : pp > 0 ? Infinity : 0;
      return { commune: c, propositions: pp, objets: po, partPropositionsPct: Math.round(partP * 1000) / 10, partRegistrePct: Math.round(partO * 1000) / 10, ratio: Number.isFinite(ratio) ? ratio : null, signale: props.length >= 10 && (ratio > P.equiteRatio) };
    });
    return { periode: '30 derniers jours', propositions: props.length, seuilRatio: P.equiteRatio, statut: A_CONFIRMER, lignes, note: 'Signalement à la direction quand une commune reçoit nettement plus de propositions que son poids dans le registre (10 propositions au moins).' };
  }
  private equitePropositions() {
    return this.equite({ kind: 'user', id: 'agent:EQUITE', name: 'agent', roles: ['R01'], entity: 'GOUVERNORAT' } as User).lignes.filter((l) => l.signale).map((l) => ({
      titre: `Équité à examiner : ${l.commune}`, detail: `${l.partPropositionsPct} % des propositions de l’IA pour ${l.partRegistrePct} % du registre (ratio ${l.ratio}, seuil ${P.equiteRatio}).`,
      commune: l.commune, cible: { type: 'COMMUNE' as const, id: l.commune }, effet: 'Signale à la direction pour vérifier que l’IA ne cible pas injustement cette commune.',
    }));
  }

  // ———————————————————————————————————————— sources externes ————————————————————————————————————————

  deposerSource(user: User, input: { kind: SourceKind; reference: string; lignes: LigneSource[] }) {
    authorize(user, 'agents-recettes:source.deposer');
    if (!input.lignes.length) throw badRequest('LOT_VIDE', 'Lot vide.');
    const lot = this.sources.insert({ id: this.ids.next('SRC'), kind: input.kind, libelle: SOURCES[input.kind].libelle, reference: input.reference.trim(), lignes: input.lignes, statut: 'A_VALIDER', deposePar: user.id, deposeLe: this.now() });
    this.audit(user, 'agents_recettes.source.deposee', 'source', lot.id, { kind: lot.kind, lignes: lot.lignes.length, reference: lot.reference });
    return lot;
  }
  validerSource(user: User, id: string, input: { approuver: boolean; motif: string }) {
    authorize(user, 'agents-recettes:source.valider');
    const lot = this.sources.get(id);
    if (!lot) throw notFound('LOT_INCONNU', 'Lot inconnu.');
    if (lot.statut !== 'A_VALIDER') throw conflict('DEJA_VALIDE', 'Lot déjà traité.');
    assertDistinctPerson(user.id, [lot.deposePar], 'La validation d’un lot est faite par une personne distincte de celle qui l’a déposé.');
    if (input.motif.trim().length < 10) throw badRequest('MOTIF_REQUIRED', 'Motif d’au moins 10 caractères requis.');
    const out = this.sources.update({ ...lot, statut: input.approuver ? 'VALIDE' : 'REJETE', validation: { by: user.id, at: this.now(), motif: input.motif.trim(), approuve: input.approuver } });
    this.audit(user, 'agents_recettes.source.validee', 'source', lot.id, { approuve: input.approuver, motif: input.motif.trim() });
    return out;
  }
  // ———————————————————————————————————————— démonstration ————————————————————————————————————————

  /**
   * Lots de démonstration [EXEMPLE] (non contractuels) déposés et validés par deux personnes distinctes du jeu de
   * démonstration, et deux doléances fictives : montrent chaque agent en action. Jamais en mode production.
   */
  seedDemo(): void {
    if (this.ctx.demoData === false || this.sources.count() > 0) return;
    const dep = this.ctx.users.get('u-dg-dgipk'); const val = this.ctx.users.get('u-auditeur'); const usager = this.ctx.users.get('u-contribuable');
    if (!dep || !val) return;
    const motif = '[EXEMPLE] Lot de démonstration non contractuel';
    const lot = (kind: SourceKind, reference: string, lignes: LigneSource[]) => { const l = this.deposerSource(dep, { kind, reference, lignes }); this.validerSource(val, l.id, { approuver: true, motif }); };
    lot('SNEL', '[EXEMPLE] Extrait SNEL fictif — Limete et Gombe', [
      { ref: 'SNEL-EX-001', lat: -4.3651, lon: 15.3462, commune: 'Limete', libelle: 'Raccordement sans objet au registre' },
      { ref: 'SNEL-EX-002', lat: -4.3049, lon: 15.3088, commune: 'Gombe', libelle: 'Raccordement sans objet au registre' },
    ]);
    lot('IMAGERIE_BATIMENTS', '[EXEMPLE] Imagerie fictive — Kalamu', [{ ref: 'IMG-EX-001', lat: -4.3522, lon: 15.3125, commune: 'Kalamu', libelle: 'Toiture détectée' }]);
    lot('RELEVES_PLAQUES', '[EXEMPLE] Plaques relevées fictives — point de contrôle Limete', [{ ref: 'PL-EX-001', plaque: '9999AB01', commune: 'Limete' }, { ref: 'PL-EX-002', plaque: '9998AB01', commune: 'Limete' }]);
    const panneaux = new Map<string, number>();
    for (const o of this.ctx.objects.objects.all()) if (o.taxpayerId && o.category === 'PANNEAU') panneaux.set(o.taxpayerId, (panneaux.get(o.taxpayerId) ?? 0) + 1);
    const [op, n] = [...panneaux.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (op) lot('OBSERVATIONS_OPERATEURS', '[EXEMPLE] Relevé fictif des panneaux publicitaires', [{ ref: 'OBS-EX-001', operateur: op, categorie: 'PANNEAU', observe: (n ?? 0) + 3 }]);
    if (usager) {
      this.deposerDoleance(usager, { commune: 'Limete', categorie: 'SERVICE', texte: '[EXEMPLE] Attente très longue au guichet de la commune (doléance fictive).' });
      this.deposerDoleance(usager, { commune: 'Limete', categorie: 'PAIEMENT', texte: '[EXEMPLE] Paiement par monnaie mobile non encore pris en compte (doléance fictive).' });
    }
  }

  listeSources(user: User) {
    authorize(user, 'agents-recettes:read');
    return { items: this.sources.all().map((l) => ({ ...l, lignes: l.lignes.length })), types: SOURCES };
  }
}

export type AgentsRecettesRoles = RoleCode;
