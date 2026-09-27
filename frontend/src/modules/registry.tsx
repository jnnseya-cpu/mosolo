/**
 * Écrans des modules d'extension (verticales, fonctions transverses). Chaque entrée ajoute une route et,
 * si `nav` est fourni, une entrée de menu visible des rôles indiqués (`roles: []` = visible de tous).
 * Libellés en français (langue de référence).
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export interface ModuleRoute {
  path: string;
  element: LazyExoticComponent<ComponentType>;
  /** Entrée de menu (facultative). */
  nav?: { label: string; short?: string; icon: string; group: 'public' | 'pilotage' | 'operations'; roles: string[] };
}

const DASH = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R17', 'R18', 'R22', 'R23', 'R24'];

export const MODULE_ROUTES: ModuleRoute[] = [
  // Socle : connexion
  { path: '/connexion', element: lazy(() => import('./socle/Login')), nav: { label: 'Connexion', icon: 'lock', group: 'public', roles: [] } },

  // Accès : entités, modules, invitations, mandats, identité, arbitrages, consultation motivée
  { path: '/acces/entites', element: lazy(() => import('./acces/EntitesModules')), nav: { label: 'Entités et modules', short: 'Entités', icon: 'building', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R05', 'R06', 'R08', 'R13', 'R14', 'R22', 'R23', 'R26', 'R27'] } },
  { path: '/acces/invitations', element: lazy(() => import('./acces/Invitations')), nav: { label: 'Invitations et comptes', short: 'Accès', icon: 'users', group: 'operations', roles: ['R26', 'R28', 'R08', 'R06', 'R07', 'R09', 'R02', 'R03', 'R12', 'R22', 'R23'] } },
  { path: '/invitation', element: lazy(() => import('./acces/InvitationAccept')) },
  { path: '/acces/mandats', element: lazy(() => import('./acces/Mandats')), nav: { label: 'Mes mandataires', short: 'Mandats', icon: 'users', group: 'public', roles: ['R30', 'R31'] } },
  { path: '/acces/identite', element: lazy(() => import('./acces/Identite')), nav: { label: 'Registre d’identité', short: 'Identité', icon: 'user', group: 'operations', roles: ['R12', 'R11', 'R07', 'R06', 'R09', 'R10'] } },
  { path: '/acces/arbitrages', element: lazy(() => import('./acces/Arbitrages')), nav: { label: 'Arbitrages entre entités', short: 'Arbitrages', icon: 'scale', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R05', 'R13', 'R14', 'R06', 'R07', 'R08', 'R11', 'R22', 'R23'] } },
  { path: '/acces/consultation', element: lazy(() => import('./acces/Consultation')), nav: { label: 'Consultation motivée', short: 'Motif', icon: 'lock', group: 'operations', roles: ['R06', 'R07', 'R09', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22', 'R23', 'R24', 'R28'] } },

  // Fiscal : biens, déclarations, exonérations, quitus, baux, carte
  { path: '/fiscal/biens', element: lazy(() => import('./fiscal/MesBiens')), nav: { label: 'Biens et relations', short: 'Biens', icon: 'building', group: 'public', roles: ['R30', 'R31', 'R06', 'R07', 'R09', 'R10', 'R11', 'R12', 'R22'] } },
  { path: '/fiscal/declarations', element: lazy(() => import('./fiscal/Declarations')), nav: { label: 'Déclarations', short: 'Déclarer', icon: 'file', group: 'public', roles: ['R30', 'R31', 'R07', 'R11', 'R12'] } },
  { path: '/fiscal/exonerations', element: lazy(() => import('./fiscal/Exonerations')), nav: { label: 'Exonérations', short: 'Exonérations', icon: 'scale', group: 'operations', roles: ['R30', 'R31', 'R06', 'R07', 'R11', 'R12', 'R13', 'R14', 'R22', 'R24'] } },
  { path: '/fiscal/quitus', element: lazy(() => import('./fiscal/Quitus')), nav: { label: 'Quitus fiscal', short: 'Quitus', icon: 'shieldCheck', group: 'public', roles: ['R30', 'R31', 'R06', 'R07', 'R12', 'R37'] } },
  { path: '/fiscal/baux', element: lazy(() => import('./fiscal/AttestationsBail')) },
  { path: '/fiscal/corrections', element: lazy(() => import('./fiscal/Corrections')), nav: { label: 'Corrections d’objets', short: 'Corrections', icon: 'replace', group: 'operations', roles: ['R06', 'R07', 'R11'] } },
  { path: '/autour-de-moi', element: lazy(() => import('./fiscal/AutourDeMoi')), nav: { label: 'Autour de moi', short: 'Autour', icon: 'gps', group: 'operations', roles: ['R06', 'R07', 'R09', 'R10', 'R11', 'R22', 'R24', 'R35'] } },
  { path: '/fiscal/carte', element: lazy(() => import('./fiscal/Carte')), nav: { label: 'Carte fiscale', short: 'Carte', icon: 'pin', group: 'operations', roles: ['R06', 'R07', 'R09', 'R10', 'R11', 'R22'] } },
  { path: '/fiscal/verifier', element: lazy(() => import('./fiscal/Verifier')) },
  { path: '/fiscal/verifier/:type', element: lazy(() => import('./fiscal/Verifier')) },
  { path: '/fiscal/verifier/:type/:code', element: lazy(() => import('./fiscal/Verifier')) },

  // Recouvrement
  { path: '/mes-arrieres', element: lazy(() => import('./recouvrement/MyArrears')), nav: { label: 'Mes arriérés et échéances', short: 'Arriérés', icon: 'clock', group: 'public', roles: ['R30', 'R31'] } },
  { path: '/recouvrement', element: lazy(() => import('./recouvrement/RecoveryQueue')), nav: { label: 'Recouvrement', icon: 'scale', group: 'operations', roles: ['R06', 'R07', 'R11', 'R20', 'R21', 'R22', 'R23'] } },
  { path: '/recouvrement/avis/:id', element: lazy(() => import('./recouvrement/NoticeView')) },
  // Remises (demande et instruction R20, décision R21) et admission en non-valeur (proposition R20, décision R21) ; lecture : recouvrement:read.
  { path: '/recouvrement/remises', element: lazy(() => import('./recouvrement/Remises')), nav: { label: 'Remises gracieuses', short: 'Remises', icon: 'scale', group: 'operations', roles: ['R06', 'R07', 'R11', 'R20', 'R21', 'R22', 'R23'] } },
  { path: '/recouvrement/non-valeurs', element: lazy(() => import('./recouvrement/NonValeurs')), nav: { label: 'Admissions en non-valeur', short: 'Non-valeurs', icon: 'ban', group: 'operations', roles: ['R06', 'R07', 'R11', 'R20', 'R21', 'R22', 'R23'] } },

  // Liquidation : dérogations à la base connue (lecture liquidation R06/R07/R11 et audit R22/R23 ; approbation R06/R07)
  { path: '/liquidation/derogations', element: lazy(() => import('./socle/Derogations')), nav: { label: 'Dérogations à la base', short: 'Dérogations', icon: 'scale', group: 'operations', roles: ['R06', 'R07', 'R11', 'R22', 'R23'] } },

  // Canaux : USSD/SVI, points de paiement, enrôlement assisté, carte MOSOLO
  { path: '/preuve', element: lazy(() => import('./preuves/ProofVerify')), nav: { label: 'Vérifier une preuve', short: 'Vérifier', icon: 'shieldCheck', group: 'public', roles: [] } },
  { path: '/preuve/:code', element: lazy(() => import('./preuves/ProofVerify')) },
  { path: '/preuve/:code/imprimer', element: lazy(() => import('./preuves/ProofPrint')) },
  { path: '/canaux/whatsapp-sms', element: lazy(() => import('./preuves/WhatsAppSms')), nav: { label: 'WhatsApp et SMS', short: 'WhatsApp', icon: 'message', group: 'public', roles: [] } },
  { path: '/canaux/ussd', element: lazy(() => import('./canaux/UssdSimulator')), nav: { label: 'USSD et SVI', short: 'USSD', icon: 'keypad', group: 'public', roles: [] } },
  { path: '/points-de-paiement', element: lazy(() => import('./canaux/PaymentPointsPublic')), nav: { label: 'Où payer ?', short: 'Payer', icon: 'store', group: 'public', roles: [] } },
  { path: '/canaux/verifier-carte', element: lazy(() => import('./canaux/CardVerify')) },
  { path: '/canaux/enrolement', element: lazy(() => import('./canaux/AssistedEnrolment')), nav: { label: 'Enrôlement assisté', short: 'Enrôler', icon: 'user', group: 'operations', roles: ['R09', 'R10', 'R12'] } },
  { path: '/canaux/carte/:number', element: lazy(() => import('./canaux/CardPrint')) },
  { path: '/canaux/point-agree', element: lazy(() => import('./canaux/PointConsole')), nav: { label: 'Console du point agréé', short: 'Encaisser', icon: 'cash', group: 'operations', roles: ['R32'] } },
  { path: '/canaux/points-supervision', element: lazy(() => import('./canaux/PointsSupervision')), nav: { label: 'Points agréés (Trésor)', short: 'Points', icon: 'store', group: 'pilotage', roles: ['R17', 'R18', 'R22', 'R24'] } },
  { path: '/canaux/jour-de-caisse', element: lazy(() => import('./canaux/CashDayReview')), nav: { label: 'Jours de caisse des points', short: 'Caisses', icon: 'ledger', group: 'pilotage', roles: ['R17', 'R18', 'R22', 'R24'] } },

  // Titres, RakaPay, pass wewa
  { path: '/titres/controle', element: lazy(() => import('./titres/Controle')), nav: { label: 'Contrôle des titres', short: 'Contrôle', icon: 'qr', group: 'operations', roles: ['R10', 'R11', 'R35'] } },
  { path: '/rakapay/cooperative', element: lazy(() => import('./rakapay/Cooperative')), nav: { label: 'Espace coopérative wewa', short: 'Coopérative', icon: 'users', group: 'operations', roles: ['R30', 'R06', 'R07'] } },
  { path: '/rakapay/pilotage', element: lazy(() => import('./rakapay/Pilotage')), nav: { label: 'Pilotage RakaPay', short: 'RakaPay', icon: 'chart', group: 'pilotage', roles: ['R01', 'R02', 'R05', 'R06', 'R07', 'R22', 'R23', 'R24', 'R36'] } },

  // Stationnement (ParkSmart)
  { path: '/stationnement', element: lazy(() => import('./parking/ParkingDriver')), nav: { label: 'Stationnement', icon: 'parking', group: 'public', roles: ['R30', 'R31'] } },
  { path: '/stationnement/controle', element: lazy(() => import('./parking/ParkingControl')), nav: { label: 'Contrôle du stationnement', short: 'Stationnement', icon: 'car', group: 'operations', roles: ['R11', 'R09'] } },
  { path: '/mes-gains', element: lazy(() => import('./parking/AgentEarnings')), nav: { label: 'Mes gains (10 %)', short: 'Gains', icon: 'cash', group: 'operations', roles: ['R09', 'R10', 'R11', 'R12', 'R35'] } },
  { path: '/stationnement/mes-gains', element: lazy(() => import('./parking/AgentEarnings')) },
  { path: '/agents/validation-commissions', element: lazy(() => import('./parking/CommissionValidations')), nav: { label: 'Validation des commissions', short: 'Commissions', icon: 'cash', group: 'pilotage', roles: ['R06', 'R07', 'R09', 'R01', 'R02', 'R05', 'R17', 'R22', 'R23', 'R24'] } },
  { path: '/agents/surveillance', element: lazy(() => import('./parking/AgentMonitoring')), nav: { label: 'Surveillance des constats', short: 'Constats', icon: 'analysis', group: 'pilotage', roles: ['R01', 'R02', 'R05', 'R06', 'R07', 'R09', 'R22', 'R23', 'R24'] } },
  { path: '/stationnement/regie', element: lazy(() => import('./parking/ParkingRegie')), nav: { label: 'Régie du stationnement', short: 'Zones', icon: 'parking', group: 'operations', roles: ['R06', 'R07'] } },
  { path: '/stationnement/tableau-de-bord', element: lazy(() => import('./parking/ParkingDashboard')), nav: { label: 'Tableau de bord stationnement', short: 'Parking', icon: 'chart', group: 'pilotage', roles: ['R01', 'R02', 'R05', 'R06', 'R07', 'R09', 'R22', 'R23'] } },

  // Publicité (KIN PUB CONTROL)
  { path: '/publicite', element: lazy(() => import('./publicite/AdvertiserSpace')), nav: { label: 'Mes dispositifs publicitaires', short: 'Publicité', icon: 'megaphone', group: 'public', roles: ['R30', 'R31'] } },
  { path: '/publicite/inspection', element: lazy(() => import('./publicite/AdInspector')), nav: { label: 'Inspection publicitaire', short: 'Inspection', icon: 'camera', group: 'operations', roles: ['R11', 'R09', 'R06', 'R07'] } },
  { path: '/publicite/regie', element: lazy(() => import('./publicite/AdRegie')), nav: { label: 'Autorisations publicité', short: 'Autorisations', icon: 'file', group: 'operations', roles: ['R06', 'R07'] } },
  { path: '/publicite/tableau-de-bord', element: lazy(() => import('./publicite/AdDashboard')), nav: { label: 'Tableau de bord publicité', short: 'Publicité', icon: 'chart', group: 'pilotage', roles: ['R01', 'R02', 'R05', 'R06', 'R07', 'R09', 'R22', 'R23'] } },
  { path: '/publicite/verifier', element: lazy(() => import('./publicite/AdVerify')) },

  // Verticales (console, plaques NFIU, CALCU)
  { path: '/verticales/console', element: lazy(() => import('./verticales/AgentConsole')), nav: { label: 'Console des verticales', short: 'Verticales', icon: 'table', group: 'operations', roles: ['R06', 'R07', 'R09', 'R10', 'R11', 'R12', 'R22', 'R24'] } },
  { path: '/verifier-plaque', element: lazy(() => import('./verticales/PlateVerify')) },
  { path: '/verifier-plaque/:code', element: lazy(() => import('./verticales/PlateVerify')) },
  { path: '/controle/calcu', element: lazy(() => import('./verticales/CalcuConsole')), nav: { label: 'CALCU — contrôle de la dépense', short: 'CALCU', icon: 'bank', group: 'pilotage', roles: ['R01', 'R05', 'R08', 'R15', 'R17', 'R22', 'R23'] } },

  // Terrain : supervision, sous-traitants, badges
  { path: '/terrain/supervision', element: lazy(() => import('./terrain/Supervision')), nav: { label: 'Supervision terrain', short: 'Supervision', icon: 'gauge', group: 'operations', roles: ['R06', 'R07', 'R09', 'R11', 'R22', 'R23', 'R24', 'R35'] } },
  { path: '/terrain/sous-traitants', element: lazy(() => import('./terrain/Subcontractors')), nav: { label: 'Sous-traitants et équipes', short: 'Sous-traitants', icon: 'users', group: 'operations', roles: ['R06', 'R07', 'R08', 'R09', 'R11', 'R17', 'R22', 'R23', 'R24', 'R35'] } },
  { path: '/verifier-agent', element: lazy(() => import('./terrain/VerifyAgent')), nav: { label: 'Vérifier un agent', short: 'Agent', icon: 'shieldCheck', group: 'public', roles: [] } },
  { path: '/verifier-agent/:code', element: lazy(() => import('./terrain/VerifyAgent')) },

  // Intégrité : signalement, enquêtes, incidents, données, accès
  { path: '/signaler', element: lazy(() => import('./integrite/Signalement')), nav: { label: 'Signaler un abus', short: 'Signaler', icon: 'megaphone', group: 'public', roles: [] } },
  { path: '/integrite/enquetes', element: lazy(() => import('./integrite/ConsoleEnquete')), nav: { label: 'Enquêtes anti-fraude', short: 'Enquêtes', icon: 'shieldCheck', group: 'operations', roles: ['R24', 'R22', 'R06', 'R21', 'R28'] } },
  { path: '/integrite/controles-mystere', element: lazy(() => import('./integrite/ControlesMystere')), nav: { label: 'Contrôles mystère', short: 'Mystère', icon: 'check', group: 'operations', roles: ['R22', 'R24'] } },
  { path: '/integrite/incidents', element: lazy(() => import('./integrite/Incidents')), nav: { label: 'Incidents de sécurité', short: 'Incidents', icon: 'alert', group: 'operations', roles: ['R28', 'R27', 'R26', 'R25', 'R22'] } },
  { path: '/integrite/donnees', element: lazy(() => import('./integrite/EspaceDonnees')), nav: { label: 'Protection des données', short: 'Données', icon: 'lock', group: 'operations', roles: ['R25', 'R22', 'R23', 'R30'] } },
  { path: '/integrite/revue-acces', element: lazy(() => import('./integrite/RevueAcces')), nav: { label: 'Revue des accès', short: 'Accès', icon: 'users', group: 'operations', roles: ['R28', 'R08', 'R22', 'R25'] } },
  { path: '/integrite/collusion', element: lazy(() => import('./integrite/Collusion')), nav: { label: 'Collusion sous quatre yeux', short: 'Collusion', icon: 'users', group: 'operations', roles: ['R22', 'R23', 'R24', 'R28', 'R06'] } },
  { path: '/integrite/seuils', element: lazy(() => import('./integrite/RegistreSeuils')), nav: { label: 'Registre des seuils anti-fraude', short: 'Seuils', icon: 'scale', group: 'pilotage', roles: ['R22', 'R23', 'R24', 'R28', 'R06', 'R05', 'R01', 'R02', 'R26', 'R27'] } },
  { path: '/integrite/cles', element: lazy(() => import('./integrite/SanteCles')), nav: { label: 'Santé des clés', short: 'Clés', icon: 'lock', group: 'operations', roles: ['R26', 'R28'] } },

  // Pilotage : tableaux par profil, indicateurs, piste d'audit, transparence
  { path: '/pilotage/tableaux', element: lazy(() => import('./pilotage/Tableaux')), nav: { label: 'Tableaux par profil', short: 'Tableaux', icon: 'grid', group: 'pilotage', roles: DASH } },
  { path: '/pilotage/indicateurs', element: lazy(() => import('./pilotage/Indicateurs')), nav: { label: 'Indicateurs', short: 'KPI', icon: 'gauge', group: 'pilotage', roles: DASH } },
  { path: '/pilotage/repartition', element: lazy(() => import('./pilotage/Repartition')), nav: { label: 'Répartition des recettes (§ 37A)', short: 'Répartition', icon: 'scale', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R05', 'R15', 'R16', 'R17', 'R18', 'R22', 'R23', 'R24'] } },
  { path: '/pilotage/reductions', element: lazy(() => import('./pilotage/Reductions')), nav: { label: 'Réductions de recettes', short: 'Réductions', icon: 'analysis', group: 'pilotage', roles: ['R01', 'R02', 'R05', 'R22', 'R23', 'R24'] } },
  { path: '/pilotage/piste-audit', element: lazy(() => import('./pilotage/PisteAudit')), nav: { label: 'Piste d’audit par dossier', short: 'Piste', icon: 'history', group: 'operations', roles: ['R22', 'R23', 'R24'] } },
  { path: '/transparence', element: lazy(() => import('./pilotage/Transparence')), nav: { label: 'Transparence publique', short: 'Transparence', icon: 'globe', group: 'public', roles: [] } },

  // Vision : sept questions par objet et par obligation, chaîne opératoire en treize maillons, maillons sautés (audit)
  { path: '/chaine', element: lazy(() => import('./chaine/Chaine')), nav: { label: 'Sept questions et chaîne', short: 'Chaîne', icon: 'sync', group: 'operations', roles: ['R06', 'R07', 'R11', 'R17', 'R22', 'R23', 'R24', 'R28'] } },
  { path: '/chaine/:objectId', element: lazy(() => import('./chaine/Chaine')) },
  { path: '/chaine/obligation/:obligationId', element: lazy(() => import('./chaine/Chaine')) },

  // Paiements : prestataires connectés (BitriPay, KODA)
  { path: '/tresor/prestataires', element: lazy(() => import('./prestataires/Prestataires')), nav: { label: 'Prestataires connectés', short: 'Prestataires', icon: 'phone', group: 'operations', roles: ['R17', 'R18', 'R22', 'R26', 'R27'] } },

  // Trésorerie, recouvrement, sous-traitance, détecteurs, CALCU (§ 15A.5, § 20.1, § 21, § 25, § 27A, § 37)
  { path: '/tresor/appariements', element: lazy(() => import('./tresor/Appariements')), nav: { label: 'Rapprochement proposé et crédits groupés', short: 'Appariements', icon: 'ledger', group: 'operations', roles: ['R17', 'R18', 'R22', 'R23'] } },
  { path: '/tresor/points-agrees', element: lazy(() => import('./tresor/PointsAgrees')), nav: { label: 'Points agréés — contrats et pénalités', short: 'Points agréés', icon: 'store', group: 'operations', roles: ['R17', 'R18', 'R22', 'R23', 'R05'] } },
  { path: '/recouvrement/rendement', element: lazy(() => import('./recouvrement/Rendement')), nav: { label: 'Rendement du recouvrement', short: 'Rendement', icon: 'chart', group: 'operations', roles: ['R06', 'R07', 'R11', 'R17', 'R20', 'R21', 'R22', 'R23'] } },
  { path: '/terrain/qualite', element: lazy(() => import('./terrain/Qualite')), nav: { label: 'Contrôle qualité de la sous-traitance', short: 'Qualité terrain', icon: 'shieldCheck', group: 'operations', roles: ['R06', 'R07', 'R09', 'R11', 'R17', 'R22', 'R23', 'R24'] } },
  { path: '/integrite/detecteurs', element: lazy(() => import('./integrite/Detecteurs')), nav: { label: 'Détecteurs anti-fraude', short: 'Détecteurs', icon: 'analysis', group: 'operations', roles: ['R22', 'R23', 'R24', 'R28', 'R06'] } },
  { path: '/controle/calcu/organe', element: lazy(() => import('./verticales/CalcuOrgane')), nav: { label: 'CALCU — organe de contrôle', short: 'Organe CALCU', icon: 'bank', group: 'pilotage', roles: ['R01', 'R05', 'R08', 'R15', 'R17', 'R22', 'R23'] } },

  // IA : liens directs
  { path: '/ia/autonomie', element: lazy(() => import('./ia/AutonomyPage')) },
  { path: '/ia/memoire', element: lazy(() => import('./ia/MemoryPage')) },
  { path: '/ia/journal', element: lazy(() => import('./ia/JournalPage')), nav: { label: 'Journal IA', short: 'Journal IA', icon: 'history', group: 'pilotage', roles: ['R22', 'R23', 'R25', 'R29'] } },
];
