/**
 * Catalogue des API — noyau de 20 routes du Cahier (chapitre 31 ; § 30.2 du document maître v3.0), routes en français.
 *
 * Chaque route française est une route RÉELLE qui relaie vers la route canonique déjà construite (convention retenue
 * ARB-43, annexe H.16.4) : même gestionnaire, mêmes contrôles d'accès, même idempotence, même audit. Les routes
 * canoniques restent inchangées ; les deux noms coexistent (règle n° 1 : on ajoute, on ne retire rien).
 * Colonnes « objet », « acteur autorisé » et « contrôles » : texte du Cahier, repris tel quel.
 */

export interface CatalogueApiRow {
  numero: number;
  methode: 'GET' | 'POST';
  /** Route française du Cahier (paramètres au format Fastify « :id »). */
  routeFr: string;
  objet: string;
  acteurAutorise: string;
  controles: string;
  /** Route canonique relayée (déjà construite). */
  routeCanonique: string;
  /** Particularités du relais (paramètre passé dans le corps, en-tête, filtre ajouté…). */
  relais: string;
}

export const CATALOGUE_REFERENCE = 'Cahier des exigences, chapitre 31 « Catalogue des API » (document maître v3.0 : § 30.2 ; correspondance : annexe H.16.4)';

export const CATALOGUE_API: readonly CatalogueApiRow[] = [
  {
    numero: 1, methode: 'POST', routeFr: '/v1/comptes', objet: 'Créer un compte', acteurAutorise: 'Public',
    controles: 'Vérification téléphone, anti-doublon, journal', routeCanonique: 'POST /v1/registrations',
    relais: 'Corps relayé à l’identique.',
  },
  {
    numero: 2, methode: 'POST', routeFr: '/v1/identites/verification', objet: 'Élever le niveau de vérification', acteurAutorise: 'Contribuable, agent',
    controles: 'Pièces, double validation N3',
    routeCanonique: 'POST /v1/acces/identity/:id/otp · POST /v1/acces/identity/:id/otp/verify · POST /v1/acces/identity/:id/proofs · POST /v1/acces/identity-proofs/:id/review',
    relais: 'Champ « etape » : ENVOI_CODE, VERIFICATION_CODE, PIECE (contribuable dans « taxpayerId ») ou CONTROLE (« proofId ») ; le contrôle d’une pièce est fait par une personne distincte de celle qui l’a saisie.',
  },
  {
    numero: 3, methode: 'POST', routeFr: '/v1/objets', objet: 'Déclarer un objet', acteurAutorise: 'Contribuable, agent',
    controles: 'Géolocalisation, catégorie, preuve', routeCanonique: 'POST /v1/fiscal-objects', relais: 'Corps relayé à l’identique.',
  },
  {
    numero: 4, methode: 'POST', routeFr: '/v1/baux', objet: 'Déclarer un bail', acteurAutorise: 'Bailleur, locataire',
    controles: 'Cohérence loyer, unité, période', routeCanonique: 'POST /v1/leases', relais: 'Corps relayé à l’identique.',
  },
  {
    numero: 5, methode: 'GET', routeFr: '/v1/objets/:id/obligations', objet: 'Obligations applicables', acteurAutorise: 'Contribuable, agent habilité',
    controles: 'Filtrage par rôle et territoire', routeCanonique: 'GET /v1/obligations?objectId=:id',
    relais: 'Filtre « objectId » ajouté à la route canonique ; refus explicite sans droit sur l’objet, puis filtrage par rôle et territoire de chaque obligation.',
  },
  {
    numero: 6, methode: 'POST', routeFr: '/v1/liquidations/simulation', objet: 'Simuler une liquidation', acteurAutorise: 'Contribuable, agent',
    controles: 'Règle publiée uniquement', routeCanonique: 'POST /v1/assessments/calculate (simulate: true)',
    relais: 'Mode simulation imposé (jamais d’obligation créée) ; règle refusée (422 RULE_NOT_PUBLISHED) si elle n’est pas ACTIVE et en vigueur.',
  },
  {
    numero: 7, methode: 'POST', routeFr: '/v1/regles', objet: 'Proposer une règle', acteurAutorise: 'Juriste',
    controles: 'Interdiction de créer, valider et publier par la même personne', routeCanonique: 'POST /v1/legal-rules', relais: 'Corps relayé à l’identique.',
  },
  {
    numero: 8, methode: 'POST', routeFr: '/v1/regles/:id/publication', objet: 'Publier une règle', acteurAutorise: 'Approbateur',
    controles: 'Quatre yeux, texte légal obligatoire', routeCanonique: 'POST /v1/legal-rules/:id/approve',
    relais: 'Corps { role } relayé à l’identique : quatre visas par quatre personnes distinctes ; la règle devient ACTIVE au dernier visa.',
  },
  {
    numero: 9, methode: 'POST', routeFr: '/v1/paiements/ordres', objet: 'Créer un ordre de paiement', acteurAutorise: 'Contribuable',
    controles: 'Idempotence, référence unique, expiration', routeCanonique: 'POST /v1/obligations/:id/payment-orders',
    relais: 'Obligation dans le corps (« obligationId ») ; en-tête Idempotency-Key relayé (rejeu ⇒ même ordre).',
  },
  {
    numero: 10, methode: 'POST', routeFr: '/v1/paiements/callback', objet: 'Confirmation prestataire', acteurAutorise: 'Partenaire agréé',
    controles: 'Signature, anti-rejeu, vérification serveur', routeCanonique: 'POST /v1/providers/:provider/callbacks',
    relais: 'Prestataire dans l’en-tête X-Provider (ou le champ « provider » du corps) ; corps brut relayé octet pour octet : la signature et l’anti-rejeu sont vérifiés par la route canonique.',
  },
  {
    numero: 11, methode: 'POST', routeFr: '/v1/reglements/import', objet: 'Relevé de compte public', acteurAutorise: 'Trésorerie, banque',
    controles: 'Contrôle d’intégrité, double validation', routeCanonique: 'POST /v1/settlements/statements', relais: 'Corps relayé à l’identique.',
  },
  {
    numero: 12, methode: 'GET', routeFr: '/v1/rapprochements/exceptions', objet: 'Files d’exception', acteurAutorise: 'Trésorerie, contrôle interne',
    controles: 'Lecture seule, journalisée', routeCanonique: 'GET /v1/reconciliation/exceptions', relais: 'Lecture seule.',
  },
  {
    numero: 13, methode: 'GET', routeFr: '/v1/quittances/:ref/verification', objet: 'Vérifier une quittance', acteurAutorise: 'Public',
    controles: 'Divulgation minimale', routeCanonique: 'GET /v1/public/receipts/:code',
    relais: 'Même résultat minimal et même limitation par poste (anti-énumération).',
  },
  {
    numero: 14, methode: 'POST', routeFr: '/v1/missions/synchronisation', objet: 'Synchroniser le terrain', acteurAutorise: 'Agent',
    controles: 'Appareil enregistré, résolution de conflits', routeCanonique: 'POST /v1/field-sync/batches',
    relais: 'Corps brut relayé octet pour octet : signature du terminal (x-device-signature) vérifiée par la route canonique.',
  },
  {
    numero: 15, methode: 'POST', routeFr: '/v1/constats', objet: 'Enregistrer un constat', acteurAutorise: 'Agent habilité',
    controles: 'GPS, photo, horodatage, géorepérage', routeCanonique: 'POST /v1/terrain/missions/:id/findings',
    relais: 'Mission dans le corps (« missionId ») ; le reste du corps est le constat de la route canonique.',
  },
  {
    numero: 16, methode: 'POST', routeFr: '/v1/recours', objet: 'Introduire une contestation', acteurAutorise: 'Contribuable',
    controles: 'Délai légal, accusé de réception', routeCanonique: 'POST /v1/appeals', relais: 'Corps relayé à l’identique.',
  },
  {
    numero: 17, methode: 'GET', routeFr: '/v1/alertes-fraude', objet: 'Consulter les alertes', acteurAutorise: 'Enquêteur, audit',
    controles: 'Aucune action automatique', routeCanonique: 'GET /v1/integrite/alerts (ou GET /v1/security/alerts avec ?source=securite)',
    relais: 'Lecture seule ; filtre facultatif « status » ; les alertes impliquant le lecteur lui restent masquées.',
  },
  {
    numero: 18, methode: 'GET', routeFr: '/v1/tableaux/:profil', objet: 'Données de tableau de bord', acteurAutorise: 'Selon rôle',
    controles: 'Agrégation conforme au périmètre', routeCanonique: 'GET /v1/tableaux/:profil (alias existant de GET /v1/pilotage/tableaux/:profil)',
    relais: 'Route déjà construite par le module « pilotage ».',
  },
  {
    numero: 19, methode: 'GET', routeFr: '/v1/previsions', objet: 'Scénarios de recettes', acteurAutorise: 'Direction, Gouverneur',
    controles: 'Hypothèses jointes', routeCanonique: 'GET /v1/pilotage/scenarios', relais: 'Mêmes filtres (commune, catégorie, entité, canal, période).',
  },
  {
    numero: 20, methode: 'POST', routeFr: '/v1/affectations/scenarios', objet: 'Générer des scénarios d’affectation', acteurAutorise: 'Finances',
    controles: 'Aucune exécution de dépense', routeCanonique: 'POST /v1/pilotage/projets/recommandations',
    relais: 'Corps relayé à l’identique : scénarios PROPOSÉS, décision par l’autorité budgétaire, aucune dépense exécutée.',
  },
];
