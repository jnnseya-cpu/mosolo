/**
 * Données de DÉMONSTRATION : utilisateurs, instruments, fiches de règles modèles (A_VERIFIER),
 * une règle FICTIVE de démonstration publiée par le circuit complet, un contribuable avec parcelle et bail.
 */
import type { AppContext } from './context.js';
import type { User } from './core/auth.js';

export const DEMO = {
  taxpayerId: 'TP-DEMO-0001',
  tenantTaxpayerId: 'TP-DEMO-0002',
  parcelId: 'OBJ-DEMO-PARCELLE-01',
  unitId: 'OBJ-DEMO-UNITE-01',
  leaseId: 'BAIL-DEMO-0001',
  demoRuleCode: 'DEMO-IF-BATI',
  dgipkAlias: 'KIN-DGIPK-RECETTES-01',
  dgtkAlias: 'KIN-DGTK-RECETTES-01',
  provider: 'mm-operator-a',
} as const;

export const DEMO_USERS: Omit<User, 'kind'>[] = [
  { id: 'u-gouverneur', name: 'Gouverneur de la Ville-Province (démo)', roles: ['R01'], entity: 'GOUVERNORAT' },
  { id: 'u-dircab', name: 'Directeur de cabinet (démo)', roles: ['R02'], entity: 'GOUVERNORAT' },
  { id: 'u-ministre-finances', name: 'Ministre provincial des Finances (démo)', roles: ['R05'], entity: 'MINFIN' },
  { id: 'u-dg-dgipk', name: 'Directeur général DGIPK (démo)', roles: ['R06'], entity: 'DGIPK' },
  { id: 'u-admin-entite', name: "Administrateur d'entité DGIPK (démo)", roles: ['R08'], entity: 'DGIPK' },
  { id: 'u-superviseur', name: 'Superviseur terrain (démo)', roles: ['R09'], entity: 'DGIPK', territory: ['Limete', 'Lemba', 'Matete', 'Ngaba'] },
  { id: 'u-agent-terrain', name: 'Agent de terrain Limete (démo)', roles: ['R10'], entity: 'DGIPK', territory: ['Limete', 'Lemba', 'Matete'] },
  { id: 'u-agent-terrain-2', name: 'Agent de terrain Limete 2 (démo)', roles: ['R10'], entity: 'DGIPK', territory: ['Limete', 'Ngaba'] },
  { id: 'u-agent-gombe', name: 'Agent de terrain Gombe (démo)', roles: ['R10'], entity: 'DGIPK', territory: ['Gombe'] },
  { id: 'u-controleur', name: 'Contrôleur DGIPK (démo)', roles: ['R11'], entity: 'DGIPK' },
  { id: 'u-guichet', name: 'Agent de guichet (démo)', roles: ['R12'], entity: 'DGIPK' },
  { id: 'u-juriste-redacteur', name: 'Juriste rédactrice (démo)', roles: ['R13'], entity: 'MINFIN' },
  { id: 'u-juriste-verificateur', name: 'Juriste vérificateur (démo)', roles: ['R14'], entity: 'MINFIN' },
  { id: 'u-validateur-financier', name: 'Validatrice financière (démo)', roles: ['R15'], entity: 'MINFIN' },
  { id: 'u-autorite-publication', name: 'Autorité de publication (démo)', roles: ['R16'], entity: 'MINFIN' },
  { id: 'u-tresor', name: 'Comptable public — Trésor (démo)', roles: ['R17'], entity: 'TRESOR' },
  { id: 'u-analyste-rappro', name: 'Analyste de rapprochement (démo)', roles: ['R18'], entity: 'TRESOR' },
  { id: 'u-coffre-1', name: 'Gestionnaire du coffre n° 1 (démo)', roles: ['R19'], entity: 'TRESOR' },
  { id: 'u-coffre-2', name: 'Gestionnaire du coffre n° 2 (démo)', roles: ['R19'], entity: 'TRESOR' },
  { id: 'u-coffre-3', name: 'Gestionnaire du coffre n° 3 (démo)', roles: ['R19'], entity: 'TRESOR' },
  { id: 'u-contentieux', name: 'Agent de contentieux — instructeur (démo)', roles: ['R20'], entity: 'DGIPK' },
  { id: 'u-decideur', name: 'Autorité de décision contentieuse (démo)', roles: ['R21'], entity: 'DGIPK' },
  { id: 'u-auditeur', name: 'Auditeur interne (démo)', roles: ['R22'], entity: 'AUDIT' },
  { id: 'u-enqueteur', name: 'Enquêteur anti-fraude (démo)', roles: ['R24'], entity: 'AUDIT' },
  // Décision du 29/09/2026 : un seul compte « Groupe Nseya — super-administrateur » (administration R26 + lecture complète R38).
  { id: 'u-superadmin', name: 'Groupe Nseya — super-administrateur (démo)', roles: ['R26', 'R38'], entity: 'PLATEFORME' },
  { id: 'u-rssi', name: 'Responsable sécurité (démo)', roles: ['R28'], entity: 'PLATEFORME' },
  { id: 'u-contribuable', name: 'Mbuyi Kalala (contribuable fictif)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: DEMO.taxpayerId, lang: 'fr' },
  { id: 'u-locataire', name: 'Nzuzi Makiese (locataire fictive)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: DEMO.tenantTaxpayerId, lang: 'ln' },
  { id: 'u-mandataire', name: 'Cabinet mandataire (démo)', roles: ['R31'], entity: 'PUBLIC', mandants: [DEMO.taxpayerId] },
];

export function seed(ctx: AppContext): void {
  for (const u of DEMO_USERS) ctx.users.add(u);

  // Coffre : comptes publics bénéficiaires (numéros FICTIFS).
  ctx.vault.seedAccount({ alias: DEMO.dgipkAlias, entity: 'DGIPK', bankName: 'Banque de recettes A (démo)', accountNumber: 'CD00 0000 0000 0000 0001 2345', holderName: 'DGIPK — Compte de recettes (démo)', currency: 'USD' });
  ctx.vault.seedAccount({ alias: DEMO.dgtkAlias, entity: 'DGTK', bankName: 'Banque de recettes B (démo)', accountNumber: 'CD00 0000 0000 0000 0009 8765', holderName: 'DGTK — Compte de recettes (démo)', currency: 'CDF' });
  // Module 60 : compte marchand Mobile Money PUBLIC (numéro FICTIF, [EXEMPLE] non contractuel) — même verrou que les comptes bancaires.
  ctx.vault.seedAccount({ alias: 'KIN-DGRK-MM-01', entity: 'DGRK', kind: 'MOBILE_MONEY', bankName: 'Opérateur Mobile Money A (démo) [EXEMPLE]', accountNumber: 'MM 243 0000 0000 01', holderName: 'DGRK — Compte marchand public (démo)', currency: 'CDF' });

  // Registre des instruments juridiques.
  const instruments = [
    { id: 'const-2006-art204', title: 'Constitution du 18 février 2006, article 204', status: 'EN_VIGUEUR' as const },
    { id: 'ol-18-004', title: 'Ordonnance-loi n° 18/004 du 13 mars 2018 (nomenclature des recettes des provinces et ETD)', status: 'EN_VIGUEUR' as const },
    { id: 'ol-13-001', title: 'Ordonnance-loi n° 13/001 du 23 février 2013', status: 'ABROGE' as const, abrogatedOn: '2018-03-13', abrogatedBy: 'ol-18-004' },
    { id: 'ol-69-009', title: 'Ordonnance-loi n° 69-009 (impôts cédulaires sur les revenus) [statut À VÉRIFIER]', status: 'A_VERIFIER' as const },
    { id: 'ol-69-006', title: 'Ordonnance-loi n° 69-006 (impôt foncier) [statut À VÉRIFIER]', status: 'A_VERIFIER' as const },
    { id: 'arrete-taux-irl-2026', title: 'Arrêté provincial fixant les taux de l’IRL (rapporté par la presse, non certifié)', status: 'A_VERIFIER' as const },
    { id: 'arrete-taux-if-2026', title: 'Arrêté provincial fixant les barèmes de l’impôt foncier 2026 (rapporté par la presse, non certifié)', status: 'A_VERIFIER' as const },
    { id: 'demo-instrument-001', title: 'Instrument FICTIF de démonstration — aucune valeur juridique', status: 'EN_VIGUEUR' as const, demo: true, note: 'Utilisé uniquement pour démontrer le circuit de publication.' },
  ];
  for (const i of instruments) ctx.rules.instruments.insert(i);
  // Tableau des textes du § 6.1 : textes manquants ajoutés au statut A_VERIFIER (jamais activés sans relevé certifié).
  ctx.rules.seedLegalTexts();

  // Fiches modèles de l'Annexe B (statut A_VERIFIER : ne peuvent produire aucune obligation).
  ctx.rules.seedSamples();

  // Contribuables, objets et bail (fictifs).
  ctx.taxpayers.register({ phone: '+243810000001', fullName: 'Mbuyi Kalala', language: 'fr', situation: 'landlord', email: 'contribuable.demo@example.cd' }, DEMO.taxpayerId);
  ctx.taxpayers.register({ phone: '+243820000002', fullName: 'Nzuzi Makiese', language: 'ln', situation: 'tenant' }, DEMO.tenantTaxpayerId);
  const agent = ctx.users.get('u-agent-terrain')!;
  const owner = ctx.users.get('u-contribuable')!;
  ctx.objects.create(owner, {
    category: 'PARCELLE', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.3712, lon: 15.3441,
    attributes: { superficie_m2: '600', usage: 'residentiel', batiments: 1 },
  }, DEMO.parcelId);
  ctx.objects.create(agent, {
    taxpayerId: DEMO.taxpayerId, category: 'UNITE_LOCATIVE', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.3713, lon: 15.3442,
    attributes: { parcelleId: DEMO.parcelId, niveau: 'rez-de-chaussée', surface_m2: '85' },
  }, DEMO.unitId);
  ctx.objects.declareLease(owner, {
    unitObjectId: DEMO.unitId, lessorId: DEMO.taxpayerId, lesseeId: DEMO.tenantTaxpayerId,
    rent: { amount: '450.00', currency: 'USD' }, periodicity: 'MENSUELLE', start: '2026-01-01',
  }, DEMO.leaseId);

  // Règle FICTIVE publiée par le circuit réel (4 personnes distinctes), puis une obligation payable.
  const drafter = ctx.users.get('u-juriste-redacteur')!;
  const rule = ctx.rules.create(drafter, {
    code: DEMO.demoRuleCode, revenueCategory: 'IMPOT_PROVINCIAL',
    label: 'DÉMONSTRATION — impôt foncier forfaitaire (règle fictive, non opposable)',
    legalInstrumentIds: ['demo-instrument-001'], articles: ['Article 1 (fictif)'],
    competentAuthority: 'Ministère provincial des Finances', administeringEntity: 'DGIPK',
    taxableEvent: 'Propriété d’un immeuble bâti (démonstration)', liableParty: 'Propriétaire',
    baseDefinition: 'Forfait par propriété selon le rang de localité', formula: 'forfait',
    // Taux maximaux de remise et d'exonération DÉCLARÉS par la fiche (fictive) : aucun taux n'est jamais saisi librement.
    rateTable: { 'forfait:1': '450', 'forfait:2': '150', 'forfait:3': '50', 'forfait:4': '10', taux_exoneration_max: '100', taux_remise_max: '50' },
    currency: 'USD', rounding: 'HALF_UP', periodicity: 'ANNUELLE', dueRule: '30 jours après émission (démonstration)',
    exemptions: [], penalties: [], effectiveFrom: '2026-01-01', beneficiaryAccountAlias: DEMO.dgipkAlias,
    appealPath: 'Réclamation auprès de la DGIPK via MOSOLO (démonstration)', sourceVerification: 'OFFICIEL_CERTIFIE',
  });
  ctx.rules.approve(drafter, rule.id, 'REDACTEUR');
  ctx.rules.approve(ctx.users.get('u-juriste-verificateur')!, rule.id, 'VERIFICATEUR_JURIDIQUE');
  ctx.rules.approve(ctx.users.get('u-validateur-financier')!, rule.id, 'VALIDATEUR_FINANCIER');
  ctx.rules.approve(ctx.users.get('u-autorite-publication')!, rule.id, 'AUTORITE_PUBLICATION');
  ctx.rules.rules.update({ ...ctx.rules.rules.get(rule.id)!, demo: true });
  ctx.assessment.calculate(ctx.users.get('u-controleur')!, {
    ruleId: rule.id, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: {}, simulate: false,
  });

  // Terminaux terrain enrôlés ; un terminal déclaré perdu et révoqué.
  const keys = ctx.secrets.deviceKeys;
  ctx.field.enroll('dev-terrain-001', 'u-agent-terrain', keys['dev-terrain-001'] ?? 'demo-device-key-001');
  ctx.field.enroll('dev-terrain-002', 'u-agent-terrain-2', keys['dev-terrain-002'] ?? 'demo-device-key-002');
  ctx.field.enroll('dev-terrain-perdu', 'u-agent-terrain', keys['dev-terrain-perdu'] ?? 'demo-device-key-perdu');
  ctx.field.revoke('dev-terrain-perdu', 'Déclaré perdu (démo)');
}
