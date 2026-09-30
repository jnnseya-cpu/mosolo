/**
 * Service du programme (Document maître FR 2, ch. 41 à 48) : registre des risques revu par une personne, recette
 * (critères d'acceptation, récits, stratégie de tests et suivis du monde réel), plan de livraison par versions,
 * plan des 100 premiers jours, registre des dix décisions du Gouvernement provincial, exportation signée de la carte
 * des écarts du Gouverneur. Aucune action financière ; aucune décision automatique : l'état des verrous de la
 * plateforme est CALCULÉ (lecture), jamais forcé par une décision enregistrée ici.
 */
import { SIX_ETATS, type RoleCode } from '@mosolo/shared';
import type { AppContext } from '../../../context.js';
import type { User } from '../../../core/auth.js';
import { DAY_MS, kinshasaDay } from '../../../core/clock.js';
import { badRequest, conflict, forbidden, notFound } from '../../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../../core/policy.js';
import { InMemoryRepository } from '../../../core/repository.js';
import { COMMUNES } from '../../../reference/kinshasa.js';
import { etatFonction, pointJuridiqueTranche, recoupementDonneesAutorise } from '../../juridique/gates.js';
import { aiguillerRecette } from '../../fiscal/aiguillage.js';
import { ExportSigner, EXPORT_KEY_ID, jsonPayload } from '../exports.js';
import { isReconciled } from '../ladder.js';
import { CurrencyTotals } from '../money.js';
import type { PlanificationService } from '../planification/service.js';
import { PILOT_COMMUNES } from '../planification/model.js';
import type { PilotageService } from '../service.js';
import {
  CONTRADICTION_SIGNALEE, CRITERES_42, DECISIONS_48, DEVISE_FR2, ETATS_ACTION, ETATS_SUIVI, ETATS_VERSION, IMPACTS, PAR_DEFAUT, PERIODICITE_REVUE_JOURS,
  PLAN_100_JOURS_47, PROBABILITES, PROGRAMME_ROUTIER, RECITS_43, RISQUES_41, SOURCE_FR2, STATUTS_DECISION, STRATEGIE_45, SUIVIS_EXTERNES, SYNTHESE_48_2, VERSIONS_44,
  zoneDe, ZONES_CRITICITE,
  type EtatAction, type EtatSuivi, type EtatVersion, type Impact, type LienDeblocage, type Probabilite, type RisqueRef, type StatutDecision,
} from './referentiels.js';

/** Rôles de supervision du programme : revoient tout risque, désignent les propriétaires. */
export const SUPERVISION: RoleCode[] = ['R01', 'R02', 'R03', 'R05'];

interface Historique { at: string; by: string; action: string; texte?: string }
interface Revue { at: string; by: string; probabilite: Probabilite; impact: Impact; commentaire: string }
interface RisqueEtat { id: string; proprietaire: RoleCode; proprietaireDesigne: boolean; revues: Revue[]; historique: Historique[] }
interface Meta { id: 'REGISTRE'; ouvertLe: string }
interface VersionEtat { id: string; etat: EtatVersion; preuve?: { reference: string; sha256: string }; historique: Historique[] }
interface SuiviEtat { id: string; etat: EtatSuivi; echeance?: string; preuve?: { reference: string; sha256: string }; historique: Historique[] }
interface PlanEtat { id: 'PLAN'; debut: string; fixePar: string; fixeLe: string; motif: string }
interface ActionEtat { id: string; etat: EtatAction; note?: string; instructionId?: string; preuve?: { reference: string; sha256: string }; historique: Historique[] }
interface Acte { reference: string; titre: string; date: string; sha256: string }
interface DecisionEtat {
  id: string;
  statut: StatutDecision;
  enAttente?: { statut: 'PRISE' | 'REFUSEE'; acte?: Acte; motif: string; par: string; le: string };
  acte?: Acte;
  enregistrePar?: string;
  validePar?: string;
  valideLe?: string;
  historique: Historique[];
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export class ProgrammeService {
  readonly meta = new InMemoryRepository<Meta>();
  readonly risques = new InMemoryRepository<RisqueEtat>();
  readonly versions = new InMemoryRepository<VersionEtat>();
  readonly suivis = new InMemoryRepository<SuiviEtat>();
  readonly plan = new InMemoryRepository<PlanEtat>();
  readonly actions = new InMemoryRepository<ActionEtat>();
  readonly decisions = new InMemoryRepository<DecisionEtat>();
  private readonly signer: ExportSigner;

  constructor(private readonly ctx: AppContext) {
    this.signer = new ExportSigner(ctx.secrets.auditHmacKey);
  }

  private now(): string { return this.ctx.clock.now().toISOString(); }
  private today(): string { return kinshasaDay(this.now()); }
  private gate(user: User, action: string) { authorize(user, `programme:${action}`); }
  private audit(user: User, action: string, resourceType: string, resourceId: string, details: Record<string, unknown> = {}) {
    this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action, resourceType, resourceId, details });
  }
  private motif(m: string): string {
    const t = m.trim();
    if (t.length < 10) throw badRequest('MOTIF_REQUIRED', 'Motif d’au moins 10 caractères requis.');
    return t;
  }
  private get pil(): PilotageService | undefined { return this.ctx.ext.pilotage as PilotageService | undefined; }
  private get planif(): PlanificationService | undefined { return this.ctx.ext.planification as PlanificationService | undefined; }

  // ————————————————————————————————— ch. 41 — registre des risques —————————————————————————————————

  /** Date d'ouverture du registre (fixée à la première consultation, conservée) : base de la première échéance de revue. */
  private ouverture(): string {
    const m = this.meta.get('REGISTRE');
    if (m) return m.ouvertLe;
    return this.meta.insert({ id: 'REGISTRE', ouvertLe: this.today() }).ouvertLe;
  }
  private etatRisque(r: RisqueRef): RisqueEtat {
    return this.risques.get(r.code) ?? { id: r.code, proprietaire: r.proprietaire, proprietaireDesigne: false, revues: [], historique: [] };
  }
  private saveRisque(e: RisqueEtat) { if (this.risques.get(e.id)) this.risques.update(e); else this.risques.insert(e); }

  private vueRisque(r: RisqueRef) {
    const e = this.etatRisque(r);
    const last = e.revues[e.revues.length - 1];
    const p = last?.probabilite ?? r.probabilite; const i = last?.impact ?? r.impact;
    const base = last ? kinshasaDay(last.at) : this.ouverture();
    const prochaineRevue = addDays(base, PERIODICITE_REVUE_JOURS);
    const today = this.today();
    return {
      code: r.code, risque: r.risque, traitement: r.traitement,
      source: { probabilite: PROBABILITES[r.probabilite].libelle, impact: IMPACTS[r.impact].libelle },
      probabilite: p, probabiliteLibelle: PROBABILITES[p].libelle, impact: i, impactLibelle: IMPACTS[i].libelle, criticite: zoneDe(p, i),
      proprietaire: e.proprietaire, proprietaireStatut: e.proprietaireDesigne ? 'DESIGNE' : PAR_DEFAUT,
      derniereRevue: last ?? null, prochaineRevue, revueEnRetard: today > prochaineRevue, joursDeRetard: today > prochaineRevue ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${prochaineRevue}T00:00:00Z`)) / DAY_MS) : 0,
      mesures: r.mesures, registreAnterieur: r.registreAnterieur, revues: e.revues, historique: e.historique,
    };
  }

  registreRisques(user: User) {
    this.gate(user, 'read');
    const items = RISQUES_41.map((r) => this.vueRisque(r));
    const cellules = (Object.keys(PROBABILITES) as Probabilite[]).flatMap((p) => (Object.keys(IMPACTS) as Impact[]).map((i) => ({
      probabilite: p, impact: i, ...zoneDe(p, i), risques: items.filter((x) => x.probabilite === p && x.impact === i).map((x) => x.code),
    })));
    return {
      source: `${SOURCE_FR2}, ch. 41`, items,
      carteChaleur: { probabilites: Object.entries(PROBABILITES).map(([k, v]) => ({ code: k, ...v })), impacts: Object.entries(IMPACTS).map(([k, v]) => ({ code: k, ...v })), cellules, zones: ZONES_CRITICITE },
      echelle: `Échelle qualitative du ch. 41 ; rangs numériques, seuils de zones et périodicité de revue (${PERIODICITE_REVUE_JOURS} jours) : ${PAR_DEFAUT}.`,
      synthese: { total: items.length, enRetard: items.filter((x) => x.revueEnRetard).length, critiques: items.filter((x) => x.criticite.zone === 'CRITIQUE').length, mesuresExternes: items.reduce((a, x) => a + x.mesures.filter((m) => m.statut === 'EXTERNE').length, 0) },
      regle: 'Chaque risque est revu par une personne (propriétaire ou supervision) ; une revue en retard est signalée, jamais close automatiquement.',
    };
  }

  private risque(code: string): RisqueRef {
    const r = RISQUES_41.find((x) => x.code === code.toUpperCase());
    if (!r) throw notFound('RISQUE_INCONNU', `Risque inconnu : ${code}`);
    return r;
  }

  reviewRisk(user: User, code: string, input: { probabilite: Probabilite; impact: Impact; commentaire: string }) {
    this.gate(user, 'risque.revue');
    const r = this.risque(code);
    const e = this.etatRisque(r);
    if (!user.roles.includes(e.proprietaire) && !user.roles.some((x) => SUPERVISION.includes(x))) {
      throw forbidden('NOT_RISK_OWNER', `Revue réservée au propriétaire du risque (${e.proprietaire}) ou à la supervision du programme.`);
    }
    const commentaire = this.motif(input.commentaire);
    const revue: Revue = { at: this.now(), by: user.id, probabilite: input.probabilite, impact: input.impact, commentaire };
    const prev = e.revues[e.revues.length - 1];
    this.saveRisque({ ...e, revues: [...e.revues, revue], historique: [...e.historique, { at: revue.at, by: user.id, action: 'revue', texte: `${PROBABILITES[input.probabilite].libelle} × ${IMPACTS[input.impact].libelle} — ${commentaire}` }] });
    this.audit(user, 'programme.risque.reviewed', 'risque', r.code, { probabilite: input.probabilite, impact: input.impact, avant: prev ? { probabilite: prev.probabilite, impact: prev.impact } : { probabilite: r.probabilite, impact: r.impact }, commentaire });
    return this.vueRisque(r);
  }

  designateOwner(user: User, code: string, input: { role: RoleCode; motif: string }) {
    this.gate(user, 'risque.proprietaire');
    const r = this.risque(code);
    const e = this.etatRisque(r);
    const motif = this.motif(input.motif);
    this.saveRisque({ ...e, proprietaire: input.role, proprietaireDesigne: true, historique: [...e.historique, { at: this.now(), by: user.id, action: 'proprietaire', texte: `${e.proprietaire} → ${input.role} — ${motif}` }] });
    this.audit(user, 'programme.risque.owner_designated', 'risque', r.code, { avant: e.proprietaire, apres: input.role, motif });
    return this.vueRisque(r);
  }

  // ————————————————————————————————— ch. 42, 43, 45 — recette —————————————————————————————————

  private suiviEtat(code: string): SuiviEtat { return this.suivis.get(code) ?? { id: code, etat: 'A_PLANIFIER', historique: [] }; }

  recette(user: User) {
    this.gate(user, 'read');
    const suivis = SUIVIS_EXTERNES.map((s) => {
      const e = this.suiviEtat(s.code);
      return { ...s, etat: e.etat, etatLibelle: ETATS_SUIVI[e.etat], echeance: e.echeance ?? null, preuve: e.preuve ?? null, historique: e.historique };
    });
    return {
      source: `${SOURCE_FR2}, ch. 42, 43 et 45`,
      criteres: CRITERES_42, recits: RECITS_43,
      strategie: STRATEGIE_45.map((p) => ({ ...p, suivis: p.suivis.map((c) => suivis.find((s) => s.code === c)!) })),
      suivis,
      regle: 'Chaque critère et chaque récit renvoie au test automatisé qui le prouve (fichier et titre, vérifiés par test). Ce qui exige le monde réel (recette avec agents réels, test d’intrusion par un tiers…) est suivi par statut, jamais simulé.',
    };
  }

  trackExternal(user: User, code: string, input: { etat: EtatSuivi; motif: string; echeance?: string; preuve?: { reference: string; sha256: string } }) {
    this.gate(user, 'suivi.write');
    const ref = SUIVIS_EXTERNES.find((s) => s.code === code.toUpperCase());
    if (!ref) throw notFound('SUIVI_INCONNU', `Suivi inconnu : ${code}`);
    if (input.etat === 'REALISE' && !input.preuve) throw badRequest('PREUVE_REQUISE', 'Un élément réalisé exige une preuve (référence du procès-verbal et empreinte SHA-256).');
    const motif = this.motif(input.motif);
    const e = this.suiviEtat(ref.code);
    const next: SuiviEtat = { ...e, etat: input.etat, ...(input.echeance ? { echeance: input.echeance } : {}), ...(input.preuve ? { preuve: input.preuve } : {}), historique: [...e.historique, { at: this.now(), by: user.id, action: input.etat, texte: motif }] };
    if (this.suivis.get(ref.code)) this.suivis.update(next); else this.suivis.insert(next);
    this.audit(user, 'programme.suivi.updated', 'suivi_externe', ref.code, { etat: input.etat, motif, echeance: input.echeance ?? null, preuve: input.preuve ?? null });
    return { ...ref, etat: next.etat, etatLibelle: ETATS_SUIVI[next.etat], echeance: next.echeance ?? null, preuve: next.preuve ?? null, historique: next.historique };
  }

  // ————————————————————————————————— ch. 44 — plan de livraison —————————————————————————————————

  planVersions(user: User) {
    this.gate(user, 'read');
    // Conversion justifiée : inventaire générique des services du contexte (recette de programme, lecture seule).
    const ctx = this.ctx as unknown as Record<string, unknown>;
    const items = VERSIONS_44.map((v) => {
      const e = this.versions.get(v.code) ?? { id: v.code, etat: 'PREVUE' as EtatVersion, historique: [] };
      const contenus = v.contenus.map((c) => {
        const socle = (c.socle ?? []).map((k) => ({ cle: k, present: ctx[k] !== undefined }));
        const modules = (c.modules ?? []).map((m) => ({ nom: m, present: this.ctx.ext[m] !== undefined }));
        return { ...c, socle, modules, construit: [...socle, ...modules].every((x) => x.present) };
      });
      return {
        code: v.code, version: v.version, public: v.public, contenus,
        construction: contenus.every((c) => c.construit) ? 'CONSTRUIT' : 'PARTIEL',
        etat: e.etat, etatLibelle: ETATS_VERSION[e.etat], preuve: e.preuve ?? null, historique: e.historique,
      };
    });
    return {
      source: `${SOURCE_FR2}, ch. 44`, items,
      communes: { pilote: [...PILOT_COMMUNES], referentiel: COMMUNES.length },
      regle: 'La construction est vérifiée à l’exécution (services et modules chargés) ; la mise en service d’une version est décidée par une personne, sur preuve.',
    };
  }

  setVersionState(user: User, code: string, input: { etat: EtatVersion; motif: string; preuve?: { reference: string; sha256: string } }) {
    this.gate(user, 'version.write');
    const v = VERSIONS_44.find((x) => x.code === code);
    if (!v) throw notFound('VERSION_INCONNUE', `Version inconnue : ${code}`);
    if (input.etat === 'EN_SERVICE' && !input.preuve) throw badRequest('PREUVE_REQUISE', 'Mise en service : procès-verbal (référence et empreinte SHA-256) requis.');
    const motif = this.motif(input.motif);
    const e = this.versions.get(v.code) ?? { id: v.code, etat: 'PREVUE' as EtatVersion, historique: [] };
    const next: VersionEtat = { ...e, etat: input.etat, ...(input.preuve ? { preuve: input.preuve } : {}), historique: [...e.historique, { at: this.now(), by: user.id, action: input.etat, texte: motif }] };
    if (this.versions.get(v.code)) this.versions.update(next); else this.versions.insert(next);
    this.audit(user, 'programme.version.state_changed', 'version', v.code, { avant: e.etat, apres: input.etat, motif, preuve: input.preuve ?? null });
    return this.planVersions(user).items.find((x) => x.code === v.code)!;
  }

  // ————————————————————————————————— ch. 47 — 100 premiers jours —————————————————————————————————

  centJours(user: User) {
    this.gate(user, 'read');
    const p = this.plan.get('PLAN');
    const today = this.today();
    const jour = p ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${p.debut}T00:00:00Z`)) / DAY_MS) + 1 : null;
    const instr = this.planif;
    const periodes = PLAN_100_JOURS_47.map((per) => {
      const echeance = p ? addDays(p.debut, per.fin - 1) : null;
      const actions = per.actions.map((a) => {
        const e = this.actions.get(a.id) ?? { id: a.id, etat: 'A_FAIRE' as EtatAction, historique: [] };
        const instruction = e.instructionId && instr ? instr.instructions.get(e.instructionId) : undefined;
        const enRetard = !!echeance && today > echeance && e.etat !== 'FAITE';
        return { ...a, etat: e.etat, etatLibelle: ETATS_ACTION[e.etat], note: e.note ?? null, preuve: e.preuve ?? null, enRetard, instruction: instruction ? { id: instruction.id, number: instruction.number, status: instruction.status, deadline: instruction.deadline } : null, historique: e.historique };
      });
      return { ...per, debutDate: p ? addDays(p.debut, per.debut - 1) : null, echeance, actions, faites: actions.filter((a) => a.etat === 'FAITE').length };
    });
    return {
      source: `${SOURCE_FR2}, ch. 47`, demarrage: p ?? null, jour, periodes,
      synthese: { actions: periodes.reduce((a, x) => a + x.actions.length, 0), faites: periodes.reduce((a, x) => a + x.faites, 0), enRetard: periodes.reduce((a, x) => a + x.actions.filter((y) => y.enRetard).length, 0) },
      regle: 'Le jour 1 est fixé par une personne habilitée (décision provinciale) ; chaque action est suivie par une personne, avec une instruction de suivi facultative (circuit des instructions du pilotage).',
    };
  }

  startPlan(user: User, input: { debut: string; motif: string }) {
    this.gate(user, 'plan.write');
    const motif = this.motif(input.motif);
    const cur = this.plan.get('PLAN');
    const next: PlanEtat = { id: 'PLAN', debut: input.debut, fixePar: user.id, fixeLe: this.now(), motif };
    if (cur) {
      if (this.actions.all().some((a) => a.etat !== 'A_FAIRE')) throw conflict('PLAN_STARTED', 'Des actions sont déjà suivies : le jour 1 ne peut plus changer.');
      this.plan.update(next);
    } else this.plan.insert(next);
    this.audit(user, 'programme.plan100.started', 'plan_100_jours', 'PLAN', { debut: input.debut, avant: cur?.debut ?? null, motif });
    return this.centJours(user);
  }

  private actionRef(id: string) {
    const a = PLAN_100_JOURS_47.flatMap((p) => p.actions.map((x) => ({ ...x, periode: p }))).find((x) => x.id === id);
    if (!a) throw notFound('ACTION_INCONNUE', `Action inconnue : ${id}`);
    return a;
  }

  setActionState(user: User, id: string, input: { etat: EtatAction; note: string; preuve?: { reference: string; sha256: string } }) {
    this.gate(user, 'plan.write');
    const a = this.actionRef(id);
    if (!this.plan.get('PLAN')) throw conflict('PLAN_NOT_STARTED', 'Jour 1 du plan non fixé.');
    const note = this.motif(input.note);
    const e = this.actions.get(a.id) ?? { id: a.id, etat: 'A_FAIRE' as EtatAction, historique: [] };
    const next: ActionEtat = { ...e, etat: input.etat, note, ...(input.preuve ? { preuve: input.preuve } : {}), historique: [...e.historique, { at: this.now(), by: user.id, action: input.etat, texte: note }] };
    if (this.actions.get(a.id)) this.actions.update(next); else this.actions.insert(next);
    this.audit(user, 'programme.plan100.action_updated', 'action_100_jours', a.id, { avant: e.etat, apres: input.etat, note, preuve: input.preuve ?? null });
    return this.centJours(user);
  }

  /** Instruction de suivi : réutilise le circuit des instructions du pilotage (émission, accusé, rapport, clôture). */
  followWithInstruction(user: User, id: string, input: { entity: string; role?: string }) {
    this.gate(user, 'plan.write');
    const a = this.actionRef(id);
    const p = this.plan.get('PLAN');
    if (!p) throw conflict('PLAN_NOT_STARTED', 'Jour 1 du plan non fixé.');
    const planif = this.planif;
    if (!planif) throw conflict('MODULE_ABSENT', 'Module de planification non chargé : instruction impossible.');
    const e = this.actions.get(a.id) ?? { id: a.id, etat: 'A_FAIRE' as EtatAction, historique: [] };
    if (e.instructionId) throw conflict('INSTRUCTION_EXISTS', `Instruction déjà émise (${e.instructionId}).`);
    // Échéance de la période ; une période déjà échue reçoit l'échéance du jour (l'instruction ne peut viser le passé).
    const fin = addDays(p.debut, a.periode.fin - 1);
    const deadline = fin < this.today() ? this.today() : fin;
    const ins = planif.issueInstruction(user, {
      origin: 'AUTRE', subject: `Plan des 100 jours — jours ${a.periode.jours}`.slice(0, 200),
      body: `Action du plan des 100 premiers jours (ch. 47) : « ${a.action} ». Responsable désigné par la source : ${a.periode.responsable}.`,
      context: {}, assignee: { entity: input.entity, ...(input.role ? { role: input.role } : {}) }, deadline,
    } as Parameters<PlanificationService['issueInstruction']>[1]);
    const next: ActionEtat = { ...e, etat: e.etat === 'A_FAIRE' ? 'EN_COURS' : e.etat, instructionId: ins.id, historique: [...e.historique, { at: this.now(), by: user.id, action: 'instruction', texte: ins.number }] };
    if (this.actions.get(a.id)) this.actions.update(next); else this.actions.insert(next);
    this.audit(user, 'programme.plan100.instruction_issued', 'action_100_jours', a.id, { instructionId: ins.id, number: ins.number, deadline });
    return this.centJours(user);
  }

  // ————————————————————————————————— ch. 48 — décisions —————————————————————————————————

  private controle(c: LienDeblocage['controle']): { etat: string; detail: string } {
    const ctx = this.ctx;
    switch (c) {
      case 'OL_13_001_REFUSEE': {
        const i = ctx.rules.instrument('ol-13-001');
        return i?.status === 'ABROGE'
          ? { etat: 'GARDE_ACTIVE', detail: 'OL 13/001 enregistrée ABROGÉE : toute règle qui la cite comme en vigueur est refusée à la publication (ABROGATED_INSTRUMENT).' }
          : { etat: 'A_VERIFIER', detail: 'Instrument ol-13-001 absent ou non abrogé au registre.' };
      }
      case 'IRL_TAUX_CERTIFIES': {
        const irl = ctx.rules.list().filter((r) => r.code === 'IRL-KIN-R1' || r.code === 'IRL-KIN-R234');
        const active = irl.filter((r) => r.status === 'ACTIVE');
        return active.length ? { etat: 'LEVE', detail: `Fiches IRL actives : ${active.map((r) => `${r.code} v${r.version}`).join(', ')}.` } : { etat: 'EN_ATTENTE', detail: `Aucune fiche IRL active (${irl.map((r) => `${r.code} v${r.version} ${r.status}`).join(', ')}) : simulation non opposable.` };
      }
      case 'RECOUPEMENT_DONNEES': { const r = recoupementDonneesAutorise(ctx); return { etat: r.autorise ? 'LEVE' : 'EN_ATTENTE', detail: r.message }; }
      case 'PILOTE_COMMUNES': return { etat: 'CONSTRUIT', detail: `Communes pilotes : ${PILOT_COMMUNES.join(', ')} ; communes témoins désignées par une personne dans le tableau du pilote.` };
      case 'ECHEANCIERS_MOBILE_MONEY': { const f = etatFonction(ctx, 'ECHEANCIERS_MOBILE_MONEY'); return { etat: f.enAttente ? 'ACTE_REQUIS' : 'LEVE', detail: f.message }; }
      case 'QUITUS_CONDITIONNE': return pointJuridiqueTranche(ctx, 'J6') ? { etat: 'LEVE', detail: 'Point J6 tranché : conditionnalité certifiée.' } : { etat: 'EN_ATTENTE', detail: 'Quitus informatif : point J6 non tranché.' };
      case 'ESPECES_AGENTS_ZERO': {
        const k = this.pil?.computeKpis({}).find((x) => x.code === 'ESPECES_AGENTS');
        return { etat: k && k.value === '0' ? 'CIBLE_TENUE' : k?.value ? 'ECART' : 'NON_MESURE', detail: `Indicateur ESPECES_AGENTS : ${k?.value ?? 'non mesuré'} (cible zéro).` };
      }
      case 'COMMISSIONS_VERSEMENT': { const f = etatFonction(ctx, 'COMMISSIONS_VERSEMENT'); return { etat: f.enAttente ? 'EN_ATTENTE' : 'LEVE', detail: f.message }; }
      case 'CLE_37A_ACTE_REQUIS': {
        const r = ctx.rules.list().filter((x) => x.code === 'CLE-REPARTITION-37A');
        return { etat: 'INCHANGE', detail: `Clé du § 37A : ${r.map((x) => `v${x.version} ${x.revenueCategory} ${x.status}`).join(', ') || 'absente'} — comportement du § 37A inchangé.` };
      }
      default: return { etat: 'SANS_EFFET_TECHNIQUE', detail: 'Décision sans verrou technique propre.' };
    }
  }

  private decisionEtat(n: number): DecisionEtat { return this.decisions.get(`D${n}`) ?? { id: `D${n}`, statut: 'A_PRENDRE', historique: [] }; }
  private decisionRef(numero: string) {
    const n = Number(numero);
    const d = DECISIONS_48.find((x) => x.numero === n);
    if (!d) throw notFound('DECISION_INCONNUE', `Décision inconnue : ${numero} (1 à 10).`);
    return d;
  }
  private vueDecision(d: (typeof DECISIONS_48)[number]) {
    const e = this.decisionEtat(d.numero);
    return {
      numero: d.numero, id: `D${d.numero}`, decision: d.decision, statut: e.statut, statutLibelle: STATUTS_DECISION[e.statut],
      enAttente: e.enAttente ?? null, acte: e.acte ?? null, enregistrePar: e.enregistrePar ?? null, validePar: e.validePar ?? null, valideLe: e.valideLe ?? null,
      debloque: d.debloque.map((l) => ({ ...l, ...this.controle(l.controle) })),
      contradiction: d.contradiction ?? null, historique: e.historique,
    };
  }

  registreDecisions(user: User) {
    this.gate(user, 'read');
    const items = DECISIONS_48.map((d) => this.vueDecision(d));
    return {
      source: `${SOURCE_FR2}, ch. 48`, items, synthese: SYNTHESE_48_2, devise: DEVISE_FR2,
      compte: { A_PRENDRE: items.filter((x) => x.statut === 'A_PRENDRE').length, PRISE: items.filter((x) => x.statut === 'PRISE').length, REFUSEE: items.filter((x) => x.statut === 'REFUSEE').length, aValider: items.filter((x) => x.enAttente).length },
      contradictions: items.filter((x) => x.contradiction).map((x) => ({ numero: x.numero, ...x.contradiction!, statut: CONTRADICTION_SIGNALEE })),
      regle: 'Une décision est enregistrée par une personne (acte : référence, date et empreinte si elle est prise) puis validée par une autre. Les verrous de la plateforme restent régis par leurs propres circuits : leur état est affiché, jamais forcé.',
    };
  }

  recordDecision(user: User, numero: string, input: { statut: 'PRISE' | 'REFUSEE'; acte?: Acte; motif: string }) {
    this.gate(user, 'decision.enregistrer');
    const d = this.decisionRef(numero);
    const e = this.decisionEtat(d.numero);
    if (e.statut !== 'A_PRENDRE') throw conflict('DECISION_CLOSE', `Décision ${d.numero} déjà ${STATUTS_DECISION[e.statut].toLowerCase()}.`);
    if (e.enAttente) throw conflict('DECISION_EN_ATTENTE', `Un enregistrement attend déjà sa validation (par ${e.enAttente.par}).`);
    if (input.statut === 'PRISE' && !input.acte) throw badRequest('ACTE_REQUIS', 'Décision prise : référence, date et empreinte SHA-256 de l’acte requises.');
    const motif = this.motif(input.motif);
    const now = this.now();
    const next: DecisionEtat = { ...e, enAttente: { statut: input.statut, ...(input.acte ? { acte: input.acte } : {}), motif, par: user.id, le: now }, historique: [...e.historique, { at: now, by: user.id, action: `enregistrement ${input.statut}`, texte: motif }] };
    if (this.decisions.get(next.id)) this.decisions.update(next); else this.decisions.insert(next);
    this.audit(user, 'programme.decision.recorded', 'decision_gouvernement', next.id, { numero: d.numero, statut: input.statut, acte: input.acte ?? null, motif });
    return this.vueDecision(d);
  }

  validateDecision(user: User, numero: string, input: { approve: boolean; motif: string }) {
    this.gate(user, 'decision.valider');
    const d = this.decisionRef(numero);
    const e = this.decisionEtat(d.numero);
    if (!e.enAttente) throw conflict('AUCUN_ENREGISTREMENT', `Aucun enregistrement à valider pour la décision ${d.numero}.`);
    assertDistinctPerson(user.id, [e.enAttente.par], 'La personne qui enregistre une décision ne la valide pas.');
    const motif = this.motif(input.motif);
    const now = this.now();
    const pending = e.enAttente;
    const next: DecisionEtat = input.approve
      ? { id: e.id, statut: pending.statut, ...(pending.acte ? { acte: pending.acte } : {}), enregistrePar: pending.par, validePar: user.id, valideLe: now, historique: [...e.historique, { at: now, by: user.id, action: 'validation', texte: motif }] }
      : { id: e.id, statut: 'A_PRENDRE', historique: [...e.historique, { at: now, by: user.id, action: 'rejet de l’enregistrement', texte: motif }] };
    this.decisions.update(next);
    this.audit(user, input.approve ? 'programme.decision.validated' : 'programme.decision.rejected', 'decision_gouvernement', e.id, { numero: d.numero, statut: pending.statut, enregistrePar: pending.par, motif, acteSha256: pending.acte?.sha256 ?? null });
    return this.vueDecision(d);
  }

  // ————————————————————————————————— récit 43-8 — exportation signée de la carte des écarts —————————————————————————————————

  /** Carte et tableau des écarts assignation / rapproché, avec les six états par commune, signés (vérifiables). */
  exportEcarts(user: User, q: { annee?: string }) {
    const pil = this.pil; const planif = this.planif;
    if (!pil || !planif) throw conflict('MODULE_ABSENT', 'Modules de pilotage et de planification requis.');
    authorize(user, 'pilotage:export');
    const gap = planif.gapMap(user, q.annee ? { year: q.annee } : {});
    const { filters } = pil.filtersFor(user, {});
    const communes = (filters.communes ?? [...COMMUNES]).filter((c) => (COMMUNES as readonly string[]).includes(c));
    const sixEtats = communes.map((commune) => {
      const levels = pil.ladder(user, { commune }).levels;
      return { commune, etats: SIX_ETATS.map((s) => { const l = levels.find((x) => x.level === s.niveau)!; return { etat: s.code, libelle: s.libelle, mesure: l.measured, montants: l.amounts, contreValeurCdf: l.consolidatedCdf }; }) };
    });
    const content = { kind: 'ecarts-assignation', annee: gap.year, generatedAt: this.now(), ecarts: gap, sixEtats, note: 'Six états distincts (§ 42) : jamais additionnés ; potentiel et disponible déclarés non mesurés tant qu’ils ne le sont pas.' };
    const payload = jsonPayload(content);
    const { sha256, signature } = this.signer.sign(payload);
    const exportId = `ECARTS-${gap.year}-${sha256.slice(0, 12)}`;
    pil.exportsLog.append({ id: `${exportId}-json`, exportId, kind: 'ecarts-assignation', format: 'json', generatedAt: content.generatedAt, generatedBy: { id: user.id, roles: user.roles }, filters: { annee: gap.year }, rows: gap.rows.length, sha256, signature, algorithm: 'HMAC-SHA256', keyId: EXPORT_KEY_ID, note: 'Carte des écarts assignation / rapproché et six états par commune : empreinte SHA-256 du JSON canonique.' });
    this.audit(user, 'pilotage.export.generated', 'export', exportId, { kind: 'ecarts-assignation', annee: gap.year, sha256 });
    return { exportId, sha256, signature, keyId: EXPORT_KEY_ID, algorithm: 'HMAC-SHA256', payload, content };
  }

  // ————————————————————————————————— synthèse —————————————————————————————————

  // ——————————————— Programme routier du Gouvernorat (30/09/2026) — recettes liées à la route mises en regard ———————————————

  /**
   * Programme routier annoncé (km livrés, km en cours) et recettes liées à la route : péage provincial, droits de voirie,
   * taxe de circulation. Rattachement d'une obligation à une ligne : code, libellé ou catégorie de la fiche de règle, ou
   * titre du module (reçu de péage, vignette). Montants agrégés, sans donnée personnelle ; aucune affectation automatique.
   */
  programmeRoutier(user: User) {
    this.gate(user, 'read');
    const pil = this.pil;
    const facts = pil?.facts();
    const fiches = new Map(this.ctx.rules.list().map((r) => [r.code, `${r.code} ${r.label}`]));
    const titres = (this.ctx.ext.titres as { credentials?: { all(): { module: string; obligationId?: string }[] } } | undefined)?.credentials?.all() ?? [];
    const lignes = PROGRAMME_ROUTIER.lignesRecettes.map((l) => {
      const re = new RegExp(l.motsCles, 'i');
      const parTitre = new Set(titres.filter((c) => l.modules.includes(c.module)).map((c) => c.obligationId).filter((x): x is string => !!x));
      const obs = (facts?.obligations ?? []).filter((o) => !o.cancelled && (re.test(fiches.get(o.ruleCode) ?? o.ruleCode) || re.test(o.category) || parTitre.has(o.id)));
      const ids = new Set(obs.map((o) => o.id));
      const liquide = new CurrencyTotals(); const rapproche = new CurrencyTotals();
      obs.forEach((o) => liquide.add(o.amount));
      const payes = (facts?.orders ?? []).filter((o) => ids.has(o.obligationId) && isReconciled(o));
      payes.forEach((o) => rapproche.add(o.amount));
      return {
        code: l.code, libelle: l.libelle, modules: l.modules, obligations: obs.length, paiementsRapproches: payes.length,
        liquide: liquide.toJSON(), rapproche: rapproche.toJSON(), regie: aiguillerRecette(l.libelle, this.ctx.rules.list()),
      };
    });
    const total = new CurrencyTotals();
    lignes.forEach((l) => l.rapproche.forEach((m) => total.add(m)));
    const km = Object.fromEntries(PROGRAMME_ROUTIER.indicateurs.map((i) => [i.code, i.valeur]));
    this.audit(user, 'programme.routier.viewed', 'programme', PROGRAMME_ROUTIER.code);
    return {
      code: PROGRAMME_ROUTIER.code, intitule: PROGRAMME_ROUTIER.intitule, source: PROGRAMME_ROUTIER.source, statut: PROGRAMME_ROUTIER.statut,
      indicateurs: PROGRAMME_ROUTIER.indicateurs,
      kmTotalAnnonce: (km.KM_LIVRES ?? 0) + (km.KM_EN_COURS ?? 0),
      partLivreePct: Math.round(((km.KM_LIVRES ?? 0) / Math.max(1, (km.KM_LIVRES ?? 0) + (km.KM_EN_COURS ?? 0))) * 1000) / 10,
      recettes: { lignes, totalRapproche: total.toJSON(), base: 'Recettes rapprochées (relevé bancaire), toutes périodes ; liquidé = obligations non annulées.', donneesDisponibles: !!facts },
      avertissement: PROGRAMME_ROUTIER.avertissement,
      generatedAt: facts?.asOf ?? this.now(),
    };
  }

  synthese(user: User) {
    this.gate(user, 'read');
    const r = this.registreRisques(user).synthese;
    const d = this.registreDecisions(user).compte;
    const v = this.planVersions(user).items;
    const c = this.centJours(user).synthese;
    return {
      source: SOURCE_FR2,
      risques: r, decisions: d, versions: { total: v.length, construites: v.filter((x) => x.construction === 'CONSTRUIT').length, enService: v.filter((x) => x.etat === 'EN_SERVICE').length },
      recette: { criteres: CRITERES_42.length, recits: RECITS_43.length, pointsStrategie: STRATEGIE_45.length, suivisExternes: SUIVIS_EXTERNES.length },
      centJours: c,
      programmeRoutier: { code: PROGRAMME_ROUTIER.code, indicateurs: PROGRAMME_ROUTIER.indicateurs, statut: PROGRAMME_ROUTIER.statut },
    };
  }
}
