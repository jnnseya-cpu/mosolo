/**
 * Campagnes de recouvrement (spécification fonctionnelle, module 33 « Campagnes de recouvrement » ; Cahier § 21 et § 21.2).
 *
 * Construit PAR-DESSUS l'existant, sans circuit parallèle :
 *  - mêmes droits que les campagnes de déclaration (`campagnes:manage` / `campagnes:approve`), même calendrier
 *    (CampaignService.calendar), même lancement à deux personnes ;
 *  - même segmentation que le recouvrement (RecoveryService.segmentOf), rapprochée des sept segments du § 21.2
 *    (conforme, retard, difficulté, litige, non-déclarant, fraude, grand débiteur) ;
 *  - même séquence que le parcours gradué (J-15, J-3, J+1, J+15, J+30 — valeurs de conception RECOVERY_PROCEDURE,
 *    à confirmer) ; une étape déjà faite par le parcours standard n'est jamais répétée ;
 *  - même mesure que le rendement du recouvrement (RecoveryYieldService.campaignYield : récupération brute, coûts saisis
 *    avec pièce, net, groupe témoin) ; « coût par franc récupéré » et taux de régularisation calculés sur données réelles.
 *
 * Doctrine :
 *  - AUCUNE CONTRAINTE : une campagne n'a que des actions d'information (rappel, SMS, appel, visite d'information,
 *    orientation vers un agent habilité à J+30) ; toute action coercitive est refusée à la création (422) ; la première
 *    étape de chaque cible est toujours amiable ; l'orientation J+30 exige un contact amiable préalable ;
 *  - litige et fraude présumée : aucun contact automatique (procédure de réclamation, enquête spécialisée) ;
 *  - TESTS : la campagne commence par un groupe test, comparé à un groupe témoin non contacté ; la généralisation est
 *    proposée puis décidée par une seconde personne, après une mesure ;
 *  - ARRÊT : si le coût atteint ou dépasse la récupération brute, le système PROPOSE l'arrêt ; une personne habilitée
 *    décide (arrêt ou poursuite motivée). Jamais d'arrêt ni de mesure automatique.
 */
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, isoDate, kinshasaDate } from '../../core/clock.js';
import { sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { isCommune } from '../../reference/kinshasa.js';
import type { Obligation } from '../../modules/assessment/service.js';
import { taxpayerRecipient, userRecipient } from '../../modules/identity/recipients.js';
import { RECOVERY_PROCEDURE } from './parameters.js';
import type { RecoveryService } from './service.js';

const { always } = GRANTS;
// Visites d'information : agent de contentieux, agents et superviseurs de terrain (jamais d'encaissement).
definePolicy('campagnes:relance.visite', { R09: always, R10: always, R20: always });

/** Les sept segments du § 21.2, avec leur traitement (Cahier, tableau « Recouvrement équitable par segment »). */
export const CAMPAIGN_SEGMENTS = {
  CONFORME: { label: 'Conforme', treatment: 'Confirmation, échéancier prévisible, services rapides', contact: true },
  RETARD: { label: 'Retard occasionnel', treatment: 'Rappel précoce, explication, paiement simplifié', contact: true },
  DIFFICULTE: { label: 'Difficulté réelle', treatment: 'Plan ou mécanisme prévu par le droit ; orientation vers l’assistance', contact: true },
  LITIGE: { label: 'Erreur ou litige', treatment: 'Suspension ou traitement selon la procédure de réclamation ; aucun contact de campagne', contact: false },
  NON_DECLARANT: { label: 'Non-déclarant probable', treatment: 'Invitation à régulariser, puis contrôle autorisé (décision humaine)', contact: true },
  FRAUDE: { label: 'Fraude présumée', treatment: 'Investigation spécialisée ; aucune sanction par algorithme ; aucun contact de campagne', contact: false },
  GRAND_DEBITEUR: { label: 'Grand débiteur', treatment: 'Gestion de cas, garanties, décisions tracées, supervision', contact: true },
} as const;
export type CampaignSegment = keyof typeof CAMPAIGN_SEGMENTS;
export const CAMPAIGN_SEGMENT_CODES = Object.keys(CAMPAIGN_SEGMENTS) as CampaignSegment[];

/** Canaux d'une campagne (module 33 : SMS, appel, visite d'information). */
export const CAMPAIGN_CHANNELS = ['SMS', 'APPEL', 'VISITE_INFORMATION'] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

/** Actions admises : exclusivement non coercitives. Toute autre action demandée est refusée (422 COERCION_FORBIDDEN). */
export const CAMPAIGN_ACTIONS = ['RAPPEL_AMIABLE', 'AVIS_ECHEANCE_DEPASSEE', 'RELANCE_INFORMATION', 'VISITE_INFORMATION', 'ORIENTATION_AGENT_HABILITE'] as const;
export type CampaignAction = (typeof CAMPAIGN_ACTIONS)[number];
/** Actions coercitives connues du recouvrement : jamais dans une campagne (elles relèvent d'une proposition R20 et d'une décision R21). */
export const COERCIVE_ACTIONS = ['MISE_EN_DEMEURE', 'MESURE_EXECUTION', 'PENALITE', 'FERMETURE', 'IMMOBILISATION', 'SAISIE', 'AVIS_FORMEL'] as const;

export type StepCode = 'J-15' | 'J-3' | 'J+1' | 'J+15' | 'J+30';
export interface CampaignStep {
  code: StepCode;
  /** Décalage par rapport à l'échéance (jours ; négatif = avant). */
  offsetDays: number;
  action: CampaignAction;
  channels: CampaignChannel[];
  /** Segments visés par l'étape (traitement du § 21.2). */
  segments: CampaignSegment[];
  label: string;
}

/**
 * Séquence J-15, J-3, J+1, J+15, J+30 (Cahier § 21, tableau de la chaîne graduée) — décalages repris des VALEURS DE
 * CONCEPTION du recouvrement (RECOVERY_PROCEDURE, à confirmer par le maître d'ouvrage).
 */
export function defaultSequence(): CampaignStep[] {
  const [b15, b3] = RECOVERY_PROCEDURE.reminderBeforeDays;
  return [
    { code: 'J-15', offsetDays: -b15, action: 'RAPPEL_AMIABLE', channels: ['SMS'], segments: ['CONFORME', 'RETARD', 'DIFFICULTE', 'GRAND_DEBITEUR', 'NON_DECLARANT'], label: `Rappel amiable J-${b15}` },
    { code: 'J-3', offsetDays: -b3, action: 'RAPPEL_AMIABLE', channels: ['SMS'], segments: ['CONFORME', 'RETARD', 'DIFFICULTE', 'GRAND_DEBITEUR', 'NON_DECLARANT'], label: `Rappel amiable J-${b3}` },
    { code: 'J+1', offsetDays: RECOVERY_PROCEDURE.overdueNoticeAfterDays, action: 'AVIS_ECHEANCE_DEPASSEE', channels: ['SMS'], segments: ['RETARD', 'DIFFICULTE', 'GRAND_DEBITEUR', 'NON_DECLARANT'], label: `Avis d’échéance dépassée J+${RECOVERY_PROCEDURE.overdueNoticeAfterDays}` },
    { code: 'J+15', offsetDays: RECOVERY_PROCEDURE.followUpAfterDays, action: 'RELANCE_INFORMATION', channels: ['APPEL', 'VISITE_INFORMATION'], segments: ['RETARD', 'DIFFICULTE', 'GRAND_DEBITEUR', 'NON_DECLARANT'], label: `Relance ciblée J+${RECOVERY_PROCEDURE.followUpAfterDays} (appel, visite d’information — aucune sanction)` },
    { code: 'J+30', offsetDays: RECOVERY_PROCEDURE.formalNoticeAfterDays, action: 'ORIENTATION_AGENT_HABILITE', channels: [], segments: ['RETARD', 'DIFFICULTE', 'GRAND_DEBITEUR', 'NON_DECLARANT'], label: `J+${RECOVERY_PROCEDURE.formalNoticeAfterDays} : orientation vers un agent habilité (constat et notification formelle décidés par une personne)` },
  ];
}

/** Étapes du parcours standard (dossier de recouvrement) équivalentes : jamais répétées par la campagne. */
const STANDARD_EQUIVALENT: Partial<Record<StepCode, string>> = { 'J-15': 'RAPPEL_J_MOINS_15', 'J-3': 'RAPPEL_J_MOINS_3', 'J+1': 'AVIS_J_PLUS_1', 'J+15': 'RELANCE_J_PLUS_15' };
const STEP_EVENT: Partial<Record<StepCode, string>> = { 'J-15': 'obligation.due_soon', 'J-3': 'obligation.due_soon', 'J+1': 'obligation.overdue', 'J+15': 'recovery.reminder.1' };
const PAYABLE = ['EMISE', 'EXIGIBLE', 'EN_RETARD', 'PARTIELLEMENT_PAYEE'];

export type Group = 'TEST' | 'TEMOIN' | 'RESERVE';
export interface CampaignTarget {
  /** Obligation (ou « DECL:objet:type:exercice » pour un non-déclarant). */
  ref: string;
  obligationId?: string;
  taxpayerId: string;
  commune: string | null;
  segment: CampaignSegment;
  segmentReasons: string[];
  dueDate: string;
  amount?: MoneyJSON;
  group: Group;
  /** Généralisée : cible de réserve incluse après la décision de généralisation. */
  generalised?: boolean;
}

export interface CampaignContact {
  id: string;
  ref: string;
  step: StepCode;
  channel: CampaignChannel | 'AUCUN';
  at: string;
  by: string;
  outcome: 'ENVOYE' | 'DEJA_FAIT_PARCOURS_STANDARD' | 'VISITE_A_FAIRE' | 'ORIENTE_AGENT' | 'DIFFERE_SANS_CONTACT_AMIABLE';
  deliveryIds?: string[];
}

export interface CampaignVisit {
  id: string;
  ref: string;
  taxpayerId: string;
  step: StepCode;
  status: 'A_FAIRE' | 'FAITE';
  outcome?: 'RENCONTRE_INFORME' | 'ABSENT' | 'ADRESSE_INTROUVABLE' | 'ORIENTE_ASSISTANCE';
  note?: string;
  gps?: { lat: number; lon: number; accuracyM: number };
  by?: string;
  at?: string;
}

export type RecoveryCampaignStatus = 'BROUILLON' | 'SIMULEE' | 'LANCEMENT_PROPOSE' | 'EN_TEST' | 'GENERALISATION_PROPOSEE' | 'GENERALISEE' | 'ARRETEE' | 'CLOTUREE';

export interface CampaignMeasure {
  at: string;
  since: string;
  test: GroupMeasure;
  control: GroupMeasure;
  generalised?: GroupMeasure;
  cost: Record<string, string>;
  costMeasured: boolean;
  gross: Record<string, string>;
  net: Record<string, string> | 'NON_MESURE';
  /** Coût par franc récupéré (par devise ; et en contre-valeur CDF indicative si le taux du jour est disponible). */
  costPerFranc: { byCurrency: Record<string, string | null>; cdfEquivalent: string | null; statut: 'MESURE' | 'NON_MESURE'; detail: string };
  stopSignals: { code: string; detail: string }[];
}
export interface GroupMeasure { targets: number; regularised: number; regularisationRate: string | null; paying: number; gross: Record<string, string> }

export interface RecoveryCampaign {
  id: string;
  code: string;
  label: string;
  entity: string;
  communes: string[];
  segments: CampaignSegment[];
  channels: CampaignChannel[];
  sequence: CampaignStep[];
  sequenceStatus: string;
  testSharePct: number;
  controlSharePct: number;
  status: RecoveryCampaignStatus;
  targets: CampaignTarget[];
  excluded: { ref: string; segment: CampaignSegment; reason: string }[];
  contacts: CampaignContact[];
  visits: CampaignVisit[];
  simulatedAt?: string;
  launch?: { proposedBy: string; proposedAt: string; approvedBy?: string; approvedAt?: string };
  generalisation?: { proposedBy: string; proposedAt: string; reason: string; approvedBy?: string; approvedAt?: string };
  measures: CampaignMeasure[];
  stopProposal?: { at: string; by: string; reasons: string[]; decision?: { by: string; at: string; stop: boolean; reason: string } };
  stop?: { by: string; at: string; reason: string };
  createdBy: string;
  createdAt: string;
  history: { at: string; by: string; action: string; note?: string }[];
}

const addDays = (d: string, n: number) => isoDate(new Date(Date.parse(`${d}T00:00:00.000Z`) + n * DAY_MS));

/** Tirage déterministe du groupe (reproductible, vérifiable) : empreinte campagne + cible. */
export function drawGroup(campaignId: string, ref: string, testSharePct: number, controlSharePct: number): Group {
  const n = Number.parseInt(sha256Hex(`${campaignId}|${ref}`).slice(0, 8), 16) % 100;
  if (n < testSharePct) return 'TEST';
  if (n < testSharePct + controlSharePct) return 'TEMOIN';
  return 'RESERVE';
}

interface YieldPort {
  campaignYield(campaignId: string, opts: { obligationIds: string[]; since: string; controlObligationIds?: string[] }): {
    gross: Record<string, string>; cost: Record<string, string>; net: Record<string, string> | 'NON_MESURE'; costMeasured: boolean; stopSignals: { code: string; detail: string }[];
  };
}

export class RecoveryCampaignService {
  readonly relances = new InMemoryRepository<RecoveryCampaign>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {}

  private recovery(): RecoveryService {
    const r = this.ctx.ext['recouvrement'] as RecoveryService | undefined;
    if (!r) throw unprocessable('RECOVERY_MODULE_REQUIRED', 'Module de recouvrement requis.');
    return r;
  }
  private yieldPort(): YieldPort {
    // Conversion justifiée : port de rendement facultatif du recouvrement, sondé à l'exécution (module éventuellement absent).
    const y = this.recovery().rendement as unknown as YieldPort | undefined;
    if (!y) throw unprocessable('YIELD_MODULE_REQUIRED', 'Mesure du rendement du recouvrement requise.');
    return y;
  }
  private today() { return kinshasaDate(this.ctx.clock.now()); }
  private now() { return this.ctx.clock.now().toISOString(); }

  get(id: string): RecoveryCampaign {
    const c = this.relances.get(id);
    if (!c) throw notFound('RECOVERY_CAMPAIGN_NOT_FOUND', `Campagne de recouvrement inconnue : ${id}`);
    return c;
  }

  create(user: User, input: {
    code: string; label: string; entity: string; communes: string[]; segments: CampaignSegment[]; channels: CampaignChannel[];
    testSharePct: number; controlSharePct: number;
    sequence?: { code: StepCode; offsetDays: number; action: string; channels: CampaignChannel[]; segments?: CampaignSegment[] }[];
  }): RecoveryCampaign {
    authorize(user, 'campagnes:manage');
    if (this.relances.findOne((c) => c.code === input.code)) throw conflict('CAMPAIGN_CODE_EXISTS', `Code de campagne déjà utilisé : ${input.code}`);
    const bad = input.communes.filter((c) => !isCommune(c));
    if (bad.length) throw badRequest('UNKNOWN_COMMUNE', `Communes inconnues : ${bad.join(', ')}`);
    if (input.testSharePct < 1 || input.controlSharePct < 1 || input.testSharePct + input.controlSharePct > 100) {
      throw badRequest('INVALID_GROUPS', 'Groupe test et groupe témoin obligatoires (au moins 1 % chacun, 100 % au plus au total).');
    }
    let sequence: CampaignStep[];
    let sequenceStatus = 'PAR DÉFAUT — séquence J-15, J-3, J+1, J+15, J+30 du Cahier (§ 21), décalages de conception à confirmer par le maître d’ouvrage';
    if (input.sequence?.length) {
      const coercive = input.sequence.filter((s) => !(CAMPAIGN_ACTIONS as readonly string[]).includes(s.action));
      if (coercive.length) {
        throw unprocessable('COERCION_FORBIDDEN', `Aucune contrainte dans une campagne : action(s) refusée(s) ${coercive.map((s) => `${s.code} ${s.action}`).join(', ')}. Les actes coercitifs relèvent d’une proposition motivée (R20) et d’une décision distincte (R21).`);
      }
      const sorted = [...input.sequence].sort((a, b) => a.offsetDays - b.offsetDays);
      if (sorted[0]!.action === 'ORIENTATION_AGENT_HABILITE') throw unprocessable('COERCION_FORBIDDEN', 'Aucune contrainte en première étape : la séquence commence par une action d’information amiable.');
      const defaults = new Map(defaultSequence().map((s) => [s.code, s]));
      sequence = sorted.map((s) => ({ code: s.code, offsetDays: s.offsetDays, action: s.action as CampaignAction, channels: s.channels, segments: s.segments ?? defaults.get(s.code)?.segments ?? ['RETARD'], label: defaults.get(s.code)?.label ?? `${s.code} ${s.action}` }));
      sequenceStatus = 'Séquence saisie — à confirmer par le maître d’ouvrage';
    } else {
      sequence = defaultSequence();
    }
    // Les canaux non retenus pour la campagne sont retirés des étapes (jamais ajoutés).
    sequence = sequence.map((s) => ({ ...s, channels: s.channels.filter((ch) => input.channels.includes(ch)) }));
    const at = this.now();
    const c = this.relances.insert({
      id: this.ids.next('CREC'), code: input.code, label: input.label, entity: input.entity, communes: input.communes, segments: input.segments, channels: input.channels,
      sequence, sequenceStatus, testSharePct: input.testSharePct, controlSharePct: input.controlSharePct, status: 'BROUILLON', targets: [], excluded: [], contacts: [], visits: [], measures: [],
      createdBy: user.id, createdAt: at, history: [{ at, by: user.id, action: 'Création', note: `Segments ${input.segments.join(', ')} ; canaux ${input.channels.join(', ')} ; test ${input.testSharePct} %, témoin ${input.controlSharePct} %` }],
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'recovery_campaign.created', resourceType: 'recovery_campaign', resourceId: c.id, details: { code: c.code, segments: c.segments, channels: c.channels, testSharePct: c.testSharePct, controlSharePct: c.controlSharePct } });
    return c;
  }

  /** Segment du § 21.2 d'une obligation, à partir de la segmentation du recouvrement (sans effet) et des enquêtes ouvertes. */
  segmentOf(o: Obligation): { segment: CampaignSegment; reasons: string[] } {
    const rec = this.recovery();
    if (this.underInvestigation([o.id, o.taxpayerId, o.objectId])) return { segment: 'FRAUDE', reasons: ['Objet, obligation ou contribuable visé par une alerte ou un dossier d’enquête ouvert (module 40).'] };
    const today = this.today();
    if (!this.ctx.assessment.isPastDue(o, today) && o.status !== 'CONTESTEE') {
      const others = this.ctx.assessment.byTaxpayer(o.taxpayerId).filter((x) => x.id !== o.id && PAYABLE.includes(x.status) && this.ctx.assessment.isPastDue(x, today));
      if (!others.length) return { segment: 'CONFORME', reasons: ['Échéance à venir ; aucune autre créance échue.'] };
    }
    const s = rec.segmentOf(o);
    const map: Record<string, CampaignSegment> = {
      CONTESTATION: 'LITIGE', GRAND_REDEVABLE: 'GRAND_DEBITEUR', CAPACITE_LIMITEE: 'DIFFICULTE', FRICTION: 'DIFFICULTE',
      OUBLI: 'RETARD', RETARD_REPETE: 'RETARD', REFUS_PRESUME: 'RETARD',
    };
    return { segment: map[s.code] ?? 'RETARD', reasons: [`Segmentation du recouvrement : ${s.label}.`, ...s.reasons] };
  }

  private underInvestigation(refs: string[]): boolean {
    const integ = this.ctx.ext['integrite'] as { alerts?: { all(): { status: string; subjects: { ref: string }[] }[] }; cases?: { all(): { status: string; links: { ref: string }[] }[] } } | undefined;
    if (!integ) return false;
    const set = new Set(refs);
    const openAlert = integ.alerts?.all().some((a) => a.status !== 'CLASSEE' && a.subjects.some((s) => set.has(s.ref)));
    const openCase = integ.cases?.all().some((c) => c.status !== 'DECIDE' && c.links.some((l) => set.has(l.ref)));
    return !!openAlert || !!openCase;
  }

  /** Cibles réelles : obligations payables des communes ; non-déclarants des campagnes de déclaration lancées. */
  private computeTargets(c: RecoveryCampaign) {
    const targets: CampaignTarget[] = [];
    const excluded: RecoveryCampaign['excluded'] = [];
    const horizon = addDays(this.today(), -c.sequence[0]!.offsetDays);
    for (const o of this.ctx.assessment.obligations.all()) {
      if (!PAYABLE.includes(o.status) && o.status !== 'CONTESTEE') continue;
      if (o.supersededBy) continue;
      const commune = o.attribution?.commune ?? null;
      if (!commune || !c.communes.includes(commune)) continue;
      if (o.dueDate > horizon) continue; // échéance trop lointaine pour la première étape
      const { segment, reasons } = this.segmentOf(o);
      if (!c.segments.includes(segment)) continue;
      if (!CAMPAIGN_SEGMENTS[segment].contact) { excluded.push({ ref: o.id, segment, reason: CAMPAIGN_SEGMENTS[segment].treatment }); continue; }
      targets.push({ ref: o.id, obligationId: o.id, taxpayerId: o.taxpayerId, commune, segment, segmentReasons: reasons, dueDate: this.ctx.assessment.dueInfo(o).dueDate, amount: o.amount, group: drawGroup(c.id, o.id, c.testSharePct, c.controlSharePct) });
    }
    if (c.segments.includes('NON_DECLARANT')) {
      const decl = this.ctx.ext['campagnes'] as { campaigns?: { all(): { id: string; status: string; communes: string[]; dueDate: string; period: string; prefill?: { items: { objectId: string; taxpayerId: string; kind: string }[] } }[] } } | undefined;
      const fiscal = this.ctx.ext['fiscal'] as { declarations?: { declarations: { findOne(p: (x: { objectId: string; kind: string; period: string; status: string }) => boolean): unknown } } } | undefined;
      for (const dc of decl?.campaigns?.all().filter((x) => x.status === 'LANCEE') ?? []) {
        for (const it of dc.prefill?.items ?? []) {
          const obj = this.ctx.objects.objects.get(it.objectId);
          if (!obj || !c.communes.includes(obj.commune)) continue;
          if (fiscal?.declarations?.declarations.findOne((d) => d.objectId === it.objectId && d.kind === it.kind && d.period === dc.period && d.status !== 'REMPLACEE')) continue;
          const ref = `DECL:${it.objectId}:${it.kind}:${dc.period}`;
          if (targets.some((t) => t.ref === ref)) continue;
          if (this.underInvestigation([it.objectId, it.taxpayerId])) { if (c.segments.includes('FRAUDE')) excluded.push({ ref, segment: 'FRAUDE', reason: CAMPAIGN_SEGMENTS.FRAUDE.treatment }); continue; }
          targets.push({ ref, taxpayerId: it.taxpayerId, commune: obj.commune, segment: 'NON_DECLARANT', segmentReasons: [`Déclaration ${it.kind} ${dc.period} non déposée (campagne ${dc.id}).`], dueDate: dc.dueDate, group: drawGroup(c.id, ref, c.testSharePct, c.controlSharePct) });
        }
      }
    }
    return { targets, excluded };
  }

  /** Simulation sur données réelles : cibles par segment et par groupe, étapes et canaux attendus ; aucun envoi. */
  simulate(user: User, id: string): RecoveryCampaign & { summary: ReturnType<RecoveryCampaignService['summary']> } {
    authorize(user, 'campagnes:manage');
    const c = this.get(id);
    if (!['BROUILLON', 'SIMULEE'].includes(c.status)) throw conflict('CAMPAIGN_BAD_STATE', `Simulation impossible au statut ${c.status}.`);
    const { targets, excluded } = this.computeTargets(c);
    const at = this.now();
    const out = this.relances.update({ ...c, targets, excluded, simulatedAt: at, status: 'SIMULEE', history: [...c.history, { at, by: user.id, action: 'Simulation', note: `${targets.length} cible(s), ${excluded.length} exclue(s) sans contact` }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'recovery_campaign.simulated', resourceType: 'recovery_campaign', resourceId: id, details: { targets: targets.length, excluded: excluded.length } });
    return { ...out, summary: this.summary(out) };
  }

  summary(c: RecoveryCampaign) {
    const bySegment: Record<string, number> = {};
    const byGroup: Record<Group, number> = { TEST: 0, TEMOIN: 0, RESERVE: 0 };
    for (const t of c.targets) { bySegment[t.segment] = (bySegment[t.segment] ?? 0) + 1; byGroup[t.group]++; }
    return { targets: c.targets.length, bySegment, byGroup, excluded: c.excluded.length, contacts: c.contacts.filter((x) => x.outcome === 'ENVOYE').length, visitsToDo: c.visits.filter((v) => v.status === 'A_FAIRE').length };
  }

  proposeLaunch(user: User, id: string): RecoveryCampaign {
    authorize(user, 'campagnes:manage');
    const c = this.get(id);
    if (c.status !== 'SIMULEE') throw conflict('SIMULATION_REQUIRED', 'Une simulation sur données réelles précède la proposition de lancement.');
    const at = this.now();
    const out = this.relances.update({ ...c, status: 'LANCEMENT_PROPOSE', launch: { proposedBy: user.id, proposedAt: at }, history: [...c.history, { at, by: user.id, action: 'Lancement de la phase de test proposé' }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'recovery_campaign.launch.proposed', resourceType: 'recovery_campaign', resourceId: id, details: { code: c.code } });
    return out;
  }

  /** Lancement (phase de TEST) décidé par une personne distincte ; seul le groupe test est contacté. */
  decideLaunch(user: User, id: string, input: { approve: boolean; reason: string }): RecoveryCampaign {
    authorize(user, 'campagnes:approve');
    const c = this.get(id);
    if (c.status !== 'LANCEMENT_PROPOSE' || !c.launch) throw conflict('CAMPAIGN_BAD_STATE', 'Aucun lancement proposé.');
    assertDistinctPerson(user.id, [c.launch.proposedBy, c.createdBy], 'Le lancement est décidé par une personne distincte de celle qui a préparé et proposé la campagne.');
    const at = this.now();
    const out = this.relances.update({
      ...c, status: input.approve ? 'EN_TEST' : 'SIMULEE', launch: input.approve ? { ...c.launch, approvedBy: user.id, approvedAt: at } : undefined,
      history: [...c.history, { at, by: user.id, action: input.approve ? 'Phase de test lancée' : 'Lancement refusé', note: input.reason }],
    } as RecoveryCampaign);
    this.ctx.audit.append({ actor: actorOf(user), action: input.approve ? 'recovery_campaign.launched' : 'recovery_campaign.launch.rejected', resourceType: 'recovery_campaign', resourceId: id, details: { proposedBy: c.launch.proposedBy, reason: input.reason } });
    return out;
  }

  private activeTargets(c: RecoveryCampaign): CampaignTarget[] {
    if (c.status === 'EN_TEST' || c.status === 'GENERALISATION_PROPOSEE') return c.targets.filter((t) => t.group === 'TEST');
    if (c.status === 'GENERALISEE') return c.targets.filter((t) => t.group === 'TEST' || (t.group === 'RESERVE' && t.generalised));
    return [];
  }

  private stillUnpaid(t: CampaignTarget): boolean {
    if (!t.obligationId) {
      const [, objectId, kind, period] = t.ref.split(':');
      const fiscal = this.ctx.ext['fiscal'] as { declarations?: { declarations: { findOne(p: (x: { objectId: string; kind: string; period: string; status: string }) => boolean): unknown } } } | undefined;
      return !fiscal?.declarations?.declarations.findOne((d) => d.objectId === objectId && d.kind === kind && d.period === period && d.status !== 'REMPLACEE');
    }
    const o = this.ctx.assessment.obligations.get(this.ctx.payments.currentObligationId(t.obligationId));
    return !!o && PAYABLE.includes(o.status);
  }

  /**
   * Exécution des étapes dues (idempotente) : pour chaque cible active encore débitrice, l'étape de la séquence dont la
   * date est atteinte et la suivante non atteinte ; jamais deux fois ; jamais une étape déjà faite par le parcours standard.
   */
  runSteps(by: User | 'systeme', id: string) {
    if (by !== 'systeme') authorize(by, 'campagnes:manage');
    const c = this.get(id);
    if (!['EN_TEST', 'GENERALISATION_PROPOSEE', 'GENERALISEE'].includes(c.status)) throw conflict('CAMPAIGN_NOT_ACTIVE', `Campagne au statut ${c.status} : aucune étape exécutable.`);
    const byId = by === 'systeme' ? 'systeme' : by.id;
    const today = this.today();
    const rec = this.recovery();
    const done: CampaignContact[] = [];
    const visits: CampaignVisit[] = [];
    const steps = [...c.sequence].sort((a, b) => a.offsetDays - b.offsetDays);
    for (const t of this.activeTargets(c)) {
      if (!this.stillUnpaid(t)) continue;
      const i = steps.findIndex((s, k) => today >= addDays(t.dueDate, s.offsetDays) && (k === steps.length - 1 || today < addDays(t.dueDate, steps[k + 1]!.offsetDays)));
      const step = steps[i];
      if (!step || !step.segments.includes(t.segment)) continue;
      if (c.contacts.some((x) => x.ref === t.ref && x.step === step.code) || done.some((x) => x.ref === t.ref && x.step === step.code)) continue;
      const contact = (channel: CampaignContact['channel'], outcome: CampaignContact['outcome'], deliveryIds?: string[]): CampaignContact => ({
        id: this.ids.next('CCT', 8), ref: t.ref, step: step.code, channel, at: this.now(), by: byId, outcome, ...(deliveryIds ? { deliveryIds } : {}),
      });
      if (step.action === 'ORIENTATION_AGENT_HABILITE') {
        // Aucune contrainte en première étape : orientation seulement après un contact amiable (campagne ou parcours standard).
        const kase = t.obligationId ? rec.caseFor(t.obligationId) : undefined;
        const amicable = c.contacts.some((x) => x.ref === t.ref && ['ENVOYE', 'DEJA_FAIT_PARCOURS_STANDARD'].includes(x.outcome))
          || c.visits.some((v) => v.ref === t.ref && v.status === 'FAITE') || !!kase?.steps.some((s) => Object.values(STANDARD_EQUIVALENT).includes(s.kind));
        if (!amicable) { done.push(contact('AUCUN', 'DIFFERE_SANS_CONTACT_AMIABLE')); continue; }
        done.push(contact('AUCUN', 'ORIENTE_AGENT'));
        continue;
      }
      const kase = t.obligationId ? rec.caseFor(t.obligationId) : undefined;
      const std = STANDARD_EQUIVALENT[step.code];
      if (std && kase?.steps.some((s) => s.kind === std)) { done.push(contact('AUCUN', 'DEJA_FAIT_PARCOURS_STANDARD')); continue; }
      const tp = this.ctx.taxpayers.taxpayers.get(t.taxpayerId);
      for (const ch of step.channels) {
        if (ch === 'VISITE_INFORMATION') {
          visits.push({ id: this.ids.next('CVIS', 6), ref: t.ref, taxpayerId: t.taxpayerId, step: step.code, status: 'A_FAIRE' });
          done.push(contact(ch, 'VISITE_A_FAIRE'));
          continue;
        }
        if (!tp) continue;
        const event = t.obligationId ? STEP_EVENT[step.code] ?? 'obligation.due_soon' : 'declaration.due_soon';
        const vars = { reference: t.obligationId ?? t.ref, date: t.dueDate, montant: t.amount ? `${t.amount.amount} ${t.amount.currency}` : '' };
        const d = this.ctx.comms.publish(event, [taxpayerRecipient(tp)], vars, { entity: c.entity, onlyChannels: ch === 'SMS' ? ['sms', 'in-app'] : ['svi'] });
        done.push(contact(ch, 'ENVOYE', d.map((x) => x.id)));
      }
    }
    const at = this.now();
    this.relances.update({ ...c, contacts: [...c.contacts, ...done], visits: [...c.visits, ...visits], history: done.length ? [...c.history, { at, by: byId, action: 'Étapes exécutées', note: `${done.filter((x) => x.outcome === 'ENVOYE').length} envoi(s), ${visits.length} visite(s) à faire, ${done.filter((x) => x.outcome === 'ORIENTE_AGENT').length} orientation(s)` }] : c.history });
    if (done.length) {
      this.ctx.audit.append({ actor: by === 'systeme' ? { kind: 'system', id: 'campagnes' } : actorOf(by), action: 'recovery_campaign.steps.run', resourceType: 'recovery_campaign', resourceId: id, details: { contacts: done.length, visits: visits.length, byStep: Object.fromEntries(steps.map((s) => [s.code, done.filter((x) => x.step === s.code).length])) } });
    }
    return { campaignId: id, contacts: done, visits };
  }

  /** Compte rendu d'une visite d'information (aucun encaissement, aucune contrainte). */
  recordVisit(user: User, id: string, visitId: string, input: { outcome: NonNullable<CampaignVisit['outcome']>; note: string; gps?: CampaignVisit['gps'] }): RecoveryCampaign {
    authorize(user, 'campagnes:relance.visite');
    const c = this.get(id);
    const v = c.visits.find((x) => x.id === visitId);
    if (!v) throw notFound('VISIT_NOT_FOUND', `Visite inconnue : ${visitId}`);
    if (v.status === 'FAITE') throw conflict('VISIT_ALREADY_RECORDED', 'Visite déjà rapportée.');
    const at = this.now();
    const out = this.relances.update({ ...c, visits: c.visits.map((x) => (x.id === visitId ? { ...x, status: 'FAITE' as const, outcome: input.outcome, note: input.note, ...(input.gps ? { gps: input.gps } : {}), by: user.id, at } : x)) });
    this.ctx.audit.append({ actor: actorOf(user), action: 'recovery_campaign.visit.recorded', resourceType: 'recovery_campaign', resourceId: id, details: { visitId, outcome: input.outcome } });
    return out;
  }

  private groupMeasure(targets: CampaignTarget[], since: string): GroupMeasure {
    const gross: Record<string, string> = {};
    let regularised = 0;
    let paying = 0;
    for (const t of targets) {
      if (!this.stillUnpaid(t)) regularised++;
      if (!t.obligationId) continue;
      const cur = this.ctx.payments.currentObligationId(t.obligationId);
      const paid = this.ctx.payments.orders.find((p) => (p.obligationId === t.obligationId || p.obligationId === cur) && ['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(p.status) && !!p.confirmedAt && p.confirmedAt >= since);
      if (paid.length) paying++;
      for (const p of paid) gross[p.amount.currency] = Money.fromJSON({ amount: gross[p.amount.currency] ?? '0', currency: p.amount.currency }).add(Money.fromJSON(p.amount)).toDecimalString();
    }
    return { targets: targets.length, regularised, regularisationRate: targets.length ? `${Math.round((regularised * 1000) / targets.length) / 10} %` : null, paying, gross };
  }

  /**
   * Mesure (tests, arrêt) : récupération brute, coûts saisis avec pièce (rendement du recouvrement), net, taux de
   * régularisation du groupe test comparé au groupe témoin, coût par franc récupéré. Si le coût est disproportionné,
   * l'arrêt est PROPOSÉ (décision humaine).
   */
  measure(by: User | 'systeme', id: string): RecoveryCampaign {
    if (by !== 'systeme') authorize(by, 'recouvrement:yield.read');
    const c = this.get(id);
    if (!c.launch?.approvedAt) throw conflict('CAMPAIGN_NOT_LAUNCHED', 'Mesure possible après le lancement de la phase de test.');
    const since = c.launch.approvedAt;
    const active = this.activeTargets(c);
    const control = c.targets.filter((t) => t.group === 'TEMOIN');
    const y = this.yieldPort().campaignYield(c.id, {
      obligationIds: active.map((t) => t.obligationId).filter((x): x is string => !!x), since,
      controlObligationIds: control.map((t) => t.obligationId).filter((x): x is string => !!x),
    });
    const byCurrency: Record<string, string | null> = {};
    let cdfCost = 0;
    let cdfGross = 0;
    let fxOk = true;
    const today = this.today();
    for (const cur of new Set([...Object.keys(y.cost), ...Object.keys(y.gross)])) {
      const cost = Number(y.cost[cur] ?? '0');
      const gross = Number(y.gross[cur] ?? '0');
      byCurrency[cur] = gross > 0 && y.costMeasured ? (cost / gross).toFixed(4) : null;
      try {
        if (cost) cdfCost += Number(this.ctx.fx.convert({ amount: y.cost[cur]!, currency: cur as CurrencyCode }, 'CDF', today).amount.amount);
        if (gross) cdfGross += Number(this.ctx.fx.convert({ amount: y.gross[cur]!, currency: cur as CurrencyCode }, 'CDF', today).amount.amount);
      } catch { fxOk = false; }
    }
    const costPerFranc: CampaignMeasure['costPerFranc'] = !y.costMeasured
      ? { byCurrency, cdfEquivalent: null, statut: 'NON_MESURE', detail: 'Aucun coût saisi pour cette campagne (registre des coûts du recouvrement) : coût par franc non calculable.' }
      : cdfGross <= 0 || !fxOk
        ? { byCurrency, cdfEquivalent: null, statut: Object.values(byCurrency).some((v) => v !== null) ? 'MESURE' : 'NON_MESURE', detail: cdfGross <= 0 ? 'Aucune récupération constatée depuis le lancement : coût par franc non calculable.' : 'Taux de change du jour indisponible : ratio par devise seulement.' }
        : { byCurrency, cdfEquivalent: (cdfCost / cdfGross).toFixed(4), statut: 'MESURE', detail: 'Coût total / récupération brute, en contre-valeur CDF indicative au taux du jour.' };
    const m: CampaignMeasure = {
      at: this.now(), since, test: this.groupMeasure(c.targets.filter((t) => t.group === 'TEST'), since), control: this.groupMeasure(control, since),
      ...(c.status === 'GENERALISEE' ? { generalised: this.groupMeasure(c.targets.filter((t) => t.group === 'RESERVE' && t.generalised), since) } : {}),
      cost: y.cost, costMeasured: y.costMeasured, gross: y.gross, net: y.net, costPerFranc, stopSignals: y.stopSignals,
    };
    let next: RecoveryCampaign = { ...c, measures: [...c.measures, m] };
    const at = m.at;
    if (m.stopSignals.length && !['ARRETEE', 'CLOTUREE'].includes(c.status) && !(c.stopProposal && !c.stopProposal.decision)) {
      next = { ...next, stopProposal: { at, by: by === 'systeme' ? 'systeme' : by.id, reasons: m.stopSignals.map((s) => s.detail) }, history: [...next.history, { at, by: 'systeme', action: 'Arrêt proposé (coût disproportionné)', note: m.stopSignals.map((s) => s.detail).join(' ') }] };
      const approvers = [...this.ctx.users.withRole('R06'), ...this.ctx.users.withRole('R05')];
      this.ctx.comms.publish('approval.requested', approvers.map(userRecipient), { objet: `Arrêt proposé — campagne ${c.code} (coût disproportionné)` }, { entity: c.entity });
      this.ctx.audit.append({ actor: { kind: 'system', id: 'campagnes' }, action: 'recovery_campaign.stop.proposed', resourceType: 'recovery_campaign', resourceId: id, details: { signals: m.stopSignals, automaticStop: false } });
    }
    const out = this.relances.update(next);
    this.ctx.audit.append({ actor: by === 'systeme' ? { kind: 'system', id: 'campagnes' } : actorOf(by), action: 'recovery_campaign.measured', resourceType: 'recovery_campaign', resourceId: id, details: { test: m.test.regularisationRate, control: m.control.regularisationRate, costPerFranc: m.costPerFranc.cdfEquivalent, stopSignals: m.stopSignals.length } });
    return out;
  }

  /** Décision humaine sur la proposition d'arrêt : arrêt motivé, ou poursuite motivée. */
  decideStop(user: User, id: string, input: { stop: boolean; reason: string }): RecoveryCampaign {
    authorize(user, 'campagnes:approve');
    const c = this.get(id);
    if (!c.stopProposal || c.stopProposal.decision) throw conflict('NO_STOP_PROPOSAL', 'Aucune proposition d’arrêt en attente.');
    const at = this.now();
    const out = this.relances.update({
      ...c, stopProposal: { ...c.stopProposal, decision: { by: user.id, at, stop: input.stop, reason: input.reason } },
      ...(input.stop ? { status: 'ARRETEE' as const, stop: { by: user.id, at, reason: input.reason } } : {}),
      history: [...c.history, { at, by: user.id, action: input.stop ? 'Arrêt décidé' : 'Poursuite décidée malgré la proposition d’arrêt', note: input.reason }],
    });
    this.ctx.audit.append({ actor: actorOf(user), action: input.stop ? 'recovery_campaign.stopped' : 'recovery_campaign.stop.declined', resourceType: 'recovery_campaign', resourceId: id, details: { reason: input.reason, proposal: c.stopProposal.reasons } });
    return out;
  }

  /** Arrêt motivé à l'initiative d'une personne (erreurs, impact social non conforme). */
  stopNow(user: User, id: string, reason: string): RecoveryCampaign {
    authorize(user, 'campagnes:approve');
    const c = this.get(id);
    if (c.status === 'ARRETEE' || c.status === 'CLOTUREE') throw conflict('CAMPAIGN_CLOSED', 'Campagne déjà close.');
    const at = this.now();
    const out = this.relances.update({ ...c, status: 'ARRETEE', stop: { by: user.id, at, reason }, history: [...c.history, { at, by: user.id, action: 'Arrêt motivé', note: reason }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'recovery_campaign.stopped', resourceType: 'recovery_campaign', resourceId: id, details: { reason } });
    return out;
  }

  /** Généralisation proposée après au moins une mesure de la phase de test. */
  proposeGeneralisation(user: User, id: string, reason: string): RecoveryCampaign {
    authorize(user, 'campagnes:manage');
    const c = this.get(id);
    if (c.status !== 'EN_TEST') throw conflict('CAMPAIGN_BAD_STATE', 'Généralisation proposée depuis la phase de test seulement.');
    if (!c.measures.length) throw conflict('MEASURE_REQUIRED', 'Tests : une mesure (groupe test comparé au groupe témoin) précède toute généralisation.');
    if (c.stopProposal && !c.stopProposal.decision) throw conflict('STOP_PROPOSAL_PENDING', 'Une proposition d’arrêt attend une décision.');
    const at = this.now();
    const out = this.relances.update({ ...c, status: 'GENERALISATION_PROPOSEE', generalisation: { proposedBy: user.id, proposedAt: at, reason }, history: [...c.history, { at, by: user.id, action: 'Généralisation proposée', note: reason }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'recovery_campaign.generalisation.proposed', resourceType: 'recovery_campaign', resourceId: id, details: { reason, lastMeasure: c.measures.at(-1)?.test.regularisationRate ?? null } });
    return out;
  }

  decideGeneralisation(user: User, id: string, input: { approve: boolean; reason: string }): RecoveryCampaign {
    authorize(user, 'campagnes:approve');
    const c = this.get(id);
    if (c.status !== 'GENERALISATION_PROPOSEE' || !c.generalisation) throw conflict('CAMPAIGN_BAD_STATE', 'Aucune généralisation proposée.');
    assertDistinctPerson(user.id, [c.generalisation.proposedBy], 'La généralisation est décidée par une personne distincte de celle qui l’a proposée.');
    const at = this.now();
    const out = this.relances.update({
      ...c, status: input.approve ? 'GENERALISEE' : 'EN_TEST',
      targets: input.approve ? c.targets.map((t) => (t.group === 'RESERVE' ? { ...t, generalised: true } : t)) : c.targets,
      generalisation: { ...c.generalisation, ...(input.approve ? { approvedBy: user.id, approvedAt: at } : {}) },
      history: [...c.history, { at, by: user.id, action: input.approve ? 'Généralisation décidée (groupe témoin maintenu)' : 'Généralisation refusée', note: input.reason }],
    });
    this.ctx.audit.append({ actor: actorOf(user), action: input.approve ? 'recovery_campaign.generalised' : 'recovery_campaign.generalisation.rejected', resourceType: 'recovery_campaign', resourceId: id, details: { reason: input.reason } });
    return out;
  }

  /** Visites d'information à faire (vue minimale de l'agent : ni montant ni segment, § 15). */
  visitsToDo(user: User) {
    authorize(user, 'campagnes:relance.visite');
    return this.relances.all().flatMap((c) => c.visits.filter((v) => v.status === 'A_FAIRE').map((v) => {
      const t = c.targets.find((x) => x.ref === v.ref);
      const tp = this.ctx.taxpayers.taxpayers.get(v.taxpayerId);
      return { campaignId: c.id, campaignCode: c.code, visitId: v.id, step: v.step, commune: t?.commune ?? null, taxpayer: tp ? { id: tp.id, name: tp.fullName } : null, purpose: 'Visite d’information : expliquer, orienter vers l’assistance ou un point de paiement officiel. Aucun encaissement, aucune contrainte.' };
    }));
  }

  list(user: User) {
    authorize(user, 'campagnes:read');
    return this.relances.all().reverse().map((c) => ({ ...c, summary: this.summary(c) }));
  }

  /** Indicateurs du module 33 : taux de régularisation (test / témoin) et coût par franc récupéré, dernière mesure. */
  indicators() {
    const rows = this.relances.all().map((c) => {
      const m = c.measures.at(-1);
      return { id: c.id, code: c.code, status: c.status, regularisationTest: m?.test.regularisationRate ?? null, regularisationControl: m?.control.regularisationRate ?? null, costPerFranc: m?.costPerFranc ?? null, measuredAt: m?.at ?? null };
    });
    const measured = rows.filter((r) => r.measuredAt);
    return {
      campaigns: rows.length, measured: measured.length, rows,
      statut: measured.length ? ('MESURE' as const) : ('NON_MESURE' as const),
      detail: measured.length ? 'Dernière mesure de chaque campagne (données réelles).' : 'Aucune campagne de recouvrement mesurée : lancer la phase de test puis mesurer.',
    };
  }
}
