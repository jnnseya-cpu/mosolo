/**
 * Sources des postes de décision : lecture SEULE des éléments en attente de décision dans les modules existants
 * (circuits, validations, portes, arbitrages, instructions…). Aucune décision n'est prise ici, aucun circuit n'est
 * réimplémenté : chaque élément indique la route de décision de sa source, et l'éligibilité d'une personne est celle que
 * la source applique déjà (politique du module + séparation des tâches). Le chapitre 27 ne modifie aucune habilitation.
 *
 * Chaque élément est rangé soit dans une des dix catégories du § 27.4 (il peut alors atteindre une corbeille de
 * décision), soit dans la file de travail de ceux qui peuvent le traiter (§ 27.13).
 */
import type { MoneyJSON, RoleCode } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { AuditRecord } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { evaluate } from '../../core/policy.js';
import { CIRCUITS } from '../integrite/gouvernance/circuits.js';
import { APPROVAL_ROLE } from '../../modules/rules/service.js';
import { isMoney, type CategorieDecision, type EtatChiffre, type Gravite } from './model.js';

export interface Forward { method: 'POST'; url: string; body: (motif: string, approve: boolean) => unknown }

export interface SourceItem {
  id: string;
  source: string;
  sourceId: string;
  module: string;
  categorie: CategorieDecision | null;
  objet: string;
  demandeurId: string | null;
  serviceInstructeur: string;
  validationAmont: string | null;
  /** Dépôt ou proposition (ISO). */
  date: string;
  /** Date limite de la source (AAAA-MM-JJ), sinon calculée par le poste. */
  echeance: string | null;
  enjeu: { montant: MoneyJSON | null; etat: EtatChiffre; nombre: string | null; commune: string | null; texte: string };
  entities: string[];
  fondement: string[];
  position: { recommandation: string; reserves: string[] };
  siRien: string;
  pieces: { libelle: string; reference?: string; sha256?: string }[];
  /** Porte sur un contribuable nommément désigné : montant exact et identité jamais sur un écran d'accueil. */
  individuel: boolean;
  gravite: Gravite;
  /** Action de politique de la source qui désigne les décideurs (lecture seule : remontée par rôles). */
  deciderAction: string | null;
  /** La personne peut-elle décider selon la source (droit + séparation des tâches) ? */
  eligible: (u: User) => boolean;
  /** Relais possibles vers la route de décision EXISTANTE (jamais une route financière). */
  approuver?: Forward;
  refuser?: Forward;
  /** Motif d'indisponibilité des actions depuis le poste (décision prise sur l'écran de la source). */
  horsPoste?: string;
  ecran: string;
  exemple?: boolean;
  information?: boolean;
}

// ————————————————————————— accès typés minimaux aux services des modules —————————————————————————

type Repo<T> = { all(): T[]; get(id: string): T | undefined };
interface AccesLike {
  entities: Repo<{ id: string; name: string; shortName: string; kind: string; parentId: string | null }>;
  modules: Repo<{ id: string; code: string; label: string; status: string; responsibleEntity: string; visas: { by: string; step: string }[]; createdBy: string; createdAt: string; actReferences: string[]; pendingReattachment?: { newEntity: string; actReference: string; motif: string; proposedBy: string; at: string } }>;
  arbitrations: Repo<{ id: string; kind: string; status: string; openedAt: string; openedBy: string; claimants: { entity: string }[]; opinion?: { by: string; text: string }; subject: Record<string, unknown> }>;
  validations: Repo<{ id: string; kind: string; status: string; entity: string; requestedBy: string; subjectUserId: string; createdAt: string; requirement: string; motif: string }>;
  listValidations(u: User): { id: string; qualified: boolean }[];
  elevations: { requests: Repo<{ id: string; userId: string; userEntity: string; role: string; status: string; requestedAt: string; motif: string; durationMinutes: number }> };
  subtree(root: string): Set<string>;
}

const ROLE_OF = (role: string): User => ({ kind: 'user', id: `role:${role}`, name: role, roles: [role as RoleCode], entity: '*' });

/** Rôles qui détiennent, en principe, le droit de l'action (grille de la politique, lue sans la modifier). */
export function rolesDeciders(action: string | null, entities: string[] = []): RoleCode[] {
  if (!action) return [];
  const out: RoleCode[] = [];
  for (let i = 1; i <= 37; i++) {
    const r = `R${String(i).padStart(2, '0')}` as RoleCode;
    // Évaluation sans ressource puis « dans l'entité de l'élément » : un droit conditionnel compte comme décideur.
    const hit = [undefined, ...entities].some((e) => {
      const u = { ...ROLE_OF(r), entity: e ?? '*' };
      return evaluate(u, action as never, e ? { entity: e, entities: [e] } : {}) !== false;
    });
    if (hit) out.push(r);
  }
  return out;
}

const may = (u: User, action: string, res: Record<string, unknown> = {}) => evaluate(u, action as never, res as never) !== false;
const notIn = (u: User, ids: (string | undefined | null)[]) => !ids.filter(Boolean).includes(u.id);
const day = (iso: string) => iso.slice(0, 10);

// ————————————————————————— circuits à quatre yeux relus au journal —————————————————————————

/** Circuits relus au journal : politique de décision et écran de la source (vérifiés dans chaque module). */
export const CIRCUITS_FILE: Record<string, { action: string; ecran: string; module: string }> = {
  TRESOR_OPERATION: { action: 'tresor:operation.approve', ecran: '/tresor', module: 'Trésor' },
  TRESOR_APPARIEMENT: { action: 'tresor:matching.decide', ecran: '/tresor/appariements', module: 'Trésor' },
  TRESOR_PENALITE_POINT: { action: 'tresor:points.penalty.decide', ecran: '/tresor/points-agrees', module: 'Trésor' },
  BASE_DEROGATION: { action: 'assessment:base-override.approve', ecran: '/liquidation/derogations', module: 'Liquidation' },
  OBJET_CORRECTION: { action: 'fiscal:object.correct.approve', ecran: '/fiscal/corrections', module: 'Fiscal' },
  REGLE_SUSPENSION: { action: 'rules:suspend.approve', ecran: '/registre', module: 'Registre juridique' },
  COMMISSION_VALIDATION: { action: 'sanctions:commission.validate', ecran: '/agents/validation-commissions', module: 'Commissions des agents' },
  FISCAL_DEPENDANCE_ACTIVATION: { action: 'fiscal:dependency.approve', ecran: '/fiscal/dependances', module: 'Fiscal' },
  ENROLEMENT_RECUPERATION: { action: 'enrolement:recovery.approve', ecran: '/acces/identite', module: 'Enrôlement' },
  CAMPAGNE_LANCEMENT: { action: 'campagnes:approve', ecran: '/recouvrement/campagnes', module: 'Campagnes' },
  POINT_JURIDIQUE: { action: 'juridique:points.decide', ecran: '/juridique/points', module: 'Registre juridique' },
  PURGE_CONSERVATION: { action: 'juridique:purge.decide', ecran: '/juridique/donnees', module: 'Protection des données' },
  TERRAIN_RECUPERATION: { action: 'terrain:clawback.decide', ecran: '/terrain/qualite', module: 'Terrain' },
  REGISTRE_SEUILS: { action: 'integrite:thresholds.approve', ecran: '/integrite/seuils', module: 'Registre des seuils' },
};

interface PendingProposal { circuit: string; label: string; key: string; actorId: string; at: string; details: Record<string, unknown> }

/** Propositions humaines encore sans décision (approbation ou refus), par circuit relu. */
export function pendingProposals(records: AuditRecord[]): PendingProposal[] {
  const byAction = new Map<string, { code: string; label: string; role: 'P' | 'D'; key: (e: AuditRecord) => string | null }>();
  for (const c of CIRCUITS) {
    if (!CIRCUITS_FILE[c.code]) continue;
    const key = (e: AuditRecord) => (c.key ? c.key(e) : e.resourceId);
    for (const a of c.proposals) byAction.set(a, { code: c.code, label: c.label, role: 'P', key });
    for (const a of [...c.approvals, ...c.refusals]) byAction.set(a, { code: c.code, label: c.label, role: 'D', key });
  }
  const open = new Map<string, PendingProposal>();
  for (const e of records) {
    const hit = byAction.get(e.action);
    if (!hit || e.outcome !== 'SUCCESS') continue;
    const k = hit.key(e);
    if (!k) continue;
    const pk = `${hit.code}|${k}`;
    if (hit.role === 'P') {
      if (e.actor.kind === 'user') open.set(pk, { circuit: hit.code, label: hit.label, key: k, actorId: e.actor.id, at: e.at, details: e.details });
      else open.delete(pk);
    } else open.delete(pk);
  }
  return [...open.values()];
}

// ————————————————————————— collecte —————————————————————————

export interface CollectOptions {
  /** Seuil (contre-valeur CDF) au-delà duquel une exonération, annulation ou un dégrèvement remonte (§ 27.4). */
  seuilExonerationCdf: number;
  toCdf: (m: MoneyJSON) => bigint;
}

export class Sources {
  private auditMemo: { length: number; items: PendingProposal[] } | null = null;

  constructor(private readonly ctx: AppContext) {}

  private svc<T>(name: string): T | undefined { return this.ctx.ext[name] as T | undefined; }
  private instrumentTitles(ids: string[]): string[] {
    return ids.map((id) => this.ctx.rules.instruments.get(id)?.title ?? id);
  }
  private ruleFondement(ruleId: string | undefined): string[] {
    if (!ruleId) return [];
    const r = this.ctx.rules.rules.get(ruleId);
    return r ? [...this.instrumentTitles(r.legalInstrumentIds), ...r.articles.map((a) => `${r.code} — ${a}`)] : [];
  }
  userLabel(id: string | null | undefined): string {
    if (!id) return '—';
    const u = this.ctx.users.get(id);
    return u ? u.name : id;
  }

  private pendingAudit(): PendingProposal[] {
    const len = this.ctx.audit.length;
    if (!this.auditMemo || this.auditMemo.length !== len) {
      this.auditMemo = { length: len, items: pendingProposals(this.ctx.audit.list({ limit: Number.MAX_SAFE_INTEGER }).items) };
    }
    return this.auditMemo.items;
  }

  /** Tous les éléments en attente de décision (indépendamment de la personne). */
  collect(o: CollectOptions): SourceItem[] {
    return [
      ...this.rules(), ...this.beneficiaryChanges(), ...this.recovery(o), ...this.disposals(), ...this.targets(), ...this.scenarios(), ...this.repartition(),
      ...this.acces(), ...this.programme(), ...this.baselines(), ...this.instructions(), ...this.circuits(),
    ];
  }

  // ——— § 27.4 (1) publication d'une règle ; visas intermédiaires en file de travail ———
  private rules(): SourceItem[] {
    const out: SourceItem[] = [];
    for (const r of this.ctx.rules.rules.all()) {
      const step = r.status === 'REVUE_JURIDIQUE' ? 'VERIFICATEUR_JURIDIQUE' : r.status === 'REVUE_FINANCIERE' ? 'VALIDATEUR_FINANCIER' : r.status === 'APPROUVEE' ? 'AUTORITE_PUBLICATION' : null;
      if (!step) continue;
      const role = APPROVAL_ROLE[step as keyof typeof APPROVAL_ROLE];
      const previous = [...r.approvals.map((a) => a.userId), r.createdBy];
      const last = r.approvals.at(-1);
      const publication = step === 'AUTORITE_PUBLICATION';
      out.push({
        id: `REGLE:${r.id}`, source: 'REGLE', sourceId: r.id, module: 'Registre juridique', categorie: publication ? 'PUBLICATION_REGLE' : null,
        objet: publication ? `Publier la règle « ${r.label} » (${r.code}, version ${r.version})` : `Viser la règle « ${r.label} » (${r.code}, version ${r.version})`,
        demandeurId: last?.userId ?? r.createdBy ?? null, serviceInstructeur: 'Juristes du référentiel (rédaction, vérification)', validationAmont: r.approvals.length ? `${r.approvals.length} visa(s) sur 4` : null,
        date: last?.at ?? r.history?.[0]?.at ?? this.ctx.clock.now().toISOString(), echeance: null,
        enjeu: { montant: null, etat: 'COMPTAGE', nombre: '1 règle', commune: null, texte: `Toutes les liquidations futures de ${r.code}` },
        entities: [r.administeringEntity], fondement: [...this.instrumentTitles(r.legalInstrumentIds), ...r.articles.map((a) => `${r.code} — ${a}`)],
        position: { recommandation: publication ? 'Publication proposée après rédaction, vérification juridique et validation financière (trois visas distincts).' : 'Visa attendu dans l’ordre du circuit à quatre visas.', reserves: r.status === 'APPROUVEE' ? ['Contrôle fiscal de publication (cas de tests exécutés, échantillon joint) appliqué par la source.'] : [] },
        siRien: publication ? 'La règle n’est pas opposable : aucune liquidation ne peut s’appuyer sur elle.' : 'La règle reste en revue.',
        pieces: r.legalInstrumentIds.map((id) => ({ libelle: this.ctx.rules.instruments.get(id)?.title ?? id, reference: id })),
        individuel: false, gravite: 'HAUTE', deciderAction: 'rule.approve',
        eligible: (u) => u.roles.includes(role) && notIn(u, previous) && may(u, 'rule.approve'),
        approuver: { method: 'POST', url: `/v1/legal-rules/${encodeURIComponent(r.id)}/approve`, body: () => ({ role: step }) },
        ...(publication ? {} : { horsPoste: 'Visa de circuit : poste de travail du juriste.' }),
        ecran: '/registre', ...((r as { demo?: boolean }).demo ? { exemple: true } : {}),
      });
    }
    return out;
  }

  // ——— § 27.4 (2) changement d'un compte public bénéficiaire (décision au coffre, jamais depuis un poste) ———
  private beneficiaryChanges(): SourceItem[] {
    return this.ctx.vault.requests.all().filter((r) => r.status === 'EN_ATTENTE_APPROBATION').map((r) => ({
      id: `COFFRE:${r.id}`, source: 'COFFRE', sourceId: r.id, module: 'Coffre des bénéficiaires', categorie: 'CHANGEMENT_COMPTE_BENEFICIAIRE' as const,
      objet: `Changement du compte public bénéficiaire « ${r.alias} »`, demandeurId: r.requestedBy, serviceInstructeur: 'Trésor — comptable public',
      validationAmont: `${r.approvals.length} validation(s) technique(s) hors bande`, date: r.requestedAt, echeance: null,
      enjeu: { montant: null, etat: 'COMPTAGE' as const, nombre: '1 compte public', commune: null, texte: 'Toutes les recettes versées sur ce compte' },
      entities: ['TRESOR'], fondement: [],
      position: { recommandation: r.reason.slice(0, 280), reserves: ['Double validation technique par les gestionnaires du coffre, puis délai de refroidissement.'] },
      siRien: 'Le compte en vigueur reste inchangé.', pieces: [{ libelle: 'Demande motivée (numéro de compte masqué)', reference: r.id }],
      individuel: false, gravite: 'CRITIQUE' as const, deciderAction: 'beneficiary.approve',
      eligible: (u: User) => may(u, 'beneficiary.approve') && notIn(u, [r.requestedBy, ...r.approvals.map((a) => a.userId)]),
      horsPoste: 'Aucun poste de décision ne modifie un compte bénéficiaire : décision au coffre (double validation technique), jamais depuis la corbeille.',
      ecran: '/tresor', information: true,
    }));
  }

  // ——— § 27.4 (3) exonération, annulation, dégrèvement au-delà du seuil ———
  private recovery(o: CollectOptions): SourceItem[] {
    const rec = this.svc<{ remissions: Repo<{ id: string; obligationId: string; taxpayerId: string; basisRuleId: string; requestedAmount: MoneyJSON; requestedBy: string; requestedAt: string; status: string; instruction?: { by: string; favorable: boolean; analysis: string }; computation?: { originalAmount: MoneyJSON } }>; writeOffs: Repo<{ id: string; obligationId: string; taxpayerId: string; amount: MoneyJSON; motivation: string; proposedBy: string; proposedAt: string; status: string }> }>('recouvrement');
    if (!rec) return [];
    const out: SourceItem[] = [];
    for (const r of rec.remissions.all().filter((x) => x.status === 'INSTRUITE')) {
      const ob = this.ctx.assessment.obligations.get(r.obligationId);
      const original = r.computation?.originalAmount ?? ob?.amount ?? null;
      const reduction = original && original.currency === r.requestedAmount.currency ? { currency: original.currency, amount: (Number(original.amount) - Number(r.requestedAmount.amount)).toFixed(2) } : null;
      const above = reduction ? o.toCdf(reduction) >= BigInt(Math.trunc(o.seuilExonerationCdf)) : false;
      out.push({
        id: `REMISE:${r.id}`, source: 'REMISE', sourceId: r.id, module: 'Recouvrement', categorie: above ? 'EXONERATION_DEGREVEMENT' : null,
        objet: 'Remise gracieuse (dégrèvement) sollicitée', demandeurId: r.requestedBy, serviceInstructeur: 'Contentieux — instruction', validationAmont: r.instruction ? `Instruction ${r.instruction.favorable ? 'favorable' : 'défavorable'}` : null,
        date: r.requestedAt, echeance: null, enjeu: { montant: reduction, etat: 'CONSTATE', nombre: '1 contribuable', commune: null, texte: 'Perte de recette discrétionnaire' },
        entities: [ob?.entity ?? 'DGIPK'], fondement: this.ruleFondement(r.basisRuleId),
        position: { recommandation: (r.instruction?.analysis ?? 'Instruction au dossier.').slice(0, 280), reserves: [] },
        siRien: 'L’obligation reste due pour son montant initial.', pieces: [{ libelle: 'Dossier de remise (nominatif, finalité déclarée requise)', reference: r.id }],
        individuel: true, gravite: 'HAUTE', deciderAction: 'recouvrement:decide',
        eligible: (u) => may(u, 'recouvrement:decide') && notIn(u, [r.requestedBy, r.instruction?.by]),
        horsPoste: 'Décision sur la dette : autorité de décision contentieuse, sur l’écran des remises (jamais depuis un poste de décision).', ecran: '/recouvrement/remises', information: above,
      });
    }
    for (const w of rec.writeOffs.all().filter((x) => x.status === 'PROPOSEE')) {
      const above = o.toCdf(w.amount) >= BigInt(Math.trunc(o.seuilExonerationCdf));
      const ob = this.ctx.assessment.obligations.get(w.obligationId);
      out.push({
        id: `NON_VALEUR:${w.id}`, source: 'NON_VALEUR', sourceId: w.id, module: 'Recouvrement', categorie: above ? 'EXONERATION_DEGREVEMENT' : null,
        objet: 'Admission en non-valeur (annulation de créance) proposée', demandeurId: w.proposedBy, serviceInstructeur: 'Contentieux', validationAmont: null,
        date: w.proposedAt, echeance: null, enjeu: { montant: w.amount, etat: 'CONSTATE', nombre: '1 contribuable', commune: null, texte: 'Créance proposée à l’annulation' },
        entities: [ob?.entity ?? 'DGIPK'], fondement: this.ruleFondement(ob?.ruleId),
        position: { recommandation: w.motivation.slice(0, 280), reserves: [] }, siRien: 'La créance reste en recouvrement.',
        pieces: [{ libelle: 'Dossier de non-valeur (nominatif, finalité déclarée requise)', reference: w.id }],
        individuel: true, gravite: 'HAUTE', deciderAction: 'recouvrement:decide',
        eligible: (u) => may(u, 'recouvrement:decide') && notIn(u, [w.proposedBy]),
        horsPoste: 'Décision sur la dette : autorité de décision contentieuse, sur l’écran des non-valeurs.', ecran: '/recouvrement/non-valeurs', information: above,
      });
    }
    return out;
  }

  // ——— § 27.4 (5) mesure irréversible sur un bien (destination légale d'un véhicule en fourrière) ———
  private disposals(): SourceItem[] {
    const vc = this.svc<{ fourriere: { dossiers: Repo<{ id: string; status: string; constat: { commune: string }; disposal?: { kind: string; authorityDecisionRef: string; legalBasis: string; motif: string; proposedBy: string; proposedAt: string; appealDeadline: string; validations: { level: number; by: string }[] }; demo?: boolean }> } }>('vehicules-controle');
    if (!vc) return [];
    return vc.fourriere.dossiers.all().filter((x) => x.status === 'DESTINATION_PROPOSEE' && x.disposal).map((x) => {
      const p = x.disposal!;
      const level = p.validations.some((v) => v.level === 1) ? 2 : 1;
      const action = level === 1 ? 'fourriere:disposal.validate1' : 'fourriere:disposal.validate2';
      return {
        id: `FOURRIERE:${x.id}`, source: 'FOURRIERE', sourceId: x.id, module: 'Fourrières (RFCK)', categorie: 'MESURE_IRREVERSIBLE_BIEN' as const,
        objet: `${p.kind === 'VENTE' ? 'Vente' : 'Destruction'} d’un véhicule en fourrière — validation de niveau ${level}`, demandeurId: p.proposedBy, serviceInstructeur: 'RFCK — fourrières',
        validationAmont: level === 2 ? 'Validation hiérarchique de premier niveau obtenue' : null, date: p.proposedAt, echeance: p.appealDeadline,
        enjeu: { montant: null, etat: 'COMPTAGE' as const, nombre: '1 véhicule', commune: x.constat.commune, texte: 'Mesure irréversible sur un bien' },
        entities: ['RFCK'], fondement: [p.legalBasis, p.authorityDecisionRef].filter(Boolean),
        position: { recommandation: p.motif.slice(0, 280), reserves: ['Délai de recours du propriétaire à respecter.'] },
        siRien: 'Le véhicule reste sous garde ; les frais de garde continuent de courir.', pieces: [{ libelle: 'Dossier de fourrière (nominatif, finalité déclarée requise)', reference: x.id }],
        individuel: true, gravite: 'HAUTE' as const, deciderAction: action,
        eligible: (u: User) => may(u, action) && notIn(u, [p.proposedBy, ...p.validations.map((v) => v.by)]),
        approuver: { method: 'POST' as const, url: `/v1/fourrieres/dossiers/${encodeURIComponent(x.id)}/destination-legale/validation`, body: (motif: string, approve: boolean) => ({ level, approve, motif }) },
        refuser: { method: 'POST' as const, url: `/v1/fourrieres/dossiers/${encodeURIComponent(x.id)}/destination-legale/validation`, body: (motif: string) => ({ level, approve: false, motif }) },
        ecran: '/fourrieres', ...(x.demo ? { exemple: true } : {}),
      };
    });
  }

  // ——— § 27.4 (7) arbitrage des assignations ———
  private targets(): SourceItem[] {
    const pl = this.svc<{ targets: Repo<{ id: string; fiscalYear: string; label: string; act: { reference: string; title: string; sha256?: string }; entries: { commune: string; amount: MoneyJSON }[]; status: string; importedBy: string; importedAt: string; example?: boolean }> }>('planification');
    if (!pl) return [];
    return pl.targets.all().filter((t) => t.status === 'IMPORTEE').map((t) => {
      const cdf = t.entries.reduce((a, e) => a + Number(e.amount.currency === 'CDF' ? e.amount.amount : 0), 0);
      return {
        id: `ASSIGNATIONS:${t.id}`, source: 'ASSIGNATIONS', sourceId: t.id, module: 'Planification — assignations', categorie: 'ARBITRAGE_ASSIGNATIONS' as const,
        objet: `Arbitrer les assignations de recettes ${t.fiscalYear} (« ${t.label} »)`, demandeurId: t.importedBy, serviceInstructeur: 'Régies et ministère provincial des Finances', validationAmont: null,
        date: t.importedAt, echeance: null,
        enjeu: { montant: cdf > 0 ? { currency: 'CDF', amount: cdf.toFixed(2) } : null, etat: 'OBJECTIF' as const, nombre: `${new Set(t.entries.map((e) => e.commune)).size} commune(s)`, commune: null, texte: 'Pression de collecte de l’exercice' },
        entities: ['MINFIN'], fondement: [`${t.act.reference} — ${t.act.title}`],
        position: { recommandation: 'Certification proposée des assignations importées (quatre yeux : importées par une personne, certifiées par une autre).', reserves: [] },
        siRien: 'L’écart à l’assignation n’est pas mesuré pour l’exercice.', pieces: [{ libelle: t.act.title, reference: t.act.reference, ...(t.act.sha256 ? { sha256: t.act.sha256 } : {}) }],
        individuel: false, gravite: 'HAUTE' as const, deciderAction: 'planification:targets.certify',
        eligible: (u: User) => may(u, 'planification:targets.certify') && notIn(u, [t.importedBy]),
        approuver: { method: 'POST' as const, url: `/v1/pilotage/assignations/${encodeURIComponent(t.id)}/certification`, body: (motif: string, approve: boolean) => ({ approve, motif }) },
        refuser: { method: 'POST' as const, url: `/v1/pilotage/assignations/${encodeURIComponent(t.id)}/certification`, body: (motif: string) => ({ approve: false, motif }) },
        ecran: '/pilotage/assignations', ...(t.example ? { exemple: true } : {}),
      };
    });
  }

  // ——— § 27.4 (9) scénario d'affectation de fonds disponibles ———
  private scenarios(): SourceItem[] {
    const pl = this.svc<{ fundScenarios: Repo<{ id: string; label: string; variant: string; period: string; available: MoneyJSON; availableBasis: string; items: { title: string; legalFundSource: string }[]; requestedBy: string; proposedAt: string; status: string }> }>('planification');
    if (!pl) return [];
    return pl.fundScenarios.all().filter((s) => s.status === 'PROPOSE').map((s) => ({
      id: `SCENARIO:${s.id}`, source: 'SCENARIO', sourceId: s.id, module: 'Planification — emploi des fonds', categorie: 'AFFECTATION_FONDS' as const,
      objet: `Retenir le scénario d’affectation « ${s.label} » (${s.period})`, demandeurId: s.requestedBy, serviceInstructeur: 'Proposition de l’IA (allocation), demandée par le service budgétaire',
      validationAmont: null, date: s.proposedAt, echeance: null,
      enjeu: { montant: s.available, etat: 'DISPONIBLE' as const, nombre: `${s.items.length} projet(s)`, commune: null, texte: `Hypothèse : ${s.availableBasis}` },
      entities: ['MINFIN'], fondement: [...new Set(s.items.map((i) => i.legalFundSource))],
      position: { recommandation: `Proposition de l’IA (variante ${s.variant}) : l’autorité décide.`, reserves: [`Hypothèse de disponibilité : ${s.availableBasis}`] },
      siRien: 'Aucun projet n’est retenu ; les fonds restent non affectés.', pieces: s.items.map((i) => ({ libelle: i.title })),
      individuel: false, gravite: 'NORMALE' as const, deciderAction: 'planification:project.decide',
      eligible: (u: User) => may(u, 'planification:project.decide') && notIn(u, [s.requestedBy]),
      approuver: { method: 'POST' as const, url: `/v1/pilotage/projets/scenarios/${encodeURIComponent(s.id)}/decision`, body: (motif: string, approve: boolean) => ({ retain: approve, motif }) },
      refuser: { method: 'POST' as const, url: `/v1/pilotage/projets/scenarios/${encodeURIComponent(s.id)}/decision`, body: (motif: string) => ({ retain: false, motif }) },
      ecran: '/pilotage/projets',
    }));
  }

  private repartition(): SourceItem[] {
    const rp = this.svc<{ keys: Repo<{ id: string; code: string; label: string; version: number; status: string; legalAct?: { instrumentId: string; reference?: string; recordedBy?: string }; activation?: { proposedBy: string; proposedAt: string; motif: string } }> }>('repartition');
    if (!rp) return [];
    return rp.keys.all().filter((k) => k.status === 'ACTIVATION_PROPOSEE' && k.activation).map((k) => ({
      id: `REPARTITION:${k.id}`, source: 'REPARTITION', sourceId: k.id, module: 'Répartition des recettes (§ 37A)', categorie: 'AFFECTATION_FONDS' as const,
      objet: `Activer la clé de répartition « ${k.label} » (version ${k.version})`, demandeurId: k.activation!.proposedBy, serviceInstructeur: 'Ministère provincial des Finances',
      validationAmont: k.legalAct ? 'Acte enregistré' : null, date: k.activation!.proposedAt, echeance: null,
      enjeu: { montant: null, etat: 'COMPTAGE' as const, nombre: '1 clé', commune: null, texte: 'Emploi de la recette rapprochée' },
      entities: ['MINFIN'], fondement: k.legalAct ? [this.ctx.rules.instruments.get(k.legalAct.instrumentId)?.title ?? k.legalAct.reference ?? k.legalAct.instrumentId] : [],
      position: { recommandation: k.activation!.motif.slice(0, 280), reserves: ['Après activation, chaque flux reste proposé au Trésor et validé par une seconde personne.'] },
      siRien: 'La clé reste en simulation : aucun calcul opposable.', pieces: k.legalAct ? [{ libelle: 'Acte juridique', reference: k.legalAct.instrumentId }] : [],
      individuel: false, gravite: 'NORMALE' as const, deciderAction: 'repartition:activation.decide',
      eligible: (u: User) => may(u, 'repartition:activation.decide') && notIn(u, [k.activation!.proposedBy, k.legalAct?.recordedBy]),
      approuver: { method: 'POST' as const, url: `/v1/pilotage/repartition/cles/${encodeURIComponent(k.id)}/activation/decision`, body: (motif: string, approve: boolean) => ({ approve, motif }) },
      refuser: { method: 'POST' as const, url: `/v1/pilotage/repartition/cles/${encodeURIComponent(k.id)}/activation/decision`, body: (motif: string) => ({ approve: false, motif }) },
      ecran: '/pilotage/repartition',
    }));
  }

  // ——— files de travail : accès (validations, arbitrages, fiches de module, élévations) ———
  private acces(): SourceItem[] {
    const a = this.svc<AccesLike>('acces');
    if (!a) return [];
    const now = this.ctx.clock.now().toISOString();
    const base = (id: string, source: string, sourceId: string, objet: string, demandeurId: string | null, date: string, entities: string[], ecran: string, deciderAction: string, eligible: (u: User) => boolean, extra: Partial<SourceItem> = {}): SourceItem => ({
      id, source, sourceId, module: 'Accès et entités', categorie: null, objet, demandeurId, serviceInstructeur: 'Module d’accès', validationAmont: null, date, echeance: null,
      enjeu: { montant: null, etat: 'COMPTAGE', nombre: null, commune: null, texte: '' }, entities, fondement: [], position: { recommandation: '', reserves: [] }, siRien: '', pieces: [],
      individuel: false, gravite: 'NORMALE', deciderAction, eligible, ecran, horsPoste: 'Décision sur l’écran de la source.', ...extra,
    });
    const out: SourceItem[] = [];
    for (const v of a.validations.all().filter((x) => x.status === 'EN_ATTENTE')) {
      out.push(base(`VALIDATION:${v.id}`, 'VALIDATION', v.id, `Seconde validation — ${v.kind === 'ACTIVATION_COMPTE' ? 'activation d’un compte de travail' : v.kind === 'DROIT_INVITER' ? 'droit d’inviter' : 'opérateur d’accès'} (${v.entity})`, v.requestedBy, v.createdAt, [v.entity], '/acces/invitations', 'acces:validation.decide',
        (u) => a.listValidations(u).some((x) => x.id === v.id && x.qualified)));
    }
    for (const x of a.arbitrations.all().filter((z) => z.status !== 'DECIDE')) {
      const entities = x.claimants.map((c) => c.entity);
      if (x.status === 'OUVERT') {
        out.push(base(`ARBITRAGE_AVIS:${x.id}`, 'ARBITRAGE_AVIS', x.id, `Avis juridique sur l’arbitrage ${x.id} (${entities.join(' / ')})`, x.openedBy, x.openedAt, entities, '/acces/arbitrages', 'acces:arbitration.opinion',
          (u) => may(u, 'acces:arbitration.opinion') && notIn(u, [x.openedBy])));
      } else {
        out.push(base(`ARBITRAGE:${x.id}`, 'ARBITRAGE', x.id, `Trancher l’arbitrage de compétence ${x.id} (${entities.join(' / ')})`, x.opinion?.by ?? x.openedBy, x.openedAt, entities, '/acces/arbitrages', 'acces:arbitration.decide',
          (u) => may(u, 'acces:arbitration.decide') && notIn(u, [x.opinion?.by, x.openedBy]) && !entities.includes(u.entity)));
      }
    }
    const steps: Record<string, { action: string; label: string }> = {
      VALIDATION_PROGRAMME: { action: 'acces:module.visa.programme', label: 'Visa programme' }, VALIDATION_JURIDIQUE: { action: 'acces:module.visa.juridique', label: 'Visa juridique' },
      RECETTE: { action: 'acces:module.recette', label: 'Recette' }, SECONDE_VALIDATION: { action: 'acces:module.activate', label: 'Activation (seconde validation)' },
    };
    for (const m of a.modules.all()) {
      const s = steps[m.status];
      if (s) {
        out.push(base(`MODULE:${m.id}`, 'MODULE', m.id, `${s.label} — fiche de module « ${m.label} »`, m.visas.at(-1)?.by ?? m.createdBy, m.createdAt, [m.responsibleEntity], '/acces/entites', s.action,
          (u) => may(u, s.action, { entity: m.responsibleEntity }) && notIn(u, m.visas.map((v) => v.by))));
      }
      if (m.pendingReattachment) {
        const p = m.pendingReattachment;
        out.push(base(`RATTACHEMENT:${m.id}`, 'RATTACHEMENT', m.id, `Rattachement du module « ${m.label} » à ${p.newEntity}`, p.proposedBy, p.at, [m.responsibleEntity, p.newEntity], '/acces/entites', 'acces:module.reattach.approve',
          (u) => may(u, 'acces:module.reattach.approve') && notIn(u, [p.proposedBy])));
      }
    }
    for (const e of a.elevations.requests.all().filter((x) => x.status === 'DEMANDEE')) {
      out.push(base(`ELEVATION:${e.id}`, 'ELEVATION', e.id, `Élévation d’accès privilégié (${e.role}, ${e.durationMinutes} min)`, e.userId, e.requestedAt, [e.userEntity], '/acces/elevations', 'acces:elevation.approve',
        (u) => may(u, 'acces:elevation.approve') && notIn(u, [e.userId]), { gravite: 'HAUTE' }));
    }
    void now;
    return out;
  }

  private programme(): SourceItem[] {
    const pg = this.svc<{ gates: Repo<{ id: string; phase: string; requestedBy: string; requestedAt: string; motif: string; status: string }> }>('programme');
    if (!pg) return [];
    return pg.gates.all().filter((g) => g.status === 'DEMANDEE').map((g) => ({
      id: `PORTE:${g.id}`, source: 'PORTE', sourceId: g.id, module: 'Conduite du programme', categorie: null,
      objet: `Porte de sortie de la phase ${g.phase}`, demandeurId: g.requestedBy, serviceInstructeur: 'Direction de programme', validationAmont: null, date: g.requestedAt, echeance: null,
      enjeu: { montant: null, etat: 'COMPTAGE' as const, nombre: null, commune: null, texte: '' }, entities: ['MINFIN'], fondement: [], position: { recommandation: g.motif.slice(0, 280), reserves: [] },
      siRien: 'La phase suivante ne peut démarrer.', pieces: [], individuel: false, gravite: 'NORMALE' as const, deciderAction: 'planification:programme.gate.decide',
      eligible: (u: User) => may(u, 'planification:programme.gate.decide') && notIn(u, [g.requestedBy]),
      horsPoste: 'Décision du comité de pilotage rattachée à une réunion consignée : écran de la feuille de route.', ecran: '/pilotage/feuille-de-route',
    }));
  }

  private baselines(): SourceItem[] {
    const pl = this.svc<{ baselines: Repo<{ id: string; label: string; period: string; status: string; importedBy: string; importedAt: string }> }>('planification');
    if (!pl) return [];
    return pl.baselines.all().filter((b) => b.status === 'IMPORTEE').map((b) => ({
      id: `BASE:${b.id}`, source: 'BASE', sourceId: b.id, module: 'Planification — base de référence', categorie: null, objet: `Certifier « ${b.label} » (${b.period})`, demandeurId: b.importedBy,
      serviceInstructeur: 'Service budgétaire', validationAmont: null, date: b.importedAt, echeance: null, enjeu: { montant: null, etat: 'COMPTAGE' as const, nombre: null, commune: null, texte: '' },
      entities: ['MINFIN'], fondement: [], position: { recommandation: '', reserves: [] }, siRien: 'La base n’est pas certifiée.', pieces: [], individuel: false, gravite: 'NORMALE' as const,
      deciderAction: 'planification:baseline.certify', eligible: (u: User) => may(u, 'planification:baseline.certify') && notIn(u, [b.importedBy]),
      horsPoste: 'Décision sur l’écran de la base de référence.', ecran: '/pilotage/base-reference',
    }));
  }

  /** Instructions (§ 26.1) : exécution attendue du service destinataire ; clôture attendue de l'autorité sur rapport. */
  private instructions(): SourceItem[] {
    const pl = this.svc<{ instructions: Repo<{ id: string; number: string; subject: string; issuedBy: string; issuedAt: string; deadline: string; status: string; assignee: { entity: string; role?: string; userId?: string } }> }>('planification');
    if (!pl) return [];
    const isAssignee = (u: User, i: { assignee: { entity: string; role?: string; userId?: string } }) =>
      (i.assignee.userId ? i.assignee.userId === u.id : u.entity === i.assignee.entity && (!i.assignee.role || u.roles.includes(i.assignee.role as RoleCode)));
    const out: SourceItem[] = [];
    for (const i of pl.instructions.all()) {
      const common = {
        module: 'Instructions (§ 26.1)', categorie: null, demandeurId: i.issuedBy, serviceInstructeur: i.assignee.entity, validationAmont: null, date: i.issuedAt, echeance: i.deadline,
        enjeu: { montant: null, etat: 'COMPTAGE' as const, nombre: null, commune: null, texte: '' }, entities: [i.assignee.entity], fondement: [], position: { recommandation: '', reserves: [] }, siRien: '',
        pieces: [], individuel: false, gravite: 'NORMALE' as const, ecran: '/pilotage/instructions',
      };
      if (i.status === 'RAPPORT_DEPOSE') {
        out.push({ ...common, id: `INSTRUCTION:${i.id}`, source: 'INSTRUCTION', sourceId: i.id, objet: `Clore l’instruction ${i.number} — ${i.subject} (rapport déposé)`, deciderAction: 'planification:instruction.close',
          eligible: (u: User) => may(u, 'planification:instruction.close') && !isAssignee(u, i), horsPoste: 'Clôture motivée sur l’écran des instructions.' });
      } else if (i.status === 'EMISE' || i.status === 'ACCUSEE') {
        out.push({ ...common, id: `INSTRUCTION_EXECUTION:${i.id}`, source: 'INSTRUCTION_EXECUTION', sourceId: i.id, objet: `Exécuter l’instruction ${i.number} — ${i.subject}`, deciderAction: 'planification:instruction.respond',
          eligible: (u: User) => isAssignee(u, i), horsPoste: 'Accusé de réception et rapport sur l’écran des instructions.' });
      }
    }
    return out;
  }

  /** Circuits à quatre yeux relus au journal (propositions sans décision). */
  private circuits(): SourceItem[] {
    return this.pendingAudit().map((p) => {
      const def = CIRCUITS_FILE[p.circuit]!;
      const entity = typeof p.details.entity === 'string' ? p.details.entity : null;
      const amount = [p.details.amount, p.details.requested, p.details.montant].find(isMoney) ?? null;
      return {
        id: `CIRCUIT:${p.circuit}:${p.key}`, source: `CIRCUIT_${p.circuit}`, sourceId: p.key, module: def.module, categorie: null,
        objet: `${p.label} — ${p.key}`, demandeurId: p.actorId, serviceInstructeur: def.module, validationAmont: null, date: p.at, echeance: null,
        enjeu: { montant: amount, etat: 'CONSTATE' as const, nombre: null, commune: null, texte: '' }, entities: entity ? [entity] : [], fondement: [],
        position: { recommandation: '', reserves: [] }, siRien: '', pieces: [], individuel: false, gravite: 'NORMALE' as const, deciderAction: def.action,
        eligible: (u: User) => may(u, def.action, entity ? { entity, entities: [entity] } : {}) && u.id !== p.actorId,
        horsPoste: 'Circuit à quatre yeux : décision sur l’écran de la source.', ecran: def.ecran,
      };
    });
  }
}

export const jourDe = day;
