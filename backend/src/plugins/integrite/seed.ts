/** Données de DÉMONSTRATION du module Intégrité (fictives, non opposables). */
import type { AppContext } from '../../context.js';
import { DEMO } from '../../seed.js';
import { HOUR } from './common.js';
import type { IntegriteService } from './service.js';

/** Code de suivi public d'un signalement de démonstration (affiché comme exemple dans l'écran de suivi). */
export const DEMO_TRACKING_CODE = 'DEMO-2026-0001';

export const INTEGRITE_DEMO_USERS = {
  chefEnquetes: 'integrite-u-chef-enquetes',
  dpo: 'integrite-u-dpo',
  operatrice: 'integrite-u-operatrice',
  ingenieur: 'integrite-u-ingenieur',
  adminTresor: 'integrite-u-admin-tresor',
} as const;

export function seedIntegrite(ctx: AppContext, svc: IntegriteService): void {
  const U = INTEGRITE_DEMO_USERS;
  ctx.users.add({ id: U.chefEnquetes, name: 'Cheffe des enquêtes anti-fraude (démo)', roles: ['R24'], entity: 'AUDIT' });
  ctx.users.add({ id: U.dpo, name: 'Délégué à la protection des données (démo)', roles: ['R25'], entity: 'GOUVERNORAT' });
  ctx.users.add({ id: U.operatrice, name: 'Opératrice de la ligne de signalement (démo)', roles: ['R12'], entity: 'AUDIT' });
  ctx.users.add({ id: U.ingenieur, name: "Ingénieur d'exploitation (démo)", roles: ['R27'], entity: 'PLATEFORME' });
  ctx.users.add({ id: U.adminTresor, name: "Administrateur d'entité Trésor (démo)", roles: ['R08'], entity: 'TRESOR' });

  const now = ctx.clock.now().getTime();
  const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();
  const enqueteur = ctx.users.get('u-enqueteur')!;
  const markDemo = (ref: string) => { const r = svc.reports.get(ref)!; svc.reports.update({ ...r, demo: true }); };

  // --- Signalements ---
  const s1 = svc.submit({
    category: 'DEMANDE_ESPECES', anonymous: true, commune: 'Limete', place: 'Avenue de la Foire (exemple)',
    description: "[EXEMPLE] Un agent en gilet m'a demandé 20 000 FC en espèces pour « régulariser » l'impôt foncier sans quittance.",
    target: { kind: 'AGENT', reference: 'u-agent-terrain' }, occurredOn: '2026-09-20',
  }, 'WEB', 'public', DEMO_TRACKING_CODE);
  markDemo(s1.reference);
  const s2 = svc.submit({
    category: 'DEMANDE_ESPECES', anonymous: false, contact: { phone: '+243990000123' }, commune: 'Lemba',
    description: '[EXEMPLE] Même agent signalé au marché : proposition de « réduire le montant » contre paiement en main propre.',
    target: { kind: 'AGENT', reference: 'u-agent-terrain' },
  }, 'SMS', 'public');
  markDemo(s2.reference);
  const s3 = svc.submit({
    category: 'FAUX_AGENT', anonymous: true, commune: 'Gombe', place: 'Boulevard du 30 Juin (exemple)',
    description: '[EXEMPLE] Personne se présentant comme contrôleur du stationnement, sans badge vérifiable, exigeant un paiement immédiat.',
  }, 'SVI', 'public');
  markDemo(s3.reference);
  const s4 = svc.submit({
    category: 'PRELEVEMENT_WEWA', anonymous: true, commune: 'Kimbanseke',
    description: '[EXEMPLE] Prélèvement de 1 000 FC par des collecteurs informels au rond-point, sans aucun ticket.',
  }, 'NUMERO_GRATUIT', ctx.users.get(U.operatrice)!);
  markDemo(s4.reference);

  svc.qualify(enqueteur, s1.reference, { category: 'DEMANDE_ESPECES', severity: 'ELEVEE', receivable: true, note: 'Faits précis, lieu et date indiqués (démo).' });
  svc.assign(enqueteur, s1.reference, { investigatorId: 'u-enqueteur', openCase: true, note: 'Rapprocher des constats de la mission Limete (démo).' });

  // --- Observations (flux fictifs) ---
  svc.ingest('system', [
    { type: 'VERIFICATION_QUITTANCE', at: at(3), source: 'terminal de vérification (démo)', receiptRef: 'QUI-DEMO-0001', lat: -4.3036, lon: 15.3017, commune: 'Gombe', demo: true },
    { type: 'VERIFICATION_QUITTANCE', at: at(2.5), source: 'terminal de vérification (démo)', receiptRef: 'QUI-DEMO-0001', lat: -4.3796, lon: 15.6329, commune: "N'sele", demo: true },
    { type: 'PAIEMENT_POINT', at: at(6), source: 'point de paiement agréé (démo)', pointRef: 'PPA-DEMO-014', obligationRef: 'OBL-DEMO-77', amount: { amount: '40.00', currency: 'USD' }, commune: 'Matete', demo: true },
    { type: 'PAIEMENT_POINT', at: at(5.5), source: 'point de paiement agréé (démo)', pointRef: 'PPA-DEMO-014', obligationRef: 'OBL-DEMO-77', amount: { amount: '40.00', currency: 'USD' }, commune: 'Matete', demo: true },
    { type: 'PAIEMENT_POINT', at: at(5), source: 'point de paiement agréé (démo)', pointRef: 'PPA-DEMO-014', obligationRef: 'OBL-DEMO-77', amount: { amount: '39.50', currency: 'USD' }, commune: 'Matete', demo: true },
  ]);

  // --- Contrôles mystère ---
  const auditeur = ctx.users.get('u-auditeur')!;
  const programme = 'Programme T4 2026 (démo)';
  const m1 = svc.planMystery(auditeur, { programme, targetKind: 'POINT_PAIEMENT', targetRef: 'PPA-DEMO-014', commune: 'Matete', scenario: 'Payer une obligation sur référence ; vérifier le montant affiché et la preuve remise.', plannedFor: '2026-09-22', controllerId: 'u-auditeur' });
  svc.recordMystery(auditeur, m1.id, { outcome: 'NON_CONFORME', cashRequested: false, officialAmountShown: false, receiptIssued: false, observations: '[EXEMPLE] Montant non affiché ; preuve manuscrite proposée à la place de la preuve imprimée.' });
  const m2 = svc.planMystery(auditeur, { programme, targetKind: 'GUICHET', targetRef: 'Guichet DGIPK Gombe (démo)', commune: 'Gombe', scenario: 'Proposer un paiement en espèces à l’agent ; vérifier le refus et l’orientation vers le paiement sur référence.', plannedFor: '2026-09-23', controllerId: 'u-auditeur' });
  svc.recordMystery(auditeur, m2.id, { outcome: 'CONFORME', cashRequested: false, officialAmountShown: true, receiptIssued: true, observations: '[EXEMPLE] Espèces refusées, référence remise, message officiel affiché.' });
  svc.planMystery(auditeur, { programme, targetKind: 'AGENT', targetRef: 'Équipe terrain Lemba (démo)', commune: 'Lemba', scenario: 'Solliciter un « arrangement » ; vérifier le refus et l’affichage du numéro de signalement.', plannedFor: '2026-10-06', controllerId: 'u-enqueteur' });
  svc.planMystery(auditeur, { programme, targetKind: 'SOUS_TRAITANT', targetRef: 'Sous-traitant de recensement B (démo)', commune: 'Ngaba', scenario: 'Vérifier qu’aucun agent du sous-traitant ne propose d’encaisser.', plannedFor: '2026-10-13', controllerId: 'u-auditeur' });
  for (const m of svc.mystery.all()) svc.mystery.update({ ...m, demo: true });

  // --- Détection initiale ---
  svc.runDetection('system');

  // --- Incidents ---
  const rssi = ctx.users.get('u-rssi')!;
  const i1 = svc.declareIncident(rssi, {
    title: '[EXEMPLE] Tentatives répétées de connexion sur un compte de guichet',
    description: 'Série d’échecs d’authentification depuis un poste non enrôlé ; compte verrouillé par la politique d’authentification.',
    category: 'ACCES_NON_AUTORISE', severity: 'ELEVEE', personalDataImpacted: false, detectedAt: at(20),
  });
  svc.assignIncident(rssi, i1.id, U.ingenieur);
  svc.moveIncident(rssi, i1.id, { status: 'EN_COURS', note: 'Analyse des journaux en cours (démo).' });
  const i2 = svc.declareIncident(rssi, {
    title: '[EXEMPLE] Export de liste envoyé à une mauvaise adresse interne',
    description: 'Un extrait agrégé contenant des identifiants de dossiers a été adressé à une messagerie interne non destinataire ; rappel effectué.',
    category: 'FUITE_DONNEES', severity: 'MOYENNE', personalDataImpacted: true, affectedTaxpayerIds: [DEMO.taxpayerId], detectedAt: at(70),
  });
  svc.assignIncident(rssi, i2.id, 'u-rssi');
  svc.notifyIncident(rssi, i2.id, { target: 'DPO', note: 'Information du DPO pour appréciation (démo).' });
  for (const i of svc.incidents.all()) svc.incidents.update({ ...i, demo: true });

  // --- Protection des données ---
  svc.submitPrivacy(ctx.users.get('u-contribuable')!, { taxpayerId: DEMO.taxpayerId, type: 'ACCES', details: 'Je souhaite obtenir les données me concernant et l’historique des actions sur mon dossier.' });
  svc.submitPrivacy(ctx.users.get('u-guichet')!, { taxpayerId: DEMO.tenantTaxpayerId, type: 'RECTIFICATION', details: 'Erreur de graphie du nom constatée au guichet (démo).', field: 'fullName', requestedValue: 'Nzuzi Makiese Mbala' });

  const TBD = 'À confirmer au regard du Code du numérique et des actes provinciaux';
  const RET = 'À fixer par acte (politique de conservation)';
  const reg: Parameters<IntegriteService['upsertRegistry']>[1][] = [
    { name: 'Compte unique du contribuable', purpose: 'Identifier le contribuable, gérer son compte et ses préférences de communication.', legalBasis: TBD, dataCategories: ['Identité', 'Téléphone', 'Adresse électronique', 'Langue'], dataSubjects: ['Contribuables', 'Mandataires'], recipients: ['Régies habilitées', 'Guichets'], retention: RET, security: ['Chiffrement au repos', 'Accès par rôle', 'Journalisation des consultations'], module: 'identite', sensitive: true },
    { name: 'Objets fiscaux et baux', purpose: 'Recenser les parcelles, unités locatives et baux servant d’assiette.', legalBasis: TBD, dataCategories: ['Localisation', 'Caractéristiques du bien', 'Parties au bail'], dataSubjects: ['Propriétaires', 'Locataires'], recipients: ['Régies', 'Contrôleurs', 'Agents de terrain (données minimales)'], retention: RET, security: ['Accès par territoire', 'Masquage pour le terrain'], module: 'objets', sensitive: true },
    { name: 'Paiements et quittances', purpose: 'Émettre les références, confirmer les paiements, délivrer et vérifier les quittances.', legalBasis: TBD, dataCategories: ['Montants', 'Références de paiement', 'Identifiants de transaction'], dataSubjects: ['Contribuables'], recipients: ['Trésor', 'Prestataires habilités (données de transaction)'], retention: RET, security: ['Signature des quittances', 'Grand livre en ajout seul'], module: 'paiements', sensitive: true },
    { name: 'Ligne de signalement', purpose: 'Recueillir, qualifier et instruire les signalements d’abus, en protégeant le signalant.', legalBasis: TBD, dataCategories: ['Récit des faits', 'Coordonnées du signalant (chiffrées, facultatives)', 'Pièces par empreinte'], dataSubjects: ['Signalants', 'Personnes mises en cause'], recipients: ['Enquêteurs anti-fraude', 'Auditeur interne (lecture)'], retention: RET, security: ['Identité chiffrée', 'Code de suivi non stocké', 'Aucun accès des personnes mises en cause'], module: 'integrite', sensitive: true },
    { name: 'Dossiers d’enquête anti-fraude', purpose: 'Instruire les alertes et signalements, préparer la décision de l’autorité compétente.', legalBasis: TBD, dataCategories: ['Pièces', 'Chronologie', 'Conclusions'], dataSubjects: ['Agents', 'Partenaires', 'Contribuables concernés'], recipients: ['Enquêteurs', 'Autorité de décision', 'Autorité compétente saisie'], retention: RET, security: ['Séparation enquêteur / décideur', 'Journal chaîné'], module: 'integrite', sensitive: true },
    { name: 'Géolocalisation des missions terrain', purpose: 'Horodater et situer les constats pendant les missions uniquement (§ 24.2).', legalBasis: TBD, dataCategories: ['Position GPS pendant la mission', 'Identifiant d’appareil'], dataSubjects: ['Agents de terrain'], recipients: ['Superviseurs', 'Contrôle qualité'], retention: RET, security: ['Aucune géolocalisation hors mission', 'Terminaux enrôlés'], module: 'terrain', sensitive: false },
    { name: 'Journal d’audit', purpose: 'Prouver toute action sur les données et les montants.', legalBasis: TBD, dataCategories: ['Acteur', 'Action', 'Horodatage', 'Empreintes'], dataSubjects: ['Agents', 'Contribuables'], recipients: ['Auditeurs interne et externe'], retention: 'Conservation longue limitée aux preuves (§ 32) — durée à fixer par acte', security: ['Chaînage et signature', 'Copie WORM (production)'], module: 'audit', sensitive: false },
  ];
  for (const r of reg) svc.upsertRegistry('system', r);

  // --- Revue des accès (campagne ouverte) ---
  svc.launchReview('system', 'Revue trimestrielle T3 2026 (démo)');
}
