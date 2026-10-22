/**
 * Articles du blog public (22/10/2026) — un article par fonctionnalité, pour convaincre : atout distinctif (« ce qui
 * la rend unique »), problème, réponse, atouts, publics, lien vers l'écran. RÈGLE : uniquement des garanties réellement
 * appliquées par la plateforme (annexe I) ; toute valeur non confirmée est signalée dans `aConfirmer`.
 */

export type Categorie = 'usagers' | 'paiement' | 'terrain' | 'secteurs' | 'pilotage' | 'confiance';

export const CATEGORIES: Record<Categorie, string> = {
  usagers: 'Pour les contribuables',
  paiement: 'Paiement et argent public',
  terrain: 'Terrain et contrôle',
  secteurs: 'Recettes par secteur',
  pilotage: 'Pilotage et décision',
  confiance: 'Confiance, sécurité et transparence',
};

export interface Article {
  slug: string;
  categorie: Categorie;
  titre: string;
  /** Une phrase qui donne envie de lire. */
  accroche: string;
  /** L'atout distinctif, en une ou deux phrases. */
  usp: string;
  probleme: string[];
  solution: string[];
  atouts: string[];
  pourQui: string[];
  /** Réserve honnête : valeurs « à confirmer », éléments externes ou non encore en service. */
  aConfirmer?: string;
  lien: { to: string; label: string };
}

export const ARTICLES: Article[] = [
  // ------------------------------------------------------------------------------------------------ usagers
  {
    slug: 'compte-unique',
    categorie: 'usagers',
    titre: 'Un seul compte pour tout',
    accroche: 'Une personne, un compte : vos biens, vos véhicules, vos commerces et toutes vos démarches au même endroit.',
    usp: 'Une personne = un compte, pour tous les services de la Ville. Vos biens et vos occupations sont reliés par des liens datés et vérifiés — jamais deviné à partir d’un nom ou d’un numéro de téléphone.',
    probleme: [
      'Aujourd’hui, un même Kinois a un dossier par service, souvent sur papier, parfois en double. Personne n’a la vue d’ensemble : ni lui, ni l’administration.',
      'Résultat : des démarches répétées, des erreurs d’identité, et des biens qui échappent à l’impôt parce qu’ils ne sont rattachés à personne.',
    ],
    solution: [
      'Avec MOSOLO, chaque personne a un compte unique. Les biens, les unités et les occupations restent des fiches distinctes, reliées au compte par des relations datées : propriétaire, copropriétaire, locataire, occupant, gestionnaire ou exploitant.',
      'Déclarer « je suis propriétaire » ou « je suis locataire » ouvre une demande, jamais un lien automatique. Le rapprochement se fait sur l’identifiant du bien, le GPS, l’adresse et le numéro d’unité, puis il est confirmé (invitation acceptée par l’autre partie, preuve, ou agent habilité). L’historique est conservé : qui occupait quelle unité, et quand.',
    ],
    atouts: [
      'Un seul identifiant pour tous les services de la Ville.',
      'Aucun lien automatique : chaque relation est confirmée, et une contestation ouvre une revue.',
      'Aucune donnée privée de l’autre partie n’est révélée avant vérification.',
      'Le lien sert les démarches et la fiscalité — jamais l’accès au compte d’un autre.',
    ],
    pourQui: ['Propriétaires, locataires et commerçants', 'Services fiscaux, qui voient enfin qui occupe quoi'],
    lien: { to: '/inscription', label: 'Créer mon compte' },
  },
  {
    slug: 'mon-espace-a-faire',
    categorie: 'usagers',
    titre: '« Mon espace » : tout ce qui vous concerne, en un seul endroit',
    accroche: 'Ce que vous devez faire, ce qui est en cours de vérification, ce qui est à jour : une ligne, une action.',
    usp: 'L’usager n’a rien à vérifier lui-même : le bloc « À faire » lui dit exactement quoi faire, et chaque bouton mène directement au paiement de la bonne échéance, dans le moyen choisi.',
    probleme: [
      'Payer ses impôts et redevances à Kinshasa, c’est souvent chercher le bon bureau, la bonne somme et la bonne personne — sans jamais savoir si l’on est en règle.',
    ],
    solution: [
      'Dans « Mon espace », un seul bloc « À faire » classe tout en trois groupes : à faire maintenant, en cours de vérification par l’administration, à jour.',
      'Chaque ligne a une seule action. Un clic sur « Payer » ouvre le paiement de cet élément précis ; le menu de l’usager ne contient aucun outil d’agent et aucun lien vers une page réservée.',
    ],
    atouts: [
      'Trois états simples, compris par tous.',
      'Une action par ligne, sans formulaire inutile.',
      'Aucun lien mort, aucune page « accès refusé » proposée à l’usager.',
    ],
    pourQui: ['Tous les contribuables, particuliers et entreprises'],
    lien: { to: '/inscription', label: 'Ouvrir mon espace' },
  },
  {
    slug: 'mes-preuves',
    categorie: 'usagers',
    titre: '« Mes preuves » en un clic',
    accroche: 'Un contrôle ? Montrez votre preuve en un clic : un code QR que l’agent vérifie instantanément.',
    usp: 'Chaque preuve (quittance, titre, pass, vignette) porte un code QR vérifiable par le résolveur universel de la Ville — par téléphone, SMS, WhatsApp, version légère ou sur papier.',
    probleme: [
      'Lors d’un contrôle, le contribuable doit souvent fouiller ses papiers, et l’agent n’a aucun moyen sûr de savoir si un reçu est authentique. C’est la porte ouverte aux arrangements.',
    ],
    solution: [
      'Le bouton « Mes preuves » est présent dans l’en-tête, dans « Mon espace » et dans le menu. Chaque preuve s’affiche avec son code QR.',
      'L’usager ne vérifie pas les agents : un agent n’agit qu’après invitation sur la plateforme. Les preuves restent lisibles même sans smartphone, par SMS, WhatsApp, une version légère ou une impression.',
    ],
    atouts: [
      'Une preuve présentée en un clic, sur tous les canaux.',
      'Un QR vérifiable par n’importe qui sur la page publique de vérification.',
      'Moins de discussion, moins de tentation : la preuve parle d’elle-même.',
    ],
    pourQui: ['Conducteurs, commerçants, propriétaires', 'Agents de contrôle'],
    aConfirmer: 'Dans la démonstration, les envois par SMS et WhatsApp sont simulés : leur raccordement réel dépend des conventions avec les opérateurs.',
    lien: { to: '/verifier', label: 'Vérifier une preuve' },
  },
  {
    slug: 'canaux-pour-tous',
    categorie: 'usagers',
    titre: 'Accessible à tous : USSD, serveur vocal, enrôlement assisté, traduction',
    accroche: 'Pas de smartphone ? Pas de problème. MOSOLO parle à chaque Kinois, par le canal qu’il a.',
    usp: 'Une même démarche est possible par l’application, l’USSD, le serveur vocal, l’enrôlement assisté ou un point de paiement agréé — et l’écran se traduit automatiquement, la version française faisant foi.',
    probleme: [
      'Une plateforme réservée aux détenteurs de smartphone laisse de côté une grande partie de la population — et autant de recettes.',
    ],
    solution: [
      'MOSOLO propose plusieurs canaux pour les mêmes démarches : application web installable, USSD, serveur vocal (SVI), enrôlement assisté par un agent et points de paiement agréés.',
      'L’écran peut être traduit automatiquement ; la mention « la version française fait foi » protège l’usager comme l’administration.',
    ],
    atouts: [
      'Inclusion réelle : chaque canal mène au même compte et aux mêmes règles.',
      'Des points de paiement agréés listés publiquement (« Où payer ? »).',
      'Traduction de l’écran entier, sans changer la valeur juridique du français.',
    ],
    pourQui: ['Tous les habitants, y compris sans smartphone ni connexion stable'],
    aConfirmer: 'Les raccordements réels USSD, SMS et serveur vocal dépendent des conventions avec les opérateurs ; la démonstration les simule.',
    lien: { to: '/points-de-paiement', label: 'Où payer ?' },
  },
  {
    slug: 'application-hors-ligne',
    categorie: 'usagers',
    titre: 'Une application qui tient même quand le réseau tombe',
    accroche: 'Installable sur Android et iPhone, MOSOLO garde l’essentiel à portée de main, même hors connexion.',
    usp: 'Une application web installable (Android et iOS) qui garde ses écrans en mémoire, et un terminal d’agent qui continue de contrôler hors ligne avant de tout synchroniser.',
    probleme: [
      'À Kinshasa, la connexion n’est pas toujours au rendez-vous. Une application qui s’arrête au premier coupure de réseau ne sert ni l’usager ni l’agent.',
    ],
    solution: [
      'MOSOLO s’installe depuis le navigateur sur Android et iPhone, sans passer par un magasin d’applications, et se met à jour toute seule.',
      'Sur le terrain, la mémoire hors ligne du terminal permet de continuer les contrôles ; les consommations sont partagées dans l’équipe à la reconnexion pour éviter les doubles usages.',
    ],
    atouts: [
      'Installation en un clic, aucune mise à jour manuelle.',
      'Contrôles possibles même sans réseau.',
      'Plus d’anciens écrans après une mise en ligne : la nouvelle version s’affiche d’elle-même.',
    ],
    pourQui: ['Usagers sur mobile', 'Agents de terrain'],
    aConfirmer: 'Les applications Android et iOS des magasins (Google Play, App Store) ne sont pas encore publiées : à réaliser lors de la mise en service. L’application web installable est disponible dès aujourd’hui.',
    lien: { to: '/application', label: 'Voir l’application' },
  },

  // ------------------------------------------------------------------------------------------------ paiement
  {
    slug: 'zero-espece',
    categorie: 'paiement',
    titre: 'Zéro espèce entre les mains des agents',
    accroche: 'L’argent ne passe plus par une poche : il va directement au compte public.',
    usp: 'Aucun agent de terrain ne reçoit jamais d’espèces. Tout paiement va directement au compte public ; les espèces ne sont acceptées qu’aux points de paiement agréés et aux guichets bancaires, puis vérifiées et rapprochées.',
    probleme: [
      'Chaque franc qui passe de main en main peut se perdre en chemin. C’est la première fuite des recettes publiques.',
    ],
    solution: [
      'Avec MOSOLO, l’agent peut aider l’usager à payer sur son téléphone (paiement assisté), mais il ne touche jamais l’argent.',
      'Les espèces ne sont reçues qu’aux points de paiement agréés et aux guichets bancaires : déclaration, vérification, dépôt, appariement et rapprochement — puis répartition par le même moteur que les paiements numériques.',
    ],
    atouts: [
      'Supprime la tentation et le soupçon à la source.',
      'Chaque paiement aboutit au compte public, traçable de bout en bout.',
      'Un point de paiement en retard de dépôt est suspendu à titre conservatoire ; la levée et la pénalité sont décidées par une personne.',
    ],
    pourQui: ['Contribuables', 'Agents de terrain, protégés de tout soupçon', 'Trésor provincial'],
    lien: { to: '/points-de-paiement', label: 'Voir les points de paiement' },
  },
  {
    slug: 'paiement-mobile-bitripay-koda',
    categorie: 'paiement',
    titre: 'Payer avec Orange Money, M-Pesa, Airtel Money, Africell Money, carte ou QR',
    accroche: 'Le moyen que vous utilisez déjà, choisi en un clic, pour payer le montant exact.',
    usp: 'Deux passerelles complémentaires : BitriPay achemine le paiement (monnaie mobile, carte, QR) et KODA vérifie la confirmation de l’opérateur sans jamais toucher l’argent. Le contribuable paie exactement ce qu’il doit : les frais des passerelles sont à la charge de la Ville.',
    probleme: [
      'Payer une taxe ne devrait pas coûter plus que la taxe. Et un paiement mobile sans vérification n’est qu’une promesse.',
    ],
    solution: [
      'Au moment de payer, l’usager choisit son moyen : Orange Money, M-Pesa, Airtel Money, Africell Money, carte bancaire ou QR BitriPay. La page de paiement s’ouvre directement sur l’opérateur choisi.',
      'Une confirmation donne une quittance provisoire ; elle devient définitive seulement quand l’argent apparaît sur le relevé bancaire du compte public.',
    ],
    atouts: [
      'Tous les opérateurs congolais, plus la carte et le QR.',
      'Le montant exact de l’obligation, sans frais ajoutés pour l’usager.',
      'Signatures des confirmations vérifiées (HMAC et Ed25519) : une fausse confirmation est rejetée.',
    ],
    pourQui: ['Tous les contribuables équipés d’un téléphone'],
    aConfirmer: 'Dans la démonstration, la page de paiement est simulée. Le raccordement réel demande les clés de BitriPay et de KODA et un paiement de test.',
    lien: { to: '/inscription', label: 'Essayer le paiement' },
  },
  {
    slug: 'quittance-verifiable',
    categorie: 'paiement',
    titre: 'La fin des faux reçus',
    accroche: 'Chaque quittance se vérifie en un scan. Une fausse quittance ne trouve aucune correspondance.',
    usp: 'Une quittance n’est définitive que lorsque l’argent est arrivé au compte public, et chacune se vérifie publiquement par son code QR. Un code inventé est immédiatement démasqué.',
    probleme: [
      'Les faux reçus coûtent doublement : la recette est perdue, et le contribuable honnête est confondu avec le fraudeur.',
    ],
    solution: [
      'Chaque quittance porte un code et un QR signés. La page publique de vérification affiche « Paiement confirmé » pour une vraie quittance, et « Aucune quittance ne correspond » pour un code inventé.',
      'La quittance est d’abord provisoire, puis définitive au rapprochement du relevé bancaire : on ne peut plus confondre « annoncé » et « encaissé ».',
    ],
    atouts: [
      'Vérification ouverte à tous, sans connexion.',
      'Provisoire puis définitive : la vérité est celle du relevé bancaire.',
      'Chaque document porte l’en-tête de la Ville et se vérifie de la même façon.',
    ],
    pourQui: ['Contribuables', 'Agents de contrôle', 'Banques et partenaires'],
    lien: { to: '/verifier', label: 'Vérifier une quittance' },
  },
  {
    slug: 'grand-livre-repartition',
    categorie: 'paiement',
    titre: 'Un seul grand livre, une répartition automatique et vérifiable',
    accroche: 'Chaque franc encaissé est enregistré une fois, réparti selon une règle approuvée, et réglé à date fixe.',
    usp: 'Un seul grand livre et un seul moteur de répartition pour tous les modules, avec une règle versionnée — jamais codée en dur — activée seulement après un circuit d’approbation, et un historique immuable.',
    probleme: [
      'Quand chaque service tient ses propres comptes, personne ne peut dire avec certitude combien la Ville a réellement encaissé, ni qui doit recevoir quoi.',
    ],
    solution: [
      'MOSOLO enregistre chaque recette dans un grand livre unique et la répartit selon la règle en vigueur (KIN-DEFAULT : 70 % Gouvernorat, 10 % ministère ou département propriétaire du module, 10 % opérations de terrain, 10 % Groupe Nseya). Le total fait toujours exactement 100 %.',
      'Les règlements suivent un calendrier fixe : Gouvernorat et Groupe Nseya tous les 7 jours, ministères et opérations de terrain chaque mois ; un montant non réglé passe « en retard » après 10 jours. Une erreur se corrige par contrepassation, jamais en effaçant.',
    ],
    atouts: [
      'Une seule source de vérité pour toutes les recettes.',
      'Règle approuvée et versionnée : on sait toujours quelle règle s’appliquait, et depuis quand.',
      'Historique impossible à réécrire.',
    ],
    pourQui: ['Gouvernorat et ministère des Finances', 'Trésor provincial', 'Ministères et régies'],
    aConfirmer: 'La règle KIN-DEFAULT est décidée mais reste « proposée, acte requis » ; les opérations de la démonstration sont simulées. La répartition commerciale proposée à la Ville (100 % de l’existant conservé, partage du seul surplus) est fixée dans la convention.',
    lien: { to: '/connexion', label: 'Voir dans la démonstration' },
  },

  // ------------------------------------------------------------------------------------------------ terrain
  {
    slug: 'agents-de-terrain',
    categorie: 'terrain',
    titre: 'Des agents de terrain équipés, rattachés et protégés',
    accroche: 'Chaque agent contrôle dans ses modules, avec des preuves horodatées — et sa propre protection.',
    usp: 'Un agent ne contrôle, ne scanne et ne vérifie que dans ses modules de rattachement ; la plaque lue est obligatoire et ses constats sont accompagnés de photos des abords, géolocalisées et horodatées.',
    probleme: [
      'Sur le terrain, la parole de l’agent contre celle de l’usager ne suffit pas : sans preuve, pas de recette, et beaucoup de contestations.',
    ],
    solution: [
      'L’agent est rattaché à ses modules par l’administrateur de son entité, et le serveur refuse tout contrôle hors de ce rattachement.',
      'Au contrôle, la plaque est lue par l’appareil ; un écart entre la plaque lue et la plaque déclarée déclenche un blocage conservatoire et un dossier. Les pénalités en cours sont visibles avec leur montant.',
    ],
    atouts: [
      'Des contrôles bornés et journalisés.',
      'Des preuves objectives : plaque lue, photos géolocalisées et horodatées.',
      'Aucune sanction automatique : une personne décide toujours.',
    ],
    pourQui: ['Agents de terrain et leurs superviseurs', 'Régies et sous-traitants'],
    lien: { to: '/connexion', label: 'Voir le poste de l’agent' },
  },
  {
    slug: 'anti-fraude-des-preuves',
    categorie: 'terrain',
    titre: 'Une preuve ne sert qu’une fois, à une seule personne',
    accroche: 'Copies, photos d’écran, gilets prêtés : MOSOLO les détecte à chaque scan.',
    usp: 'QR animé pour les pass personnels, détection des copies à chaque scan, vignettes techniques signées, gilets refusés sur simple numéro : un code ne sert qu’une personne, un véhicule, un lieu à la fois.',
    probleme: [
      'Un QR photographié et partagé, une vignette recopiée, un gilet prêté : chaque copie est une recette perdue.',
    ],
    solution: [
      'Les pass personnels exigent un QR animé, impossible à capturer en photo. Chaque scan est comparé aux précédents ; une copie détectée entraîne un blocage immédiat et l’ouverture d’un dossier.',
      'La chaîne de la fraude est instruite (qui a présenté, qui a accepté), la décision est prise par une personne distincte, et la recette perdue est facturée au titulaire — jamais de sanction automatique.',
    ],
    atouts: [
      'Fraude détectée au moment du contrôle, pas des mois après.',
      'Fonctionne aussi hors ligne grâce à la mémoire du terminal.',
      'Décision humaine et motivée, pour une sanction juste.',
    ],
    pourQui: ['Agents de contrôle', 'Cellule anti-fraude', 'Titulaires honnêtes, protégés des copieurs'],
    lien: { to: '/verifier', label: 'Voir la vérification' },
  },
  {
    slug: 'remuneration-des-agents',
    categorie: 'terrain',
    titre: 'Des agents payés sur les résultats vérifiés',
    accroche: 'Quand l’agent est intéressé à la recette réellement encaissée, la corruption ne paie plus.',
    usp: 'La part des opérations de terrain est calculée sur la recette réellement rapprochée au relevé bancaire — jamais sur un montant liquidé ou promis.',
    probleme: [
      'Un agent mal payé, ou payé en liquide, est exposé à toutes les tentations. Et une prime calculée sur des montants « annoncés » encourage les faux constats.',
    ],
    solution: [
      'MOSOLO calcule la part de terrain sur la recette éligible rapprochée : 10 % pour un agent direct, 7 % pour l’agent d’un sous-traitant et 3 % pour le sous-traitant.',
      'Un second mode, la réserve par module, répartit au prorata des points de résultats vérifiés multipliés par une note de qualité. Les points fictifs ou frauduleux sont repris sur décision d’une autre personne.',
    ],
    atouts: [
      'L’intérêt de l’agent est aligné sur celui de la Ville.',
      'Chaque agent ne voit que ses propres gains.',
      'Aucune prime sur un argent qui n’est pas arrivé au compte public.',
    ],
    pourQui: ['Agents et sous-traitants', 'Directions des régies'],
    aConfirmer: 'Aucun versement réel avant l’arrêté qui l’autorise ; chaque commission est validée par un superviseur distinct.',
    lien: { to: '/connexion', label: 'Voir dans la démonstration' },
  },
  {
    slug: 'carte-et-geolocalisation',
    categorie: 'terrain',
    titre: 'La carte de Kinshasa, embarquée et précise',
    accroche: 'Chaque bien, chaque contrôle, chaque commune : sur une carte qui ne dépend d’aucun service payant.',
    usp: 'Un fond de carte OpenStreetMap de Kinshasa fabriqué dans l’application elle-même : pas de clé, pas de coût par affichage, et une géolocalisation précise partout.',
    probleme: [
      'Sans adresse fiable, on ne peut ni recenser, ni contrôler, ni réclamer. Et une carte louée à un service étranger coûte à chaque affichage.',
    ],
    solution: [
      'MOSOLO embarque sa propre carte de Kinshasa (données OpenStreetMap). Les biens, les points de paiement et les constats sont géolocalisés.',
    ],
    atouts: [
      'Aucun coût par affichage, aucune dépendance à un fournisseur de cartes.',
      'Géolocalisation des biens et des contrôles.',
      'Attribution « © contributeurs OpenStreetMap » respectée.',
    ],
    pourQui: ['Agents de recensement et de contrôle', 'Services fiscaux et urbanisme'],
    lien: { to: '/points-de-paiement', label: 'Voir la carte des points de paiement' },
  },

  // ------------------------------------------------------------------------------------------------ secteurs
  {
    slug: 'stationnement-intelligent',
    categorie: 'secteurs',
    titre: 'Stationnement intelligent (ParkSmart)',
    accroche: 'Moins de voitures qui tournent, plus de places libres, et chaque minute payée au compte public.',
    usp: 'Un tarif qui s’ajuste automatiquement, à l’intérieur des fourchettes fixées par l’acte, pour garder 15 à 25 % de places libres — et des contrôles par plaque lue.',
    probleme: [
      'Le stationnement est une recette importante, mais la perception manuelle laisse filer l’essentiel, et les rues restent saturées.',
    ],
    solution: [
      'Le conducteur paie depuis son téléphone. L’agent contrôle par la plaque, avec des photos des abords du véhicule comme preuve.',
      'MOSOLO ajuste le tarif dans les limites fixées par l’acte juridique pour maintenir des places disponibles. Il complète la perception numérique déjà engagée par la Ville.',
    ],
    atouts: [
      'Contrôle par plaque, sans papier à afficher.',
      'Pénalités visibles avec leur montant au moment du contrôle.',
      'Un tarif qui sert aussi la circulation, pas seulement la caisse.',
    ],
    pourQui: ['Conducteurs', 'Gestionnaires du stationnement', 'Communes'],
    aConfirmer: 'Les fourchettes de tarif sont celles de l’acte juridique à adopter ; les tarifs de la démonstration sont fictifs.',
    lien: { to: '/services', label: 'Voir les services' },
  },
  {
    slug: 'publicite-kin-pub-control',
    categorie: 'secteurs',
    titre: 'Publicité et enseignes (KIN PUB CONTROL)',
    accroche: 'Chaque panneau, chaque enseigne, chaque véhicule publicitaire : recensé, payé, vérifiable.',
    usp: 'L’agent voit « autour de moi » tous les supports publicitaires et commerces, avec leur situation ; la publicité mobile est contrôlée par la plaque du véhicule.',
    probleme: [
      'Les supports publicitaires se multiplient plus vite que les registres. Beaucoup ne paient rien, faute d’être connus.',
    ],
    solution: [
      'MOSOLO recense panneaux, enseignes et commerces avec leur position. Sur le terrain, l’écran « Autour de moi » montre ce qui est à jour et ce qui ne l’est pas.',
      'Pour la publicité sur véhicule, le contrôle se fait par la plaque.',
    ],
    atouts: [
      'Un registre vivant, à jour à chaque passage.',
      'Contrôle ciblé : l’agent voit tout de suite qui n’est pas en règle.',
    ],
    pourQui: ['Annonceurs et commerçants', 'Service de la publicité'],
    aConfirmer: 'Aucune pénalité tant que le barème n’est pas publié ; les tarifs de la démonstration sont fictifs.',
    lien: { to: '/services', label: 'Voir les services' },
  },
  {
    slug: 'titres-et-pass',
    categorie: 'secteurs',
    titre: 'Titres, tickets et pass numériques',
    accroche: 'Un ticket ou un pass sur le téléphone, impossible à recopier, vérifié en un scan.',
    usp: 'Un moteur de titres unique pour tous les tickets et pass de la Ville, chacun lié à son titulaire (personne, plaque ou téléphone), avec QR animé pour les pass personnels.',
    probleme: [
      'Les tickets papier se perdent, se revendent et se falsifient.',
    ],
    solution: [
      'MOSOLO délivre des titres numériques (tickets, pass) liés à leur titulaire. Un pass au porteur est lui aussi rattaché à une personne, une plaque ou un téléphone.',
      'À chaque scan, la validité, le titulaire et l’absence de copie sont vérifiés.',
    ],
    atouts: [
      'Un seul moteur pour tous les titres.',
      'Achat sur téléphone, sans espèces.',
      'Copies détectées automatiquement.',
    ],
    pourQui: ['Usagers des transports et services', 'Contrôleurs'],
    aConfirmer: 'Les tarifs réels des titres (pass wewa, bus) attendent leur acte ; ceux de la démonstration sont fictifs.',
    lien: { to: '/services', label: 'Voir les services' },
  },
  {
    slug: 'secteurs-raccordes',
    categorie: 'secteurs',
    titre: 'Toutes les recettes de la Ville dans une seule plateforme',
    accroche: 'Impôts, droits, taxes et redevances : ceux qu’on perçoit déjà, et ceux que personne ne perçoit encore.',
    usp: 'MOSOLO couvre toutes les lignes de recettes de la Ville dans un seul grand livre, et se raccorde aux plateformes existantes plutôt que de les remplacer.',
    probleme: [
      'Chaque nouvelle recette apporte souvent son propre outil. Au bout du compte, la Ville a des outils qui ne se parlent pas, et des recettes que personne ne couvre.',
    ],
    solution: [
      'MOSOLO rassemble seize secteurs — marchés sans espèces, événements, construction, télécommunications, stationnement, publicité, antennes, concessions, carrières, contrôle technique et d’autres — sur le même compte, les mêmes règles et le même paiement.',
      'La liquidation automatique s’applique là où une règle active la prévoit (antennes, concessions, carrières) ; les sanctions restent décidées par une personne. Les plateformes déjà engagées par la Ville sont raccordées, sans double saisie.',
    ],
    atouts: [
      'Une seule plateforme, un seul compte, un seul grand livre.',
      'Rien n’est remplacé : les outils existants sont prolongés.',
      'Les recettes jusqu’ici sans outil sont enfin couvertes.',
    ],
    pourQui: ['Gouvernorat', 'DGIPK, DGTK et régies', 'Ministères sectoriels'],
    aConfirmer: 'Certains secteurs (aviation, ports, contribution plastique) attendent leur acte et ne facturent rien ; l’écran « Chemin vers l’acte » montre qui doit agir. Le raccordement en direct de chaque plateforme existante dépend de sa documentation technique.',
    lien: { to: '/services', label: 'Voir tous les services' },
  },
  {
    slug: 'fiscalite-des-biens',
    categorie: 'secteurs',
    titre: 'Biens, déclarations, exonérations et quitus fiscal',
    accroche: 'Déclarer, payer et obtenir son quitus sans file d’attente.',
    usp: 'Le bien, sa déclaration, ses éventuelles exonérations et le quitus fiscal sont reliés au compte unique : le quitus se délivre et se vérifie en ligne.',
    probleme: [
      'Obtenir un quitus fiscal demande aujourd’hui des déplacements et des attestations qui se vérifient mal.',
    ],
    solution: [
      'Dans MOSOLO, le contribuable déclare ses biens, suit ses échéances et demande son quitus. Les exonérations sont instruites et tracées.',
      'Le quitus n’est délivré que sur des quittances définitives et porte un code vérifiable, comme toutes les preuves de la Ville. Une exonération exige sa base légale et deux validations — jamais l’IA.',
    ],
    atouts: [
      'Démarches fiscales en ligne, de la déclaration au quitus.',
      'Un quitus vérifiable par une banque, un notaire ou une administration.',
    ],
    pourQui: ['Propriétaires et entreprises', 'DGIPK'],
    aConfirmer: 'Un montant n’est réclamé que sur une règle active adoptée ; d’ici là, la déclaration reste une simulation et le quitus est informatif.',
    lien: { to: '/fiscal/dependances', label: 'Voir les conditions des services' },
  },

  // ------------------------------------------------------------------------------------------------ pilotage
  {
    slug: 'centre-de-commandement',
    categorie: 'pilotage',
    titre: 'Le Centre de commandement du Gouverneur',
    accroche: 'Chaque matin, commune par commune, ce qui est dû et ce qui est réellement entré.',
    usp: 'Une vue unique de toutes les recettes de la Ville, sur données réelles : le Gouverneur voit où l’argent se perd, commune par commune, et décide.',
    probleme: [
      'Aujourd’hui, le Gouverneur découvre les chiffres des mois plus tard, consolidés à la main, sans pouvoir dire où se situent les fuites.',
    ],
    solution: [
      'Le Centre de commandement montre, commune par commune, l’intensité du recouvrement : ce qui est liquidé et ce qui est rapproché du relevé bancaire.',
      'Le Gouverneur, son directeur de cabinet et le secrétaire exécutif voient l’ensemble des modules ; chaque ministre voit ceux de son ministère.',
    ],
    atouts: [
      'Des écarts visibles là où ils se produisent.',
      'Des chiffres issus du grand livre, pas de tableaux recopiés.',
      'Une vue adaptée à chaque autorité.',
    ],
    pourQui: ['Gouverneur, directeur de cabinet, secrétaire exécutif', 'Ministres provinciaux'],
    lien: { to: '/connexion', label: 'Voir dans la démonstration' },
  },
  {
    slug: 'agents-ia-de-recettes',
    categorie: 'pilotage',
    titre: 'Les agents IA de recettes : l’IA propose, une personne décide',
    accroche: 'Sept familles d’agents d’intelligence artificielle qui cherchent les recettes oubliées — sans jamais sanctionner.',
    usp: 'L’IA analyse l’assiette, les paiements, les fuites, les arriérés, les tarifs, la confiance et le terrain, puis propose ; une personne décide, avec un motif journalisé.',
    probleme: [
      'Les données existent, mais personne n’a le temps de les croiser pour trouver qui ne paie pas, où, et pourquoi.',
    ],
    solution: [
      'MOSOLO met au travail sept familles d’agents IA. Leurs principes : aucune charge sans acte, les grands contribuables d’abord, aider avant de punir, et un contrôle d’équité.',
      'Les fournisseurs d’IA (Claude, OpenAI, Gemini) sont facultatifs : sans clé, les agents fonctionnent avec leurs règles internes. Les données envoyées sont agrégées ou caviardées, et les coûts sont plafonnés.',
    ],
    atouts: [
      'Des pistes de recettes concrètes, chaque jour.',
      'Aucune sanction automatique.',
      'Données protégées et coûts maîtrisés.',
    ],
    pourQui: ['Directions des recettes', 'Cabinet du Gouverneur', 'Ministère des Finances'],
    aConfirmer: 'Les paramètres des agents IA sont « à confirmer » par le Gouvernorat.',
    lien: { to: '/connexion', label: 'Voir dans la démonstration' },
  },
  {
    slug: 'recouvrement-et-registre',
    categorie: 'pilotage',
    titre: 'Avis, registre juridique et recouvrement',
    accroche: 'Chaque avis s’appuie sur un acte, chaque relance est tracée, chaque contestation est entendue.',
    usp: 'Aucune charge sans acte : chaque montant réclamé renvoie à son fondement juridique dans le registre, et le recouvrement suit des étapes tracées.',
    probleme: [
      'Un avis sans base juridique claire est contestable, et une relance non tracée se perd.',
    ],
    solution: [
      'Le registre juridique de MOSOLO relie chaque recette à son acte. Les avis sont générés à l’image de la Ville et vérifiables ; le recouvrement suit des étapes datées.',
    ],
    atouts: [
      'Des avis incontestables sur leur fondement.',
      'Un recouvrement suivi, sans relance oubliée.',
    ],
    pourQui: ['Services de recouvrement', 'Contribuables, qui savent sur quoi repose chaque montant'],
    lien: { to: '/connexion', label: 'Voir dans la démonstration' },
  },

  // ------------------------------------------------------------------------------------------------ confiance
  {
    slug: 'ou-va-votre-argent',
    categorie: 'confiance',
    titre: '« Où va votre argent »',
    accroche: 'Ce que chaque commune a payé, et ce qui y a été réalisé : publié pour tous.',
    usp: 'Une page publique qui montre, par commune, les recettes confirmées par la banque et les réalisations financées — la meilleure raison de payer.',
    probleme: [
      'On paie plus volontiers quand on voit le résultat. Sans transparence, l’impôt reste une perte.',
    ],
    solution: [
      'La page « Où va votre argent » publie, commune par commune, les recettes rapprochées du relevé bancaire et les réalisations financées sur acte.',
      'Aucune donnée individuelle n’y figure, et une commune de moins de cinq contribuables n’est pas publiée.',
    ],
    atouts: [
      'Transparence ouverte à tous, sans connexion.',
      'Des chiffres confirmés par la banque, pas des annonces.',
      'Vie privée respectée.',
    ],
    pourQui: ['Tous les Kinois', 'Société civile et médias'],
    aConfirmer: 'Publication trimestrielle sur décision du Gouverneur ou du ministre des Finances ; la démonstration affiche des données fictives.',
    lien: { to: '/ou-va-votre-argent', label: 'Voir où va votre argent' },
  },
  {
    slug: 'integrite-et-audit',
    categorie: 'confiance',
    titre: 'Signalements, enquêtes et piste d’audit',
    accroche: 'Personne, à aucun niveau, ne peut seul modifier une dette, un compte ou une trace.',
    usp: 'Une piste d’audit chaînée et des circuits à personnes distinctes : chaque action est tracée, et aucune ne peut être effacée — ce qui protège aussi le Gouverneur.',
    probleme: [
      'Là où une seule personne peut effacer une dette ou modifier un compte, la fraude est toujours possible — et le soupçon pèse sur tous.',
    ],
    solution: [
      'MOSOLO journalise chaque action dans une piste d’audit chaînée. Les décisions sensibles demandent deux personnes distinctes.',
      'Les usagers peuvent signaler un abus, y compris par SMS ou serveur vocal ; les doléances sont traitées sans représailles et instruites par des enquêtes tracées.',
    ],
    atouts: [
      'Historique impossible à réécrire.',
      'Personne ne valide seul ce qu’il propose.',
      'Un canal de signalement protégé.',
    ],
    pourQui: ['Inspection et audit', 'Citoyens', 'Autorités, protégées par la traçabilité'],
    aConfirmer: 'Les signalements par SMS et serveur vocal sont simulés dans la démonstration ; les numéros courts restent à attribuer.',
    lien: { to: '/signaler', label: 'Signaler un abus' },
  },
  {
    slug: 'acces-et-confidentialite',
    categorie: 'confiance',
    titre: 'Chacun voit ce qu’il doit voir — et pas plus',
    accroche: 'Des accès par rôle, des montants sur autorisation, des consultations motivées et journalisées.',
    usp: 'Chaque rôle n’accède qu’à ce qu’il a à faire. Les montants individuels ne sont vus qu’après autorisation d’un membre de la direction, pour une durée limitée, et chaque consultation est journalisée.',
    probleme: [
      'Une plateforme fiscale contient des données sensibles. Si tout le monde voit tout, la confiance disparaît.',
    ],
    solution: [
      'Les gains des autres ne sont visibles que du Gouverneur, du directeur de cabinet, du secrétaire exécutif, du ministre des Finances et de Groupe Nseya ; tous les autres ne voient que leurs propres gains.',
      'Le Trésor, l’audit ou l’anti-fraude accèdent aux montants nécessaires après approbation d’un membre de la direction, distinct du demandeur, sur motif journalisé. Toute consultation d’un dossier personnel est motivée.',
    ],
    atouts: [
      'Confidentialité appliquée par le serveur, pas seulement par l’affichage.',
      'Accès temporaires et motivés.',
      'Groupe Nseya, opérateur technique, ne peut ni approuver, ni payer, ni réécrire l’historique.',
    ],
    pourQui: ['Contribuables', 'Directions', 'Organes de contrôle'],
    aConfirmer: 'Durée des accès sur autorisation : 7 jours par défaut, 30 au plus — à confirmer.',
    lien: { to: '/connexion', label: 'Se connecter' },
  },
  {
    slug: 'documents-a-l-image-de-la-ville',
    categorie: 'confiance',
    titre: 'Des documents officiels, à l’image de la Ville',
    accroche: 'Avis, quittances, cartes, preuves : tous portent l’en-tête de la Ville-Province de Kinshasa.',
    usp: 'Tout document généré — PDF, impression, avis, quittance, carte ou preuve — porte la même identité officielle et se vérifie par son code.',
    probleme: [
      'Des documents disparates, faciles à imiter, affaiblissent l’autorité de la Ville.',
    ],
    solution: [
      'MOSOLO applique à chaque document l’en-tête « Ville-Province de Kinshasa », le filet tricolore et un code de vérification.',
    ],
    atouts: [
      'Une identité officielle cohérente.',
      'Des documents vérifiables, donc difficiles à falsifier.',
    ],
    pourQui: ['Contribuables', 'Partenaires et banques'],
    aConfirmer: 'Tant que les actes ne sont pas pris, les documents portent la mention « DÉMONSTRATION — NON OPPOSABLE ».',
    lien: { to: '/verifier', label: 'Vérifier un document' },
  },
];
