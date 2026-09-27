/**
 * Parcours de bout en bout des verticales (Spécification fonctionnelle des modules, Partie V).
 *
 * « Chaque verticale assemble des modules du socle. Elle ne possède ni compte contribuable, ni règles hors registre,
 * ni circuit de paiement propres (§ 11.1). » Chaque étape du parcours renvoie à l'écran réel qui la sert et à la route
 * de l'API qui l'exécute : la verticale n'est qu'un assemblage lisible des mêmes circuits (compte unique, registre des
 * règles, ordre de paiement vers le compte public, quittance, titre, contrôle, rapprochement).
 *
 * Chaque parcours est exercé de bout en bout par `backend/test/verticales-bout-en-bout.test.ts` (une verticale = un test),
 * avec des règles de DÉMONSTRATION [EXEMPLE] publiées par les quatre visas lorsque la verticale le permet.
 */

export interface EtapeParcours {
  rang: number;
  /** Libellé de l'étape (Partie V). */
  label: string;
  /** Modules du catalogue mobilisés par l'étape. */
  modules: number[];
  /** Écran de la plateforme qui sert l'étape (chemin de l'application web). */
  ecran: string;
  /** Route principale de l'API qui exécute l'étape. */
  route: string;
  /** Garde juridique propre à l'étape (acte requis, cadrage) : l'étape reste visible mais ne produit aucun montant. */
  garde?: string;
}

export interface ParcoursVerticale {
  /** Nom de la verticale dans la Partie V (nom de marque, affiché en second). */
  nomPartieV: string;
  finalite: string;
  modules: number[];
  etapes: EtapeParcours[];
  reglesPropres: string[];
}

const e = (rang: number, label: string, modules: number[], ecran: string, route: string, garde?: string): EtapeParcours => ({ rang, label, modules, ecran, route, ...(garde ? { garde } : {}) });

export const PARCOURS: Record<string, ParcoursVerticale> = {
  propriete: {
    nomPartieV: 'MOSOLO Property', finalite: 'Connaître chaque parcelle, bâtiment et unité, et son statut juridique et fiscal.', modules: [7, 8, 9, 79],
    etapes: [
      e(1, 'Recensement de la parcelle et de ses bâtiments, géolocalisation et identifiant', [34, 8], '/fiscal/recensement', 'POST /v1/fiscal-objects'),
      e(2, 'Rattachement du propriétaire avec preuve', [7], '/fiscal/biens', 'POST /v1/fiscal/relationships'),
      e(3, 'Pose de la plaque NFIU', [79], '/verticales/console', 'POST /v1/verticales/plates'),
      e(4, 'Liquidation de l’impôt foncier sur règle publiée', [26, 27], '/fiscal/declarations', 'POST /v1/assessments/calculate'),
      e(5, 'Paiement, quittance et statut « payé » visible au scan', [28, 31, 71], '/verifier-plaque', 'GET /v1/public/verticales/plates/:code'),
    ],
    reglesPropres: [
      'Distinction propriété déclarée, observée, vérifiée, contestée.',
      'Blocage des mutations sans quitus.',
      'Requalification bâti / non bâti après visite.',
    ],
  },
  locatif: {
    nomPartieV: 'MOSOLO Rental', finalite: 'Faire émerger l’assiette locative, premier gisement de Kinshasa.', modules: [9, 79],
    etapes: [
      e(1, 'Signal de location probable (compteurs, indemnités, imagerie) → dossier de vérification', [61], '/fiscal/anomalies-locatives', 'GET /v1/fiscal/anomalies'),
      e(2, 'Déclaration du bail par le locataire ou le bailleur', [9], '/fiscal/baux', 'POST /v1/leases'),
      e(3, 'Calcul de la retenue et de l’IRL', [9, 27], '/fiscal/declarations', 'POST /v1/fiscal/declarations'),
      e(4, 'Attestation de bail enregistré au locataire', [9], '/fiscal/baux', 'POST /v1/fiscal/leases/:id/attestations'),
      e(5, 'Campagne préremplie de février et rapprochement annuel', [32, 9], '/recouvrement/campagnes', 'POST /v1/campagnes/:id/pre-remplissage'),
    ],
    reglesPropres: [
      'Aucune dette sur simple signal.',
      'Taux et retenue par rang de localité.',
      'Élargissement 2026 de l’assiette.',
    ],
  },
  entreprises: {
    nomPartieV: 'MOSOLO Business', finalite: 'Relier chaque entreprise et établissement à ses activités, autorisations et obligations.', modules: [10, 17, 56],
    etapes: [
      e(1, 'Enregistrement de l’établissement et de ses dirigeants', [10, 7], '/services/entreprises', 'POST /v1/verticales/entreprises/cases'),
      e(2, 'Détermination des obligations par activité, lieu et catégorie', [10, 26], '/verticales/console', 'GET /v1/verticales/entreprises/etablissements/:objectId/obligations'),
      e(3, 'Patente et autorisations avec QR « en règle »', [10], '/verifier-plaque', 'GET /v1/public/verticales/certificates/:code'),
      e(4, 'Recoupement Mobile Money, livraisons brassicoles, RCCM', [17, 61], '/opportunites/recoupement', 'POST /v1/verticales/secteurs/donnees-tierces'),
      e(5, 'Suivi des grands redevables', [56], '/verticales/secteurs', 'POST /v1/verticales/secteurs/grands-redevables'),
    ],
    reglesPropres: ['L’existence d’une activité n’emporte pas assujettissement : la règle décide.'],
  },
  mobilite: {
    nomPartieV: 'MOSOLO Mobility', finalite: 'Gérer véhicules, autorisations de transport et péages sur l’objet véhicule.', modules: [11, 12, 25, 76],
    etapes: [
      e(1, 'Import du registre des immatriculations', [11], '/fiscal/reprise', 'POST /v1/fiscal-objects'),
      e(2, 'Vignette et taxe de circulation', [11], '/services/mobilite', 'POST /v1/verticales/mobilite/objects/:objectId/liquidate'),
      e(3, 'Autorisations de transport et taxe journalière', [12, 76], '/verticales/console', 'POST /v1/verticales/mobilite/cases'),
      e(4, 'Péage lié à la plaque', [25], '/verticales/secteurs', 'POST /v1/verticales/secteurs/25/releves', 'Acte requis (J1) : types de titres de péage non activables'),
      e(5, 'Contrôle par plaque en ligne et hors ligne', [11, 70], '/titres/controle', 'GET /v1/verticales/vehicules/:plaque/controle'),
    ],
    reglesPropres: ['Mutations conditionnées au quitus lorsque la règle l’exige.', 'Aucune immobilisation automatique.'],
  },
  stationnement: {
    nomPartieV: 'MOSOLO Parking', finalite: 'Faire du stationnement une recette quotidienne et une discipline urbaine.', modules: [14, 75, 76],
    etapes: [
      e(1, 'Délimitation des zones (Gombe, artères)', [14, 75], '/stationnement/regie', 'POST /v1/parking/zones'),
      e(2, 'Achat ou prolongation d’un ticket lié à la plaque', [75, 76], '/stationnement', 'POST /v1/parking/sessions'),
      e(3, 'Rappel ambre avant expiration', [70, 75], '/stationnement', 'GET /v1/parking/sessions/mine'),
      e(4, 'Contrôle par plaque ou caméra', [70, 75], '/stationnement/controle', 'GET /v1/parking/control/:plate'),
      e(5, 'Constat réglementaire et recours', [75, 22], '/stationnement/controle', 'POST /v1/parking/violations'),
    ],
    reglesPropres: ['Tarification dynamique.', 'Réservations de voirie.', 'Surréservation seulement après validation juridique.'],
  },
  publicite: {
    nomPartieV: 'MOSOLO Advertising', finalite: 'Connaître chaque support publicitaire et sécuriser ses droits.', modules: [15, 77],
    etapes: [
      e(1, 'Recensement et plaque QR', [15], '/publicite', 'POST /v1/publicite/devices'),
      e(2, 'Autorisation et liquidation', [15, 27], '/publicite/regie', 'POST /v1/publicite/authorizations/:id/decide'),
      e(3, 'Contrôle avec OCR et preuve', [77], '/publicite/inspection', 'POST /v1/publicite/inspections'),
      e(4, 'Dossier de constat, validation, notification', [77], '/publicite/inspection', 'POST /v1/publicite/cases/:id/decide'),
      e(5, 'Paiement officiel et régularisation', [28, 77], '/publicite', 'POST /v1/obligations/:id/payment-orders'),
    ],
    reglesPropres: ['Le contrôleur constate, l’autorité décide.', 'Badge vérifiable par les exploitants.'],
  },
  telecom: {
    nomPartieV: 'MOSOLO Telecom', finalite: 'Liquider les sites d’antennes des opérateurs.', modules: [16, 56],
    etapes: [
      e(1, 'Import des listes de sites', [16], '/services/telecom', 'POST /v1/verticales/telecom/cases'),
      e(2, 'Rapprochement sites déclarés / observés', [16], '/verticales/console', 'GET /v1/verticales/telecom/reconciliation'),
      e(3, 'Avis annuel automatique', [16, 27], '/verticales/secteurs', 'POST /v1/verticales/secteurs/antennes/liquidation-annuelle'),
      e(4, 'Suivi par la cellule grands redevables', [56], '/verticales/secteurs', 'POST /v1/verticales/secteurs/grands-redevables'),
    ],
    reglesPropres: ['Peu de redevables, rendement élevé.', 'Données opérateurs sous protocole.'],
  },
  marches: {
    nomPartieV: 'MOSOLO Markets', finalite: 'Numériser les marchés et les étals.', modules: [20, 76],
    etapes: [
      e(1, 'Plan géoréférencé du marché', [20], '/services/marches', 'GET /v1/verticales/marches/plan'),
      e(2, 'Titre d’étal journalier, hebdomadaire ou mensuel', [20, 76], '/services/marches', 'POST /v1/verticales/marches/stalls/:id/titles'),
      e(3, 'Plaque QR d’étal', [20, 71], '/verifier-plaque', 'POST /v1/verticales/plates'),
      e(4, 'Contrôle sans téléphone du commerçant', [70], '/verticales/console', 'GET /v1/verticales/plates/:code/scan'),
    ],
    reglesPropres: ['Aucun encaissement par le placier.'],
  },
  'domaine-public': {
    nomPartieV: 'MOSOLO Public Domain', finalite: 'Gérer emprises et occupations temporaires ou permanentes.', modules: [19, 20],
    etapes: [
      e(1, 'Demande d’occupation', [19], '/services/domaine-public', 'POST /v1/verticales/domaine-public/cases'),
      e(2, 'Titre à durée', [19, 76], '/verticales/console', 'POST /v1/verticales/cases/:id/decide'),
      e(3, 'Contrôle', [70], '/verticales/console', 'GET /v1/verticales/plates/:code/scan'),
      e(4, 'Renouvellement ou libération', [19], '/services/domaine-public', 'POST /v1/verticales/domaine-public/cases'),
    ],
    reglesPropres: ['Rattachement aux objets existants, sans recensement supplémentaire.'],
  },
  environnement: {
    nomPartieV: 'MOSOLO Environment', finalite: 'Préparer et gérer les recettes environnementales.', modules: [18, 19],
    etapes: [
      e(1, 'Registre des assujettis', [18], '/services/environnement', 'GET /v1/verticales/environnement/registre'),
      e(2, 'Simulation d’impact', [18, 26], '/verticales/console', 'POST /v1/verticales/environnement/simulations'),
      e(3, 'Activation après édit', [18, 26], '/registre', 'POST /v1/legal-rules/:id/approve', 'Acte requis (J15, J16) : désactivé tant qu’aucun édit n’est publié'),
      e(4, 'Déclarations et reversements', [18, 28], '/services/environnement', 'POST /v1/verticales/environnement/objects/:objectId/liquidate'),
    ],
    reglesPropres: ['Désactivé tant qu’aucun édit n’est publié.'],
  },
  ports: {
    nomPartieV: 'MOSOLO Ports', finalite: 'Tracer embarcations, quais et départs.', modules: [13, 24],
    etapes: [
      e(1, 'Registre des embarcations et quais', [24], '/services/ports', 'POST /v1/verticales/ports/cases'),
      e(2, 'Titre d’embarquement à usage unique', [13, 76], '/titres/catalogue', 'GET /v1/titres/types', 'Cadrage sectoriel requis (J30) : type EMB-CARTE non activable'),
      e(3, 'Manifestes', [13, 24], '/services/ports', 'POST /v1/verticales/ports/cases'),
      e(4, 'Rapprochement mouvements / titres / paiements', [24, 52], '/verticales/secteurs', 'POST /v1/verticales/secteurs/24/releves'),
    ],
    reglesPropres: ['Pilote après cadrage sectoriel.'],
  },
  avia: {
    nomPartieV: 'MOSOLO AVIA', finalite: 'Intégrer la Ville dans la chaîne de données aériennes.', modules: [62, 78],
    etapes: [
      e(1, 'Connexion BSP/GDS et portail agences', [78], '/verticales/console', 'POST /v1/verticales/avia/rrh/connectors/:code/pull'),
      e(2, 'IFA dans le QR de la carte d’embarquement', [78], '/verticales/console', 'POST /v1/public/verticales/avia/ifa/verify'),
      e(3, 'Scan RVA et validation DGM', [78], '/verticales/console', 'POST /v1/verticales/avia/rrh/passenger-events'),
      e(4, 'Rapprochement mensuel', [52, 78], '/verticales/console', 'POST /v1/verticales/avia/rrh/reconciliations'),
      e(5, 'Facturation des écarts', [62, 78], '/verticales/console', 'POST /v1/verticales/avia/auto/run', 'Mesures contraignantes seulement après arrêté (J23, D21) : avant, proposition ; après, facturation ou compensation automatique, contradictoire maintenu'),
    ],
    reglesPropres: ['Mesures contraignantes seulement après arrêté.', 'Aucune interférence avec Go-Pass.'],
  },
  evenements: {
    nomPartieV: 'MOSOLO Events', finalite: 'Encadrer les événements et leur billetterie.', modules: [21, 76],
    etapes: [
      e(1, 'Demande d’autorisation', [21], '/services/evenements', 'POST /v1/verticales/evenements/cases'),
      e(2, 'Déclaration de billetterie', [21, 76], '/services/evenements', 'POST /v1/verticales/evenements/events/:objectId/ticketing'),
      e(3, 'Certificat QR sur le lieu', [21, 71], '/verifier-plaque', 'GET /v1/public/verticales/certificates/:code'),
      e(4, 'Liquidation et contrôle', [21, 27, 70], '/verticales/console', 'POST /v1/verticales/evenements/objects/:objectId/liquidate'),
    ],
    reglesPropres: ['Autorisation refusée sans enregistrement.'],
  },
  construction: {
    nomPartieV: 'MOSOLO Construction', finalite: 'Suivre carrières, chantiers et droits de voirie.', modules: [19, 22],
    etapes: [
      e(1, 'Géoréférencement des sites', [22, 8], '/services/construction', 'POST /v1/verticales/construction/cases'),
      e(2, 'Bons de sortie à usage unique', [22, 76], '/verticales/secteurs', 'POST /v1/verticales/secteurs/22/releves', 'Base légale des carrières à certifier (J1) : bon de sortie non activable'),
      e(3, 'Droits de voirie des chantiers', [19, 27], '/verticales/console', 'POST /v1/verticales/construction/objects/:objectId/liquidate'),
      e(4, 'Quitus pour les permis de bâtir', [82], '/verticales/console', 'POST /v1/verticales/construction/cases'),
    ],
    reglesPropres: ['Écart sorties / déclarations suivi mensuellement.'],
  },
  actifs: {
    nomPartieV: 'MOSOLO Assets', finalite: 'Valoriser le patrimoine provincial.', modules: [48, 61],
    etapes: [
      e(1, 'Inventaire des actifs', [48], '/verticales/actifs', 'POST /v1/verticales/actifs/inventaire'),
      e(2, 'Évaluation', [48], '/verticales/actifs', 'POST /v1/verticales/actifs/inventaire/:id/evaluations'),
      e(3, 'Appel public ou délibération', [48, 61], '/verticales/actifs', 'POST /v1/verticales/actifs/appels'),
      e(4, 'Suivi des revenus domaniaux', [48, 52], '/verticales/actifs', 'GET /v1/verticales/actifs/revenus'),
    ],
    reglesPropres: ['Aucune attribution de gré à gré sans procédure.'],
  },
  rakapay: {
    nomPartieV: 'MOSOLO Billetterie et moto-taxis (RakaPay)', finalite: 'Vendre et contrôler tous les droits d’accès urbains à durée, avec comme premier cas d’usage le pass des plus d’un million de wewa de Kinshasa.', modules: [12, 14, 20, 25, 76, 81],
    etapes: [
      e(1, 'Opérateurs invités et accrédités (communes, exploitants, coopératives de wewa)', [76], '/rakapay/operateurs', 'POST /v1/rakapay/operateurs/candidatures'),
      e(2, 'Tickets à durée : stationnement, marchés, transport, taxe journalière, pass wewa', [76, 81], '/titres/catalogue', 'GET /v1/rakapay/catalogue'),
      e(3, 'Achat par application, USSD, coopérative ou point agréé ; SMS de secours', [76, 81, 66], '/services/rakapay', 'POST /v1/rakapay/wewa/passes'),
      e(4, 'Contrôle par QR, gilet ou plaque, en ligne ou hors ligne ; vérification par le passager', [70, 81], '/titres/controle', 'POST /v1/rakapay/wewa/controles'),
      e(5, 'Analyse quotidienne pour l’opérateur, audit comportemental et blocage préventif par la supervision', [76], '/rakapay/pilotage', 'GET /v1/rakapay/indicateurs'),
    ],
    reglesPropres: ['Espèces uniquement via point agréé.', 'Aucune demande de paiement à une moto en vert.', 'Ventes des opérateurs privés séparées des recettes publiques.'],
  },
  recouvrement: {
    nomPartieV: 'MOSOLO Recovery', finalite: 'Recouvrer équitablement et au meilleur rendement net.', modules: [32, 33, 36],
    etapes: [
      e(1, 'Segmentation des arriérés', [32], '/recouvrement', 'GET /v1/recouvrement/arrieres'),
      e(2, 'Campagnes graduées', [32, 33], '/recouvrement', 'POST /v1/recouvrement/dossiers/:id/propositions'),
      e(3, 'Plans d’apurement autorisés', [33], '/mes-arrieres', 'POST /v1/recouvrement/echeanciers'),
      e(4, 'Mesures légales et clôture', [36], '/recouvrement', 'POST /v1/recouvrement/propositions/:id/decision'),
    ],
    reglesPropres: ['Proportionnalité et recours : aucune mesure sans décision humaine motivée.'],
  },
};
