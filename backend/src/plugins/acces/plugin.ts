/**
 * Module « acces » : identité avancée, espaces d'entité et fiches de module, arbitrage entre entités,
 * invitations en cascade, mandats, doublons et fusion, MFA simulé, consultation motivée.
 */
import type { AppContext } from '../../context.js';
import { sha256Hex } from '../../core/crypto.js';
import { conflict } from '../../core/errors.js';
import { DEMO } from '../../seed.js';
import { definePlugin } from '../types.js';
import type { EntityKind } from './model.js';
import { registerAccesPolicies } from './policy.js';
import { registerAccesRoutes } from './routes.js';
import { AccesService } from './service.js';

export { AccesService } from './service.js';

/** Utilisateurs de démonstration propres au module (ids préfixés « acces- »). */
export const ACCES_DEMO_USERS = {
  sg: 'acces-u-sg',
  exploitation: 'acces-u-exploitation',
  chefService: 'acces-u-chef-service',
  adminLimete: 'acces-u-admin-limete',
  controleurLimete: 'acces-u-controleur-limete',
  adminTransports: 'acces-u-admin-transports',
  adminGombe: 'acces-u-admin-gombe',
} as const;

const DEMO_ENTITIES: { id: string; name: string; shortName: string; kind: EntityKind; parentId: string | null }[] = [
  { id: 'PLATEFORME', name: 'Exploitation technique de la plateforme KINSHASA MOSOLO', shortName: 'Plateforme', kind: 'PLATEFORME', parentId: null },
  { id: 'GOUVERNORAT', name: 'Gouvernorat de la Ville-Province de Kinshasa', shortName: 'Gouvernorat', kind: 'EXECUTIF', parentId: null },
  { id: 'MINFIN', name: 'Ministère provincial des Finances', shortName: 'Min. Finances', kind: 'MINISTERE', parentId: 'GOUVERNORAT' },
  { id: 'MIN-TRANSPORTS', name: 'Ministère provincial des Transports (démo)', shortName: 'Min. Transports', kind: 'MINISTERE', parentId: 'GOUVERNORAT' },
  { id: 'MIN-ECONOMIE', name: 'Ministère provincial de l’Économie (démo)', shortName: 'Min. Économie', kind: 'MINISTERE', parentId: 'GOUVERNORAT' },
  { id: 'DGIPK', name: 'Direction générale des impôts provinciaux de Kinshasa', shortName: 'DGIPK', kind: 'REGIE', parentId: 'MINFIN' },
  { id: 'DGTK', name: 'Direction générale des droits, taxes et redevances de Kinshasa', shortName: 'DGTK', kind: 'REGIE', parentId: 'MINFIN' },
  { id: 'TRESOR', name: 'Trésor provincial — Comptable public', shortName: 'Trésor', kind: 'TRESOR', parentId: 'MINFIN' },
  { id: 'CONTENTIEUX', name: 'Service du contentieux fiscal provincial', shortName: 'Contentieux', kind: 'SERVICE_TECHNIQUE', parentId: 'MINFIN' },
  { id: 'AUDIT', name: 'Inspection et audit interne provincial', shortName: 'Audit', kind: 'AUDIT', parentId: 'GOUVERNORAT' },
  { id: 'COMMUNE-LIMETE', name: 'Commune de Limete (démo)', shortName: 'Limete', kind: 'COMMUNE', parentId: 'GOUVERNORAT' },
  { id: 'COMMUNE-GOMBE', name: 'Commune de la Gombe (démo)', shortName: 'Gombe', kind: 'COMMUNE', parentId: 'GOUVERNORAT' },
  { id: 'SERVICE-URBANISME', name: 'Service provincial de l’urbanisme (démo)', shortName: 'Urbanisme', kind: 'SERVICE_TECHNIQUE', parentId: 'GOUVERNORAT' },
  { id: 'ST-RECENSEMENT-DEMO', name: 'Sous-traitant de recensement FICTIF (démo)', shortName: 'ST recensement', kind: 'SOUS_TRAITANT', parentId: 'DGIPK' },
];

function seedDemo(ctx: AppContext, svc: AccesService): void {
  const at = ctx.clock.now().toISOString();
  for (const e of DEMO_ENTITIES) {
    svc.entities.insert({ ...e, status: 'ACTIVE', createdAt: at, createdBy: 'u-superadmin', decisionRef: 'Décision FICTIVE du Comité de pilotage n° DEMO-CP-01', demo: true });
  }
  const U = ACCES_DEMO_USERS;
  const add = (u: Parameters<AppContext['users']['add']>[0]) => { if (!ctx.users.get(u.id)) ctx.users.add(u); };
  add({ id: U.sg, name: 'Secrétaire général du Gouvernement (démo)', roles: ['R03'], entity: 'GOUVERNORAT' });
  add({ id: U.exploitation, name: 'Ingénieure d’exploitation (démo)', roles: ['R27'], entity: 'PLATEFORME' });
  add({ id: U.chefService, name: 'Cheffe de service Impôt foncier — responsable de module (démo)', roles: ['R07'], entity: 'DGIPK' });
  add({ id: U.adminLimete, name: 'Administrateur d’entité — Commune de Limete (démo)', roles: ['R08'], entity: 'COMMUNE-LIMETE' });
  add({ id: U.controleurLimete, name: 'Contrôleur communal Limete (démo)', roles: ['R11'], entity: 'COMMUNE-LIMETE' });
  add({ id: U.adminTransports, name: 'Administrateur d’entité — Ministère des Transports (démo)', roles: ['R08'], entity: 'MIN-TRANSPORTS' });
  add({ id: U.adminGombe, name: 'Administrateur d’entité — Commune de la Gombe (démo)', roles: ['R08'], entity: 'COMMUNE-GOMBE' });

  // Droit d'inviter (permission explicite) et opérateur d'accès désigné.
  for (const userId of ['u-admin-entite', 'u-dg-dgipk', U.adminLimete, U.adminTransports, U.adminGombe, U.chefService]) {
    const u = ctx.users.get(userId);
    if (u) svc.grants.insert({ id: `GRT-DEMO-${userId}`, userId, kind: 'DROIT_INVITER', entity: u.entity, grantedBy: 'u-superadmin', status: 'ACTIF', createdAt: at });
  }
  if (ctx.users.get('u-guichet')) {
    svc.grants.insert({ id: 'GRT-DEMO-OPERATEUR-ACCES', userId: 'u-guichet', kind: 'OPERATEUR_ACCES', entity: 'DGIPK', grantedBy: 'u-admin-entite', status: 'ACTIF', createdAt: at });
  }

  // Fiches de module : une fiche active (règle fictive DEMO-IF-BATI), une fiche en cours de validation.
  const mod = svc.modules;
  const hist = (by: string, from: null | string, to: string) => ({ at, from: from as never, to: to as never, by });
  mod.insert({
    id: 'MOD-DEMO-IF', code: 'IF-DEMO', label: 'Impôt foncier — démonstration (règle fictive)', revenueScope: 'IMPOT_FONCIER',
    responsibleEntity: 'DGIPK', moduleManagerId: U.chefService, beneficiaryAliases: [DEMO.dgipkAlias], objectTypes: ['PARCELLE'],
    ruleCodes: [DEMO.demoRuleCode], credentialTypes: [], validityModel: 'ANNUEL', proofMechanisms: ['QR_STATIQUE', 'RECU_IMPRIME', 'SMS'],
    usageRules: 'Quittance nominative, non transférable.', channels: ['APPLICATION', 'USSD', 'GUICHET', 'POINT_PAIEMENT_AGREE'],
    fieldWorkflows: ['Recensement des parcelles', 'Constat d’occupation'], dashboards: ['Taux de recouvrement par commune'], dependencies: [],
    sharedReadWith: ['MINFIN'], actReferences: ['Instrument FICTIF de démonstration — aucune valeur juridique'], status: 'ACTIF',
    visas: [
      { step: 'SOUMISSION', by: 'u-admin-entite', role: 'R08', at },
      { step: 'PROGRAMME', by: 'u-dircab', role: 'R02', at },
      { step: 'JURIDIQUE', by: 'u-juriste-verificateur', role: 'R14', at },
      { step: 'RECETTE', by: U.exploitation, role: 'R27', at, note: 'Recette de démonstration réussie' },
      { step: 'ACTIVATION', by: 'u-gouverneur', role: 'R01', at },
    ],
    recette: { passed: true, report: 'Recette de démonstration réussie', by: U.exploitation, at },
    history: [hist('u-admin-entite', null, 'BROUILLON'), hist('u-gouverneur', 'SECONDE_VALIDATION', 'ACTIF')],
    attachments: [{ entity: 'DGIPK', from: at, actReference: 'Arrêté FICTIF n° DEMO-001 (démonstration)', validatedBy: 'u-gouverneur' }],
    createdBy: 'u-admin-entite', createdAt: at, demo: true,
  });
  mod.insert({
    id: 'MOD-DEMO-STAT', code: 'STAT-DEMO', label: 'Stationnement urbain — fiche en préparation (tarif : acte requis)', revenueScope: 'STATIONNEMENT',
    responsibleEntity: 'MIN-TRANSPORTS', beneficiaryAliases: [DEMO.dgtkAlias], objectTypes: ['ZONE_STATIONNEMENT', 'VEHICULE'], ruleCodes: [],
    credentialTypes: ['Ticket horaire', 'Abonnement'], validityModel: 'HORAIRE', proofMechanisms: ['QR_DYNAMIQUE', 'PLAQUE', 'SMS'],
    usageRules: 'Titre lié à la plaque ; surréservation désactivée (J24).', channels: ['APPLICATION', 'USSD', 'POINT_PAIEMENT_AGREE'],
    fieldWorkflows: ['Contrôle par plaque'], dashboards: ['Occupation des zones'], dependencies: ['Vignette automobile à jour (règle à certifier)'],
    sharedReadWith: ['DGTK'], actReferences: [], status: 'VALIDATION_JURIDIQUE',
    visas: [{ step: 'SOUMISSION', by: U.adminTransports, role: 'R08', at }, { step: 'PROGRAMME', by: 'u-dircab', role: 'R02', at }],
    history: [hist(U.adminTransports, null, 'BROUILLON'), hist('u-dircab', 'VALIDATION_PROGRAMME', 'VALIDATION_JURIDIQUE')],
    attachments: [], createdBy: U.adminTransports, createdAt: at, demo: true,
  });
  // Double revendication de compétence : la commune de la Gombe dépose une fiche « stationnement » → bloquée, arbitrage ouvert.
  const gombe = ctx.users.get(U.adminGombe);
  if (gombe) {
    svc.createModule(gombe, {
      code: 'STAT-GOMBE-DEMO', label: 'Stationnement communal de la Gombe (démo)', revenueScope: 'STATIONNEMENT', responsibleEntity: 'COMMUNE-GOMBE',
      beneficiaryAliases: [], objectTypes: ['ZONE_STATIONNEMENT'], ruleCodes: [], credentialTypes: ['Ticket horaire'], validityModel: 'HORAIRE',
      proofMechanisms: ['QR_DYNAMIQUE'], usageRules: '', channels: ['APPLICATION'], fieldWorkflows: [], dashboards: [], dependencies: [],
      sharedReadWith: [], actReferences: [],
    }, { demo: true });
  }

  // Revendication de la DGIPK sur le fait générateur de l'obligation fictive semée (parcelle de démonstration, 2026).
  svc.ruleFacts.set(DEMO.demoRuleCode, 'PROPRIETE_BATIE');
  svc.claims.insert({
    id: 'REV-DEMO-0001', entity: 'DGIPK', objectId: DEMO.parcelId, factCode: 'PROPRIETE_BATIE', period: at.slice(0, 4), ruleCode: DEMO.demoRuleCode,
    basis: 'Règle fictive DEMO-IF-BATI (démonstration)', status: 'ACCEPTEE', createdBy: 'u-controleur', createdAt: at, demo: true,
  });

  // Identité : contribuable de démonstration au niveau N2 (preuves fictives), doublon probable, personne morale.
  const tp = ctx.taxpayers.taxpayers.get(DEMO.taxpayerId);
  if (tp) {
    ctx.taxpayers.taxpayers.update({ ...tp, phoneVerifiedAt: at, verificationLevel: 'N2', kind: 'PERSONNE_PHYSIQUE' });
    const proof = (id: string, type: 'OTP_TELEPHONE' | 'PIECE_IDENTITE' | 'ADRESSE' | 'VISITE_TERRAIN', ref: string, by: string) => svc.proofs.insert({
      id, taxpayerId: tp.id, type, referenceMasked: `•••${ref.slice(-3)}`, referenceHash: sha256Hex(`${type}:${ref.toUpperCase()}`),
      status: 'VALIDEE', declaredBy: by, declaredAt: at, reviewedBy: 'u-guichet', reviewedAt: at, note: 'Preuve fictive (démonstration)',
    });
    svc.proofs.insert({ id: 'PRV-DEMO-OTP', taxpayerId: tp.id, type: 'OTP_TELEPHONE', referenceMasked: '+243•••01', referenceHash: sha256Hex(tp.phone), status: 'VALIDEE', declaredBy: 'systeme', declaredAt: at, reviewedBy: 'systeme', reviewedAt: at });
    proof('PRV-DEMO-PIECE', 'PIECE_IDENTITE', 'CE-DEMO-0001234', 'u-contribuable');
    proof('PRV-DEMO-ADR', 'ADRESSE', 'LIMETE-KINGABWA-DEMO', 'u-contribuable');
    proof('PRV-DEMO-VISITE', 'VISITE_TERRAIN', 'PV-DEMO-VISITE-01', 'u-agent-terrain');
  }
  if (!ctx.taxpayers.taxpayers.findOne((t) => t.phone === '+243810000091')) {
    const dup = ctx.taxpayers.register({ phone: '+243810000091', fullName: 'MBUYI KALALA Jean-Pierre', language: 'fr', situation: 'owner_occupier', kind: 'PERSONNE_PHYSIQUE' });
    svc.proofs.insert({
      id: 'PRV-DEMO-DUP-PIECE', taxpayerId: dup.id, type: 'PIECE_IDENTITE', referenceMasked: '•••234', referenceHash: sha256Hex('PIECE_IDENTITE:CE-DEMO-0001234'),
      status: 'DECLAREE', declaredBy: 'u-guichet', declaredAt: at, note: 'Pièce saisie au guichet (fictive) — identique à un compte existant',
    });
  }
  if (!ctx.taxpayers.taxpayers.findOne((t) => t.phone === '+243850000077')) {
    svc.registerOrganisation({
      raisonSociale: 'Brasserie fictive du Pool SARL (démo)', forme: 'SARL', rccm: 'CD/KIN/RCCM/DEMO-B-0001', idNat: 'DEMO-IDNAT-0001', phone: '+243850000077',
      language: 'fr', representatives: [
        { fullName: 'Ilunga Mwamba (fictif)', fonction: 'Gérant statutaire', habilitation: 'DIRIGEANT' },
        { fullName: 'Kanku Lufuluabo (fictive)', fonction: 'Responsable fiscale', habilitation: 'MANDATAIRE_HABILITE' },
      ],
      declarant: { fullName: 'Ilunga Mwamba (fictif)', fonction: 'Gérant statutaire' },
    }, { demo: true });
  }

  // Mandat professionnel correspondant au mandataire semé (cabinet certifié N3, fictif).
  svc.certifiedMandataires.add('u-mandataire');
  const mandataire = ctx.users.get('u-mandataire');
  if (mandataire && tp) {
    svc.mandates.insert({
      id: 'MDT-DEMO-0001', mandantTaxpayerId: tp.id, mandataireUserId: mandataire.id, kind: 'PROFESSIONNEL', scope: ['CONSULTER', 'DECLARER', 'PAYER', 'CONTESTER'],
      objectIds: [], validFrom: '2026-01-01', validTo: '2027-12-31', proofRef: 'Mandat écrit FICTIF (démonstration)', status: 'ACTIF', createdAt: at, createdBy: 'u-contribuable', demo: true,
    });
  }
  // Proche déclaré (conflit d'intérêts, fictif) : le contrôleur DGIPK est récusé sur le dossier de la locataire de démonstration.
  svc.declaredRelations.set('u-controleur', new Set([DEMO.tenantTaxpayerId]));
}

export const accesPlugin = definePlugin<AccesService>({
  name: 'acces',
  create: (ctx) => {
    registerAccesPolicies();
    const svc = new AccesService(ctx);
    // Garde commune de liquidation : tout fait générateur connu n'est revendiqué que par une seule entité (§ 10A.3),
    // y compris par la route du socle POST /v1/assessments/calculate. Seconde revendication ⇒ 409 + arbitrage ouvert.
    ctx.assessment.addLiquidationGuard(({ user, rule, objectId, at }) => {
      const factCode = svc.ruleFacts.get(rule.code);
      if (!factCode) return;
      const r = svc.claim(user, { objectId, factCode, period: at.toISOString().slice(0, 4), ruleCode: rule.code, basis: `Liquidation ${rule.code}` });
      if (r.blocked) {
        throw conflict('CLAIM_BLOCKED', 'Fait générateur déjà revendiqué par une autre entité : aucune obligation n’est créée, un dossier d’arbitrage est ouvert.', {
          claimId: r.claim.id, arbitrationId: r.claim.arbitrationId,
        });
      }
    });
    return svc;
  },
  seed: (ctx, svc) => seedDemo(ctx, svc),
  routes: (app, ctx, svc) => registerAccesRoutes(app, ctx, svc),
});
