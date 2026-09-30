# KINSHASA MOSOLO — consignes permanentes du maître d'ouvrage

## Règle n° 1 : on ajoute, on ne retire jamais (27/09/2026)

Les nouvelles spécifications s'ajoutent à l'existant. **Rien de ce qui existe ne doit être supprimé, retiré ni omis** :
modules, écrans, routes, règles, contrôles anti-fraude, tests, documents (document maître, annexes, captures, PDF, Word),
données de démonstration.

- Toute nouvelle exigence est construite **par-dessus** l'existant, ou l'**enrichit** : fusionner, combiner et
  harmoniser avec ce qui est déjà construit (mêmes circuits, mêmes règles, même vocabulaire), jamais en parallèle.
- Si une nouvelle exigence semble contredire l'existant : ne rien supprimer ; harmoniser (l'ancien comportement reste
  disponible ou est étendu) et signaler la contradiction au maître d'ouvrage pour arbitrage.
- Un nettoyage technique (code mort, doublons) ne retire aucune fonctionnalité ni aucun contrôle ; en cas de doute, on garde.
- Le document maître (`docs/document-maitre/`, annexe I) est mis à jour à chaque ajout, sans effacer les sections existantes.

## Autres principes constants

- Les agents de terrain ne reçoivent jamais d'espèces ; paiements numériques vers le compte public uniquement.
- L'IA propose, une personne décide ; aucune sanction automatique.
- Aucun taux, tarif ni seuil inventé : les valeurs non confirmées sont marquées « par défaut — à confirmer par le maître
  d'ouvrage » ; les données de démonstration sont marquées non contractuelles.
- Logos non modifiés ; interface et commentaires en français.
- **Noms en français d'abord (27/09/2026)** : tous les modules, verticales, écrans, menus, statuts et autres noms affichés
  dans la plateforme ont un nom français principal ; un nom de marque ou un terme anglais n'apparaît qu'en second, entre
  parenthèses (ex. « Stationnement intelligent (ParkSmart) », « Centre de commandement (Command Centre) »).
- Avant de livrer : `npm run typecheck && npm run lint && npm test && npm run build -w frontend`, et
  `python3 tools/gen_routes.py` si des routes changent.

## Décisions du maître d'ouvrage (27/09/2026, suite à la spécification fonctionnelle)

- **Réserve des agents (§ 37A.5, module 67)** : les 10 % des agents et sous-traitants forment une réserve par module,
  répartie au prorata de points de résultats vérifiés × note de qualité, jamais selon le montant liquidé ; l'écran
  actuel de la commission de 10 % est conservé et harmonisé avec cette réserve.
- **Exécution automatique après acte** : une fois l'acte juridique et la convention enregistrés, les deux flux du § 37A
  sont exécutés automatiquement (piste d'audit complète) et la facturation des écarts AVIA est automatique ; avant
  l'acte, simulation / proposition seulement.
- **Point de paiement en retard (module 66)** : suspension conservatoire automatique au dépassement du délai
  contractuel ; levée et pénalité décidées par une personne.
- **ParkSmart (module 75)** : tarification automatique à l'intérieur de fourchettes fixées par l'acte, pour maintenir
  15 à 25 % de places libres.
- **Liquidation « automatique »** des modules qui la prévoient (antennes, concessions, carrières) : automatique sur règle
  ACTIVE ; les sanctions restent décidées par une personne.
- **IRL** : 22 % à tous les rangs, retenue 20 % (rang 1) / 15 % (rangs 2 à 4) — § 16.2 ; statut « à vérifier ».
- **Plaque NFIU** : l'agent habilité voit la situation complète (§ 16.7) ; scan public minimal.
- **Module 4** : application Android **et iOS**.
- **Données de démonstration (27/09/2026)** : toutes les données de démonstration sont conservées pour l'instant
  (aucune suppression ni modification) ; le mode production (sans `--demo`) ne les charge pas.
- **Interface (27/09/2026)** : pas de « Vérification publique » dans le menu du Gouverneur, du directeur de cabinet,
  du secrétaire général et des ministres (R01–R05) ; la mention « Document de travail soumis à validation juridique… »
  n'est plus affichée.

- **Menus des autorités (27/09/2026, corrigé le 28/09/2026)** : Gouverneur, directeur de cabinet et secrétaire exécutif
  (R01–R03) voient toujours tous les modules. Les ministres (R04, R05) ne voient que les modules de leur ministère et des
  départements de sa tutelle (régies dirigées par un directeur général, trésor, services) : rattachement explicite
  d'abord, sinon ministère de tutelle par défaut du module (à confirmer).
- **Contrats partenaires (27/09/2026)** : approuvés par le directeur de cabinet (R02) seul.
- **Compte unique, biens et occupations (28/09/2026)** : une personne = un compte ; biens, unités et occupations restent
  des enregistrements distincts, reliés par des RELATIONS datées (propriétaire, copropriétaire, locataire, occupant,
  gestionnaire, exploitant). Le choix « propriétaire / locataire » à l'inscription ouvre une revendication, jamais un lien
  automatique. Rapprochement sur identifiant du bien, GPS, adresse et numéro d'unité — jamais sur le téléphone ou le nom
  seuls ; confirmation par la personne, puis vérification (invitation acceptée par l'autre partie, preuve, ou agent de
  terrain habilité) ; contestation → revue. Historique conservé (qui occupait quelle unité, quand). Aucune suggestion ne
  divulgue les données privées de l'autre partie avant vérification ; le lien sert les démarches et la fiscalité, jamais
  un accès au compte de l'autre.
- **Moteur de paiement, de répartition et de règlement (29/09/2026, spécification v1.0 — `docs/sources/`)** : un seul
  grand livre et un seul moteur de répartition pour tous les modules ; règle versionnée KIN-DEFAULT (70 % Gouvernorat,
  10 % Groupe Nseya, 10 % ministère/département propriétaire du module, 10 % opérations de terrain), jamais codée en
  dur, activation après circuit d'approbation, total exactement 100 %. **Pool de terrain** : agent direct 10 % ; agent
  de sous-traitant 7 % + sous-traitant 3 % de la recette éligible rapprochée (décision qui précise celle du 27/09 sur
  la réserve par points × qualité : les deux modes restent disponibles, le mode « par recette » est celui de la règle
  V1 proposée). **Groupe Nseya** : rôle dédié à visibilité complète sur la plateforme (lecture, export, descente à la
  transaction), sans pouvoir supprimer ni réécrire l'historique ; toute consultation de données personnelles
  individuelles reste journalisée avec motif (critère C42-05). **Ministre des Finances** : visibilité financière
  complète sur ce moteur. Historique immuable : corrections par contrepassation puis écriture corrigée.
  **Tranché le 29/09/2026 : aucune espèce pour les agents.** Le § 13 de la spécification (« l'agent enregistre
  l'encaissement d'espèces ») ne s'applique pas aux agents de terrain : les espèces ne sont reçues qu'aux points de
  paiement agréés et aux guichets bancaires (déclaration, vérification, dépôt, appariement, rapprochement), puis
  réparties par le même moteur.
- **Décisions du 29/09/2026 (suite)** : signature Ed25519 de BitriPay **exigée partout** dès qu'une clé est configurée
  (en plus du HMAC) ; codes BitriPay « frais publics » (GOVERNMENT_FEE) pour droits administratifs et redevances de
  service, « impôt » (TAX) sinon ; la valeur définie dans l'environnement du serveur prime sur la console « Clés et
  raccordements » ; la console des clés et le **registre des modèles d'IA** sont réservés à l'administration (R26, et
  R29 pour l'IA ; R28 pour la sécurité) et n'apparaissent pas au menu des autorités ; `KODA_SUCCESS_URL` laissé vide
  pour le retour vers MOSOLO ; le **Gouverneur** dispose du « Centre de commandement » (tableau complet) en plus des
  cinq entrées de son poste de décision.
- **Frais de gestion de Groupe Nseya (29/09/2026)** : 5 % sur les coûts technologiques qu'il finance (IA, hébergement,
  SMS, API…), distincts de ses 10 % ; aucun frais sur les coûts financés par le Gouvernorat.
- **Moteur de répartition — suite (29/09/2026)** : un paiement au **guichet bancaire** compte comme espèces pour la part
  de Groupe Nseya (droit « à payer » que le Gouvernorat règle) ; règlements du Gouvernorat et de Groupe Nseya **tous les
  7 jours**, des ministères et des opérations de terrain **mensuellement** ; un montant passe « en retard » après
  **10 jours** ; table « module → ministère propriétaire » confirmée telle quelle.
- **Rôle de Groupe Nseya (29/09/2026)** : le code **R38** « Groupe Nseya — super-administrateur (lecture complète) » est
  confirmé comme rôle dédié.
- **Gains d'autrui (29/09/2026)** : seuls le Gouverneur, le directeur de cabinet, le secrétaire exécutif, le ministre des
  Finances (R01, R02, R03, R05) et Groupe Nseya (R38) voient ce que gagnent les autres (agents, sous-traitants,
  ministères, départements, Groupe Nseya, Gouvernorat) ; tous les autres ne voient que leurs propres gains (régie :
  ses agents ; sous-traitant : son ombrelle ; agent : lui-même), côté serveur. Trésor, audit et anti-fraude gardent
  leurs circuits sans montant individuel (annexe I, § I.38).
- **Compte unique Groupe Nseya (29/09/2026)** : Groupe Nseya est aussi le super-administrateur de la plateforme — un seul
  compte « Groupe Nseya — super-administrateur » (R26 + R38) ; incompatibilité R38/R26 levée. Ce compte ne vérifie,
  n'approuve, n'active ni ne paie jamais (circuits à personnes distinctes maintenus). Taux affichés « 100 % », jamais
  « 100,000 % » (annexe I, § I.39).
- **Accès aux montants sur autorisation (29/09/2026)** : Trésor, rapprochement, validation financière, contrôle qualité,
  audit et anti-fraude voient les montants nécessaires à leur travail après **approbation préalable d'un membre de la
  direction** (R01, R02, R03, R05), distinct du demandeur, sur motif journalisé, pour une durée limitée (7 jours par
  défaut, 30 au plus — à confirmer) ; chaque utilisation est journalisée (annexe I, § I.40).
- **Espace usager (30/09/2026)** : l'usager n'a rien à vérifier ; tout ce qui le concerne est en un seul endroit, bloc
  « À faire » de « Mon espace » (à faire maintenant / en cours de vérification par l'administration / à jour), avec une
  action par ligne. Le menu des usagers (R30, R31) ne contient ni outils de vérification ni écrans d'agents ; aucun lien
  proposé ne mène à une page réservée (annexe I, § I.41).
- **Contrôles (30/09/2026)** : l'usager ne vérifie pas les agents (un agent n'agit qu'après invitation sur la
  plateforme) ; il présente ses preuves en UN CLIC (« Mes preuves » : bouton de l'en-tête, de « Mon espace » et du menu),
  chacune avec son code QR vérifiable par le résolveur universel (annexe I, § I.42).
- **Paiements (30/09/2026)** : KODA = vérification de la confirmation de l'opérateur (ne touche jamais l'argent), tous
  les opérateurs congolais (Orange, M-Pesa, Airtel, Africell), proposée pour monnaie mobile, QR et USSD ; BitriPay =
  acheminement (monnaie mobile, QR, carte). Une vérification ou confirmation donne une quittance PROVISOIRE ; définitive
  au rapprochement du relevé seulement. **Frais des passerelles à la charge de la Ville** (décision du 30/09/2026),
  facturés à part (coût « API de paiement » du Gouvernorat), jamais retenus sur la recette ; le contribuable paie le
  montant exact de son obligation (annexe I, § I.43 bis).
- **Démonstration BitriPay / KODA (30/09/2026)** : sans clé, « Payer » ouvre une page de paiement SIMULÉE
  (`/demo/passerelle/…`, bandeau explicite, aucun logo) dont le webhook signé passe par la route réelle ; refusée dès
  qu'une vraie clé est configurée. Mise en service réelle : clés + adresse de webhook + « Tester la connexion » + un
  paiement de test (annexe I, § I.45).
- **Redevance de contrôle technique (30/09/2026)** : liquidée à la prise de rendez-vous par la fiche ACTIVE, payée par
  le circuit commun, jamais en espèces au centre ; le centre confirme le créneau après paiement. Tarif réel par
  catégorie et compte bénéficiaire à confirmer (démo : barème fictif) — annexe I, § I.46.
- **Marque des documents (30/09/2026)** : tout document généré (PDF, impression, page HTML du serveur, avis, quittance,
  carte, preuve) porte l'en-tête Ville de Kinshasa / « Ville-Province de Kinshasa » / KINSHASA MOSOLO + filet tricolore
  et le pied « réalisée par Groupe Nseya » (composants `PrintLetterhead` / `PrintFooterMark`, `core/brand.ts`, PDF
  commun) — annexe I, § I.48.
- **Groupe Nseya selon la phase (30/09/2026)** : en démonstration, lecture globale (aucun « Accès refusé » en lecture) ;
  plateforme en service : périmètre propre seulement (moteur de paiement/répartition, grand livre, trésor en agrégats,
  règles, audit, supervision) — jamais les tableaux du Gouverneur ni les opérations quotidiennes des services (liste à
  confirmer). Jamais d'écriture ; dossiers personnels par consultation motivée (C42-05) — annexe I, § I.50.
- **Agents de terrain rattachés (30/09/2026)** : R09/R10/R11 ne contrôlent, scannent et vérifient que dans leurs modules
  de rattachement (serveur : `MODULE_NON_RATTACHE` ; menu filtré) ; rattachement par l'administrateur de l'entité,
  journalisé — annexe I, § I.51. Interface en français tant que les traductions ne sont pas validées.
- **Anti-fraude des preuves (30/09/2026)** : plaque lue obligatoire (écart ⇒ blocage conservatoire + dossier) ; QR animé
  exigé pour les pass personnels ; copies détectées à chaque scan ; gilets par numéro refusés ; vignettes techniques
  signées ; mémoire hors ligne ; chaîne de la fraude, instruction, décision par une personne distincte, recette perdue
  facturée au titulaire — jamais de sanction automatique (annexe I, § I.52).
- **Accueil et traduction (30/09/2026)** : « / » reste la page d'accueil pour tout compte (bouton « Ouvrir mon espace de
  travail » ; `/?travail` pour l'ouverture directe) ; traduction automatique de l'écran par Google Cloud Translation
  (mention « la version française fait foi ») ; seuils anti-fraude confirmés — annexe I, § I.53.
- **Réforme de la DGRK (30/09/2026)** : DGRK remplacée par DGIPK (impôts provinciaux) et DGTK (droits, taxes et
  redevances) ; les dossiers repris de l'e-DGRK sont aiguillés (fiche du registre, sinon table « par défaut — à
  confirmer », sinon arbitrage motivé par une personne distincte) ; compte démo KIN-DGRK-MM-01 libellé « ancienne DGRK
  (historique) » ; **pas de section propre au programme routier** (système de recettes) : il figure comme projet
  `GOUV-ROUTES` dans « Projets publics et emploi des fonds » (propositions de l'IA), chiffres annoncés à confirmer, coût
  « à confirmer » — l'IA le cite sans le classer tant qu'une personne n'a pas saisi le coût. Répartition officielle DGIPK / DGTK attendue du
  Gouvernorat (annexe I, § I.54).
