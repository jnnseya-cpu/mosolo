/**
 * Écrans des modules d'extension (verticales, fonctions transverses). Chaque entrée ajoute une route et,
 * si `nav` est fourni, une entrée de menu visible des rôles indiqués (`roles: []` = visible de tous).
 * Libellés en français (langue de référence).
 */
import { type ComponentType, type LazyExoticComponent } from 'react';
import { lazyPage } from '../lib/nouvelleVersion';

export interface ModuleRoute {
  path: string;
  element: LazyExoticComponent<ComponentType>;
  /** Entrée de menu (facultative). */
  nav?: { label: string; short?: string; icon: string; group: 'public' | 'pilotage' | 'operations'; roles: string[] };
}

/** Lecteurs des écrans du programme (politique programme:read). */
const PROGRAMME = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R13', 'R14', 'R15', 'R16', 'R17', 'R18', 'R22', 'R23', 'R24', 'R25', 'R26', 'R27', 'R28'];
const DASH = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R17', 'R18', 'R22', 'R23', 'R24'];

export const MODULE_ROUTES: ModuleRoute[] = [
  // Socle : connexion
  { path: '/connexion', element: lazyPage(() => import('./socle/Login')), nav: { label: 'Connexion', icon: 'lock', group: 'public', roles: [] } },

  // Accès : entités, modules, invitations, mandats, identité, arbitrages, consultation motivée
  { path: '/acces/entites', element: lazyPage(() => import('./acces/EntitesModules')), nav: { label: 'Entités et modules', short: 'Entités', icon: 'building', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R05', 'R06', 'R08', 'R13', 'R14', 'R22', 'R23', 'R26', 'R27'] } },
  { path: '/acces/invitations', element: lazyPage(() => import('./acces/Invitations')), nav: { label: 'Invitations et comptes', short: 'Accès', icon: 'users', group: 'operations', roles: ['R26', 'R28', 'R08', 'R06', 'R07', 'R09', 'R02', 'R03', 'R12', 'R22', 'R23'] } },
  { path: '/invitation', element: lazyPage(() => import('./acces/InvitationAccept')) },
  { path: '/acces/mandats', element: lazyPage(() => import('./acces/Mandats')), nav: { label: 'Mes mandataires', short: 'Mandats', icon: 'users', group: 'public', roles: ['R30', 'R31'] } },
  { path: '/acces/identite', element: lazyPage(() => import('./acces/Identite')), nav: { label: 'Registre d’identité', short: 'Identité', icon: 'user', group: 'operations', roles: ['R12', 'R11', 'R07', 'R06', 'R09', 'R10'] } },
  { path: '/acces/arbitrages', element: lazyPage(() => import('./acces/Arbitrages')), nav: { label: 'Arbitrages entre entités', short: 'Arbitrages', icon: 'scale', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R05', 'R13', 'R14', 'R06', 'R07', 'R08', 'R11', 'R22', 'R23'] } },
  { path: '/acces/consultation', element: lazyPage(() => import('./acces/Consultation')), nav: { label: 'Consultation motivée', short: 'Motif', icon: 'lock', group: 'operations', roles: ['R06', 'R07', 'R09', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22', 'R23', 'R24', 'R28'] } },
  // Types de comptes ; départements, modules et variables (27/09/2026, § 12A).
  { path: '/acces/types-de-comptes', element: lazyPage(() => import('./acces/TypesDeComptes')), nav: { label: 'Types de comptes', short: 'Comptes', icon: 'users', group: 'pilotage', roles: ['R26', 'R28', 'R22', 'R23', 'R08', 'R06', 'R02', 'R03'] } },
  { path: '/acces/departements', element: lazyPage(() => import('./acces/Departements')), nav: { label: 'Départements, modules et variables', short: 'Départements', icon: 'building', group: 'pilotage', roles: ['R26', 'R08'] } },

  // Fiscal : biens, déclarations, exonérations, quitus, baux, carte
  { path: '/fiscal/biens', element: lazyPage(() => import('./fiscal/MesBiens')), nav: { label: 'Biens et relations', short: 'Biens', icon: 'building', group: 'public', roles: ['R30', 'R31', 'R06', 'R07', 'R09', 'R10', 'R11', 'R12', 'R22'] } },
  { path: '/fiscal/declarations', element: lazyPage(() => import('./fiscal/Declarations')), nav: { label: 'Déclarations', short: 'Déclarer', icon: 'file', group: 'public', roles: ['R30', 'R31', 'R07', 'R11', 'R12'] } },
  { path: '/fiscal/exonerations', element: lazyPage(() => import('./fiscal/Exonerations')), nav: { label: 'Exonérations', short: 'Exonérations', icon: 'scale', group: 'operations', roles: ['R30', 'R31', 'R06', 'R07', 'R11', 'R12', 'R13', 'R14', 'R22', 'R24'] } },
  { path: '/fiscal/quitus', element: lazyPage(() => import('./fiscal/Quitus')), nav: { label: 'Quitus fiscal', short: 'Quitus', icon: 'shieldCheck', group: 'public', roles: ['R30', 'R31', 'R06', 'R07', 'R12', 'R37'] } },
  { path: '/fiscal/baux', element: lazyPage(() => import('./fiscal/AttestationsBail')) },
  { path: '/fiscal/corrections', element: lazyPage(() => import('./fiscal/Corrections')), nav: { label: 'Corrections d’objets', short: 'Corrections', icon: 'replace', group: 'operations', roles: ['R06', 'R07', 'R11'] } },
  { path: '/autour-de-moi', element: lazyPage(() => import('./fiscal/AutourDeMoi')), nav: { label: 'Autour de moi', short: 'Autour', icon: 'gps', group: 'operations', roles: ['R06', 'R07', 'R09', 'R10', 'R11', 'R22', 'R24', 'R35'] } },
  { path: '/fiscal/carte', element: lazyPage(() => import('./fiscal/Carte')), nav: { label: 'Carte fiscale', short: 'Carte', icon: 'pin', group: 'operations', roles: ['R06', 'R07', 'R09', 'R10', 'R11', 'R22'] } },
  // Fiscal (extensions) : anomalies locatives § 16.4, assiette 2026 § 16.3, conditions des services § 10A.3, recensement § 17.4, reprise e-DGRK § 7.5
  { path: '/fiscal/anomalies-locatives', element: lazyPage(() => import('./fiscal/Anomalies')), nav: { label: 'Anomalies locatives', short: 'Anomalies', icon: 'analysis', group: 'operations', roles: ['R06', 'R07', 'R11', 'R22', 'R24', 'R09'] } },
  { path: '/fiscal/assiette-2026', element: lazyPage(() => import('./fiscal/Assiette2026')), nav: { label: 'Assiette 2026 (édit budgétaire)', short: 'Assiette 2026', icon: 'file', group: 'public', roles: ['R30', 'R31', 'R06', 'R07', 'R11', 'R12', 'R22'] } },
  { path: '/fiscal/dependances', element: lazyPage(() => import('./fiscal/Dependances')), nav: { label: 'Conditions des services (quitus, vignette)', short: 'Conditions', icon: 'check', group: 'public', roles: [] } },
  { path: '/fiscal/recensement', element: lazyPage(() => import('./fiscal/Recensement')), nav: { label: 'Vagues de recensement', short: 'Recensement', icon: 'grid', group: 'operations', roles: ['R06', 'R07', 'R11', 'R22', 'R09', 'R10'] } },
  { path: '/fiscal/reprise', element: lazyPage(() => import('./fiscal/Reprise')), nav: { label: 'Reprise e-DGRK et import par lots', short: 'Reprise', icon: 'upload', group: 'operations', roles: ['R06', 'R07', 'R11', 'R12', 'R22', 'R23'] } },
  // Compte unique (ch. 9, 28/09/2026) : biens et relations (spécification « Liaison des biens et occupations » v1.0),
  // vue du propriétaire (occupation masquée) et file de revue (réviseurs habilités, agents de terrain affectés).
  { path: '/mes-preuves', element: lazyPage(() => import('./compte-unique/MesPreuves')), nav: { label: 'Mes preuves (contrôle)', short: 'Preuves', icon: 'qr', group: 'public', roles: ['R30'] } },
  { path: '/espace/biens-relations', element: lazyPage(() => import('./compte-unique/BiensRelations')), nav: { label: 'Mes biens et relations', short: 'Mes biens', icon: 'building', group: 'public', roles: ['R30'] } },
  { path: '/espace/biens/:id', element: lazyPage(() => import('./compte-unique/VueProprietaire')) },
  { path: '/biens-relations/revue', element: lazyPage(() => import('./compte-unique/RevueBiens')), nav: { label: 'Revue des biens et relations', short: 'Revue biens', icon: 'scale', group: 'operations', roles: ['R06', 'R07', 'R11', 'R12', 'R22', 'R23', 'R10', 'R35'] } },
  // Compte unique : profils et espaces § 9.3, récupération contrôlée
  { path: '/mon-espace/profils', element: lazyPage(() => import('./socle/Profils')), nav: { label: 'Mes profils et espaces', short: 'Profils', icon: 'user', group: 'public', roles: ['R30', 'R31', 'R07', 'R11', 'R12'] } },
  { path: '/recuperation-compte', element: lazyPage(() => import('./socle/Recuperation')), nav: { label: 'Récupérer mon compte', short: 'Récupérer', icon: 'lock', group: 'public', roles: [] } },
  { path: '/fiscal/verifier', element: lazyPage(() => import('./fiscal/Verifier')) },
  { path: '/fiscal/verifier/:type', element: lazyPage(() => import('./fiscal/Verifier')) },
  { path: '/fiscal/verifier/:type/:code', element: lazyPage(() => import('./fiscal/Verifier')) },

  // Recouvrement
  { path: '/mes-arrieres', element: lazyPage(() => import('./recouvrement/MyArrears')), nav: { label: 'Mes arriérés et échéances', short: 'Arriérés', icon: 'clock', group: 'public', roles: ['R30', 'R31'] } },
  { path: '/recouvrement', element: lazyPage(() => import('./recouvrement/RecoveryQueue')), nav: { label: 'Recouvrement', icon: 'scale', group: 'operations', roles: ['R06', 'R07', 'R11', 'R20', 'R21', 'R22', 'R23'] } },
  { path: '/recouvrement/avis/:id', element: lazyPage(() => import('./recouvrement/NoticeView')) },
  // Réclamations et recours côté administration (module 37 ; § 13.4 et § 23 du Document maître FR 2) : propriétaire, délai, état, décision motivée.
  { path: '/recours', element: lazyPage(() => import('./recouvrement/Recours')), nav: { label: 'Réclamations et recours', short: 'Recours', icon: 'scale', group: 'operations', roles: ['R06', 'R07', 'R20', 'R21', 'R22', 'R23'] } },
  // Remises (demande et instruction R20, décision R21) et admission en non-valeur (proposition R20, décision R21) ; lecture : recouvrement:read.
  { path: '/recouvrement/remises', element: lazyPage(() => import('./recouvrement/Remises')), nav: { label: 'Remises gracieuses', short: 'Remises', icon: 'scale', group: 'operations', roles: ['R06', 'R07', 'R11', 'R20', 'R21', 'R22', 'R23'] } },
  // Campagnes (§ 8, § 45) et prorogations d'échéance (§ 6.2)
  { path: '/recouvrement/campagnes', element: lazyPage(() => import('./recouvrement/Campagnes')), nav: { label: 'Campagnes et calendrier', short: 'Campagnes', icon: 'clock', group: 'pilotage', roles: ['R01', 'R02', 'R05', 'R06', 'R07', 'R11', 'R13', 'R16', 'R22', 'R23', 'R09', 'R20', 'R21'] } },
  { path: '/recouvrement/non-valeurs', element: lazyPage(() => import('./recouvrement/NonValeurs')), nav: { label: 'Admissions en non-valeur', short: 'Non-valeurs', icon: 'ban', group: 'operations', roles: ['R06', 'R07', 'R11', 'R20', 'R21', 'R22', 'R23'] } },

  // Liquidation : dérogations à la base connue (lecture liquidation R06/R07/R11 et audit R22/R23 ; approbation R06/R07)
  { path: '/liquidation/derogations', element: lazyPage(() => import('./socle/Derogations')), nav: { label: 'Dérogations à la base', short: 'Dérogations', icon: 'scale', group: 'operations', roles: ['R06', 'R07', 'R11', 'R22', 'R23'] } },

  // Canaux : USSD/SVI, points de paiement, enrôlement assisté, carte MOSOLO
  { path: '/preuve', element: lazyPage(() => import('./preuves/ProofVerify')), nav: { label: 'Vérifier une preuve', short: 'Vérifier', icon: 'shieldCheck', group: 'public', roles: [] } },
  { path: '/preuve/:code', element: lazyPage(() => import('./preuves/ProofVerify')) },
  { path: '/preuve/:code/imprimer', element: lazyPage(() => import('./preuves/ProofPrint')) },
  { path: '/canaux/whatsapp-sms', element: lazyPage(() => import('./preuves/WhatsAppSms')), nav: { label: 'WhatsApp et SMS', short: 'WhatsApp', icon: 'message', group: 'public', roles: [] } },
  { path: '/canaux/ussd', element: lazyPage(() => import('./canaux/UssdSimulator')), nav: { label: 'USSD et SVI', short: 'USSD', icon: 'keypad', group: 'public', roles: [] } },
  { path: '/points-de-paiement', element: lazyPage(() => import('./canaux/PaymentPointsPublic')), nav: { label: 'Où payer ?', short: 'Payer', icon: 'store', group: 'public', roles: [] } },
  { path: '/canaux/verifier-carte', element: lazyPage(() => import('./canaux/CardVerify')) },
  { path: '/canaux/contestation', element: lazyPage(() => import('./canaux/ContestationAssistee')), nav: { label: 'Contestation sans écrit (guichet)', short: 'Contester', icon: 'scale', group: 'operations', roles: ['R12'] } },
  { path: '/canaux/enrolement', element: lazyPage(() => import('./canaux/AssistedEnrolment')), nav: { label: 'Enrôlement assisté', short: 'Enrôler', icon: 'user', group: 'operations', roles: ['R09', 'R10', 'R12'] } },
  { path: '/canaux/carte/:number', element: lazyPage(() => import('./canaux/CardPrint')) },
  { path: '/canaux/point-agree', element: lazyPage(() => import('./canaux/PointConsole')), nav: { label: 'Console du point agréé', short: 'Encaisser', icon: 'cash', group: 'operations', roles: ['R32'] } },
  { path: '/canaux/points-supervision', element: lazyPage(() => import('./canaux/PointsSupervision')), nav: { label: 'Points agréés (Trésor)', short: 'Points', icon: 'store', group: 'pilotage', roles: ['R17', 'R18', 'R22', 'R24'] } },
  { path: '/canaux/jour-de-caisse', element: lazyPage(() => import('./canaux/CashDayReview')), nav: { label: 'Jours de caisse des points', short: 'Caisses', icon: 'ledger', group: 'pilotage', roles: ['R17', 'R18', 'R22', 'R24'] } },

  // Titres, RakaPay, pass wewa
  { path: '/titres/controle', element: lazyPage(() => import('./titres/Controle')), nav: { label: 'Contrôle des titres', short: 'Contrôle', icon: 'qr', group: 'operations', roles: ['R10', 'R11', 'R35'] } },
  // Anti-fraude des preuves (30/09/2026) : dossiers, chaîne de la fraude, instruction et décision par des personnes distinctes.
  { path: '/anti-fraude/preuves', element: lazyPage(() => import('./titres/FraudesPreuves')), nav: { label: 'Fraudes sur les preuves', short: 'Fraudes preuves', icon: 'shieldCheck', group: 'operations', roles: ['R24', 'R22', 'R23', 'R06', 'R07', 'R09'] } },
  { path: '/titres/catalogue', element: lazyPage(() => import('./titres/Catalogue')), nav: { label: 'Catalogue des titres', short: 'Titres', icon: 'ticket', group: 'public', roles: [] } },
  { path: '/rakapay/cooperative', element: lazyPage(() => import('./rakapay/Cooperative')), nav: { label: 'Espace coopérative wewa', short: 'Coopérative', icon: 'users', group: 'operations', roles: ['R30', 'R06', 'R07'] } },
  { path: '/rakapay/pilotage', element: lazyPage(() => import('./rakapay/Pilotage')), nav: { label: 'Pilotage RakaPay', short: 'RakaPay', icon: 'chart', group: 'pilotage', roles: ['R01', 'R02', 'R05', 'R06', 'R07', 'R22', 'R23', 'R24', 'R36'] } },
  { path: '/rakapay/operateurs', element: lazyPage(() => import('./rakapay/Operateurs')), nav: { label: 'Opérateurs de billetterie (RakaPay)', short: 'Opérateurs', icon: 'ticket', group: 'operations', roles: ['R30', 'R35', 'R01', 'R02', 'R05', 'R06', 'R07', 'R22', 'R23', 'R24'] } },

  // Stationnement (ParkSmart)
  { path: '/stationnement', element: lazyPage(() => import('./parking/ParkingDriver')), nav: { label: 'Stationnement', icon: 'parking', group: 'public', roles: ['R30', 'R31'] } },
  { path: '/stationnement/controle', element: lazyPage(() => import('./parking/ParkingControl')), nav: { label: 'Contrôle du stationnement', short: 'Stationnement', icon: 'car', group: 'operations', roles: ['R11', 'R09'] } },
  { path: '/mes-gains', element: lazyPage(() => import('./parking/AgentEarnings')), nav: { label: 'Mes gains (10 %)', short: 'Gains', icon: 'cash', group: 'operations', roles: ['R09', 'R10', 'R11', 'R12', 'R35'] } },
  { path: '/stationnement/mes-gains', element: lazyPage(() => import('./parking/AgentEarnings')) },
  // Module 67 : réserve des agents par module, points de résultats vérifiés × note de qualité (§ 37A.5).
  { path: '/agents/reserve', element: lazyPage(() => import('./terrain/ReserveAgents')), nav: { label: 'Réserve des agents (§ 37A.5)', short: 'Réserve', icon: 'scale', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R05', 'R06', 'R07', 'R09', 'R11', 'R17', 'R22', 'R23', 'R24'] } },
  { path: '/agents/validation-commissions', element: lazyPage(() => import('./parking/CommissionValidations')), nav: { label: 'Validation des commissions', short: 'Commissions', icon: 'cash', group: 'pilotage', roles: ['R06', 'R07', 'R09', 'R01', 'R02', 'R03', 'R05'] } },
  { path: '/agents/surveillance', element: lazyPage(() => import('./parking/AgentMonitoring')), nav: { label: 'Surveillance des constats', short: 'Constats', icon: 'analysis', group: 'pilotage', roles: ['R01', 'R02', 'R05', 'R06', 'R07', 'R09', 'R22', 'R23', 'R24'] } },
  { path: '/stationnement/regie', element: lazyPage(() => import('./parking/ParkingRegie')), nav: { label: 'Régie du stationnement', short: 'Zones', icon: 'parking', group: 'operations', roles: ['R06', 'R07'] } },
  { path: '/stationnement/tableau-de-bord', element: lazyPage(() => import('./parking/ParkingDashboard')), nav: { label: 'Tableau de bord stationnement', short: 'Parking', icon: 'chart', group: 'pilotage', roles: ['R01', 'R02', 'R05', 'R06', 'R07', 'R09', 'R22', 'R23'] } },
  { path: '/stationnement/parksmart', element: lazyPage(() => import('./parking/ParkSmartPilotage')), nav: { label: 'ParkSmart — tarifs, occupation, déploiement', short: 'ParkSmart', icon: 'analysis', group: 'pilotage', roles: ['R01', 'R02', 'R05', 'R06', 'R07', 'R09', 'R20', 'R21', 'R22', 'R23'] } },

  // Publicité (KIN PUB CONTROL)
  { path: '/publicite', element: lazyPage(() => import('./publicite/AdvertiserSpace')), nav: { label: 'Mes dispositifs publicitaires', short: 'Publicité', icon: 'megaphone', group: 'public', roles: ['R30', 'R31'] } },
  { path: '/publicite/inspection', element: lazyPage(() => import('./publicite/AdInspector')), nav: { label: 'Inspection publicitaire', short: 'Inspection', icon: 'camera', group: 'operations', roles: ['R11', 'R09', 'R06', 'R07'] } },
  { path: '/publicite/regie', element: lazyPage(() => import('./publicite/AdRegie')), nav: { label: 'Autorisations publicité', short: 'Autorisations', icon: 'file', group: 'operations', roles: ['R06', 'R07'] } },
  { path: '/publicite/tableau-de-bord', element: lazyPage(() => import('./publicite/AdDashboard')), nav: { label: 'Tableau de bord publicité', short: 'Publicité', icon: 'chart', group: 'pilotage', roles: ['R01', 'R02', 'R05', 'R06', 'R07', 'R09', 'R22', 'R23'] } },
  { path: '/publicite/verifier', element: lazyPage(() => import('./publicite/AdVerify')) },
  { path: '/publicite/carte', element: lazyPage(() => import('./publicite/AdCarte')), nav: { label: 'Carte et pilote publicité', short: 'Carte pub', icon: 'pin', group: 'operations', roles: ['R06', 'R07', 'R09', 'R11', 'R22'] } },
  { path: '/publicite/contrats', element: lazyPage(() => import('./publicite/AdContrats')), nav: { label: 'Contrats et échéances publicitaires', short: 'Contrats', icon: 'file', group: 'public', roles: ['R30', 'R31'] } },
  { path: '/publicite/signaler', element: lazyPage(() => import('./publicite/AdSignaler')), nav: { label: 'Signaler un panneau', short: 'Panneau', icon: 'megaphone', group: 'public', roles: [] } },

  // Verticales (console, plaques NFIU, CALCU)
  { path: '/verticales/console', element: lazyPage(() => import('./verticales/AgentConsole')), nav: { label: 'Console des verticales', short: 'Verticales', icon: 'table', group: 'operations', roles: ['R06', 'R07', 'R09', 'R10', 'R11', 'R12', 'R22', 'R24'] } },
  { path: '/verifier-plaque', element: lazyPage(() => import('./verticales/PlateVerify')) },
  { path: '/verifier-plaque/:code', element: lazyPage(() => import('./verticales/PlateVerify')) },
  { path: '/controle/calcu', element: lazyPage(() => import('./verticales/CalcuConsole')), nav: { label: 'CALCU — contrôle de la dépense', short: 'CALCU', icon: 'bank', group: 'pilotage', roles: ['R01', 'R05', 'R08', 'R15', 'R17', 'R22', 'R23'] } },
  { path: '/verticales/fiches', element: lazyPage(() => import('./verticales/Fiches')), nav: { label: 'Fiches sectorielles (modules 13 à 25)', short: 'Fiches', icon: 'grid', group: 'operations', roles: ['R01', 'R02', 'R05', 'R06', 'R07', 'R09', 'R10', 'R11', 'R22', 'R24', 'R30', 'R31', 'R34', 'R35'] } },
  // Partie V : patrimoine provincial (inventaire → évaluation → appel → revenus domaniaux) et environnement (registre, simulation).
  { path: '/verticales/actifs', element: lazyPage(() => import('./verticales/Patrimoine')), nav: { label: 'Patrimoine provincial (MOSOLO Assets)', short: 'Patrimoine', icon: 'bank', group: 'operations', roles: ['R01', 'R02', 'R05', 'R06', 'R07', 'R11', 'R15', 'R22', 'R23'] } },
  { path: '/verticales/environnement', element: lazyPage(() => import('./verticales/Environnement')), nav: { label: 'Environnement — registre et simulation', short: 'Environnement', icon: 'leaf', group: 'operations', roles: ['R01', 'R02', 'R05', 'R06', 'R07', 'R11', 'R22', 'R23'] } },
  { path: '/verticales/secteurs', element: lazyPage(() => import('./verticales/Secteurs')), nav: { label: 'Modules sectoriels (acte requis)', short: 'Secteurs', icon: 'grid', group: 'operations', roles: ['R06', 'R07', 'R09', 'R10', 'R11', 'R22', 'R24', 'R30', 'R31', 'R35'] } },
  // Référentiel des recettes (Cahier ch. 7) : transparence publique, inventaire et codes pour les agents habilités.
  { path: '/referentiel/recettes', element: lazyPage(() => import('./referentiel/Recettes')), nav: { label: 'Référentiel des recettes', short: 'Recettes', icon: 'ledger', group: 'public', roles: [] } },
  // Modèle de données (ch. 30) et matrice d'habilitations (ch. 12) du Document maître FR 2, évalués en direct.
  { path: '/referentiel/modele-donnees', element: lazyPage(() => import('./referentiel/ModeleDonnees')), nav: { label: 'Modèle de données et habilitations', short: 'Modèle', icon: 'table', group: 'pilotage', roles: ['R01', 'R02', 'R05', 'R06', 'R07', 'R13', 'R14', 'R16', 'R17', 'R22', 'R23', 'R25', 'R26', 'R28'] } },

  // Terrain : supervision, sous-traitants, badges
  // Gestion documentaire (module 38) : pièces chiffrées, versions, sceau, OCR, conservation, exports filigranés.
  { path: '/documents', element: lazyPage(() => import('./documents/Documents')), nav: { label: 'Gestion documentaire', short: 'Documents', icon: 'file', group: 'operations', roles: ['R06', 'R07', 'R09', 'R11', 'R12', 'R17', 'R18', 'R20', 'R21', 'R22', 'R23', 'R24', 'R25', 'R30', 'R31'] } },
  // Notifications et communication (module 39) : modèles versionnés, avis sur plaque, indicateurs ; préférences du contribuable.
  { path: '/communication/notifications', element: lazyPage(() => import('./communication/Notifications')), nav: { label: 'Notifications et modèles', short: 'Notifications', icon: 'message', group: 'operations', roles: ['R01', 'R02', 'R05', 'R06', 'R07', 'R10', 'R11', 'R12', 'R13', 'R14', 'R16', 'R20', 'R21', 'R22', 'R23'] } },
  { path: '/mes-preferences', element: lazyPage(() => import('./communication/MesPreferences')), nav: { label: 'Mes préférences de communication', short: 'Préférences', icon: 'message', group: 'public', roles: ['R30', 'R31'] } },
  // Indicateurs des modules 27 à 40 (spécification fonctionnelle), calculés sur les données réelles.
  { path: '/pilotage/indicateurs-modules-27-40', element: lazyPage(() => import('./pilotage/IndicateursModules2740')), nav: { label: 'Indicateurs des modules 27 à 40', short: 'Indicateurs 27–40', icon: 'gauge', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R17', 'R18', 'R20', 'R21', 'R22', 'R23', 'R24'] } },
  // Renseignement anti-fraude (module 40) : scores explicables, suspension conservatoire, transmission à l'autorité.
  { path: '/integrite/renseignement', element: lazyPage(() => import('./integrite/Renseignement')), nav: { label: 'Renseignement anti-fraude', short: 'Renseignement', icon: 'shieldCheck', group: 'operations', roles: ['R24', 'R22', 'R28', 'R26', 'R06', 'R21'] } },
  // Inspection et constat (module 35) : dossiers préparés, paquet hors ligne, procès-verbaux selon les pouvoirs.
  { path: '/terrain/inspection', element: lazyPage(() => import('./terrain/Inspection')), nav: { label: 'Inspection et constat', short: 'Inspection', icon: 'file', group: 'operations', roles: ['R06', 'R07', 'R09', 'R10', 'R11', 'R22', 'R23', 'R24'] } },
  { path: '/mes-proces-verbaux', element: lazyPage(() => import('./terrain/MesProcesVerbaux')), nav: { label: 'Procès-verbaux me concernant', short: 'PV', icon: 'file', group: 'public', roles: ['R30', 'R31'] } },
  { path: '/terrain/supervision', element: lazyPage(() => import('./terrain/Supervision')), nav: { label: 'Supervision terrain', short: 'Supervision', icon: 'gauge', group: 'operations', roles: ['R06', 'R07', 'R09', 'R11', 'R22', 'R23', 'R24', 'R35'] } },
  { path: '/terrain/sous-traitants', element: lazyPage(() => import('./terrain/Subcontractors')), nav: { label: 'Sous-traitants et équipes', short: 'Sous-traitants', icon: 'users', group: 'operations', roles: ['R06', 'R07', 'R08', 'R09', 'R11', 'R17', 'R22', 'R23', 'R24', 'R35'] } },
  // Apprentissage et environnement de travail (§ 24) : espace par rôle, mes certificats, administration des certifications
  { path: '/apprentissage', element: lazyPage(() => import('./apprentissage/Espace')), nav: { label: 'Espace d’apprentissage', short: 'Apprendre', icon: 'question', group: 'operations', roles: [] } },
  { path: '/apprentissage/mes-certificats', element: lazyPage(() => import('./apprentissage/MesCertificats')) },
  { path: '/apprentissage/certifications', element: lazyPage(() => import('./apprentissage/Certifications')), nav: { label: 'Certifications et contenus d’apprentissage', short: 'Certifications', icon: 'shieldCheck', group: 'pilotage', roles: ['R06', 'R07', 'R08', 'R09', 'R17', 'R22', 'R23', 'R24', 'R26', 'R28', 'R01', 'R02', 'R03', 'R05'] } },
  { path: '/verifier-agent', element: lazyPage(() => import('./terrain/VerifyAgent')), nav: { label: 'Vérifier un agent', short: 'Agent', icon: 'shieldCheck', group: 'public', roles: [] } },
  { path: '/verifier-agent/:code', element: lazyPage(() => import('./terrain/VerifyAgent')) },

  // Intégrité : signalement, enquêtes, incidents, données, accès
  { path: '/signaler', element: lazyPage(() => import('./integrite/Signalement')), nav: { label: 'Signaler un abus', short: 'Signaler', icon: 'megaphone', group: 'public', roles: [] } },
  { path: '/integrite/enquetes', element: lazyPage(() => import('./integrite/ConsoleEnquete')), nav: { label: 'Enquêtes anti-fraude', short: 'Enquêtes', icon: 'shieldCheck', group: 'operations', roles: ['R24', 'R22', 'R06', 'R21', 'R28'] } },
  { path: '/integrite/controles-mystere', element: lazyPage(() => import('./integrite/ControlesMystere')), nav: { label: 'Contrôles mystère', short: 'Mystère', icon: 'check', group: 'operations', roles: ['R22', 'R24'] } },
  { path: '/integrite/incidents', element: lazyPage(() => import('./integrite/Incidents')), nav: { label: 'Incidents de sécurité', short: 'Incidents', icon: 'alert', group: 'operations', roles: ['R28', 'R27', 'R26', 'R25', 'R22'] } },
  { path: '/integrite/donnees', element: lazyPage(() => import('./integrite/EspaceDonnees')), nav: { label: 'Protection des données', short: 'Données', icon: 'lock', group: 'operations', roles: ['R25', 'R22', 'R23', 'R30'] } },
  { path: '/integrite/revue-acces', element: lazyPage(() => import('./integrite/RevueAcces')), nav: { label: 'Revue des accès', short: 'Accès', icon: 'users', group: 'operations', roles: ['R28', 'R08', 'R22', 'R25'] } },
  { path: '/integrite/collusion', element: lazyPage(() => import('./integrite/Collusion')), nav: { label: 'Collusion sous quatre yeux', short: 'Collusion', icon: 'users', group: 'operations', roles: ['R22', 'R23', 'R24', 'R28', 'R06'] } },
  { path: '/integrite/seuils', element: lazyPage(() => import('./integrite/RegistreSeuils')), nav: { label: 'Registre des seuils anti-fraude', short: 'Seuils', icon: 'scale', group: 'pilotage', roles: ['R22', 'R23', 'R24', 'R28', 'R06', 'R05', 'R01', 'R02', 'R26', 'R27'] } },
  { path: '/integrite/cles', element: lazyPage(() => import('./integrite/SanteCles')), nav: { label: 'Santé des clés', short: 'Clés', icon: 'lock', group: 'operations', roles: ['R26', 'R28'] } },
  { path: '/integrite/scellement', element: lazyPage(() => import('./integrite/Scellement')), nav: { label: 'Scellement du journal d’audit', short: 'Scellement', icon: 'shieldCheck', group: 'operations', roles: ['R22', 'R23', 'R28', 'R26', 'R27'] } },
  { path: '/integrite/surveillance-technique', element: lazyPage(() => import('./integrite/SurveillanceTechnique')), nav: { label: 'Surveillance technique (appareils, GPS, plafonds)', short: 'Surveillance', icon: 'gps', group: 'operations', roles: ['R28', 'R22', 'R24', 'R09', 'R27'] } },
  { path: '/acces/elevations', element: lazyPage(() => import('./acces/Elevations')), nav: { label: 'Accès privilégiés juste-à-temps', short: 'Élévations', icon: 'lock', group: 'operations', roles: ['R26', 'R27', 'R28', 'R22', 'R23'] } },
  { path: '/donnees/extractions', element: lazyPage(() => import('./socle/Extractions')), nav: { label: 'Extractions de données (trois visas)', short: 'Extractions', icon: 'download', group: 'operations', roles: ['R26', 'R27', 'R25', 'R02', 'R03', 'R05', 'R22', 'R23', 'R28'] } },

  // Pilotage : tableaux par profil, indicateurs, piste d'audit, transparence
  { path: '/pilotage/tableaux', element: lazyPage(() => import('./pilotage/Tableaux')), nav: { label: 'Tableaux par profil', short: 'Tableaux', icon: 'grid', group: 'pilotage', roles: DASH } },
  { path: '/pilotage/indicateurs', element: lazyPage(() => import('./pilotage/Indicateurs')), nav: { label: 'Indicateurs', short: 'KPI', icon: 'gauge', group: 'pilotage', roles: DASH } },
  { path: '/pilotage/repartition', element: lazyPage(() => import('./pilotage/Repartition')), nav: { label: 'Répartition des recettes (§ 37A)', short: 'Répartition', icon: 'scale', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R05', 'R15', 'R16', 'R17', 'R18', 'R22', 'R23', 'R24', 'R38'] } },
  // Moteur de répartition et droits (spécifications du 29/09/2026), par-dessus la répartition du § 37A ; écrans de la
  // spécification v1.0 (§ 15, § 21, § 22, § 24) servis par le même écran (onglet présélectionné), droits côté serveur.
  { path: '/pilotage/moteur-repartition', element: lazyPage(() => import('./pilotage/MoteurRepartition')), nav: { label: 'Répartition des recettes et droits', short: 'Droits', icon: 'scale', group: 'pilotage', roles: ['R04', 'R06', 'R07', 'R08', 'R10', 'R14', 'R15', 'R16', 'R17', 'R18', 'R19', 'R22', 'R23', 'R27'] } },
  { path: '/pilotage/acces-montants', element: lazyPage(() => import('./pilotage/AccesMontants')), nav: { label: 'Accès aux montants (autorisation préalable)', short: 'Montants', icon: 'lock', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R05', 'R11', 'R15', 'R17', 'R18', 'R22', 'R23', 'R24'] } },
  { path: '/executive/finance', element: lazyPage(() => import('./pilotage/MoteurRepartition')), nav: { label: 'Centre de commandement financier (Executive Finance)', short: 'Finances', icon: 'gauge', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R05'] } },
  { path: '/groupe-nseya/command-centre', element: lazyPage(() => import('./pilotage/MoteurRepartition')), nav: { label: 'Centre de commandement Groupe Nseya (Command Centre)', short: 'Nseya', icon: 'gauge', group: 'pilotage', roles: ['R38'] } },
  { path: '/platform-admin/finance/allocation-rules', element: lazyPage(() => import('./pilotage/MoteurRepartition')), nav: { label: 'Règles de répartition (Allocation Rules) — proposition', short: 'Règles', icon: 'scale', group: 'operations', roles: ['R26'] } },
  { path: '/subcontractor/finance', element: lazyPage(() => import('./pilotage/MoteurRepartition')), nav: { label: 'Mes finances de sous-traitant (Subcontractor Finance)', short: 'Finances', icon: 'bank', group: 'operations', roles: ['R35'] } },
  { path: '/pilotage/reductions', element: lazyPage(() => import('./pilotage/Reductions')), nav: { label: 'Réductions de recettes', short: 'Réductions', icon: 'analysis', group: 'pilotage', roles: ['R01', 'R02', 'R05', 'R22', 'R23', 'R24'] } },
  // Opportunités de recettes (Cahier v2.9 § 8) : registre et pipeline, recoupement sous protocole, maximisation et leviers.
  { path: '/opportunites', element: lazyPage(() => import('./opportunites/Registre')), nav: { label: 'Opportunités de recettes', short: 'Opportunités', icon: 'star', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R09', 'R11', 'R13', 'R14', 'R15', 'R22', 'R23', 'R24', 'R25'] } },
  { path: '/opportunites/recoupement', element: lazyPage(() => import('./opportunites/Recoupement')), nav: { label: 'Recoupement des données', short: 'Recoupement', icon: 'sync', group: 'operations', roles: ['R05', 'R06', 'R07', 'R08', 'R09', 'R10', 'R11', 'R12', 'R22', 'R23', 'R24', 'R25', 'R34', 'R37'] } },
  { path: '/opportunites/maximisation', element: lazyPage(() => import('./opportunites/Maximisation')), nav: { label: 'Maximisation et leviers', short: 'Maximiser', icon: 'analysis', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R09', 'R11', 'R13', 'R14', 'R15', 'R17', 'R18', 'R22', 'R23', 'R24', 'R25'] } },
  { path: '/pilotage/piste-audit', element: lazyPage(() => import('./pilotage/PisteAudit')), nav: { label: 'Piste d’audit par dossier', short: 'Piste', icon: 'history', group: 'operations', roles: ['R22', 'R23', 'R24'] } },
  { path: '/transparence', element: lazyPage(() => import('./pilotage/Transparence')), nav: { label: 'Transparence publique', short: 'Transparence', icon: 'globe', group: 'public', roles: [] } },
  // Planification et pilotage stratégique : base de référence et RANV, pilote, scénarios, assignations, instructions, accords, projets, partage légal
  { path: '/pilotage/base-reference', element: lazyPage(() => import('./pilotage/BaseReference')), nav: { label: 'Base de référence et RANV', short: 'RANV', icon: 'gauge', group: 'pilotage', roles: [...DASH, 'R15'] } },
  { path: '/pilotage/pilote', element: lazyPage(() => import('./pilotage/Pilote')), nav: { label: 'Pilote de 180 jours', short: 'Pilote', icon: 'chart', group: 'pilotage', roles: [...DASH, 'R15', 'R36'] } },
  // Conduite du programme (Cahier nouvelle version ch. 35 à 37) : phases et portes, plans d'action datés, modèle opérationnel, gouvernance
  { path: '/pilotage/feuille-de-route', element: lazyPage(() => import('./pilotage/FeuilleDeRoute')), nav: { label: 'Feuille de route et modèle opérationnel', short: 'Feuille de route', icon: 'clock', group: 'pilotage', roles: [...DASH, 'R13', 'R14', 'R15', 'R25', 'R26', 'R27', 'R28', 'R36'] } },
  { path: '/pilotage/scenarios', element: lazyPage(() => import('./pilotage/Scenarios')), nav: { label: 'Simulateur de scénarios', short: 'Scénarios', icon: 'analysis', group: 'pilotage', roles: [...DASH, 'R15'] } },
  { path: '/pilotage/assignations', element: lazyPage(() => import('./pilotage/Assignations')), nav: { label: 'Assignations et écarts', short: 'Assignations', icon: 'scale', group: 'pilotage', roles: [...DASH, 'R15'] } },
  { path: '/pilotage/instructions', element: lazyPage(() => import('./pilotage/Instructions')), nav: { label: 'Instructions et suivi', short: 'Instructions', icon: 'check', group: 'pilotage', roles: [...DASH, 'R09', 'R11', 'R13', 'R14', 'R15', 'R16', 'R20', 'R21'] } },
  { path: '/pilotage/accords-service', element: lazyPage(() => import('./pilotage/AccordsService')), nav: { label: 'Accords de service entre entités', short: 'Accords', icon: 'users', group: 'pilotage', roles: [...DASH, 'R15', 'R16'] } },
  { path: '/pilotage/projets', element: lazyPage(() => import('./pilotage/Projets')), nav: { label: 'Emploi des recettes — suggestions de l’IA', short: 'Emploi des recettes', icon: 'building', group: 'pilotage', roles: [...DASH, 'R15', 'R16'] } },
  { path: '/pilotage/partage-legal', element: lazyPage(() => import('./pilotage/PartageLegal')), nav: { label: 'Partage légal des recettes', short: 'Partage', icon: 'scale', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R08', 'R13', 'R14', 'R15', 'R16', 'R17', 'R18', 'R22', 'R23', 'R24'] } },
  // Programme (Document maître FR 2, ch. 41–48) : risques, recette, versions, 100 premiers jours, décisions du Gouvernement.
  { path: '/pilotage/risques', element: lazyPage(() => import('./pilotage/Risques')), nav: { label: 'Registre des risques', short: 'Risques', icon: 'alert', group: 'pilotage', roles: PROGRAMME } },
  { path: '/pilotage/recette', element: lazyPage(() => import('./pilotage/Recette')), nav: { label: 'Recette — critères d’acceptation', short: 'Recette', icon: 'check', group: 'pilotage', roles: PROGRAMME } },
  { path: '/pilotage/versions', element: lazyPage(() => import('./pilotage/Versions')), nav: { label: 'Plan de livraison par versions', short: 'Versions', icon: 'table', group: 'pilotage', roles: PROGRAMME } },
  { path: '/pilotage/cent-jours', element: lazyPage(() => import('./pilotage/CentJours')), nav: { label: 'Plan des 100 premiers jours', short: '100 jours', icon: 'clock', group: 'pilotage', roles: PROGRAMME } },
  { path: '/pilotage/decisions-gouvernement', element: lazyPage(() => import('./pilotage/Decisions')), nav: { label: 'Décisions du Gouvernement provincial', short: 'Décisions', icon: 'scale', group: 'pilotage', roles: PROGRAMME } },
  // Agents IA de recettes (01/10/2026) : hub de direction, tournée de l'agent de terrain, doléances des usagers.
  { path: '/agents-recettes', element: lazyPage(() => import('./agents-recettes/AgentsRecettes')), nav: { label: 'Agents IA de recettes', short: 'Agents IA', icon: 'analysis', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R13', 'R14', 'R15', 'R16', 'R17', 'R18', 'R20', 'R21', 'R22', 'R23', 'R24', 'R26', 'R27', 'R28'] } },
  { path: '/agents-recettes/tournee', element: lazyPage(() => import('./agents-recettes/Tournee')), nav: { label: 'Ma tournée du jour (copilote)', short: 'Tournée', icon: 'pin', group: 'operations', roles: ['R09', 'R10', 'R11'] } },
  { path: '/mes-doleances', element: lazyPage(() => import('./agents-recettes/MesDoleances')), nav: { label: 'Mes doléances', short: 'Doléances', icon: 'message', group: 'public', roles: ['R30', 'R31'] } },
  { path: '/satisfaction', element: lazyPage(() => import('./pilotage/Satisfaction')), nav: { label: 'Donner mon avis', short: 'Avis', icon: 'check', group: 'public', roles: ['R30', 'R31'] } },

  // Vision : sept questions par objet et par obligation, chaîne opératoire en treize maillons, maillons sautés (audit)
  { path: '/chaine', element: lazyPage(() => import('./chaine/Chaine')), nav: { label: 'Sept questions et chaîne', short: 'Chaîne', icon: 'sync', group: 'operations', roles: ['R06', 'R07', 'R11', 'R17', 'R22', 'R23', 'R24', 'R28'] } },
  { path: '/chaine/:objectId', element: lazyPage(() => import('./chaine/Chaine')) },
  { path: '/chaine/obligation/:obligationId', element: lazyPage(() => import('./chaine/Chaine')) },

  // Registre juridique : points à trancher (J1–J30, § 6.4, annexe B), textes (§ 6.1), fonctions en attente ; données C1–C5
  { path: '/juridique/points', element: lazyPage(() => import('./juridique/PointsJuridiques')), nav: { label: 'Points juridiques à trancher', short: 'Points J', icon: 'scale', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R05', 'R06', 'R13', 'R14', 'R15', 'R16', 'R22', 'R23', 'R25', 'R36'] } },
  { path: '/juridique/donnees', element: lazyPage(() => import('./juridique/DonneesConservation')), nav: { label: 'Classification et conservation des données', short: 'Données', icon: 'lock', group: 'operations', roles: ['R25', 'R28', 'R26', 'R22', 'R23'] } },

  // Paiements : prestataires connectés (BitriPay, KODA)
  { path: '/tresor/prestataires', element: lazyPage(() => import('./prestataires/Prestataires')), nav: { label: 'Prestataires connectés', short: 'Prestataires', icon: 'phone', group: 'operations', roles: ['R17', 'R18', 'R22', 'R26', 'R27', 'R28'] } },
  // Page de retour après la page de paiement hébergée du prestataire (29/09/2026) : état réel lu dans MOSOLO.
  { path: '/paiement/retour', element: lazyPage(() => import('./prestataires/RetourPaiement')) },
  // Page de paiement SIMULÉE de BitriPay / KODA (démonstration, 30/09/2026) : bac à sable local seulement (refus serveur sinon).
  { path: '/demo/passerelle/:provider', element: lazyPage(() => import('./prestataires/PasserelleDemo')) },
  // « Clés et raccordements » (29/09/2026) : super-administrateur (R26) et responsable sécurité (R28) seulement.
  { path: '/plateforme/cles', element: lazyPage(() => import('./plateforme/ClesRaccordements')), nav: { label: 'Clés et raccordements', short: 'Clés', icon: 'lock', group: 'operations', roles: ['R26', 'R28'] } },

  // Trésorerie, recouvrement, sous-traitance, détecteurs, CALCU (§ 15A.5, § 20.1, § 21, § 25, § 27A, § 37)
  { path: '/tresor/appariements', element: lazyPage(() => import('./tresor/Appariements')), nav: { label: 'Rapprochement proposé et crédits groupés', short: 'Appariements', icon: 'ledger', group: 'operations', roles: ['R17', 'R18', 'R22', 'R23'] } },
  { path: '/tresor/points-agrees', element: lazyPage(() => import('./tresor/PointsAgrees')), nav: { label: 'Points agréés — contrats et pénalités', short: 'Points agréés', icon: 'store', group: 'operations', roles: ['R17', 'R18', 'R22', 'R23', 'R05'] } },
  { path: '/recouvrement/rendement', element: lazyPage(() => import('./recouvrement/Rendement')), nav: { label: 'Rendement du recouvrement', short: 'Rendement', icon: 'chart', group: 'operations', roles: ['R06', 'R07', 'R11', 'R17', 'R20', 'R21', 'R22', 'R23'] } },
  { path: '/terrain/qualite', element: lazyPage(() => import('./terrain/Qualite')), nav: { label: 'Contrôle qualité de la sous-traitance', short: 'Qualité terrain', icon: 'shieldCheck', group: 'operations', roles: ['R06', 'R07', 'R09', 'R11', 'R17', 'R22', 'R23', 'R24'] } },
  { path: '/integrite/detecteurs', element: lazyPage(() => import('./integrite/Detecteurs')), nav: { label: 'Détecteurs anti-fraude', short: 'Détecteurs', icon: 'analysis', group: 'operations', roles: ['R22', 'R23', 'R24', 'R28', 'R06'] } },
  { path: '/controle/calcu/organe', element: lazyPage(() => import('./verticales/CalcuOrgane')), nav: { label: 'CALCU — organe de contrôle', short: 'Organe CALCU', icon: 'bank', group: 'pilotage', roles: ['R01', 'R05', 'R08', 'R15', 'R17', 'R22', 'R23'] } },

  // Chaîne véhicule RFCK (modules 82 à 84 — n° 59–61 dans le catalogue du maître d'ouvrage du 27/09/2026)
  { path: '/vehicules/controle-technique', element: lazyPage(() => import('./vehicules-controle/ControleTechnique')), nav: { label: 'Contrôle technique et vignette sécurisée', short: 'Contrôle technique', icon: 'car', group: 'operations', roles: ['R01', 'R02', 'R04', 'R05', 'R06', 'R07', 'R08', 'R11', 'R22', 'R23', 'R24', 'R34'] } },
  { path: '/vehicules/scan', element: lazyPage(() => import('./vehicules-controle/ScanVehicule')), nav: { label: 'Scan unique du véhicule', short: 'Scan véhicule', icon: 'qr', group: 'operations', roles: ['R09', 'R10', 'R11'] } },
  { path: '/vehicules/fourrieres', element: lazyPage(() => import('./vehicules-controle/Fourrieres')), nav: { label: 'Fourrières, enlèvement et gardiennage', short: 'Fourrières', icon: 'parking', group: 'operations', roles: ['R04', 'R06', 'R07', 'R10', 'R11', 'R17', 'R21', 'R22', 'R23', 'R24', 'R35'] } },
  { path: '/vehicules/centres-agrees', element: lazyPage(() => import('./vehicules-controle/CentresAgrees')), nav: { label: 'Centres agréés et tiers de confiance', short: 'Centres agréés', icon: 'building', group: 'operations', roles: ['R01', 'R04', 'R06', 'R07', 'R22', 'R23', 'R24', 'R34', 'R35'] } },
  { path: '/vehicules/rfck', element: lazyPage(() => import('./vehicules-controle/RaccordementRfck')), nav: { label: 'Raccordement RFCK et domaine officiel', short: 'RFCK', icon: 'sync', group: 'pilotage', roles: ['R01', 'R02', 'R04', 'R05', 'R06', 'R07', 'R08', 'R17', 'R22', 'R23', 'R25', 'R26', 'R27', 'R28'] } },
  { path: '/vehicules/mes-vehicules', element: lazyPage(() => import('./vehicules-controle/MesVehicules')), nav: { label: 'Mes véhicules', short: 'Véhicules', icon: 'car', group: 'public', roles: ['R30', 'R31'] } },
  { path: '/vehicules/verifier', element: lazyPage(() => import('./vehicules-controle/VerifierVignette')), nav: { label: 'Vérifier une vignette technique ou un centre', short: 'Vignette technique', icon: 'shieldCheck', group: 'public', roles: [] } },
  { path: '/v/ct/:numero', element: lazyPage(() => import('./vehicules-controle/VerifierVignette')) },
  // Parcours du citoyen — modules 1 à 12 de la Spécification fonctionnelle (application Android et iOS, portail public,
  // relations, cadastre, locatif, patentes, véhicules, transport, indicateurs).
  { path: '/application', element: lazyPage(() => import('./citoyen/Application')), nav: { label: 'Application mobile (Android et iOS)', short: 'Application', icon: 'phone', group: 'public', roles: [] } },
  { path: '/simulateurs', element: lazyPage(() => import('./citoyen/PortailPublic')), nav: { label: 'Informations et simulateurs', short: 'Simuler', icon: 'analysis', group: 'public', roles: [] } },
  { path: '/citoyen/pieces', element: lazyPage(() => import('./citoyen/Pieces')), nav: { label: 'Contrôle des pièces (enrôlement)', short: 'Pièces', icon: 'shieldCheck', group: 'operations', roles: ['R07', 'R09', 'R10', 'R11', 'R12', 'R22', 'R30', 'R31'] } },
  { path: '/mon-espace/situation', element: lazyPage(() => import('./citoyen/Situation')), nav: { label: 'Attestation de situation', short: 'Situation', icon: 'file', group: 'public', roles: ['R30', 'R31', 'R12'] } },
  { path: '/citoyen/relations', element: lazyPage(() => import('./citoyen/Relations')), nav: { label: 'Relations : revue à la date d’effet', short: 'Relations', icon: 'replace', group: 'operations', roles: ['R06', 'R07', 'R11', 'R22'] } },
  { path: '/citoyen/cadastre', element: lazyPage(() => import('./citoyen/Cadastre')), nav: { label: 'Cadastre fiscal géospatial', short: 'Cadastre', icon: 'pin', group: 'operations', roles: ['R01', 'R02', 'R05', 'R06', 'R07', 'R09', 'R10', 'R11', 'R22', 'R24'] } },
  { path: '/citoyen/locatif', element: lazyPage(() => import('./citoyen/Locatif')), nav: { label: 'Intelligence locative (IRL)', short: 'Locatif', icon: 'building', group: 'operations', roles: ['R01', 'R05', 'R06', 'R07', 'R09', 'R11', 'R22', 'R24'] } },
  { path: '/citoyen/activites', element: lazyPage(() => import('./citoyen/Activites')), nav: { label: 'Activités et patentes', short: 'Patentes', icon: 'store', group: 'operations', roles: ['R01', 'R05', 'R06', 'R07', 'R09', 'R10', 'R11', 'R22', 'R24', 'R30', 'R31'] } },
  { path: '/citoyen/vehicules', element: lazyPage(() => import('./citoyen/Vehicules')), nav: { label: 'Véhicules et circulation', short: 'Véhicules', icon: 'car', group: 'operations', roles: ['R01', 'R05', 'R06', 'R07', 'R09', 'R10', 'R11', 'R22', 'R24', 'R35'] } },
  { path: '/citoyen/transport', element: lazyPage(() => import('./citoyen/Transport')), nav: { label: 'Autorisations de transport', short: 'Transport', icon: 'bus', group: 'operations', roles: ['R01', 'R05', 'R06', 'R07', 'R09', 'R10', 'R11', 'R22', 'R24', 'R30', 'R31'] } },
  { path: '/citoyen/indicateurs', element: lazyPage(() => import('./citoyen/Indicateurs')), nav: { label: 'Indicateurs des modules 1 à 12', short: 'KPI citoyen', icon: 'gauge', group: 'pilotage', roles: [...DASH, 'R11'] } },
  // Pilotage et décision (modules 41 à 47), plateforme et accès (51 à 55), recettes spécifiques (56, 57), terrain (58), apprentissage (50)
  // Postes de décision des autorités et postes de travail (Cahier nouvelle version, ch. 27 ; catalogue n° 41 à 44, noms
  // du 27/09/2026, anciens noms conservés entre parenthèses). Le Gouverneur a un menu de cinq entrées (components/Shell).
  { path: '/poste-de-decision', element: lazyPage(() => import('./postes/PosteDecision')), nav: { label: 'Postes de décision des autorités (ancien Centre de commandement exécutif)', short: 'Décider', icon: 'check', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R36'] } },
  { path: '/poste-de-decision/:vue', element: lazyPage(() => import('./postes/PosteDecision')) },
  { path: '/poste-de-decision/:vue/:id', element: lazyPage(() => import('./postes/PosteDecision')) },
  { path: '/poste-de-travail', element: lazyPage(() => import('./postes/PosteTravail')), nav: { label: 'Poste de travail (file de travail)', short: 'Travail', icon: 'table', group: 'operations', roles: ['R06', 'R07', 'R08', 'R09', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R16', 'R17', 'R18', 'R19', 'R20', 'R21', 'R22', 'R23', 'R24', 'R25', 'R26', 'R27', 'R28', 'R29', 'R35'] } },
  { path: '/decision/commandement', element: lazyPage(() => import('./decision/Commandement')), nav: { label: 'Centre de commandement (Command Centre)', short: 'Commandement', icon: 'gauge', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R05'] } },
  { path: '/decision/regie-fiscale', element: lazyPage(() => import('./decision/Regies').then((m) => ({ default: m.RegieFiscale }))), nav: { label: 'Poste de travail — régie fiscale (Tableau de bord de la régie fiscale)', short: 'Régie fiscale', icon: 'chart', group: 'pilotage', roles: ['R06', 'R07', 'R01', 'R02', 'R03', 'R05', 'R22', 'R23'] } },
  { path: '/decision/regie-taxes', element: lazyPage(() => import('./decision/Regies').then((m) => ({ default: m.RegieTaxes }))), nav: { label: 'Poste de travail — régie des taxes (Tableau de bord de la régie des taxes)', short: 'Régie des taxes', icon: 'chart', group: 'pilotage', roles: ['R06', 'R07', 'R01', 'R02', 'R03', 'R05', 'R22', 'R23'] } },
  { path: '/decision/ministere', element: lazyPage(() => import('./decision/Finances').then((m) => ({ default: m.TableauMinistere }))), nav: { label: 'Postes ministériels (Tableau de bord ministériel)', short: 'Ministère', icon: 'building', group: 'pilotage', roles: ['R04', 'R01', 'R02', 'R03', 'R05', 'R17', 'R18', 'R22', 'R23'] } },
  { path: '/decision/salle-controle', element: lazyPage(() => import('./decision/Finances').then((m) => ({ default: m.SalleControle }))), nav: { label: 'Salle de contrôle finances et trésorerie', short: 'Salle de contrôle', icon: 'alert', group: 'pilotage', roles: ['R17', 'R18', 'R05', 'R15', 'R01', 'R22', 'R23'] } },
  { path: '/decision/audit', element: lazyPage(() => import('./decision/AuditInvestigation')), nav: { label: 'Audit et investigation', short: 'Audit', icon: 'shieldCheck', group: 'pilotage', roles: ['R22', 'R23', 'R24'] } },
  { path: '/decision/previsions', element: lazyPage(() => import('./decision/Finances').then((m) => ({ default: m.PrevisionTresorerie }))), nav: { label: 'Prévision de trésorerie hebdomadaire', short: 'Prévision', icon: 'analysis', group: 'pilotage', roles: ['R01', 'R02', 'R03', 'R05', 'R06', 'R07', 'R15', 'R17', 'R18', 'R22', 'R23'] } },
  { path: '/acces/delegations', element: lazyPage(() => import('./acces/Delegations')), nav: { label: 'Accès et délégations', short: 'Délégations', icon: 'users', group: 'operations', roles: ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R11', 'R12', 'R13', 'R14', 'R15', 'R16', 'R18', 'R20', 'R21', 'R22', 'R23', 'R24', 'R26', 'R28'] } },
  { path: '/plateforme/partenaires', element: lazyPage(() => import('./plateforme/Plateforme').then((m) => ({ default: m.Partenaires }))), nav: { label: 'Intégration et API partenaires', short: 'API partenaires', icon: 'sync', group: 'operations', roles: ['R26', 'R27', 'R28', 'R25', 'R22', 'R23'] } },
  { path: '/plateforme/administration', element: lazyPage(() => import('./plateforme/Plateforme').then((m) => ({ default: m.Administration }))), nav: { label: 'Administration de la plateforme', short: 'Administration', icon: 'grid', group: 'operations', roles: ['R26', 'R27', 'R28', 'R22', 'R23'] } },
  { path: '/plateforme/supervision', element: lazyPage(() => import('./plateforme/Plateforme').then((m) => ({ default: m.SupervisionSante }))), nav: { label: 'Supervision et santé du système', short: 'Supervision', icon: 'gauge', group: 'operations', roles: ['R26', 'R27', 'R28', 'R22'] } },
  // Trousse de visualisation (27/09/2026) : galerie des composants de graphiques, données réelles sinon [EXEMPLE] (rôles internes).
  { path: '/visualisation/galerie', element: lazyPage(() => import('./plateforme/GalerieVisualisation')), nav: { label: 'Galerie de visualisation', short: 'Graphiques', icon: 'chart', group: 'pilotage', roles: DASH } },
  { path: '/grands-redevables', element: lazyPage(() => import('./verticales/GrandsRedevables')), nav: { label: 'Grands redevables', short: 'Grands redevables', icon: 'building', group: 'operations', roles: ['R06', 'R07', 'R11', 'R01', 'R02', 'R05', 'R22', 'R23', 'R24'] } },
  { path: '/terrain/equipements', element: lazyPage(() => import('./terrain/Equipements')), nav: { label: 'Équipements terrain (terminaux)', short: 'Terminaux', icon: 'phone', group: 'operations', roles: ['R28', 'R08', 'R09', 'R06', 'R22', 'R24', 'R26'] } },
  { path: '/apprentissage/procedures', element: lazyPage(() => import('./apprentissage/Procedures')), nav: { label: 'Base de procédures', short: 'Procédures', icon: 'file', group: 'operations', roles: [] } },

  // IA : liens directs
  { path: '/ia/autonomie', element: lazyPage(() => import('./ia/AutonomyPage')) },
  { path: '/ia/memoire', element: lazyPage(() => import('./ia/MemoryPage')) },
  { path: '/ia/journal', element: lazyPage(() => import('./ia/JournalPage')), nav: { label: 'Journal IA', short: 'Journal IA', icon: 'history', group: 'pilotage', roles: ['R22', 'R23', 'R25', 'R29'] } },
  { path: '/ia/modeles', element: lazyPage(() => import('./ia/ModelesPage')), nav: { label: 'Registre des modèles d’IA', short: 'Modèles IA', icon: 'analysis', group: 'pilotage', roles: ['R26', 'R29'] } }, // Décision du 29/09/2026 : menu réservé à l’administration (R26, R29) ; lectures d’audit, DPD et sécurité inchangées côté serveur
];
