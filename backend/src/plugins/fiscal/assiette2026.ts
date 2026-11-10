/**
 * Élargissement d'assiette prévu par l'édit budgétaire 2026 (§ 16.3) : baux emphytéotiques, loyers des sociétés
 * immobilières, indemnités de logement. Chaque cas a son formulaire déclaratif propre, un contrôle de cohérence et une
 * voie de recours identifiée (notamment au regard des résolutions du Conseil national du travail invoquées par les
 * entreprises). Les règles sont inscrites au registre au statut A_VERIFIER : RIEN N'EST ACTIF, aucun taux n'est
 * inventé, aucune déclaration ne produit d'obligation tant qu'une version n'est pas certifiée et ACTIVE (4 visas).
 */
import type { User } from '../../core/auth.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { badRequest, notFound } from '../../core/errors.js';
import { authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import type { RuleRecord } from '../../modules/rules/service.js';
import { actorOf, type FiscalDeps } from './common.js';

const { always, ownTaxpayer, mandant } = GRANTS;
definePolicy('fiscal:assiette2026.declare', { R30: ownTaxpayer, R31: mandant, R12: always });
definePolicy('fiscal:assiette2026.read', { R30: ownTaxpayer, R31: mandant, R06: always, R07: always, R11: always, R12: always, R22: always });

export const EDIT_2026_INSTRUMENT = 'edit-budgetaire-2026';

export const ASSIETTE_2026_CASES = ['BAIL_EMPHYTEOTIQUE', 'LOYERS_SOCIETE_IMMOBILIERE', 'INDEMNITE_LOGEMENT'] as const;
export type Assiette2026Case = (typeof ASSIETTE_2026_CASES)[number];

interface CaseField { name: string; label: string; type: 'texte' | 'nombre' | 'date' | 'choix'; required: boolean; choices?: string[]; objectAttribute?: boolean }

/** Formulaires déclaratifs propres (champs) et attributs d'objet correspondants. */
export const ASSIETTE_2026: Record<Assiette2026Case, { label: string; ruleCode: string; appealPath: string; fields: CaseField[]; coherence: string[] }> = {
  BAIL_EMPHYTEOTIQUE: {
    label: 'Bail emphytéotique (entreprise ↔ église, ASBL ou ONG) pour un immeuble destiné à la location',
    ruleCode: 'IRL-KIN-BAIL-EMPHYTEOTIQUE',
    appealPath: 'Réclamation auprès de la DGRK/DGIPK [délai À VÉRIFIER — Édit n° 005/2021, J4]',
    fields: [
      { name: 'bailleur_nature', label: 'Nature du bailleur', type: 'choix', required: true, choices: ['EGLISE', 'ASBL', 'ONG'], objectAttribute: true },
      { name: 'bailleur_nom', label: 'Nom du bailleur', type: 'texte', required: true },
      { name: 'preneur_nif', label: 'NIF de l’entreprise preneuse', type: 'texte', required: true },
      { name: 'duree_annees', label: 'Durée du bail (années)', type: 'nombre', required: true, objectAttribute: true },
      { name: 'date_debut', label: 'Date de début', type: 'date', required: true },
      { name: 'unites_destinees_location', label: 'Unités destinées à la location', type: 'nombre', required: true, objectAttribute: true },
      { name: 'loyers_percus', label: 'Loyers perçus sur la période', type: 'nombre', required: true },
    ],
    coherence: ['Bailleur de nature église, ASBL ou ONG', 'Preneur identifié par un NIF', 'Au moins une unité destinée à la location', 'Durée cohérente avec un bail emphytéotique [durée minimale À VÉRIFIER]'],
  },
  LOYERS_SOCIETE_IMMOBILIERE: {
    label: 'Loyers perçus par une société immobilière',
    ruleCode: 'IRL-KIN-SOCIETES-IMMOBILIERES',
    appealPath: 'Réclamation auprès de la DGRK/DGIPK [délai À VÉRIFIER — Édit n° 005/2021, J4]',
    fields: [
      { name: 'rccm', label: 'RCCM de la société', type: 'texte', required: true },
      { name: 'nif', label: 'NIF de la société', type: 'texte', required: true },
      { name: 'unites_louees', label: 'Unités louées', type: 'nombre', required: true, objectAttribute: true },
      { name: 'loyers_percus', label: 'Loyers perçus sur la période', type: 'nombre', required: true },
    ],
    coherence: ['Déclarant personne morale', 'Unités louées cohérentes avec les baux déclarés au registre', 'Loyers perçus positifs si des unités sont louées'],
  },
  INDEMNITE_LOGEMENT: {
    label: 'Indemnités de logement versées aux travailleurs (logement propre, du conjoint ou gratuit)',
    ruleCode: 'IRL-KIN-INDEMNITES-LOGEMENT',
    appealPath: 'Réclamation auprès de la DGRK/DGIPK ; résolutions du Conseil national du travail invoquées à produire au dossier [À VÉRIFIER]',
    fields: [
      { name: 'employeur_nif', label: 'NIF de l’employeur', type: 'texte', required: true },
      { name: 'effectif', label: 'Effectif total', type: 'nombre', required: true },
      { name: 'beneficiaires', label: 'Travailleurs bénéficiant d’une indemnité de logement', type: 'nombre', required: true },
      { name: 'situation', label: 'Situation de logement', type: 'choix', required: true, choices: ['LOGEMENT_PROPRE', 'LOGEMENT_CONJOINT', 'LOGEMENT_GRATUIT'] },
      { name: 'montant_indemnites', label: 'Montant total des indemnités sur la période', type: 'nombre', required: true },
      { name: 'resolution_cnt', label: 'Résolution du Conseil national du travail invoquée (si applicable)', type: 'texte', required: false },
    ],
    coherence: ['Bénéficiaires ≤ effectif', 'Employeur identifié par un NIF', 'Montant positif si des bénéficiaires sont déclarés'],
  },
};

export interface Assiette2026Declaration {
  id: string;
  case: Assiette2026Case;
  taxpayerId: string;
  objectId?: string;
  period: string;
  values: Record<string, string>;
  coherence: { check: string; ok: boolean; detail: string }[];
  status: 'ENREGISTREE_A_INSTRUIRE';
  liquidation: 'AUCUNE';
  rule: { code: string; version: number; status: string };
  appealPath: string;
  acknowledgement: { number: string; at: string; contentHash: string };
  filedBy: string;
}

const DEC = /^\d{1,15}(\.\d{1,6})?$/;

export class Assiette2026Service {
  readonly declarations = new InMemoryRepository<Assiette2026Declaration>();
  private readonly ids = new IdGenerator();

  constructor(private readonly d: FiscalDeps) {}

  /** Inscrit l'instrument (À VÉRIFIER) et les trois fiches de règle au statut A_VERIFIER, si absentes. Rien n'est activé. */
  seedRules(): void {
    const { rules } = this.d.ctx;
    if (!rules.instruments.get(EDIT_2026_INSTRUMENT)) {
      rules.instruments.insert({ id: EDIT_2026_INSTRUMENT, title: 'Édit budgétaire 2026 de la Ville-Province de Kinshasa — élargissement de l’assiette (§ 16.3) [texte À VÉRIFIER]', status: 'A_VERIFIER' } as Parameters<typeof rules.instruments.insert>[0]);
    }
    const base = (code: string, label: string, taxable: string, liable: string, baseDef: string, inputName: string, c: Assiette2026Case): RuleRecord => ({
      id: `rule-${code.toLowerCase()}-v1`, code, version: 1, revenueCategory: 'IMPOT_PROVINCIAL', label: `${label} [À VÉRIFIER]`,
      legalInstrumentIds: [EDIT_2026_INSTRUMENT, 'ol-18-004'], articles: ['Édit budgétaire 2026 — article à identifier [À VÉRIFIER]'],
      competentAuthority: 'Ministère provincial des Finances', administeringEntity: 'DGIPK', taxableEvent: taxable, liableParty: liable,
      baseDefinition: baseDef, formula: `${inputName} * taux / 100`, rateTable: {}, currency: 'USD', rounding: 'HALF_UP', periodicity: 'ANNUELLE',
      dueRule: 'Échéance à fixer par l’acte [À VÉRIFIER]', exemptions: [], penalties: [], effectiveFrom: '2026-01-01',
      beneficiaryAccountAlias: 'KIN-DGIPK-RECETTES-01', appealPath: ASSIETTE_2026[c].appealPath,
      status: 'A_VERIFIER', sourceVerification: 'DOCUMENT_DE_TRAVAIL', approvals: [], createdAt: this.d.nowIso(), sample: true,
      changeReason: 'Élargissement d’assiette de l’édit budgétaire 2026 (§ 16.3) : taux non publié, acte requis.',
    });
    const sheets = [
      base('IRL-KIN-BAIL-EMPHYTEOTIQUE', 'IRL — baux emphytéotiques d’immeubles destinés à la location', 'Perception de loyers d’un immeuble construit sous bail emphytéotique', 'Entreprise preneuse [À VÉRIFIER]', 'Loyers perçus sur la période', 'loyers_percus', 'BAIL_EMPHYTEOTIQUE'),
      base('IRL-KIN-SOCIETES-IMMOBILIERES', 'IRL — loyers perçus par les sociétés immobilières', 'Perception de loyers par une société immobilière', 'Société immobilière', 'Loyers perçus sur la période', 'loyers_percus', 'LOYERS_SOCIETE_IMMOBILIERE'),
      base('IRL-KIN-INDEMNITES-LOGEMENT', 'IRL — indemnités de logement versées aux travailleurs', 'Versement d’indemnités de logement', 'Employeur (agent de retenue) [À VÉRIFIER]', 'Indemnités de logement versées sur la période', 'montant_indemnites', 'INDEMNITE_LOGEMENT'),
    ];
    for (const r of sheets) if (!rules.rules.get(r.id)) rules.rules.insert(r);
  }

  catalogue() {
    const all = this.d.ctx.rules.rules.all();
    return ASSIETTE_2026_CASES.map((c) => {
      const def = ASSIETTE_2026[c];
      const versions = all.filter((r) => r.code === def.ruleCode).sort((a, b) => b.version - a.version);
      return {
        code: c, ...def,
        rules: versions.map((r) => ({ id: r.id, code: r.code, version: r.version, status: r.status, label: r.label })),
        active: versions.some((r) => r.status === 'ACTIVE'),
        notice: 'Règle au statut À VÉRIFIER : la déclaration est enregistrée et instruite, sans aucune liquidation.',
      };
    });
  }

  private coherence(c: Assiette2026Case, v: Record<string, string>, taxpayerId: string): Assiette2026Declaration['coherence'] {
    const n = (k: string) => Number.parseFloat(v[k] ?? '0');
    const tp = this.d.ctx.taxpayers.get(taxpayerId);
    if (c === 'BAIL_EMPHYTEOTIQUE') return [
      { check: 'Nature du bailleur', ok: ['EGLISE', 'ASBL', 'ONG'].includes(v.bailleur_nature ?? ''), detail: v.bailleur_nature ?? '—' },
      { check: 'Preneur identifié par un NIF', ok: !!v.preneur_nif, detail: v.preneur_nif ? 'NIF fourni' : 'NIF manquant' },
      { check: 'Unités destinées à la location', ok: n('unites_destinees_location') >= 1, detail: v.unites_destinees_location ?? '0' },
    ];
    if (c === 'LOYERS_SOCIETE_IMMOBILIERE') {
      const leases = this.d.ctx.objects.leases.find((l) => l.lessorId === taxpayerId).length;
      return [
        { check: 'Déclarant personne morale', ok: tp.kind === 'PERSONNE_MORALE', detail: tp.kind ?? 'PERSONNE_PHYSIQUE' },
        { check: 'Unités louées et baux déclarés au registre', ok: n('unites_louees') === leases || leases === 0, detail: `${v.unites_louees ?? '0'} déclarée(s) ; ${leases} bail(aux) au registre` },
        { check: 'Loyers positifs si unités louées', ok: n('unites_louees') === 0 || n('loyers_percus') > 0, detail: v.loyers_percus ?? '0' },
      ];
    }
    return [
      { check: 'Bénéficiaires ≤ effectif', ok: n('beneficiaires') <= n('effectif'), detail: `${v.beneficiaires ?? '0'} / ${v.effectif ?? '0'}` },
      { check: 'Employeur identifié par un NIF', ok: !!v.employeur_nif, detail: v.employeur_nif ? 'NIF fourni' : 'NIF manquant' },
      { check: 'Montant positif si bénéficiaires', ok: n('beneficiaires') === 0 || n('montant_indemnites') > 0, detail: v.montant_indemnites ?? '0' },
    ];
  }

  declare(user: User, input: { case: Assiette2026Case; taxpayerId?: string; objectId?: string; period: string; values: Record<string, string>; attest: boolean }): Assiette2026Declaration {
    const taxpayerId = input.taxpayerId ?? (user.roles.includes('R30') ? user.taxpayerId : undefined);
    if (!taxpayerId) throw badRequest('TAXPAYER_REQUIRED', 'Contribuable concerné requis.');
    authorize(user, 'fiscal:assiette2026.declare', { taxpayerId });
    if (!input.attest) throw badRequest('ATTESTATION_REQUIRED', 'Le déclarant doit attester l’exactitude de sa déclaration.');
    if (input.objectId) this.d.ctx.objects.get(input.objectId);
    const def = ASSIETTE_2026[input.case];
    const values: Record<string, string> = {};
    for (const f of def.fields) {
      const v = input.values[f.name]?.trim();
      if (!v) { if (f.required) throw badRequest('MISSING_INPUT', `Champ requis : « ${f.label} » (${f.name}).`); continue; }
      if (f.type === 'nombre' && !DEC.test(v)) throw badRequest('INVALID_INPUT', `Nombre décimal attendu pour « ${f.label} ».`);
      if (f.type === 'choix' && !f.choices!.includes(v)) throw badRequest('INVALID_INPUT', `Valeur attendue pour « ${f.label} » : ${f.choices!.join(', ')}.`);
      values[f.name] = v;
    }
    const rule = this.d.ctx.rules.rules.find((r) => r.code === def.ruleCode).sort((a, b) => b.version - a.version)[0];
    const now = this.d.nowIso();
    const id = this.ids.next(`DEL-${input.period}`);
    const ack = this.ids.next(`ACR-EL-${input.period}`);
    const x = this.declarations.insert({
      id, case: input.case, taxpayerId, ...(input.objectId ? { objectId: input.objectId } : {}), period: input.period, values,
      coherence: this.coherence(input.case, values, taxpayerId), status: 'ENREGISTREE_A_INSTRUIRE', liquidation: 'AUCUNE',
      rule: { code: def.ruleCode, version: rule?.version ?? 0, status: rule?.status ?? 'ABSENTE' }, appealPath: def.appealPath,
      acknowledgement: { number: ack, at: now, contentHash: sha256Hex(canonicalJson({ id, case: input.case, taxpayerId, values })) }, filedBy: user.id,
    });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'fiscal.assiette2026.declared', resourceType: 'declaration', resourceId: id, details: { case: input.case, period: input.period, ruleStatus: x.rule.status, incoherences: x.coherence.filter((c) => !c.ok).length } });
    this.d.ctx.comms.publish('declaration.submitted', [taxpayerRecipient(this.d.ctx.taxpayers.get(taxpayerId))], { reference: ack }, { entity: 'DGIPK' });
    return x;
  }

  list(user: User, taxpayerId?: string) {
    if (taxpayerId) authorize(user, 'fiscal:assiette2026.read', { taxpayerId });
    else authorize(user, 'fiscal:assiette2026.read');
    return this.declarations.all().filter((x) => !taxpayerId || x.taxpayerId === taxpayerId);
  }

  get(id: string) {
    const x = this.declarations.get(id);
    if (!x) throw notFound('DECLARATION_NOT_FOUND', `Déclaration inconnue : ${id}`);
    return x;
  }
}
