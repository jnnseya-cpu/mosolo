# Annexe I — Modules construits et couverture des exigences

Cette annexe décrit, **tel que construit et testé**, le logiciel qui met en œuvre le présent document. Elle résulte d’un audit exhaustif des quatre documents sources (Cahier des exigences consolidé v2, Spécification fonctionnelle des modules, Dossier du Gouverneur, Note exécutive) et du prompt « AI Operating System » : **3 793 exigences** relevées une à une, comparées au code, puis construites par lots. Les arbitrages du présent document (Annexe H) prévalent sur les sources en cas de contradiction.

## I.0 Architecture d’extension et synthèse

Chaque verticale ou fonction transverse est un **module d’extension** qui réutilise le socle commun : compte unique, registre des règles à quatre visas, liquidation déterministe, paiement par référence vers le compte public, quittance signée, rapprochement à trois voies, grand livre, audit chaîné et communications. **Aucun module n’a son propre compte contribuable, ses propres règles ni son propre circuit de paiement** (§ 11.3). Les droits d’accès de chaque module sont déclarés dans le point de décision central (actions `module:action`, refus par défaut, jamais permises à l’IA).

| Module | Extension(s) | Routes API | Écrans | Tests backend |
|---|---|---|---|---|
| Socle technique : persistance, identité et sécurité | `socle` | 14 | 1 | 20 |
| Accès, entités, invitations, mandats et identité | `acces` | 63 | 7 | 24 |
| Fiscal : biens, déclarations, exonérations, quitus | `fiscal` | 39 | 9 | 19 |
| Trésor et cycle complet de la quittance | `tresor` | 23 | 0 | 11 |
| Registre juridique complet, avis et recouvrement | `recouvrement` | 33 | 3 | 22 |
| Moteur de titres, RakaPay et pass wewa | `titres + rakapay` | 43 | 3 | 28 |
| Stationnement (ParkSmart) et publicité (KIN PUB CONTROL) | `parking + publicite` | 58 | 9 | 22 |
| Verticales branchées sur l’API, AVIA, NFIU, CALCU | `verticales` | 43 | 4 | 22 |
| Canaux : USSD, SVI, enrôlement assisté, points de paiement agréés | `canaux` | 33 | 7 | 27 |
| Opérations de terrain, sous-traitance et badges | `terrain` | 47 | 4 | 9 |
| Intégrité : signalement, enquêtes, incidents, données personnelles | `integrite` | 52 | 6 | 25 |
| Pilotage sur données réelles, indicateurs et transparence | `pilotage` | 15 | 4 | 16 |
| Système d’exploitation de l’IA (AI OS) | `ia` | 28 | 3 | 19 |

Ensemble (27/09/2026) : **631 routes** (catalogue généré et vérifié en intégration continue : `specs/routes-api.md`), 73 écrans de modules (80 routes d’écran) en plus des écrans du socle, **548 tests backend**, 101 tests d’interface et 32 tests du paquet partagé, tous au vert, et une analyse statique (ESLint) bloquante en intégration continue ; l’application complète (socle et 17 modules d’extension) est couverte par un test d’intégration et par la persistance sur un vrai PostgreSQL en intégration continue. Chaque écran a été contrôlé à 390 px et 1 440 px sans défilement horizontal.

**Garde-fous vérifiés par les tests, pour tous les modules.** Aucun montant sans règle ACTIVE ; aucune sanction, pénalité, immobilisation, suspension ou blocage automatique (le système constate et propose, une personne habilitée décide avec motif, séparation des tâches) ; fonds uniquement vers les comptes publics du coffre ; aucun encaissement par un agent, un contrôleur, une coopérative ou un sous-traitant ; aucune quittance sur capture d’écran ou SMS ; jamais de double perception d’un même fait générateur (garde du moteur de liquidation et revendication unique par entité) ; vérifications publiques sans nom ni adresse ; l’IA propose, l’humain décide.

## I.1 Socle technique : persistance, identité et sécurité

Le module « socle » donne au monolithe modulaire les fonctions transverses qu'exige la mise en service : une persistance PostgreSQL, une authentification réelle, une limitation de débit et une chaîne d'intégration continue. Rien de cela ne change le fonctionnement par défaut. Sans `DATABASE_URL`, les données restent en mémoire. L'en-tête de démonstration `x-demo-user` n'est accepté que si `MOSOLO_DEMO_MODE` vaut explicitement `true`, et jamais lorsque `NODE_ENV=production` (démarrage refusé). Le développement local (`npm run dev`), les tests et l'intégration continue l'activent explicitement ; hors démonstration, le serveur exige les secrets réels des prestataires.

**Persistance.** Le serveur découvre automatiquement tous les dépôts de l'application, ceux du socle comme ceux des modules d'extension, et les nomme par leur chemin (`payments.orders`, `ledger.entries`…). Chaque écriture est journalisée dans PostgreSQL. Les documents modifiables vont dans `repository_snapshot` (JSONB, mise à jour par UPSERT). Les journaux en ajout seul vont dans `append_only_journal` : audit chaîné, grand livre, délivrances, observations, alertes et preuves. Dans cette table, un déclencheur refuse toute modification ou suppression. Au redémarrage, l'instantané est rechargé et la chaîne d'audit est vérifiée. Les générateurs d'identifiants repartent au-delà des numéros déjà attribués. Les migrations sont versionnées et chaque sauvegarde est un export JSON complet signé (HMAC-SHA256) avec un manifeste SHA-256 par dépôt. Toute restauration est refusée si la signature, le manifeste ou la chaîne d'audit ne se vérifient pas. Cette étape reste transitoire : le schéma relationnel `backend/db/schema.sql` (PostgreSQL + PostGIS) demeure la cible.

**Authentification.** Un fournisseur d'identité local, compatible OIDC, publie une découverte minimale (`/.well-known/openid-configuration`) et ses clés publiques (JWKS). Le contribuable se connecte avec son numéro de téléphone et un code à usage unique envoyé par SMS (événement `auth.otp_code`). Un numéro inconnu reçoit une réponse identique, ce qui empêche de deviner quels numéros sont inscrits. L'agent public se connecte avec son identifiant, un mot de passe (scrypt) et un code TOTP, avec protection contre le rejeu : la MFA vaut pour tout compte de travail. Le serveur émet un jeton EdDSA de 15 minutes, lié à une session serveur révocable. La session dure au plus 4 à 12 heures selon le profil, et 30 minutes sans prolongation sur un appareil partagé. Chaque connexion, chaque échec, chaque verrouillage temporaire (5 échecs, 15 minutes, sans autre effet sur le compte) et chaque révocation est inscrit au journal d'audit. Pour les rôles sensibles, le document maître exige des clés d'accès (passkeys, FIDO2). Leur enregistrement est **[À RACCORDER]** à l'IdP souverain : l'API l'indique explicitement (501) et aucune clé n'est simulée.

**Limitation de débit et exploitation.** Toutes les requêtes passent par une fenêtre glissante, par utilisateur authentifié ou, à défaut, par adresse IP. Elle a trois paliers : global 600/min, routes publiques 60/min, connexion 10/min par IP. Un dépassement renvoie un 429 au format RFC 9457, avec les en-têtes `Retry-After` et `RateLimit-*`. Le premier refus de chaque fenêtre est journalisé. La limitation est temporaire et automatique : elle ne bloque jamais un compte. La chaîne d'intégration continue (`.github/workflows/ci.yml`) installe les dépendances de façon reproductible. Elle contrôle les types et exécute les tests des trois paquets, puis construit le frontend. Un second travail démarre sur un PostgreSQL réel, sauvegarde, vérifie que la base refuse la modification du journal, restaure et redémarre.

**Écran de connexion.** L'écran `frontend/src/modules/socle/Login.tsx` propose deux parcours : contribuable (téléphone puis code) et agent (identifiant et mot de passe, puis code TOTP). En démonstration, il affiche des comptes fictifs avec leur QR TOTP. Une fois connecté, l'utilisateur voit sa session et son niveau d'authentification, peut révoquer ses sessions et se déconnecter. Le sélecteur de démonstration de l'en-tête reste disponible.

| Fonction | Construit | Paramètre / route | Reste à raccorder |
|---|---|---|---|
| Persistance | Instantané JSONB par dépôt, journal en ajout seul protégé, migrations | `DATABASE_URL`, `npm run start:persistent` | Schéma relationnel cible, écriture transactionnelle + outbox |
| Sauvegarde | Export signé, vérification, restauration refusée si altérée | `npm run db:backup / db:verify / db:restore`, `POST /v1/socle/exports` | Copie WORM hors site, exercices trimestriels |
| Contribuable | Téléphone + OTP SMS (5 min, 5 essais, empreinte seule) | `POST /v1/auth/login`, `POST /v1/auth/otp` | Fournisseur SMS réel |
| Agent | Mot de passe + TOTP (MFA pour tous), verrouillage temporaire | idem | Passkeys / FIDO2 pour rôles sensibles, IdP Keycloak |
| Sessions | JWT EdDSA 15 min, JWKS, révocation, appareil partagé | `/v1/auth/me`, `/refresh`, `/logout`, `/sessions` | Jetons en cookie httpOnly (BFF) |
| Démonstration | `x-demo-user`, codes affichés, comptes fictifs | `MOSOLO_DEMO_MODE=true` (défaut désactivé ; refusé en production) | Désactivé par défaut |
| Débit | Fenêtre glissante, 3 paliers, 429 RFC 9457 + audit | `MOSOLO_RATE_LIMIT*` | Passerelle API, détection d'abus |
| CI | Types, tests, construction, PostgreSQL réel | `.github/workflows/ci.yml` | SAST/DAST, SBOM, portes de mise en production |

## I.2 Accès, entités, invitations, mandats et identité

#### Module « acces » — identité avancée, entités, invitations en cascade et arbitrage entre entités

Le module « acces » applique deux principes. Pour le citoyen, un compte unique. Pour les administrations, des espaces propres (§ 10A, § 12A).

Chaque entité reçoit un **espace d'entité**. C'est l'administrateur de la plateforme qui le crée, sur décision écrite du Comité de pilotage (ARB-63). Les entités sont des régies, ministères, communes, services techniques, Trésor, audit, sous-traitants ou opérateurs délégués. Elles sont organisées en arborescence : un administrateur d'entité agit dans son entité et dans ses sous-entités, jamais au-delà.

Chaque service est décrit par une **fiche de configuration de module**. Elle précise l'entité responsable, les comptes bénéficiaires et les règles du registre. Elle précise aussi les types d'objets et de titres, le modèle de validité, les preuves, les canaux et les dépendances. Seuls les alias de comptes publics du coffre sont acceptés.

La fiche suit un circuit à visas donnés par des personnes distinctes :
1. soumission par l'entité ;
2. visa du programme (Cabinet ou Secrétariat général) ;
3. visa juridique avec références d'actes ;
4. recette constatée par l'exploitation technique ;
5. seconde validation par le comité de pilotage, sur référence d'arrêté.

L'activation est refusée tant qu'une règle de la fiche n'est pas au statut ACTIVE. Un module n'a qu'une seule entité responsable à un instant donné. Chaque changement de rattachement exige une seconde validation et laisse un historique. Le rattachement ne détermine aucune part de recettes : la clé 10/10/10/70 et la « part de 10 % » sont écartées (ARB-01, ARB-05).

**Arbitrage entre entités.** Un fait générateur (objet × fait × période) ne peut être revendiqué qu'une fois. Lorsqu'une seconde entité revendique le même fait pour le même objet et la même période :
- la revendication est bloquée ;
- un dossier d'arbitrage est ouvert ;
- aucune obligation n'est créée, donc le citoyen ne voit jamais de double obligation (critère d'acceptation § 10A.4).

Le même mécanisme vaut pour une compétence de module : une seconde fiche sur un domaine déjà rattaché reste bloquée.

Le dossier est d'abord instruit par un juriste, qui rend un avis motivé. Il est ensuite tranché par une autorité distincte, étrangère aux entités en litige et authentifiée par un second facteur. Aucune obligation déjà émise n'est annulée d'office : si elle relève d'une autre entité, la décision le signale et la rectification passe par le circuit de réclamation.

La liquidation « sous garde » procède en trois temps :
- elle vérifie la revendication ;
- elle refuse toute seconde obligation pour le même fait et la même période ;
- elle passe ensuite par le circuit commun (`ctx.assessment`), avec la règle ACTIVE de l'entité.

**Invitations en cascade.** Aucun compte de travail ne naît d'une inscription publique. Le parcours public ne crée que des comptes de contribuable ; il rejette tout champ de rôle. Inviter est une permission explicite, délégable après seconde validation et révocable.

Une invitation est nominative : nom, téléphone, entité, niveau d'accès, rôles, périmètre, date de fin, motif. Elle respecte trois interdits :
- pas d'élévation : le niveau et les rôles accordés sont inférieurs ou égaux à ceux de l'invitant ;
- pas de sortie de périmètre : même entité, même territoire, mêmes modules ;
- pas de rôles incompatibles au sens du § 12.5.

L'invité reçoit un lien et un code à usage unique. Le lien est valable 72 heures, ne sert qu'une fois et ne fonctionne qu'avec le numéro invité. Pour finaliser, la personne présente :
- ce code ;
- une pièce d'identité ;
- une photographie ;
- un second facteur qu'elle définit elle-même (une clé d'accès pour les rôles sensibles) ;
- un terminal enregistré, s'il s'agit d'un agent de terrain.

Certains comptes restent inactifs jusqu'à une seconde validation par une personne distincte de l'invitant :
- rôles sensibles et comptes disposant du droit d'inviter : responsable sécurité ou direction de l'entité ;
- compte du Gouverneur : confirmation hors bande par le Cabinet ou le Secrétariat général ;
- comptes d'audit : autorité d'audit ;
- agents de terrain : habilitation par la régie, sur formation certifiée.

L'opérateur d'accès désigné peut finaliser en présence de la personne une invitation déjà émise par son entité. Il ne modifie ni le niveau ni le périmètre et ne connaît jamais les secrets. La révocation d'un compte est immédiate et révoque aussi ses terminaux ; ses invités sont rattachés au successeur. La suspension d'une entité révoque en cascade tous ses comptes et toutes ses invitations. Chaque étape est journalisée dans le journal chaîné, qui est visible de l'administrateur de l'entité et de l'audit.

**Identité avancée.** Le téléphone est vérifié par un code à usage unique : 5 minutes, 5 essais, empreinte stockée seulement. En bac à sable, le code est journalisé dans une boîte d'envoi de démonstration. Il n'est jamais renvoyé par l'API métier, et cette boîte disparaît dès qu'un fournisseur SMS est branché.

Les niveaux N0-A et N0 à N3 sont calculés à partir de preuves. Chaque pièce est contrôlée par une personne distincte de celle qui l'a saisie, et le niveau ne baisse jamais d'office.

Les personnes morales s'inscrivent avec leurs identifiants RCCM, identification nationale et NIF. Ces identifiants ont le statut probant « déclaré » tant qu'ils ne sont pas contrôlés. L'inscription désigne des représentants nommément habilités. L'enrôlement assisté N0-A se fait avec un consentement devant témoin ou oral enregistré. L'empreinte reste désactivée tant que la question J18 n'est pas certifiée, et l'agent ne reçoit jamais de paiement.

Le système propose les doublons à partir d'une même pièce, d'un même RCCM, d'un même NIF ou d'un même courriel. Une similitude de noms ne suffit pas sans pièce justificative. La fusion suit trois étapes, par trois personnes distinctes : proposition, vérification, approbation. Elle conserve les preuves des deux comptes et reste réversible.

Le contribuable de niveau N1 au moins peut désigner un mandataire. Le mandat précise les actions (consulter, déclarer, payer, contester), les objets et la durée (trois ans au plus). Un mandat de tiers professionnel est réservé aux mandataires certifiés N3. Le mandat est révocable par le mandant ou par le mandataire, et la politique d'accès commune suit immédiatement son état.

**Consultation motivée.** Toute consultation d'un dossier individuel par cette voie déclare sa finalité et son motif. Hors du périmètre de l'agent, l'accès « bris de glace » :
- exige un second facteur ;
- dure 30 minutes ;
- déclenche une alerte à l'audit et à la sécurité ;
- fait l'objet d'une revue a posteriori.

La consultation de son propre dossier ou de celui d'un proche déclaré est refusée, et l'administrateur de la plateforme n'y a pas accès. Une revue qui conclut à une consultation injustifiée ouvre un signalement, sans sanction automatique.

| Fonction | Garde-fou principal | Références |
|---|---|---|
| Espaces d'entité | Création sur décision écrite du Comité de pilotage ; suspension ⇒ révocation en cascade | § 12A.3, § 12A.5, ARB-63 |
| Fiche de module | Visas distincts, recette, seconde validation sur arrêté ; règles ACTIVE ; comptes du coffre seulement | § 10A.4, H.4.3, AC-ENT-02/03 |
| Arbitrage | Seconde revendication bloquée ; avis puis décision motivée d'une autorité étrangère au litige ; aucune annulation d'office | § 10A.3, § 10A.4, J22 |
| Invitations | Droit d'inviter explicite ; pas d'élévation ni de sortie de périmètre ; lien à usage unique, lié au numéro, 72 h | § 12A.2, § 12A.5, AC-INV-01 à 03 |
| Seconde validation | Personne distincte de l'invitant ; hors bande pour le Gouverneur ; habilitation par la régie pour le terrain | § 12A.5, § 12A.6, AC-INV-05 |
| Inscription assistée | Invitation préalable, même entité, niveau conservé, secrets définis par la personne | § 12A.7, AC-INV-04 |
| Vérification d'identité | Code à usage unique jamais exposé en production ; niveaux N0-A à N3 fondés sur des preuves | § 9.1, § 9.2 |
| Doublons et fusion | Aucune fusion sur la seule similitude de noms ; trois personnes ; réversible | § 9.1, § 12.3 |
| Mandats | Périmètre, durée, révocation ; N1 pour le mandant, N3 pour un tiers professionnel | § 9.1, § 13.5 |
| Consultation motivée | Motif obligatoire ; bris de glace avec MFA, 30 min, alerte et revue ; récusation | § 12.1, H.6.8 |
| MFA (simulé) | Second facteur récent pour les actions sensibles ; clé d'accès exigée pour les rôles sensibles | § 12.5, § 12A.5 |

## I.3 Fiscal : biens, déclarations, exonérations, quitus

Le module fiscal (extension `backend/src/plugins/fiscal`, écrans `frontend/src/modules/fiscal`) donne une identité fiscale stable à chaque bien et organise les démarches qui s'y rattachent, sans créer de circuit parallèle : liquidation par le moteur commun et les règles du registre, paiement par le circuit commun, audit chaîné et communications du catalogue. La hiérarchie SIG suit le document maître (§ 16.1, § 17) : commune › quartier › avenue › parcelle › bâtiment › unité. À la **validation** d'un objet par un agent habilité (contrôleur, chef de service ou direction, jamais l'auteur du recensement), le système attribue un **identifiant géographique fiscal** : un UUID interne permanent et un code territorial lisible au format `KIN-LIM-Q001-P000001-U01` (§ 17.3). Le code n'est jamais réattribué et un sous-objet prolonge le code de son parent. Une étiquette QR signée (« QR par bien », NFIU) est émise à la validation, puis posée par un agent. Avant l'acte J27, elle sert à l'identification administrative et n'entraîne aucune restriction de location (ARB-16).

Les **relations contribuable–objet** (propriétaire, copropriétaire, usufruitier, héritier présumé, gestionnaire) sont datées. Elles portent une quote-part, des pièces et un statut probant (déclaré, observé, vérifié, contesté). Une relation sans pièce est refusée. La déclaration d'un contribuable ouvre une instruction et ne vaut jamais preuve de propriété. Un agent distinct du déclarant la valide. Pour un objet de forte valeur, le niveau N2 est exigé. Des revendications qui dépasseraient 100 % sur une même période ouvrent un dossier de conflit, sans qu'aucune donnée de l'autre partie ne soit communiquée. Le conflit est ensuite tranché par une décision motivée. Un détachement (vente, mutation…) clôt la relation sans jamais la supprimer.

La **déclaration pré-remplie** reprend les données connues de l'objet : loyers annuels calculés à partir des baux déclarés, superficie et rang de localité. Le contribuable confirme ou corrige, atteste, puis dépose. Il reçoit un accusé de réception horodaté avec l'empreinte du contenu. Une obligation n'est liquidée que si la règle est ACTIVE (quatre visas). Sinon, le calcul reste une **simulation non opposable**. Un même fait générateur n'est jamais facturé deux fois sur une même période. Une correction à la baisse d'un élément vérifié ouvre une vérification sans bloquer le dépôt. La correction d'une déclaration déjà liquidée est instruite par un contrôleur ; si elle est acceptée, une obligation rectificative est émise par contre-écriture.

Le **registre des exonérations et remises** suit le circuit du § 12.6 : demande, instruction avec base légale obligatoire, visa juridique, puis décision. La base légale doit être un instrument EN VIGUEUR du registre juridique, avec l'article cité. Les deux validations sont données par des personnes distinctes entre elles et distinctes de l'initiateur. Une exonération n'est jamais décidée par l'IA (garde `APPROVE_EXEMPTION`). Son effet est daté et ne rétroagit jamais sans décision expresse de rétroactivité. Une exonération approuvée s'applique aux liquidations suivantes ; le montant brut et la réduction, avec sa base légale, figurent dans la trace et l'explication de l'obligation. Une remise approuvée rectifie l'obligation visée par contre-écriture. Des alertes de concentration (même décideur, même commune) sont proposées à l'audit.

Le **quitus fiscal numérique** n'est délivré que si aucune obligation exigible n'est impayée. Les obligations en recours sont exclues, sauf refus exprès de l'effet suspensif (ARB-17). Chaque obligation exigible doit être soldée sur **quittance définitive** : un paiement seulement confirmé ne suffit pas. Sa validité est limitée (90 jours, seuil ambre à 15 jours, paramètres de démonstration). Il est vérifiable par QR sans nom ni montant, l'identifiant du contribuable étant masqué, et par l'API des services (R37). Il est révocable sur décision motivée ; la revue ne fait que proposer. Il reste **informatif** tant que l'acte J6 n'est pas certifié. L'**attestation de bail enregistré** est délivrée au bailleur ou au locataire et se vérifie publiquement sans nom ni loyer. Enfin, la **carte à deux couches** (situation fiscale, et vérification / couverture du recensement) affiche des couleurs calculées par le serveur. Le public ne voit que des agrégats par commune, masqués sous 20 objets. Le contribuable voit ses biens, l'agent son périmètre, sans aucun montant.

| Fonction | Garde-fou principal | Route clé |
|---|---|---|
| IGF et QR par bien | Validation par une personne distincte ; IGF jamais réattribué | `POST /v1/fiscal/objects/:id/validate` |
| Scan public de plaque | Authenticité, commune, quartier et couleur de situation avec légende générique ; ni nom ni montant (le Cahier prévaut, ARB-76 révisé) | `GET /v1/public/fiscal/plates/:code` |
| Relations | Pièce obligatoire ; N2 pour forte valeur ; conflit > 100 % | `POST /v1/fiscal/relationships` |
| Déclaration pré-remplie | Règle ACTIVE sinon simulation non opposable ; anti-double facturation | `POST /v1/fiscal/declarations` |
| Exonérations / remises | Base légale du registre ; 2 validations distinctes ; jamais l'IA ; pas de rétroactivité sans décision | `POST /v1/fiscal/exemptions/:id/decision` |
| Quitus | Quittances définitives ; recours exclus ; informatif (J6) ; révocation motivée | `POST /v1/fiscal/clearances` |
| Attestation de bail | Parties du bail seulement ; vérification sans nom ni loyer | `POST /v1/fiscal/leases/:id/attestations` |
| Carte à deux couches | Agrégats publics ≥ 20 objets ; aucun montant | `GET /v1/fiscal/map` |

## I.4 Trésor et cycle complet de la quittance

Le module « tresor » achève la chaîne financière décrite aux chapitres 18 à 20 : une quittance n'est plus seulement émise puis rendue définitive, elle peut aussi être annulée, remplacée, contrepassée ou remboursée, et réimprimée en duplicata. Toute modification d'état suit une décision humaine motivée, proposée par une personne et validée par une autre (quatre yeux). Aucune quittance n'est jamais supprimée ni ne « expire » : son statut public évolue. La vérification publique, sans authentification, renvoie un statut minimal (valide, en attente, annulée, contrepassée, remboursée, remplacée par la quittance n° …, suspecte, inconnue), le motif générique et la date du statut, sans nom, adresse ni historique. Un remplacement produit un nouveau numéro repris des données faisant foi (le montant, la référence de paiement et la transaction ne changent jamais) ; l'ancienne quittance renvoie vers la nouvelle. Un duplicata garde le même numéro et la même signature, porte la mention « DUPLICATA n° k », est horodaté et compté ; un duplicata présenté mais jamais délivré est déclaré suspect.

La vérification publique est protégée contre l'énumération : le chiffre de contrôle du code court est vérifié avant toute recherche, et le débit est limité par poste (30 vérifications par minute, 10 codes inconnus par quart d'heure, réponse 429 avec délai d'attente). Le poste n'est connu que par une empreinte salée et tronquée. Le journal des vérifications est agrégé (compteurs par jour et par résultat, nombre de postes distincts) et réservé au Trésor, à l'audit, à l'anti-fraude et à la sécurité. Pour les contrôleurs hors connexion, une liste de révocation signée Ed25519 (codes et statuts uniquement) est publiée à côté de la clé publique des quittances (§ 19.3).

Côté Trésor, les exceptions de rapprochement sont rangées dans les quatre files du § 20 (paiement sans obligation, obligation payée sans règlement, règlement sans paiement identifié, écart de montant, de devise ou de compte). Chaque exception a une échéance de 48 heures, un responsable (affecté parmi les analystes de rapprochement ou comptables publics), un état (ouverte, en cours, résolue, classée), des justificatifs référencés par empreinte SHA-256 et un historique. La clôture est proposée par la personne affectée, avec motif, et validée par un comptable public distinct ; un dépassement de délai est signalé une fois au Trésor. Un crédit non identifié peut être porté, par cette même validation, au compte d'attente : le suspens est daté (date de valeur), justifié, suivi par ancienneté (0–2 j, 3–5 j, 6–30 j, plus de 30 j) et apuré en double validation, soit par affectation à un paiement confirmé du même montant et du même compte public (rapprochement, quittance définitive, obligation soldée), soit par restitution à l'émetteur d'origine.

Les opérations financières sensibles passent toutes par la double validation : annulation et remplacement de quittance, contrepassation d'un paiement (contre-écriture liée à l'original, paiement « contrepassé », quittance « contrepassée », obligation de nouveau exigible, notification), remboursement (seulement après rapprochement ou sur doublon, montant payé exactement, vers l'instrument d'origine — aucun compte ne peut être saisi), contre-écriture d'une écriture du grand livre, apurement de suspens et paramétrage de la nomenclature. L'auteur ne peut pas valider sa propre proposition ; un agent d'IA ne peut ni proposer ni valider. Chaque proposition, validation ou rejet est journalisé avec son motif.

La comptabilisation suit l'échelle v3.0 : un paiement rapproché devient « Comptabilisé » lorsqu'il est imputé selon une nomenclature paramétrable (les codes livrés sont fictifs et marqués DÉMO tant que la nomenclature officielle n'est pas fournie ; un code n'est réputé officiel que s'il cite son acte). La clôture quotidienne couvre toutes les écritures non encore clôturées jusqu'à la journée choisie (heure de Kinshasa) ; elle enregistre les totaux par devise, l'équilibre, les exceptions, suspens et imputations en attente, et son empreinte SHA-256 est chaînée à la précédente puis signée Ed25519. La clôture mensuelle exige que toutes les écritures du mois soient couvertes et imputées. L'export vers la comptabilité publique (CSV séparé par points-virgules ou JSON) ne contient aucune donnée nominative, porte l'empreinte et la signature du contenu, et signale les codes de démonstration.

| Fonction | Règle appliquée | Qui propose | Qui valide / consulte |
|---|---|---|---|
| Annulation de quittance | Provisoire ou suspecte seulement, paiement non réglé | Trésor (R17), analyste (R18), contentieux (R20), guichet (R12) | Comptable public distinct (R17) |
| Remplacement de quittance | Nouveau numéro, données faisant foi, renvoi public | idem | R17 distinct |
| Contrepassation | Paiement confirmé ou contesté ; contre-écriture liée | R17, R18 | R17 distinct |
| Remboursement | Après rapprochement ou doublon ; instrument d'origine uniquement | R17, R18 | R17 distinct |
| Duplicata | Même numéro, mention DUPLICATA n° k, compteur audité | Contribuable (sa quittance), mandataire, guichet, Trésor | — |
| Exceptions (4 files) | Délai 48 h, responsable, justificatif, motif | Personne affectée (R17/R18) | R17 distinct ; lecture R22 |
| Compte d'attente | Daté, justifié, ancienneté, apurement à quatre yeux | R17, R18 | R17 distinct ; lecture R22, R23 |
| Clôtures | Quotidienne chaînée et signée ; mensuelle si tout est clôturé et imputé | R17 | Lecture R18, R22, R23, R05 |
| Imputation / export | Nomenclature paramétrable (codes DÉMO), export signé sans nominatif | R17 | Export R17, R22, R23 |
| Vérification publique | Statut minimal, clé de contrôle, 30/min et 10 inconnus/15 min par poste | Public | Journal agrégé : R17, R22, R24, R28 |

## I.5 Registre juridique complet, avis et recouvrement

#### Recouvrement gradué, avis légaux, arriérés et recours (module d'extension « recouvrement » et compléments du registre)

Le registre juridique couvre désormais tout le cycle de vie d'une règle au-delà de la publication. Une règle PUBLIEE ou ACTIVE peut être **suspendue** par l'autorité de publication (R16) sur décision motivée (autorité et motif obligatoires) : elle cesse immédiatement de produire des obligations, et la levée, elle aussi motivée, lui rend son statut antérieur. L'**abrogation** est datée et citée : l'instrument abrogatoire doit figurer au registre et être en vigueur ; à compter de la date, la règle passe ABROGEE et toute liquidation est refusée ; en cas de date passée, les obligations émises depuis sont signalées pour examen, jamais annulées d'office. L'abrogation d'un instrument l'inscrit sur la liste noire et signale les règles qui le citent, sans abrogation automatique. Chaque version porte son **historique** en ajout seul (création, visas, entrée en vigueur, suspension, levée, abrogation, remplacement), consultable version par version ; à l'entrée en vigueur d'une nouvelle version, la précédente est close (EXPIREE, « remplacée par »). La **rétroactivité** est bloquée : une nouvelle version dont la date d'effet précède sa publication n'est publiable que si elle cite un acte en vigueur (instrument, article, justification) l'autorisant expressément.

Le **recalcul contrôlé** suit trois temps. La simulation d'impact, sans effet, examine les obligations des versions antérieures : ancien et nouveau montant, sens de l'écart, traitement proposé et motif d'exclusion (obligation soldée, contestée, partiellement payée, émise avant la date d'effet, hausse sans acte de rétroactivité). La décision appartient à la direction de la régie (R06, même entité), personne distincte de l'auteur de la simulation, et exige que la nouvelle version soit ACTIVE. L'application se fait par obligation rectificative : l'originale est conservée (ANNULEE, contre-écriture au grand livre) et la nouvelle porte la version de règle appliquée et son explication complète. Une obligation modifiée entre simulation et décision est écartée.

Les **avis légaux** sont numérotés par nature (AI avis d'imposition, RA rappel, AE échéance dépassée, RL relance, AF notification formelle, MD mise en demeure, ME mesure envisagée, DM décision de mesure, LM levée, EC échéancier). Un avis n'est jamais émis sans ses mentions obligatoires : base légale, montant, échéance, voie et délai de recours, destinataire. Chaque avis porte l'empreinte SHA-256 de son contenu, la preuve de notification (lignes du journal de délivrance du moteur de communications, canal, statut, horodatage) et l'accusé de lecture horodaté enregistré à l'ouverture par le destinataire. L'aperçu est imprimable.

Les **arriérés** sont constatés (âge, tranche de la balance âgée, totaux par devise jamais additionnés entre devises, commune du fait générateur) et **segmentés** selon le § 21.2 (oubli, friction, capacité limitée, contestation, retards répétés, refus présumé à vérifier, grand redevable) avec un profil de risque explicable ; segment et profil sont des aides à l'orientation (`automaticDecision: false`) et ne sont jamais montrés au contribuable. La prescription est calculée à titre indicatif (cinq ans, à vérifier) : elle bloque les mesures et appelle un examen juridique, sans extinction automatique. La reprise d'un arriéré historique exige sa base légale d'origine (un instrument abrogé ne fonde que les exercices nés sous son empire), un avis juridique, un acte interruptif si la prescription indicative est atteinte, et la validation d'une personne distincte (R06).

Le **parcours gradué** combine des rappels amiables datés (J−15, J−3, J+1 avec constat du retard, J+15 avec offre d'assistance), exécutés par la planification sans jamais sauter d'étape, et des étapes au-delà du rappel qui sont toujours une **proposition** d'un agent de recouvrement (R20) suivie d'une **décision motivée** d'une autorité distincte (R21) : notification formelle, mise en demeure (base légale en vigueur obligatoire), mesure d'exécution (nature prévue par l'acte, information préalable du contribuable et recueil de ses observations), levée proposée par le système dès régularisation, classement motivé. Aucune proposition ni décision n'est possible sur un dossier contesté avec effet suspensif demandé ou accordé, sans adresse de notification vérifiée, pendant un paiement en cours de règlement, pendant un échéancier en vigueur, sur une règle suspendue ou une créance à prescription indicative atteinte. Les **échéanciers** ne sont possibles que si un instrument en vigueur les autorise (instrument fictif en démonstration) ; le découpage est exact en unités mineures, le suivi impute les paiements confirmés par le circuit commun, et la défaillance est constatée par une personne. **Pénalités** et **remises** exigent une règle ACTIVE du registre (catégorie PENALITE pour une pénalité ; base de remise déclarée pour une remise), une décision R21 distincte et, pour la pénalité, une liquidation par le moteur commun par un troisième agent ; la remise produit une obligation rectificative.

Les **réclamations** sont typées (bien non détenu, activité fermée, véhicule vendu, information erronée, double imposition, montant erroné), reçoivent un accusé de réception numéroté et scellé, affichent leurs délais (introduction, décision) et un décompte calculé à l'heure serveur, acceptent des pièces par empreinte SHA-256 (dédoublonnées), conservent un historique complet et indiquent la voie de recours suivante avec la décision. L'effet suspensif est demandé par le contribuable et décidé par l'autorité (R21). Le décideur est distinct de l'instructeur et de l'auteur de la liquidation contestée ; le dépassement du délai de réponse est signalé une seule fois à la régie et à l'audit (`appeal.sla_breach`). Tous les délais sont des valeurs de conception à remplacer par l'Édit n° 005/2021.

| Élément | Règle appliquée | Qui décide | Événement / trace |
|---|---|---|---|
| Suspension d'une règle | Motif + autorité ; plus aucune liquidation | R16 | `rule.suspended`, historique |
| Abrogation | Instrument abrogatoire en vigueur ; aucune liquidation après la date | R16 | `rule.abrogated`, `rule.abrogated.effective` |
| Nouvelle version rétroactive | Bloquée sans acte autorisant | 4 visas + acte | `RETROACTIVITY_NOT_AUTHORIZED` |
| Recalcul | Simulation → décision → rectificative ; jamais en défaveur sans acte | R06 (≠ auteur simulation) | `rule.recalculation.*` |
| Avis légal | Mentions obligatoires, empreinte, preuve de délivrance, accusé de lecture | Système / agent | `recovery.notice.issued`, `recovery.notice.read` |
| Rappels J−15, J−3, J+1, J+15 | Datés, un par étape, écart minimal 7 j | Planification | `obligation.due_soon`, `obligation.overdue`, `recovery.reminder.1` |
| Notification formelle, mise en demeure, mesure | Proposition + décision motivée ; garde-fous § 21.3 | R20 propose, R21 décide | `recovery.proposal.*`, `recovery.formal_notice`, `recovery.enforcement.*` |
| Échéancier | Acte requis ; défaillance constatée par une personne | R20 / R21 | `installment_plan.*` |
| Pénalité / remise | Règle ACTIVE ; décision humaine ; liquidation ou rectificative | R20, R21, liquidateur | `recovery.penalty.*`, `recovery.remission.*` |
| Réclamation | Délais, pièces par empreinte, effet suspensif décidé | R20 instruit, R21 décide | `appeal.*`, `appeal.sla_breach` |

## I.6 Moteur de titres, RakaPay et pass wewa

Le **moteur de titres** (plugin `titres`) distingue la quittance, preuve permanente d'un paiement, du titre, droit ouvert limité dans le temps ou dans l'usage. Aucun titre n'existe sans paiement confirmé : une commande de titre crée une obligation par la règle du registre (liquidation déterministe d'une règle ACTIVE, jamais un prix saisi), puis un ordre de paiement du circuit commun ; le titre n'est émis qu'après le rappel signé du prestataire et la quittance provisoire, à laquelle il reste adossé (§ H.11.1). Une référence expirée ou un paiement échoué ferme la commande et annule l'obligation par contre-écriture (aucune dette pour un service non rendu) ; un paiement contrepassé ou une quittance annulée révoque le titre (ARB-22). Chaque type de titre porte une référence d'acte (J21, J28) : un type « acte requis » n'est pas activable. La validité est calculée sur l'heure du serveur, au fuseau de Kinshasa, selon les neuf modèles du § H.11.3, et restituée par six statuts affichés couleur + icône + texte (+ signal sonore au contrôle).

Le **contrôle** accepte le QR dynamique de l'application (HMAC-SHA256 du titre et de la fenêtre de 30 s, régénéré automatiquement : une capture d'écran ou un code copié est refusé à la fenêtre suivante), le QR statique signé Ed25519 (papier, autocollant, gilet), le code court et la plaque. La réponse est minimale — valide, expiré ou invalide — sans nom, adresse ni identifiant de contribuable. Un titre à usage unique est consommé au premier contrôle valide ; toute nouvelle présentation affiche « DÉJÀ UTILISÉ » avec l'heure et le lieu du premier usage et lève une alerte. Hors ligne, le terminal enrôlé télécharge un paquet signé (clé publique, liste de révocation signée, plaques actives), contrôle localement puis synchronise un lot signé HMAC par sa clé : le serveur reconfirme chaque contrôle, détecte les divergences et les doubles usages. Un contrôle négatif ouvre un **constat** à instruire (`legalEffect: AUCUN_MONTANT`) : jamais d'amende, d'obligation, d'immobilisation ni d'encaissement ; le contrôleur auteur ne peut pas en décider. Suspension, levée, annulation et remplacement d'un titre sont des décisions humaines motivées (chef de service ou directeur de l'entité), journalisées.

La **billetterie RakaPay** (plugin `rakapay`) gère opérateurs (public, coopératives, privé), stations géoréférencées, lignes et catalogue de tickets (trajet à usage unique, accès 1, 7 et 30 jours). La station de départ fixe la commune à laquelle la recette est attribuée (`STATION_DEPART`, § 20.3). Le **pass wewa** est un ticket RakaPay à durée (jour en 24 h glissantes, semaine, mois ; seuils ambre 2 h / 1 j / 3 j) lié à la plaque et au conducteur, non transférable ; il se renouvelle en continuité. Le registre des motos (plaque, numéro d'ordre, marque, propriétaire, commune, station d'attache, autocollant QR signé) et des conducteurs (permis, gilet numéroté QR signé, carte conducteur, affectation historisée conducteur ↔ moto) est tenu **gratuitement**. Le conducteur paie son pass (USSD, Mobile Money, point agréé) ; la coopérative accréditée peut payer en groupe (une référence par commune, activation individuelle de chaque pass). La coopérative inscrit et suit ses membres mais n'encaisse pas, ne fixe aucun tarif et ne valide aucun contrôle ; son accréditation et sa suspension sont des décisions humaines motivées.

Le **contrôle protecteur** lit le gilet, l'autocollant, la plaque ou le QR du téléphone : un wewa en vert obtient « rien à payer » et aucun constat n'est possible ; le passager peut vérifier publiquement un gilet (conducteur enregistré, pass vert ou rouge, sans nom). Une période de grâce paramétrable marque les constats comme pédagogiques. Les signalements de prélèvements irréguliers sont reçus sans compte, anonymes, et instruits par la cellule anti-fraude. Le tableau de pilotage expose des agrégats : couverture par station et commune (estimations [EXEMPLE]), conformité au contrôle, paiement numérique (cible 100 %, espèces sur la route : 0), plaintes (délai, part confirmée), tickets, réutilisations détectées et recette par commune.

**Démonstration.** Les tarifs proviennent de deux règles FICTIVES publiées par le circuit complet (quatre visas distincts, `demo: true`) : pass wewa 500 / 3 500 / 15 000 FC (illustration [EXEMPLE] du § H.27.16.1), bus 500 / 1 500 / 9 000 / 30 000 FC. Les tarifs réels restent « acte requis » (J28, J21, J25). Les paiements de démonstration passent par un rappel prestataire signé HMAC traité par le circuit commun.

| Élément | Construit | Garde-fou |
|---|---|---|
| Statuts | Gris, vert, ambre, rouge, bleu, noir ; texte + icône + son | Heure serveur seule (AC-TIT-01, 02, 04) |
| Modèles de validité | Durée courte, journalier (calendaire / 24 h), hebdo-mensuel, exercice, événement, usage unique, carnet, abonnement (consentement), glissant conditionnel | Calcul serveur, plafond, tolérance, seuil ambre par type |
| Émission | Commande → obligation (règle ACTIVE) → ordre → rappel signé → quittance → titre | Type sans acte refusé ; aucun titre sans quittance |
| QR | Dynamique HMAC 30 s ; statique Ed25519 ; code court ; plaque | Capture refusée (AC-TIT-05) ; préfixe par module |
| Contrôle | En ligne, par plaque, hors ligne (paquet + lot signés) | Usage unique une fois (AC-TIT-03) ; constat sans montant (AC-TIT-06) |
| Décisions | Suspendre, lever, annuler, remplacer ; classer / transmettre un constat | Personne habilitée de l'entité, motif, séparation contrôleur / décideur |
| Wewa | Registre gratuit, pass plaque + conducteur, paiement individuel ou groupé, vérification passager | Vert = rien à payer ; coopérative sans encaissement ni contrôle |
| Pilotage | Couverture, conformité, paiement numérique, plaintes, recette par commune | Agrégats uniquement ; estimations [EXEMPLE] |

## I.7 Stationnement (ParkSmart) et publicité (KIN PUB CONTROL)

**MOSOLO Parking (ParkSmart, § 11A ; § H.27.5).** Le module `parking` gère des zones de stationnement délimitées par une géométrie simple (polygone pour une zone, ligne pour une artère), leur capacité (places standard, livraison, PMR, mètres linéaires) et leur rang de localité. Une zone n'est payante que si elle est rattachée à une grille tarifaire qui est une règle ACTIVE du registre juridique (quatre visas, date d'effet atteinte). Sinon elle reste « acte requis » et aucune session ne peut y être vendue. Les deux décisions structurantes du dossier source, la Gombe en zone payante intégrale et le boulevard du 30 Juin en artère payante, sont enregistrées avec ce statut (décision D20, acte J24). La démonstration s'appuie sur deux zones fictives, « DEMO-GOMBE-CENTRE » et « DEMO-LIMETE-LUMUMBA ». Elles sont liées à une grille et à un barème fictifs (`DEMO-PARK-HORAIRE`, `DEMO-PARK-PENALITE`) publiés par le circuit réel et marqués démonstration. La régie peut créer une zone, la rattacher à une grille et la suspendre ou la rouvrir avec un motif. Elle ne saisit jamais de montant.

**Sessions liées à la plaque.** L'usager démarre une session pour une plaque, une zone et une durée (multiple de 15 minutes, dans la limite fixée par l'acte). Le moteur commun liquide alors une obligation sur la règle ACTIVE, au nom d'un compte technique de liquidation. Cette obligation est rattachée à un objet « occupation de voirie » situé dans la commune de la zone : la recette est donc attribuée au lieu du stationnement (§ 20.3). Le paiement passe exclusivement par le circuit commun : ordre de paiement, confirmation signée du prestataire, quittance provisoire, puis rapprochement. La validité court à partir de la confirmation. La prolongation suit le même chemin : chaque achat est une obligation distincte, créée avec une clé d'idempotence. Un rappel « ambre » (événement `ticket.expiring`) est envoyé une seule fois avant l'expiration. L'usager peut terminer sa session et consulter son historique. Un marchand peut payer une session pour la plaque d'un client. Les réservations de voirie (déménagement, chantier, livraison, événement) sont soumises à une décision motivée de la régie. Leur approbation liquide la redevance. La surréservation est désactivée (ARB-14) et la capacité publiée est une borne stricte. Les parkings privés et marchands partenaires sont inscrits, conventionnés ou suspendus sur décision motivée. Leurs places libres sont déclarées par l'exploitant et aucun fonds privé ne transite par MOSOLO.

**Contrôle et constat (RW1, ARB-12).** Le contrôle par plaque rend un résultat minimal (vert, ambre ou rouge, avec l'échéance), sans nom ni adresse, et chaque contrôle est journalisé. Un feu rouge ne crée aucune obligation. Le constat est humain et photographique : empreintes SHA-256 des photos, GPS et heure du serveur, preuves en ajout seul. Le constat de non-paiement est impossible si un titre valide existe. Le superviseur vérifie ensuite le constat ; il doit être une personne distincte de l'agent. Le système prépare alors une proposition selon le barème ACTIF de la zone, ou « acte requis » si aucun barème n'est publié. Une troisième personne décide avec motif. Si la décision retient le constat et que le titulaire déclaré de la plaque est connu, l'obligation de pénalité est liquidée au nom du décideur. Sinon, la décision est tracée sans montant. L'usager présente ses observations avant la décision. Après la décision, sa contestation ouvre une réclamation dans le circuit commun des recours. Le module ne contient aucune route de blocage, de fourrière ou d'encaissement par un agent.

**KIN PUB CONTROL (§ 11B ; § H.27.6).** Le module `publicite` tient l'inventaire géolocalisé des dispositifs. Chaque fiche comporte le type, les dimensions, la surface calculée exactement en décimal, les faces, l'éclairage, les empreintes des photos, l'exploitant (compte unique) ou l'exploitant présumé, un identifiant unique et un jeton de plaque QR. Un objet fiscal `PANNEAU` est créé dès que l'exploitant est connu. L'exploitant déclare ses supports et demande l'autorisation en ligne, pièces jointes par empreinte. La demande est instruite (complément ou proposition) puis décidée par une personne distincte. Quand l'autorisation est accordée, les droits sont liquidés par la règle du registre (démonstration : `DEMO-PUB-SURFACE`, surface × faces × tarif du rang + supplément d'éclairage). Sans règle active, la liquidation est tracée « acte requis », sans montant. L'avis au redevable (base, formule, taux, échéance, voie de recours) et le paiement passent par le circuit commun. Les échéances font l'objet d'un préavis à 30 jours puis d'un avis d'expiration. Seul un inspecteur accrédité (commune, période) peut constater ; son accréditation est révocable et son badge est vérifiable publiquement. L'inspecteur recherche l'autorisation par référence, jeton QR ou texte lu par lecture optique (simple proposition), puis dresse un constat en ajout seul. Un constat non conforme, non déclaré ou de retrait ouvre un dossier : vérification par le superviseur, puis décision motivée par une personne distincte. La décision peut rattacher l'exploitant, constater un retrait et liquider les droits. Elle n'émet aucune pénalité, faute de barème publié. L'exploitant est notifié et peut contester.

**Pilotage.** Les deux tableaux de bord ne présentent que des agrégats. Côté stationnement : occupation et cible de 15 à 25 % de places libres, rotation, recettes confirmées et rapprochées par zone, par place, par mètre linéaire et par commune, taux de conformité au contrôle, priorités de patrouille (usage exclusif du « score »), et garde-fous affichés. Côté publicité : taux d'autorisation, échéances, contrôles par nature, dossiers, régularisations, recettes par m², situation par commune, et qualité des inspecteurs, mesurée par l'exactitude et non par le nombre de sanctions.

| Élément | Parking (ParkSmart) | Publicité (KIN PUB CONTROL) |
|---|---|---|
| Règle de liquidation | Grille de la zone, règle ACTIVE (démo : `DEMO-PARK-HORAIRE`, CDF) | `DEMO-PUB-SURFACE` (démo, CDF) ; sinon « acte requis » |
| Pénalités | Barème ACTIF de la zone (démo : `DEMO-PARK-PENALITE`), après décision motivée seulement | Aucune (barème non publié) |
| Compte bénéficiaire | Alias du coffre `KIN-DGTK-RECETTES-01` | Idem |
| Attribution (§ 20.3) | Commune de la zone (objet d'occupation de voirie) | Commune du support (objet `PANNEAU`) |
| Circuit RW1 | Agent R11 → superviseur R09 → régie R06/R07 → recours R20/R21 | Inspecteur accrédité R11 → R09 → R06/R07 → recours |
| Garde-fous testés | Aucune obligation au contrôle, photo obligatoire, séparation des personnes, pas de fourrière ni de blocage, pas de surréservation, agents sans encaissement | Accréditation obligatoire, constat en ajout seul, instruction ≠ décision, aucun montant sans règle active, vérification publique sans nom |
| Données de démonstration | 4 zones (2 réelles « acte requis », 2 fictives), sessions payées, contrôles, constats, réservation, partenaires | Exploitant fictif, 3 supports déclarés et 1 recensé, autorisations, inspecteur accrédité, dossiers |

## I.8 Verticales branchées sur l’API, AVIA, NFIU, CALCU

#### Module « verticales » — services sectoriels branchés sur le socle

Le module « verticales » est la mise en œuvre de la règle du § 11.3 : chaque verticale (Property, Rental, Business, Mobility, RakaPay, Parking, Advertising, Telecom, Markets & Public Domain, Environment, Ports, Events, Construction, Assets, Recovery, AVIA) est une vue du compte unique, sans compte contribuable propre, sans règle hors registre et sans circuit de paiement parallèle. Le catalogue est servi par le serveur : pour chaque verticale, la composition de modules retenue par l'Annexe H (§ H.5.3), le statut juridique, les prérequis (codes J, G, D), l'entité gestionnaire, la tutelle indicative [À VÉRIFIER], la release, le point de vigilance et les démarches disponibles. Aucune verticale n'est présentée comme « confirmée » : faute de règle sectorielle certifiée, le statut est « base légale existante — textes et barèmes à certifier », « base partielle », « acte requis » ou « cadrage sectoriel préalable ». Les verticales RakaPay, stationnement et publicité sont servies par leurs modules dédiés ; le portail en conserve seulement les cartes.

L'espace de l'usager par verticale est calculé à partir des vraies données du socle : objets du contribuable rattachés par catégorie ou par type (étal, emprise, site télécom, embarcation, événement, chantier, aéronef…), obligations issues du moteur de liquidation, paiements, quittances et démarches. Chaque obligation montre sa règle, sa version et la commune du fait générateur ; en démonstration, les montants proviennent de règles fictives publiées par le circuit réel des quatre visas et portent la mention « Règle fictive de démonstration, non opposable ». Les verticales « acte requis » ou « cadrage requis » (AVIA, ports, stationnement, RakaPay, contribution plastique) n'ont aucune obligation : le serveur les filtre et refuse toute liquidation, avec trace dans l'audit. Le paiement passe toujours par l'ordre de paiement du socle et la confirmation signée du prestataire ; la quittance est provisoire jusqu'au rapprochement.

Les démarches en ligne sont génériques : dépôt idempotent avec pièces transmises par empreinte SHA-256 (le fichier reste chez l'usager), prise en charge par un agent de l'entité gestionnaire, demande de complément, visite sur place consignée par un agent de terrain dans son territoire, proposition motivée, puis décision motivée par une personne distincte de l'instructeur et du visiteur. Le système vérifie et affiche les conditions (visite conforme, droits réglés, étal libre) mais ne décide pas. L'acceptation produit l'effet prévu : création de l'objet déclaré, certificat QR (autorisation d'événement, permis d'occuper la voie, autorisation d'occupation, quitus de chantier), cessation à une date prouvée, attribution d'étal. Les signalements de demande d'espèces sont protégés : instruits par l'anti-fraude, invisibles des agents de la régie concernée, identité du déclarant masquée.

Les spécificités sectorielles couvrent : les marchés sans espèces (plan des marchés et étals, plaque QR d'étal, titre au jour, à la semaine ou au mois liquidé sur la règle active et payé à distance, statut vert, ambre ou rouge calculé à l'heure du serveur, contrôle par scan sans téléphone du commerçant, aucun placier n'encaisse) ; les événements (autorisation, certificat QR, déclaration de billetterie, liquidation par un agent, contrôle de jauge qui constate un écart sans sanction) ; la construction (demande, visite, permis d'occuper la voie, droits de voirie, quitus de chantier délivré seulement après visite conforme et paiement confirmé, sans conditionner d'autre service avant l'acte J6) ; le télécom (rapprochement contradictoire des sites déclarés et observés, jamais de taxation automatique). La plaque NFIU et les plaques d'objets reçoivent un code lisible à clé de contrôle et une signature ; la vérification publique n'indique que l'authenticité, la commune et le quartier (ARB-76) ; le scan d'un agent est journalisé, en lecture seule, sans montant pour l'agent de terrain ; le guichet retrouve les obligations payables par plaque ; un rapport journalier d'activité des agents est produit sans montant.

AVIA (KIN-AVIA FISCUS) est préparée derrière « acte requis » : déclarations mensuelles des compagnies, données d'embarquement et de sortie transmises par l'exploitant (partenaire de données), rapprochement par un analyste, procédure contradictoire en cas d'écart, validation motivée par une autre personne, facturation uniquement sur demande humaine et uniquement si une règle ACTIVE existe — refusée et tracée aujourd'hui. CALCU (module 80) fonctionne en pilote de démonstration : registre des comptes publics validé conjointement par les Finances et l'organe de contrôle, justificatifs par empreinte, passerelle bancaire qui standardise sans analyser, moteur de correspondance vert / ambre / rouge (compte non enregistré, pièces manquantes, surfacturation, paiement répété, fractionnement, bénéficiaire hors objet), rapports d'anomalie numérotés ; aucune opération n'est jamais bloquée et le gel d'un dossier relève d'une décision humaine motivée de l'organe de contrôle, avec base légale citée, clôturée par une autre personne.

| Élément | Construit | Garde-fou |
|---|---|---|
| Catalogue des verticales | 16 verticales servies par l'API (Markets et Public Domain fusionnés, § 11.3) | Aucun statut « confirmé » ; tutelle marquée [À VÉRIFIER] |
| Espace de l'usager | Objets, obligations, quittances, démarches, certificats par verticale | Vraies données du socle ; aucune obligation en « acte requis » |
| Démarches en ligne | Dépôt, pièces par empreinte, complément, visite, proposition, décision | Décideur distinct de l'instructeur et du visiteur ; motif obligatoire |
| Marchés | Plan, étals, plaque QR, titres jour / semaine / mois | Paiement par le circuit commun ; aucun placier n'encaisse |
| Événements | Autorisation, certificat QR, billetterie, liquidation, contrôle de jauge | Double facturation refusée ; écart constaté sans sanction |
| Construction | Demande, visite, permis d'occuper la voie, droits, quitus | Quitus seulement après visite conforme et paiement confirmé |
| Plaques (NFIU et objets) | Pose, remplacement, scan agent, guichet, rapport journalier | Vérification publique minimale ; aucun montant modifiable |
| Télécom | Rapprochement déclaré ↔ observé | Vérification contradictoire, jamais de taxation automatique |
| AVIA | Déclarations, données exploitant, rapprochement, contradictoire, validation | Aucune facturation automatique ; refus « acte requis » tracé |
| CALCU | Registre des comptes, justificatifs, correspondance, rapports | Aucun paiement bloqué ; gel humain motivé du seul dossier |

## I.9 Canaux : USSD, SVI, enrôlement assisté, points de paiement agréés

Le module « canaux » met en œuvre la promesse du § 13A et du § H.7 : personne n'est exclu de l'enrôlement, du paiement ou de la preuve de paiement faute de téléphone, de connexion ou d'alphabétisation. Il ne crée aucun circuit parallèle. Les comptes sont ceux du compte unique, les montants viennent d'obligations liquidées sur une règle ACTIVE. Les paiements passent par la référence du circuit commun et par une confirmation signée, et les fonds vont uniquement vers les comptes publics du coffre. Dans la démonstration, les montants proviennent de la règle fictive DEMO-IF-BATI. Le code USSD et le numéro vert du SVI restent « À CONFIGURER » jusqu'aux conventions avec les opérateurs (J29, décision 10, D15).

L'enrôlement assisté (module 63) fonctionne à domicile, sur site ou au guichet MOSOLO, même sans réseau. L'agent enregistre les dossiers sur son terminal enrôlé. Il les transmet ensuite en lot signé par la clé HMAC de ce terminal, qui doit être affecté à l'agent ; un terminal révoqué est refusé. Chaque dossier est contrôlé séparément : zone et plage horaire de l'agent, lecture du résumé (version audio identifiée) avant le consentement, et consentement par voix enregistrée ou devant un témoin identifié. L'empreinte digitale reste fermée tant que J18 n'est pas certifié (ARB-24). L'agent doit aussi attester qu'aucun paiement n'a été demandé ni reçu. Tout refus est journalisé. Le dossier accepté crée un compte N0-A et une carte MOSOLO. Un doublon possible, même nom ou même téléphone, donne un dossier « à revoir ». C'est un superviseur distinct de l'agent qui tranche : jamais de fusion automatique. L'avis à pictogrammes est produit en données structurées : ce qui est dû, l'échéance, les lieux de paiement et les actions payer, contester et vérifier. Chaque couleur y est doublée d'une forme.

La carte MOSOLO (module 65) porte un numéro de 12 chiffres avec clé de Luhn, qu'on peut saisir sur un clavier basique, et un QR signé Ed25519 qui ne contient aucune donnée personnelle. La vérification publique ne renvoie que « authentique et active », « bloquée », « révoquée » ou « non authentique ». Le guichet, l'agent, le titulaire ou son mandataire peuvent bloquer la carte immédiatement, y compris par l'USSD ou le SVI. La réémission exige une seconde personne ; l'ancien QR renvoie alors « carte révoquée ». Le code secret des canaux USSD et SVI n'est conservé que sous forme d'empreinte scrypt salée. Trois erreurs verrouillent le canal pour ce compte pendant 15 minutes : c'est une mesure de protection, avec alerte, et non une sanction.

L'USSD (module 6) et le SVI (module 64) partagent un même moteur de session et les mêmes parcours : solde et obligations, payer, vérifier une quittance, mes quittances, points de paiement, langue, carte perdue. Un écran USSD fait au plus 182 caractères. Aucune donnée sensible complète n'est affichée (AC-INC-03) : ni nom, ni adresse, ni historique détaillé, et les montants n'apparaissent qu'après le code secret. Le SVI énonce les montants en toutes lettres, par exemple « cent cinquante dollars américains », et épelle la référence. « Payer » émet ou réaffiche la référence du circuit commun au nom du seul titulaire. Chaque session est journalisée avec le numéro appelant sous forme d'empreinte, et la saisie du code secret est toujours masquée. Une session expire après 3 minutes d'inactivité. Les langues nationales sont sélectionnables, mais leurs messages vocaux restent signalés « à valider par des relecteurs natifs ».

Les points de paiement agréés (module 66, R32) sont référencés par le Trésor à partir d'un agrément. Une seconde personne du Trésor les active, et ils deviennent alors des prestataires habilités dotés d'un secret de signature. L'opérateur saisit la seule référence, ou présente la carte pour faire émettre une référence : le montant est lu dans l'ordre et ne peut pas être transmis. L'encaissement est confirmé par le rappel signé commun (HMAC, nonce, horodatage) : seule cette confirmation produit la quittance provisoire, puis la quittance devient définitive après le relevé du compte public. Le reçu imprimable porte le QR signé et un code court de 6 caractères avec contrôle ; une réimpression porte la mention DUPLICATA. La caisse est clôturée chaque jour puis rapprochée du versement bancaire, par compte public du coffre. Un compte hors coffre est refusé. Un écart ou un retard ouvre une exception et une proposition de suspension ; le Trésor décide avec motif (ARB-12), et le point suspendu perd immédiatement son habilitation. La vérification par code court limite la fréquence et alerte en cas d'énumération.

| Fonction | Route principale | Rôles | Garde-fou |
|---|---|---|---|
| Session USSD / SVI | `POST /v1/ussd/sessions`, `/v1/ivr/sessions` (+ `/:id/input`) | Passerelle opérateur (simulateur) | Code secret haché, 182 caractères, rien de sensible, expiration 3 min |
| Enrôlement assisté | `POST /v1/assisted-enrolments/batches` | R10 (dans sa zone), R12 | Lot signé, résumé lu + consentement, horaire, aucun paiement |
| Revue des doublons | `POST /v1/assisted-enrolments/:id/review` | R09 | Personne distincte de l'agent, motif |
| Avis à pictogrammes | `GET /v1/pictogram-notices/:taxpayerId` | R09, R10, R12, R30 (lui-même), R31 | Initiales seulement |
| Carte MOSOLO | `GET/POST /v1/mosolo-cards/:n` (block, pin, reissue-requests) | R10, R12, R09, R30, R31 | Réémission sous double validation |
| Vérification publique | `GET /v1/public/short-codes/:code`, `/v1/public/mosolo-cards/verify` | Public | Réponse minimale, limitation 10 par 10 min et 5 échecs |
| Registre des points | `GET/POST /v1/payment-points` (+ activate, suspend, reinstate) | R17 (R18, R22, R24 en lecture) | Quatre yeux, suspension humaine motivée |
| Encaissement | `POST /v1/payment-points/:id/collections` | R32 opérateur du point | Référence seule, plafonds, confirmation signée, idempotence |
| Caisse et versement | `POST /v1/payment-points/:id/cash-days/:day/close` et `/deposit` | R32 | Comptes du coffre, exception si écart ou retard |
| Indicateurs | `GET /v1/channels/indicators` | R01–R29, R36 | Agrégats seulement |

## I.10 Opérations de terrain, sous-traitance et badges

#### Opérations de terrain, sous-traitance et badges vérifiables (module « terrain »)

Le module « terrain » met en œuvre les chapitres 15 et 15A du Cahier tels qu'arbitrés au § H.8 : il organise le travail des équipes internes de la régie et des sous-traitants accrédités, depuis l'invitation d'une structure jusqu'au contrôle de la qualité de ses constats. Son principe cardinal est inscrit dans le code : ni agent, ni sous-traitant, ni responsable de module ne touche l'argent public, ne crée une dette ou ne valide seul ses propres résultats. Le module ne contient aucune fonction d'encaissement, n'appelle jamais le circuit de paiement et n'accepte aucun champ de montant dans ses formulaires ; un constat terrain garde le statut probant « observé » et ne produit jamais d'obligation.

Un sous-traitant n'entre dans la plateforme que sur invitation de la régie, après une sélection conduite hors plateforme. Il complète son dossier (RCCM, NIF, références, capacité), la régie enregistre sa diligence (existence légale, quitus fiscal, absence de conflit d'intérêts, liens déclarés avec des agents publics), puis l'accréditation suit un circuit maker-checker : une personne propose, une autre approuve. L'accréditation est donnée par module et par commune, pour une durée limitée, et commence par une période probatoire sur un lot réduit (cinq agents au plus), conformément au § H.24.4. La confirmation, la suspension, la levée et le retrait sont des décisions humaines motivées ; la suspension d'un sous-traitant révoque d'un coup ses agents, leurs badges et leurs terminaux. Les agents invités par un gestionnaire restent inactifs tant que la régie ne les a pas habilités (identité vérifiée, certificat de formation valide, engagement déontologique, terminal enrôlé) ; chaque habilitation délivre un badge numérique à code court et QR signé.

Les missions sont bornées dans le temps et dans l'espace : commune, quartier, point central et rayon, objets assignés, objectif chiffré, consignes et échéance. Un sous-traitant ne peut créer ni affecter de mission hors du lot qui lui est attribué (commune, quartiers, période) ; l'affectation refuse un agent non habilité, hors zone, d'une autre structure, ou déclaré lié au quartier ou aux objets visés. L'agent capture hors ligne sa position, la précision du GPS, l'empreinte SHA-256 de sa photo (jamais le fichier) et ses observations ; à la synchronisation, chaque constat est scellé par l'empreinte de son contenu et rejouable sans doublon. Toute opération éloignée du point enregistré au-delà de la tolérance de la commune est signalée — « Opération effectuée à 430 m du point enregistré — vérification requise » — puis revue par un superviseur, jamais rejetée automatiquement.

Le contrôle qualité est indépendant du producteur des constats. Un superviseur ou un contrôleur de la régie tire un échantillon aléatoire d'au moins 5 % des constats soumis, auquel s'ajoutent tous les constats à risque (écart GPS, hors zone, GPS imprécis) ; chaque constat retenu fait l'objet d'une contre-visite confiée à un autre agent de la régie, qui constate à l'aveugle. La contre-visite produit une proposition ; la validation ou le rejet reste une décision motivée d'un réviseur qui n'est ni l'auteur ni membre de sa structure, et un constat revu est figé. Le tableau de qualité donne, par agent et par sous-traitant, le taux d'erreur mesuré par contre-visite, le taux de rejet, les écarts GPS, les délais de revue et les résultats des contrôles mystère, eux-mêmes publiés sous forme agrégée. Une irrégularité ouvre une alerte et une proposition d'examen : aucune sanction n'est automatique.

La rémunération des sous-traitants suit l'arbitrage RW6 : elle n'est jamais un pourcentage des recettes ni un montant lié à ce que paient les contribuables. Le module calcule seulement une estimation indicative, livrables vérifiés (constats validés après contrôle, missions achevées dans les délais) multipliés par les prix unitaires du contrat, le paiement réel intervenant sur crédit budgétaire, hors plateforme, après certification par la régie. Enfin, tout citoyen peut vérifier un agent sans compte, par le code du badge ou son QR : la réponse (valide, suspendu, révoqué, expiré ou inconnu) indique le nom d'usage, la structure, le module, la zone et la période, sans téléphone ni adresse ; un badge inconnu ou un agent qui demande de l'argent peut être signalé anonymement, et le signalement est transmis à l'enquêteur anti-fraude.

| Fonction | Règle appliquée | Écran / route |
|---|---|---|
| Accréditation des sous-traitants | Invitation après sélection ; diligence ; maker-checker ; par module et commune ; durée limitée ; probation sur lot réduit (≤ 5 agents) | Sous-traitants et équipes · `/v1/terrain/subcontractors` |
| Agents et habilitation | Compte nominatif inactif jusqu'à l'habilitation par la régie ; plafond d'agents ; suspension motivée révoquant badge et terminaux | `/v1/terrain/agents/:id/habilitation`, `/suspend` |
| Badge vérifiable | Code court à caractère de contrôle + QR signé ; vérification publique minimale ; signalement anonyme | Vérifier un agent · `/v1/public/agent-badges/:code` |
| Missions | Zone, période, objectifs ; aucune mission hors lot ; interdiction du quartier et des objets déclarés de l'agent | Supervision terrain · `/v1/terrain/missions` |
| Constats | GPS et précision, empreinte SHA-256 de la photo, scellé, horodatage ; écart au point enregistré signalé selon la tolérance communale ; aucune dette | Écran agent `/terrain` · `/v1/terrain/missions/:id/findings` |
| Contrôle qualité | Échantillon ≥ 5 % + 100 % des cas à risque ; contre-visite par un autre agent de la régie ; décision humaine motivée ; taux d'erreur par agent et sous-traitant | Supervision terrain · `/v1/terrain/quality` |
| Contrôles mystère | Planifiés et consignés par l'audit ou l'enquêteur ; alerte et proposition en cas d'irrégularité ; publication agrégée | `/v1/terrain/mystery-checks`, `/v1/public/terrain/mystery-checks/summary` |
| Rémunération | Calcul indicatif : livrables vérifiés × prix unitaires du contrat ; jamais sur les montants payés ; paiement sur crédit budgétaire hors plateforme | `/v1/terrain/subcontractors/:id/remuneration` |

## I.11 Intégrité : signalement, enquêtes, incidents, données personnelles

#### Module Intégrité — ligne de signalement, anti-fraude, incidents, protection des données

Le module Intégrité réunit les dispositifs par lesquels KINSHASA MOSOLO rend la fraude difficile à commettre, rapide à détecter et impossible à effacer, sans jamais promettre sa disparition (§ 18A.8, § 25, modules 40, 45, 51 et 69). Il suit la même doctrine que le reste de la plateforme : **le système constate et propose, une personne habilitée décide, avec motif, et tout est journalisé dans le journal d'audit chaîné**. Aucune alerte, aucun contrôle mystère, aucune conclusion d'enquête ne produit de sanction, de suspension ni de blocage automatique : chaque objet porte la mention « effet automatique : aucun » et un agent d'IA ne peut ni qualifier, ni classer, ni décider (garde `assertAiMay`).

**Ligne de signalement protégée.** Toute personne peut signaler, sans compte, une demande d'espèces, un faux agent, une fausse quittance, un point de paiement irrégulier, un prélèvement sur un wewa ou un sous-traitant qui encaisse, par le web, par SMS (mot-clé `SIGNAL`), par le serveur vocal ou par l'intermédiaire d'une opératrice du numéro gratuit ou d'un guichet. SMS et serveur vocal sont simulés en démonstration ; les numéros courts restent à attribuer. L'anonymat est possible : aucune coordonnée n'est alors conservée. Sinon, les coordonnées sont chiffrées (AES-256-GCM) et ne sont renvoyées par aucune route ; elles ne servent qu'aux accusés de réception, adressés sous le nom « Signalant protégé ». Le signalant reçoit une seule fois un **code de suivi secret** de douze caractères, dont seule une empreinte HMAC est stockée. Ce code lui permet de consulter l'état de son signalement, de lire les messages de la ligne et d'ajouter des éléments ou des pièces. Les pièces ne sont jamais téléversées : seule leur empreinte SHA-256 est transmise. Chaque signalement suit le cycle Reçu → Qualifié → Transmis → Clos. Il a des délais de qualification et de traitement suivis au tableau de bord ; ces délais de démonstration restent paramétrables. **Une personne mise en cause n'y a jamais accès**, même si elle est enquêteur : le refus est journalisé. Elle ne peut pas non plus être désignée pour l'instruire.

**Détection et dossiers d'enquête.** Des règles explicables produisent des *alertes à examiner* : quittance vérifiée depuis des lieux éloignés dans un court délai, quittance vérifiée un grand nombre de fois, paiements fractionnés sur une même obligation, agent visé par plusieurs signalements, taux anormal de non-conformité aux contrôles mystère, concentration d'actes sensibles sur une même personne, refus d'accès répétés, alertes techniques du socle. Chaque alerte expose ses variables, ses sources et un niveau de confiance. Ses seuils sont des paramètres de démonstration. Une alerte ne se classe que si un responsable **distinct** de l'enquêteur valide la proposition de classement. Le dossier d'enquête réunit alertes, signalements et contrôles mystère. Il contient les pièces par empreinte, les liens, les demandes de pièces et une chronologie. Il est complété par la trace du journal d'audit. L'enquêteur en charge dépose ses conclusions et propose une suite. La **décision motivée** (au moins 20 caractères) revient à une autorité de décision (R06 ou R21) qui n'a pas contribué au dossier. Quatre suites sont possibles : classement, saisine de l'autorité compétente, suspension conservatoire d'un accès technique, renvoi à l'autorité hiérarchique. La décision décrit l'exécution attendue sans jamais l'effectuer elle-même.

**Contrôles mystère, incidents, données, accès.** Les contrôles mystère sont planifiés par l'audit interne ou les enquêteurs. Seul le contrôleur désigné en enregistre le résultat. Un constat non conforme ouvre un signal ; les suites (aucune, rappel de procédure, dossier) sont décidées ensuite. Les résultats sont publiés sous forme **agrégée** par type de cible, sans aucun nom. Chaque incident de sécurité a une gravité, un propriétaire, une échéance et un cycle qui ne recule pas (Déclaré → En cours → Contenu → Résolu → Clos). La clôture exige une preuve scellée par empreinte. En cas d'atteinte aux données personnelles, le délégué à la protection des données doit être informé avant la clôture. Lui seul décide d'informer les personnes concernées. Dans son espace, le DPO traite les demandes d'accès (export des données et de l'historique des actions, les agents étant pseudonymisés) et de rectification (nom, adresse électronique, langue ; journalisées par empreintes avant et après). Il tient un registre des traitements versionné, où les bases légales et les durées de conservation non établies sont marquées « à confirmer ». Il contrôle aussi le journal des consultations de dossiers individuels. Enfin, la revue périodique des habilitations se fait par campagnes. Chaque accès interne est confirmé ou retiré avec motif, par le responsable sécurité ou par l'administrateur de l'entité concernée, jamais par la personne elle-même. Les accès privilégiés sont signalés pour une revue mensuelle. Les retraits décidés sont exécutés et attestés par l'administrateur de l'annuaire.

| Fonction | Qui agit | Garde-fou codé |
|---|---|---|
| Signaler (web, SMS, SVI, numéro gratuit) | Public, opératrice (R12) | Anonymat réel, identité chiffrée, code de suivi non stocké |
| Qualifier, transmettre, informer, clore | Enquêteur R24 | Personne mise en cause exclue ; clôture impossible avant décision du dossier lié |
| Examiner une alerte / proposer le classement | Enquêteur R24 | Effet automatique : aucun |
| Valider le classement | R24 ou R28 distinct | Séparation des tâches (`SEPARATION_OF_DUTIES`) |
| Instruire et conclure un dossier | Enquêteur en charge | Pièces par empreinte, chronologie, dossier figé après décision |
| Décider la suite | R06 / R21 non contributeur | Motif obligatoire, exécution par l'autorité compétente |
| Contrôles mystère | R22 / R24, contrôleur désigné | Publication agrégée seulement |
| Incidents | Tout agent déclare ; R28 / R27 pilotent ; R28 clôt | Preuve de clôture, DPO informé si données personnelles |
| Demandes des personnes, registre | Personne concernée, guichet ; DPO (R25) | Accès limité à son propre dossier ; versions conservées |
| Revue des accès | R28, R08 (son entité) | Nul ne revoit ses propres accès |
| Indicateurs | Gouverneur, R05, audit, enquêteurs, DPO | Agrégats seulement |

## I.12 Pilotage sur données réelles, indicateurs et transparence

Le module de pilotage (module d'extension `pilotage`) calcule les tableaux de bord de la Ville-Province **sur les données réelles du socle** : obligations liquidées sur règle active, ordres de paiement, confirmations signées des prestataires, quittances, relevés du compte public importés par le Trésor, écritures du grand livre et réclamations. Il ne modifie aucune donnée métier et n'exécute aucun acte financier ou juridique : il lit, agrège, explique et exporte. Les tableaux ne montrent que des agrégats ; le rattachement territorial suit la commune du fait générateur (§ 20.3), et une recette sans lieu établi apparaît comme « lieu non établi », jamais devinée.

L'**échelle unifiée de la recette** (onze niveaux, § 26.1) est la seule grille de lecture de tous les tableaux, rapports et exports. Chaque niveau est un stock « ayant atteint au moins ce stade » : le confirmé inclut le réglé, qui inclut le rapproché, et **les niveaux ne s'additionnent jamais**. Les montants sont donnés par devise légale (arithmétique exacte, sans nombre flottant) avec une contre-valeur consolidée en francs congolais, explicitement indicative. Deux niveaux ne sont pas mesurables aujourd'hui et sont déclarés comme tels : le potentiel estimé (modèle statistique non calibré) et le disponible pour affectation (budget voté et règles du Trésor non intégrés). L'assiette vérifiée est comptée en objets validés, sans valorisation monétaire. Le montant contesté est un indicateur séparé, hors échelle : une obligation sous réclamation sort de l'exigible. La consultation détaillée se fait par commune, catégorie de recette, administration, canal et mois ; la consultation jusqu'au paiement individuel (référence, statut, écritures, sans nom) est réservée au Trésor et à l'audit, jamais au Gouverneur.

Le **catalogue des indicateurs** (§ 39, annexe H § H.19, questions de décision du § 26.1) donne pour chacun sa définition, sa formule, sa source, sa valeur calculée, sa cible, son statut (atteinte, sous la cible, sans cible, non calculable, non mesuré) et sa tendance sur sept jours, recalculée à la date d'arrêté antérieure. Un indicateur sans source mesurable (taux de recensement, coût de collecte, RANV, satisfaction) est déclaré « non mesuré » : aucune valeur n'est inventée. Les **tableaux par profil** (Gouverneur, direction générale de régie, Trésor, commune, audit, ministre) appliquent le périmètre du rôle : province entière pour les autorités, le Trésor et l'audit ; administration propre pour un ministre sectoriel ou un directeur de régie ; territoire pour une commune. Toute demande hors périmètre est refusée et journalisée.

La **transparence publique** est trimestrielle : recettes rapprochées par commune et par catégorie, délais de recours, sans aucune donnée personnelle. Avant toute publication, un contrôle de divulgation s'exécute : seuil de cinq contribuables distincts par cellule, règle de dominance (un contribuable ne peut représenter plus de 85 % d'une cellule), masquage complémentaire pour qu'aucune cellule masquée ne se retrouve par différence avec le total, effectifs publiés par tranches, et recherche de tout identifiant personnel dans le contenu. La publication est une **décision humaine** du Gouverneur ou du ministre des Finances, motivée, journalisée, versionnée, avec empreinte SHA-256 et signature ; le public peut vérifier l'authenticité du tableau affiché.

La **piste d'audit par dossier** (auditeurs internes et externes, enquêteur anti-fraude) reconstitue la chronologie complète d'un objet fiscal, d'une obligation ou d'un paiement : journal d'audit chaîné, écritures du grand livre, quittances provisoire et définitive, réclamations et notifications (destinataire masqué). Elle vérifie qu'il n'y a pas de trou : intégrité du journal chaîné, équilibre du grand livre, écriture de constatation de chaque obligation, chaîne paiement → quittance → écritures → rapprochement, contre-écritures motivées. Chaque consultation est journalisée. Enfin, tout tableau s'**exporte signé** : fichier CSV et fichier JSON canonique, empreinte SHA-256 et signature HMAC-SHA256 par une clé d'export dédiée, manifeste téléchargeable, vérification publique et journalisation de chaque extraction (qui, quoi, quels filtres, quelle empreinte).

| Fonction | Route | Accès | Garde-fous |
|---|---|---|---|
| Échelle de la recette | `GET /v1/pilotage/echelle` | R01–R08, R17, R18, R22–R24 (périmètre du rôle) | Onze niveaux, jamais additionnés ; potentiel et disponible « non mesurés » ; contesté hors échelle |
| Consultation détaillée | `GET /v1/pilotage/drill/{commune\|category\|entity\|channel\|month}` | idem | Agrégats ; colonnes = niveaux distincts |
| Paiements individuels | `GET /v1/pilotage/drill/paiements` | R17, R18, R22, R23 | Sans nom ni coordonnée ; traçable jusqu'aux écritures |
| Série mensuelle | `GET /v1/pilotage/serie` | idem échelle | Liquidé, confirmé, rapproché |
| Indicateurs | `GET /v1/pilotage/indicateurs` | idem échelle | Définition, formule, source, cible, tendance ; « non mesuré » explicite |
| Tableaux par profil | `GET /v1/pilotage/tableaux/{profil}` (alias `GET /v1/tableaux/{profil}`) | selon le profil | Périmètre imposé ; refus journalisé |
| Piste d'audit | `GET /v1/pilotage/piste-audit/{référence}` | R22, R23, R24 | Contrôles « sans trou » ; consultation journalisée |
| Export signé | `GET /v1/pilotage/exports/{type}` ; `POST /v1/pilotage/exports/verify` | lecteurs du tableau ; vérification publique | SHA-256 + HMAC ; neutralisation des formules CSV ; export journalisé |
| Transparence (aperçu, publication) | `GET /v1/pilotage/transparence/{AAAA-Tn}` ; `POST …/publier` | aperçu R01, R05, R22, R23 ; publication R01, R05 | Test anti-ré-identification bloquant ; décision motivée ; versions |
| Transparence publique | `GET /v1/public/transparency[/{AAAA-Tn}]` | public | Aucune donnée personnelle ; seuil 5, dominance 85 %, masquage complémentaire |

#### Conduite du programme : feuille de route, modèle opérationnel, gouvernance (module « programme », ajout du 27/09/2026)

Écran « Feuille de route et modèle opérationnel » (`/pilotage/feuille-de-route`) : phases 0 à 6 du Cahier nouvelle version (§ 35.1) avec preuves des livrables (référence + SHA-256) et portes de sortie à deux personnes (demande par l'une, décision motivée du comité de pilotage par une autre, rattachée à une réunion consignée ; garde de séquence ; porte refusée sans preuve de chaque livrable ; porte bloquée sans binôme provincial ou avec jalon de transfert en retard) ; plans d'action datés à 30 jours → 24 mois à partir d'une date de démarrage saisie par une personne, actions en retard signalées (jour de Kinshasa) ; modèle opérationnel (huit fonctions, effectifs indicatifs au pilote, postes « à pourvoir », binômes et calendriers de transfert, indicateur d'autonomie) ; gouvernance du programme (cinq instances, réunions consignées avec procès-verbal SHA-256, réunion en retard selon la fréquence — délais PAR_DÉFAUT à confirmer —, versions de règles en revue rattachées au comité juridique et tarifaire). Exemple illustratif du § 39.3 en lecture seule sur l'écran des scénarios. Détail : § 36.1 et § 38.3 du document maître. Tests : `backend/test/programme.test.ts`, `frontend/test/programme.test.tsx`.

## I.13 Système d’exploitation de l’IA (AI OS)

#### Couche d’intelligence (module « ia ») — état construit

La couche d’intelligence (§ 23.5) est un module d’extension du socle (`backend/src/plugins/ia`). Il ne passe par aucun LLM. Quatorze agents déterministes (les 13 agents métier du § 23.2 et l’agent transverse Communication) lisent les données réelles du socle au travers d’une **passerelle en lecture seule**. Chaque agent a une **fiche de contrôle** : mission, domaines de données autorisés, niveau d’autonomie maximal, actions permises, rôles qui peuvent le solliciter, rôles qui valident et interdits. Si un agent lit un domaine absent de sa fiche, l’erreur `IA_DATA_DOMAIN_FORBIDDEN` est levée. Les vues fournies aux agents sont minimisées : elles ne contiennent ni nom, ni téléphone, ni courriel, ni coordonnées GPS, ni numéro de compte. Les identifiants des agents publics y sont pseudonymisés. L’interface `IaAgentProvider` reste en place : un fournisseur fondé sur un modèle pourra remplacer le fournisseur déterministe derrière la même passerelle.

Chaque sortie est une recommandation au **format standard à 8 rubriques** : situation, analyse, risque, recommandation, prochaine action, responsable (toujours un rôle humain), échéance et confiance avec ses sources. Elle comprend au besoin le bloc de décision complet, étape recommandée incluse. Les scores s’accompagnent de leurs facteurs contributifs. Les **données citées** donnent la référence de chaque élément lu. Le **journal IA**, en ajout seul, enregistre pour chaque génération : la finalité déclarée, la version du modèle, la version de la fiche (empreinte de la consigne), l’empreinte des données lues, les domaines consultés, les champs masqués, les citations et l’empreinte de la sortie. Il lie ensuite la décision humaine (rôle, motif, délai en millisecondes), les exécutions et les annulations. Chaque événement est aussi inscrit au journal d’audit chaîné. La reconstitution d’une recommandation (`GET /v1/ia/journal/:id`) vérifie l’intégrité de sa sortie.

Les **trois niveaux d’autonomie** sont appliqués techniquement. Le **niveau A** couvre la préparation de brouillons, les résumés, le classement, la création de tâches et les rappels facultatifs. L’agent exécute ces actions sous la garde `assertAiMay(…, 'draft.write')`, qui reste inchangée. Elles sont journalisées et réversibles. Le responsable d’entité (R08 ou R06, entité propre) peut les désactiver globalement, action par action ou agent par agent ; une action désactivée reste proposée à la validation humaine. Le **niveau B** couvre la demande de pièces, l’ouverture de mission, la relance obligatoire et le dossier de vérification anti-fraude. L’IA n’exécute jamais ces actions : l’exécution a lieu au nom de l’agent public qui valide, en un clic, et reste annulable. Une mission n’est jamais affectée hors du périmètre de l’agent de terrain ni de celui du superviseur. Le **niveau C** ne s’exécute jamais : la décision (acceptée, modifiée ou rejetée, avec motif) renvoie au circuit maker-checker du domaine. Rejeter une recommandation retire ses effets automatiques. Un **coupe-circuit** par agent est réservé aux rôles R28 et R29.

La **mémoire à quatre niveaux** (§ 23.5.4) est en place.
- **Utilisateur** : le titulaire seul la consulte. Pour un contribuable, une liste blanche limite la mémoire aux préférences de service ; aucun profilage. Toute consultation par un tiers est refusée et journalisée. La conservation est de 12 mois pour un agent public et de 24 mois pour un contribuable.
- **Espace (entité)** : cloisonnée par entité. Elle reçoit les décisions humaines, les hypothèses et les modèles. Les décisions sont conservées 10 ans et ne peuvent pas être effacées avant cette échéance. Les autres éléments peuvent être effacés avec un motif, qui est journalisé.
- **Processus** : étape atteinte, étapes faites, en attente et bloquées, changements récents et prochaine décision, pour les règles, recours, obligations, changements de bénéficiaire et recommandations. Son accès suit les droits sur le dossier.
- **Intelligence** : agrégats pseudonymisés. Tout identifiant y est refusé. Conservation de 36 mois.

Le délégué à la protection des données voit un registre des volumes, jamais le contenu, et applique la purge. Les durées ci-dessus sont des propositions à valider.

Côté navigateur, l’écran `/ia` offre la boîte de réception (filtres par agent, niveau et statut ; validation B, décision C, annulation), le catalogue des agents, les paramètres d’autonomie, l’explorateur de mémoire et le journal. Le motif de décision est enregistré automatiquement sur l’appareil sous forme **chiffrée** (WebCrypto AES-GCM-256). La clé est dérivée par utilisateur d’une clé d’appareil HMAC non exportable, conservée comme `CryptoKey` dans IndexedDB : elle n’est jamais stockée en clair. Sans WebCrypto, rien n’est écrit.

| Agent | Données autorisées | Niveau max. | Actions | Validation |
|---|---|---|---|---|
| Découverte des recettes | Objets, baux | C | A : fiche d’opportunité (brouillon) | R06, R07 → comité |
| Enrôlement | Compte de l’usager | A | A : pré-remplissage | Le contribuable confirme |
| Apprentissage de l’usager | Compte, obligations propres, pages d’aide | A | A : réponse sourcée | Sans effet ; renvoi au guichet |
| Copilote des agents publics | Recours, obligations | C | A : résumé, classement du motif, projet de décision | R20, R21 signent |
| Veille juridique | Règles, textes | C | A : note de veille, tâche de certification | R13, R14 ; aucune publication |
| Intelligence locative | Objets, baux, constats | B | B : demande de pièces | R09, R06 |
| Missions terrain | Objets, baux, conflits, équipes | B | B : mission dans le périmètre | R09 |
| Rapprochement | Paiements, exceptions | C | A : tâche d’affectation | R17, R18 (quatre yeux) |
| Détection de fraude | Audit pseudonymisé, alertes, terminaux, agrégats, coffre | B | B : dossier de vérification | R24 |
| Prévision | Obligations, paiements | C | — | R05, R17 |
| Aide à la décision exécutive | Agrégats | C | — | R01, R02, R05 |
| Allocation des investissements | Paiements rapprochés, comptes publics | C | — (aucune clé de répartition) | R05, R01 |
| Apprentissage continu | Décisions humaines | C | A : note de version candidate | R29 + comité des modèles |
| Communication | Communications, obligations | B | A : note ; B : relance n° 1 | R06, R07, R08 |

## I.14 Preuves sur tous les canaux : compte à rebours 50 % / 1 %, WhatsApp, SMS, version légère, papier

Tout le monde n’a pas un téléphone Android ou iOS. Le module d’extension `preuves` rend **chaque preuve vérifiable par son code, sur tous les canaux**, avec la même réponse :

- **Application** : page « Vérifier une preuve » (`/preuve`).
- **WhatsApp** : assistant officiel (compte certifié).
- **SMS** : « V + code », depuis n’importe quel téléphone.
- **USSD et serveur vocal** : l’option 3 vérifie désormais tout code.
- **Pages légères sans JavaScript** (`/l`) : pour KaiOS, Opera Mini et la 2G.
- **Papier imprimé** : aux couleurs de la Ville.

Les preuves couvertes sont :
- tickets et places de stationnement (code aléatoire `PKT…`, non séquentiel) ;
- places d’étal au marché ;
- pass wewa et tickets RakaPay ;
- certificats et autorisations des verticales ;
- supports publicitaires ;
- quitus et attestations de bail ;
- badges d’agents ;
- quittances, reçus de points agréés et cartes MOSOLO ;
- plaques.

**Règle de couleur unique (décision du maître d’ouvrage).** Toute preuve à durée limitée affiche un compte à rebours dont la couleur dépend de la part de validité restante :

| Part de validité restante | Couleur | Texte | Au contrôle |
|---|---|---|---|
| 50 % ou plus | Vert | ✓ VALIDE — encore … | Valable |
| De 1 % à moins de 50 % | Ambre (orange) | ⚠ VALIDE — expire dans … | Valable |
| Moins de 1 % | Rouge | ⚠ VALIDE — EXPIRE DANS … | **Valable** (à renouveler) |
| 0 % | Rouge | ✗ EXPIRÉ DEPUIS … | Non valable |
| Avant le début | Gris | PAS ENCORE ACTIF | Non valable |

Cette règle remplace les seuils ambre fixés en durée de l’Annexe H (§ H.11.4) et les seuils propres à chaque module. Elle est calculée en un seul endroit (`shared/validity.ts`), côté serveur comme côté client. La couleur n’est jamais seule : icône, texte, barre de progression graduée à 50 % et 1 %, et pourcentage l’accompagnent.

L’heure de référence est **celle du serveur**. Chaque réponse porte l’en-tête `x-mosolo-server-time` : changer l’heure du téléphone ne change rien. Le rouge sous 1 % n’est **pas** une infraction. Le résultat du contrôle reste « VALIDE », et le feu de contrôle du stationnement reste distinct de la couleur d’affichage : aucun constat n’est possible sur un titre encore valable.

| Canal | Pour qui | Ce qu’il fait | Garde-fous |
|---|---|---|---|
| Application, `/preuve` | Smartphone | Vérifier tout code ou QR, compte à rebours en direct, « comment lire la couleur » | Réponse minimale : ni nom, ni adresse ; plaque masquée (KN-00••-DM) |
| WhatsApp (assistant officiel) | Habitants avec WhatsApp, sans l’application | Vérifier un code ; où payer ; comment payer ; rappels ; signaler un faux agent ; français et lingala | **Consentement explicite** (« OUI ») avant tout contenu ; « STOP » le retire. **Aucun lien de paiement** (tout lien est retiré, ARB-64). **Aucun montant** nominatif. Webhook signé `x-hub-signature-256` |
| SMS « V code », « POINTS commune », « SIGNAL … » | Tout téléphone, sans Internet | Réponse de 320 caractères au plus, sans accents (GSM-7) : couleur, temps restant, fin de validité | Passerelle signée HMAC (`x-mosolo-signature`) ; limiteur anti-énumération par numéro |
| USSD et serveur vocal (option 3) | Sans données mobiles | Tout code, même réponse | Existant (§ I.9), étendu au résolveur universel |
| Pages légères `/l` | KaiOS, Opera Mini, 2G/EDGE, forfaits de quelques Mo | Vérifier, où payer, comment payer, signaler (anonyme) ; version imprimable avec QR | **Aucun JavaScript**, aucune police ni image externe, moins de 10 Ko par page, barre de validité en caractères (lisible sur écran monochrome) |
| Papier imprimé | Sans téléphone ; guichet, point agréé, affichage | A6 à afficher ; ticket thermique 80 mm ou 58 mm | Voir ci-dessous |

**Vérifier en scannant le QR code.** Sur la page « Vérifier une preuve », au guichet de quittance et sur l'écran de contrôle des agents, le bouton « Scanner un QR code » ouvre la caméra arrière. Il fonctionne sur (presque) tous les téléphones :

- **Détecteur natif** du navigateur quand il existe (Chrome sur Android).
- **Sinon, décodage en JavaScript** (jsQR, 47 Ko compressés, chargé seulement à l'ouverture du lecteur) : iPhone et Safari, Firefox, anciens Android.
- **Secours universel « Prendre une photo du QR »** : l'appareil photo du téléphone prend l'image, décodée sur place. Utile quand la caméra en direct est refusée ou indisponible (page hors HTTPS).
- **Aucune image n'est envoyée au serveur** : seul le texte lu du QR l'est.

Le contenu lu est interprété de la même façon partout (`shared/proofs.ts`) :

- lien de vérification de la preuve, quel que soit le domaine imprimé ;
- charge signée d'une quittance, duplicata compris ;
- jeton signé d'un titre ou d'un gilet ;
- code nu.

Un lien collé dans un SMS, WhatsApp ou la version légère est aussi accepté. Un QR de plaque, de quitus, d'agent, de support publicitaire ou de carte ouvre directement sa page de vérification, signature comprise.

Essai réel dans Chromium sans détecteur natif (donc avec jsQR) :

- **caméra simulée** filmant la preuve imprimée : ticket reconnu environ 0,2 s après l'apparition du QR ;
- **photo** de la preuve A6, inclinée et floue : ticket reconnu.

La preuve imprimée est marquée et vérifiable :
- **Marquage** : logo officiel de la Ville inchangé, bandeau aux couleurs nationales, fond de sécurité (guilloche) et micro-texte du code.
- **Vérification** : QR vers la page de vérification (lisible par tout appareil photo et par le terminal de contrôle), code court et dates en gros caractères.
- **Échéancier des couleurs** : un papier ne peut pas décompter. Il porte donc les instants de passage : vert jusqu’au …, orange jusqu’au …, rouge jusqu’au …, puis expiré.
- **État et mentions** : état à l’impression, rappel « aucun agent ne reçoit d’espèces », et mention « DÉMONSTRATION — NON OPPOSABLE » tant que les actes ne sont pas pris.
- **Aucun nom ni montant** n’est imprimé. **Seule la vérification en ligne fait foi** : la photocopie d’un ticket expiré s’affiche EXPIRÉ.

Routes :
- `GET /v1/public/preuves/:code` ;
- `GET /v1/public/preuves?c=` (jetons longs) ;
- `GET /v1/public/preuves/:code/impression` ;
- `POST /v1/sms/inbound` ;
- `GET|POST /v1/whatsapp/webhook` ;
- `GET /l`, `/l/v`, `/l/imprimer`, `/l/points`, `/l/payer`, `GET|POST /l/signaler`.

Écrans :
- `/preuve` et `/preuve/:code` ;
- `/preuve/:code/imprimer` (formats A6, 80 mm, 58 mm) ;
- `/canaux/whatsapp-sms` (simulateur) ;
- liens « Imprimer » depuis le stationnement, le pass wewa, les tickets RakaPay, les certificats et le quitus.

Tests :
- `backend/test/preuves.test.ts` : résolution de chaque type de preuve ; seuils à l’heure serveur ; SMS sans accents et signé en production ; consentement WhatsApp, absence de lien et de montant ; pages sans script de moins de 10 Ko.
- `frontend/test/validity-countdown.test.tsx` : seuils, dates seules, statut bloquant, contenu de la preuve imprimée.

## I.15 Terrain : lecture de plaque, caméra de preuve des abords, pénalités visibles avec leur montant, commission de tous les agents

Décisions du maître d’ouvrage du 27/09/2026, puis précisions du même jour, construites et testées :
- le montant est montré à tous les agents ;
- la commission de 10 % vaut pour les agents de tous les modules ;
- les photos de preuve portent sur les abords du véhicule, pas sur la plaque.

**1. Lecture de la plaque à la caméra.** Sur le terminal de contrôle, « Scanner la plaque (caméra) » ouvre la caméra arrière avec un cadre de visée au format plaque. La reconnaissance de caractères (Tesseract) est **servie par MOSOLO lui-même** (`/ocr/`, environ 7 Mo) : aucun service externe, et elle fonctionne hors réseau après la première utilisation. Elle n’est pas dans le pré-cache d’installation de l’application.

**La machine propose, l’agent décide** : le texte lu (normalisé au format KN-0000-XX) s’affiche avec sa confiance. L’agent le corrige si besoin, puis « Confirmer et contrôler ». Un secours par photo existe.

Essai réel dans Chromium, caméra simulée filmant l’arrière d’un véhicule : KN-0777-DM lu correctement en moins de 0,3 s une fois le moteur chargé.

**2. Caméra de preuve géolocalisée : les abords du véhicule (plaque ROUGE).** Quand le contrôle est rouge, la caméra de preuve s’ouvre d’elle-même.

- **Vues** : l’agent prend **jusqu’à 5 photos des abords du véhicule** : devant, derrière, côté droit, côté gauche, plus une autre vue (panneau d’interdiction, marquage au sol, horaire affiché).
- **Objet de la preuve** : le **lieu et les circonstances** du stationnement (passage piéton, trottoir, voie, signalisation). **Ce n’est pas un gros plan de la plaque** : la plaque est déjà lue au contrôle et figure en texte sur chaque photo.
- **Mentions incrustées dans l’image**, dans un bandeau et en filigrane :
  - date et heure (horloge du **serveur**, Kinshasa) ;
  - nom et identifiant de l’agent, numéro du contrôle ;
  - coordonnées GPS avec leur précision ;
  - **lieu saisi par l’agent** (obligatoire) ;
  - plaque et vue.
- **Empreinte et versement** : l’empreinte SHA-256 de l’image est calculée sur l’appareil. Le serveur **vérifie l’empreinte**, n’accepte que du JPEG (900 Ko au plus), dans les 30 minutes du contrôle rouge et par l’agent qui l’a fait. Il **conserve l’image telle que reçue** et signale un écart d’horloge de plus de 5 minutes.
- **Protection des photos** :
  - une même image ne peut servir deux fois ;
  - une reprise conserve l’ancienne photo ;
  - une photo jointe à un constat ne peut plus être remplacée.
- **Sans GPS** : l’agent peut utiliser la position de la zone, signalée au vérificateur.
- **Lecture des photos** : le superviseur, la régie et le titulaire de la plaque les voient (droit de contester) ; toute consultation est journalisée.

Le circuit RW1 est inchangé : le **constat ne sanctionne pas**.

**3. Pénalités visibles, avec leur montant.**

Règle retenue par le maître d’ouvrage : **dans les 30 jours, seulement les agents du module ; au-delà de 30 jours, tous les agents**.

- **Agents du même module, à tout âge** : après un contrôle, l’agent voit les pénalités impayées de l’usager **relevant de son module**, dès leur décision, avec leur montant (marquées « votre module »). Correspondance : contrôle de stationnement → pénalités du stationnement ; contrôle de titres ou de pass wewa → pénalités des titres ; inspection publicitaire → publicité ; scan de plaque d’objet → verticales.
- **Agents de tous les modules, après 30 jours d’impayé** : une pénalité non payée 30 jours après sa décision devient visible, **avec son montant**, de **tout agent de tout module, à l’occasion d’un contrôle**. Contrôles concernés :
  - stationnement ;
  - titres et tickets ;
  - pass wewa (même pour une plaque qui n’est pas celle d’une moto enregistrée) ;
  - scan d’une plaque d’étal, de chantier ou de site ;
  - inspection publicitaire.
- Le bandeau de l’écran de contrôle s’intitule selon le cas « Pénalités impayées de votre module », « … depuis plus de 30 jours » ou les deux.
- **Garde-fous** :
  - visible seulement **après un contrôle réel** (divulgation journalisée avec la référence du contrôle) ;
  - jamais pour un usager ;
  - le montant est celui **fixé par la décision : il ne se négocie pas** ;
  - l’agent invite l’usager à payer par les canaux officiels avec sa référence, et **n’encaisse rien** ;
  - aucune mesure sur place ;
  - une pénalité contestée, payée ou annulée sort du registre.

Le montant visible de tous les agents augmente le risque de sollicitation d’espèces. Les parades à maintenir :
- la règle « zéro espèces » affichée partout ;
- le signalement anonyme (SMS, WhatsApp, version légère) ;
- les contrôles mystère (§ 15A) ;
- le suivi des divulgations par agent.

**4. Commission de 10 % pour tous les agents, quel que soit leur module.** Deux recettes seulement comptent.

- **Pénalités issues du constat de l’agent**, vérifiées et décidées par d’autres personnes :
  - stationnement : constat ;
  - publicité : inspection non conforme retenue.
- **Paiements provoqués par un contrôle de l’agent qui a révélé un défaut** :

| Module | Paiement attribué à l’agent | Délai |
|---|---|---|
| Stationnement | Session ouverte pour la plaque après un contrôle rouge | 1 h |
| Titres et pass wewa (RakaPay) | Titre acheté pour la plaque ou le titulaire après un contrôle non valide | 1 h |
| Verticales | Dette de l’objet (étal, chantier, site…) payée après le scan de sa plaque | 72 h |
| Publicité | Dette du support payée après une inspection non conforme | 72 h |
| Terrain (missions) | Dette de l’objet payée après le constat de l’agent | 72 h |

**Attribution unique** : une pénalité revient à l’auteur du constat. Un paiement ne compte qu’une fois, pour le **premier** contrôle qui l’a précédé, tous modules confondus.

Chaque ligne passe par des états :

- **en attente** (l’usager n’a pas payé) ;
- **payée, rapprochement en cours** ;
- **acquise** (rapprochée au compte public, à verser) ;
- **annulée** (pénalité annulée sur recours).

**Garde-fous** :
- La commission est calculée sur des recettes **arrivées au compte public** et **versée par le Trésor (paie)**. **Un agent ne reçoit jamais d’argent de l’usager.**
- Les personnes qui vérifient ou décident ne perçoivent rien sur leurs décisions.
- Sommes par devise, sans addition de devises.

Tableaux de bord :
- **chaque agent** : « Mes gains (10 %) », sur `/mes-gains`, avec la ventilation par module ;
- **le pilotage, les régies, le Trésor et l’audit** : « Commissions des agents », tous modules.

**Le taux est une décision du maître d’ouvrage : un arrêté est requis avant tout versement réel.**

Risque de conflit d’intérêts à surveiller (indicateurs par agent, contrôles mystère, § 15A) : les garde-fous ci-dessus (preuve vérifiée, décision par un tiers, recours, annulation de la commission) doivent rester actifs.

**5. Surveillance des constats par agent (recommandation retenue).** La commission sur les pénalités crée une incitation à multiplier les constats ; l’écran « Surveillance des constats » (`/agents/surveillance`) la rend visible.

- **Compteurs par agent et par module** : contrôles, défauts relevés, constats, constats écartés à la vérification, retenus, classés sans suite, contestés, annulés, photos ou positions faibles (GPS absent, ajusté à la main ou au-delà de 50 m, horloge décalée) ; part des pénalités dans sa commission.
- **Signaux « à examiner »**, comparés à la **médiane des autres agents du même module** :

| Signal | Condition (seuils à valider par l’inspection des services) |
|---|---|
| Taux de constats élevé | Plus du double de la médiane des pairs (au moins 5 contrôles et 3 constats) |
| Preuves écartées | 30 % ou plus des constats vérifiés écartés |
| Constats classés | 40 % ou plus des constats décidés classés sans suite |
| Contestations | 30 % ou plus des pénalités retenues contestées ou annulées |
| Preuves faibles | 30 % ou plus de photos ou positions imprécises |
| Commission issue de pénalités | 70 % ou plus (information seulement) |

- **Un signal n’entraîne aucune mesure automatique** : il ouvre un examen humain (superviseur, contrôle mystère § 15A). Accès : Gouverneur et cabinet, direction et régies (DGIPK, DGRK), supervision de terrain, inspection, audit.

Routes :

| Route | Rôle |
|---|---|
| `POST /v1/parking/evidence-photos` | Verser une photo de preuve |
| `GET /v1/parking/evidence-photos/:id` | Lire une photo de preuve |
| `GET /v1/parking/penalties?plate=` | Pénalités d’un usager (agents du module) |
| `GET /v1/agents/me/earnings` | Gains de l’agent, tous modules |
| `GET /v1/agents/earnings` | Commissions de tous les agents (pilotage, régies, Trésor, audit) |
| `GET /v1/agents/monitoring` | Surveillance des constats par agent (pilotage, régies, supervision, inspection, audit) |
| `GET /v1/parking/agents/me/earnings` | Gains de l’agent (même contenu, pour les écrans du stationnement) |
| Champ `penalitesImpayees` | Ajouté aux réponses des contrôles des autres modules |

Tests (`backend/test/parking-field.test.ts`) :
- empreintes, formats, délais et verrouillage des photos ;
- constat lié à ses photos, droits de lecture ;
- visibilité : même module à tout âge, tous modules après 30 jours, jamais pour l’usager ;
- états de la commission, attribution des paiements, droits d’accès ;
- commission d’un contrôleur de titres (titre racheté après un contrôle non valide) et d’un agent des verticales (dette payée après le scan) ;
- montant visible dans les autres modules ;
- surveillance des constats (signal d’un agent qui multiplie les constats, droits d’accès) ;
- point ajusté à la main (source MANUEL) signalé comme position imprécise.

## I.16 Cartographie OpenStreetMap auto-hébergée et géolocalisation précise

**Choix du maître d’ouvrage : OpenStreetMap, auto-hébergée** (plutôt que Google Maps).

| Critère | Google Maps | OpenStreetMap auto-hébergée (retenue) |
|---|---|---|
| Coût | Facturé à l’usage au-delà d’un quota ; montant variable avec le nombre d’agents et d’usagers | Aucune redevance ; seul l’hébergement (quelques centaines de Mo) |
| Souveraineté des données | Chaque affichage passe par les serveurs de Google (positions des agents, lieux contrôlés) | Tout est servi par MOSOLO : aucune position ne sort de l’infrastructure de la Ville |
| Hors réseau | Limité, conditions d’utilisation restrictives | Fonctionne sans réseau une fois l’application et la carte chargées |
| Qualité à Kinshasa | Bonne sur les grands axes | Bonne sur les axes ; les quartiers peuvent être complétés par la Ville (données ouvertes, licence ODbL) |
| Licence | Contrat commercial, restrictions de stockage | ODbL : mention « © contributeurs OpenStreetMap » obligatoire (affichée sur chaque carte) |

**Construction.**

- **Moteur** : MapLibre GL (libre), chargé seulement par les écrans qui affichent une carte.
- **Fond de carte** : tuiles vectorielles de Kinshasa au format PMTiles, fichier unique `/tiles/kinshasa.pmtiles` servi par MOSOLO, fabriqué par `tools/maps/construire-tuiles-kinshasa.sh` (extrait Protomaps ou Geofabrik + Planetiler ; emprise 15,05–15,70 E, 4,15–4,75 S ; zoom 16). Le fichier n’est pas dans le dépôt : il se fabrique sur le serveur de la Ville. Tant qu’il manque, les cartes affichent les couches MOSOLO (points, zones, cercle de précision) sur un fond neutre, avec une note.
- **Polices et icônes de carte** : servies par MOSOLO (`/map/`), licences dans `frontend/public/map/LICENCES.md`.
- **Anciens téléphones sans WebGL** : les écrans gardent leur plan schématique ; les coordonnées restent affichées et enregistrées.
- **Application installée (PWA)** : le moteur de carte est pré-chargé ; polices et icônes sont mises en cache à la première carte ; les tuiles (lues par plages d’octets) ne passent pas par le service worker.

**Géolocalisation précise, partout où elle sert.**

- **Méthode** : GPS haute précision, jamais de position en cache ; plusieurs relevés ; la position retenue est la **moyenne pondérée des meilleurs relevés récents** (précision au plus 1,5 fois la meilleure, 25 secondes au plus). La recherche s’arrête à la précision cible (10 m pour les preuves, l’enrôlement et les missions ; 15 m pour le contrôle des titres, qui ne doit pas attendre) ou au bout de 30 secondes, en gardant le meilleur résultat.
- **Qualité affichée et transmise** : excellente (≤ 5 m), bonne (≤ 15 m), moyenne (≤ 50 m), faible au-delà ; nombre de relevés ; barre de progression.
- **Carte de vérification** : le point et son cercle de précision sur la carte OSM. L’agent peut **ajuster le point à la main** : la position est alors marquée « MANUEL » et signalée au vérificateur ; sans GPS, la position de la zone peut être utilisée, marquée « ZONE ».
- **Écrans concernés** :

| Écran | Usage de la position |
|---|---|
| Caméra de preuve (stationnement) | Incrustée dans chaque photo, avec sa précision et sa source |
| Constat de stationnement, inspection publicitaire, espace annonceur | Position du véhicule ou du support |
| Contrôle des titres et du pass wewa | Lieu du contrôle |
| Enrôlement assisté | Domicile ou site de la personne enrôlée |
| Missions de terrain et contre-visites | Position du constat, comparée au point enregistré |
| Autour de moi (agents des biens et activités) | Biens et commerces proches colorés vert, ambre, rouge, dans le secteur de l’agent |
| Carte des zones (usager, régie), carte des supports, points de paiement | Fond OSM au lieu du plan schématique |

- **Contrôle côté serveur** : chaque photo de preuve porte sa distance au centre de la zone ; elle est signalée si la précision dépasse 30 m, si la source n’est pas le GPS, ou si elle est à plus de 600 m de la zone. Ces signaux alimentent la surveillance des constats (§ I.15, 5).

**« Autour de moi » : biens et commerces proches en vert, ambre ou rouge** (demande du maître d’ouvrage du 27/09/2026). Les agents des modules liés aux biens et aux activités physiques (propriété, locatif, entreprises, marchés, chantiers, sites, publicité) disposent de l’écran « Autour de moi » (`/autour-de-moi`, route `GET /v1/fiscal/nearby`). Une fois sur place, ils voient les biens et commerces proches :

| Couleur | Sens |
|---|---|
| Vert | À jour : aucune obligation exigible impayée |
| Ambre | Paiement partiel, échéance dans les 30 jours, paiement en rapprochement ou objet non encore validé |
| Rouge | En retard, sur un objet vérifié |
| Gris | Recensé, non encore liquidé |
| Bleu | En litige ou en revue |

- **Une fois dans la zone** : la liste ne s’affiche que si la position, mesurée par le GPS (100 m de précision au plus, jamais une position saisie à la main), se trouve dans une commune du **secteur de l’agent**. Hors secteur, rien n’est montré.
- **Carte et liste** : la position de l’agent, le rayon choisi (100 m à 1 km) et les biens colorés sur la carte OSM ; la liste va du plus proche au plus éloigné (référence IGF, plaque posée, quartier, motif de la couleur) ; filtre par couleur ; mise à jour automatique quand l’agent se déplace de 40 m.
- **Aucun montant ni nom de contribuable** dans la liste : la couleur oriente la visite, elle ne vaut ni constat ni sanction (circuit RW1 inchangé). L’agent ne reçoit jamais d’espèces ; il peut faire payer un bien ambre ou rouge par canal numérique (§ I.17).
- **Journalisation** : chaque consultation est tracée (position, précision, rayon, commune, nombre de biens et de rouges montrés), ce qui alimente la surveillance des agents.
- **Rôles** : agent de terrain, superviseur, contrôleur et sous-traitant de terrain dans leur secteur ; direction, chef de service, audit et anti-fraude partout. Les véhicules (objets mobiles) sont exclus.
- Tests : `backend/test/fiscal-nearby.test.ts` (dans le secteur, hors secteur, précision insuffisante, rayon plafonné, rôles refusés).

## I.17 Paiement numérique assisté par l’agent : jamais d’espèces

Décision du maître d’ouvrage du 27/09/2026 : **un agent de terrain ne reçoit jamais d’espèces**. Les espèces se paient uniquement dans les lieux prévus (point de paiement agréé, guichet bancaire MOSOLO). En revanche, l’agent peut **faire payer sur place par les canaux numériques**, comme partout dans le système.

**Aucun circuit parallèle.** L’agent émet (ou ré-affiche) la **référence officielle du circuit commun, au nom du seul titulaire** ; c’est le même ordre de paiement que dans l’application, l’USSD ou au guichet :

| Canal proposé par l’agent | Ce que fait l’usager |
|---|---|
| Monnaie mobile | Paie depuis **son** téléphone vers le compte public, avec la référence |
| USSD | Compose le code USSD officiel sur **son** téléphone et saisit la référence (tout téléphone, sans internet) |
| QR | Scanne le QR du prestataire connecté avec **son** application ; montant et compte public déjà renseignés |
| Carte | Paie par **sa** carte sur un terminal agréé ou dans l’application |
| Espèces | **Refusées à l’agent** (`CASH_NOT_ALLOWED_FOR_AGENT`) : l’usager va dans un point agréé ou au guichet bancaire, avec la même référence |

**Garde-fous.**

- Le montant est le **solde de l’obligation** : il ne se saisit pas et ne se négocie pas.
- L’agent ne touche ni argent, ni téléphone, ni carte, ni code secret de l’usager ; l’ordre appartient au titulaire ; le bénéficiaire est le compte public.
- **Sur place** : position GPS précise (100 m au plus) ; pour un bien fixe, 300 m au plus du bien ; **dans le secteur** de l’agent.
- **Une seule référence active** par obligation ; une obligation déjà couverte par un paiement confirmé n’est plus proposée.
- La **quittance** part à l’usager dès la confirmation signée du prestataire ; l’agent voit « Paiement confirmé ».
- Chaque référence assistée est **journalisée** (agent, position, distance au bien, canal, référence). La commission reste régie par § I.15.

Où : pénalités au contrôle du stationnement, bandeau des pénalités impayées, biens ambre ou rouges de « Autour de moi », scan d’une plaque de verticale, supports publicitaires aux droits impayés. Routes : `GET /v1/agents/assist/payables`, `POST /v1/agents/assist/payment-orders`, `GET /v1/agents/assist/payment-orders/:reference`. Tests : `backend/test/assisted-payment.test.ts`.

## I.18 KIN PUB CONTROL sur le terrain : « Autour de moi », enseignes, commerces, publicité mobile

Construit **dans le module de publicité existant**. Les supports restent rattachés au registre fiscal une fois leur exploitant identifié.

**Tout ce qui s’affiche est assujetti.** Chaque support porte son **emplacement** :

| Emplacement | Exemples | Contrôle |
|---|---|---|
| Support dédié | Panneau, écran, bâche, **banderole** | Sur place (position) |
| Façade ou porte d’un commerce | **Enseigne** du commerce | Sur place, lié à l’établissement enregistré |
| Devant un commerce | **Chevalet**, kakémono sur le trottoir | Sur place, lié à l’établissement |
| Véhicule ou objet mobile | **Publicité sur véhicule** : voiture, taxi, bus, camion, moto, tricycle, remorque | **Par la plaque du véhicule**, où qu’il soit |

**« Autour de moi » de l’inspecteur** : sur place, dans son secteur, position GPS précise ; supports en **rouge** (affiché sans autorisation, autorisation expirée, droits impayés), **ambre** (demande en cours, échéance proche, barème non publié), **vert** (autorisé et à jour) ; commerces enregistrés **sans enseigne déclarée, à vérifier** (jamais présumés en infraction), avec constat pré-rempli. **Publicité mobile** : onglet « Véhicules », plaque saisie ou lue à la caméra. Droits impayés : « Faire payer (numérique) » (§ I.17).

**Tarifs : rien n’est inventé.** Supports fixes, enseignes et chevalets : règle existante (taxe au m², fictive de démonstration), à confirmer par l’acte pour les enseignes. Publicité sur véhicule : règle distincte ; sans acte publié, l’autorisation est « acte requis » **sans montant**, puis liquidée en double validation dès que la règle devient active.

Routes : `GET /v1/publicite/nearby`, `GET /v1/publicite/vehicles/:plate`. Tests : `backend/test/publicite-terrain.test.ts`.

## I.19 Verrouillage de la fraude et des fuites financières

Demande du maître d’ouvrage du 27/09/2026 : « que la fraude et les fuites financières soient complètement verrouillées ». Six revues de code puis trois revues adverses (flux de l’argent de bout en bout ; fraude interne, agents et collusion ; fuites par les données, les réductions, le rapprochement et l’audit) ont été menées sur l’ensemble du système. Chaque chemin trouvé a été fermé (**bloqué**) ou rendu visible (**détecté** : alerte, exception, signal d’examen), et un test automatisé **rejoue l’attaque** pour prouver qu’elle échoue. Aucun système n’est inviolable : l’objectif est qu’aucune personne seule ne puisse détourner, effacer ou réduire une recette, et qu’aucune collusion ne passe inaperçue.

**Principes appliqués partout.**

- **Une personne physique, un compte de travail** : chaque compte est lié à l’empreinte (jamais le numéro en clair) de la pièce d’identité ; un second compte pour la même personne est refusé et signalé ; la séparation des tâches (auteur ≠ vérificateur ≠ décideur) s’applique **par personne**, pas par compte.
- **Conflit d’intérêts** : nul ne vérifie, ne décide ni n’accorde ce qui profite à un contribuable auquel il est lié.
- **Jamais d’espèces à un agent** : un opérateur de point agréé (R32) ne peut détenir aucun rôle d’agent public ; les agents font payer uniquement par canal numérique, au nom du titulaire, vers le compte public (§ I.17).
- **Montants jamais saisis** : un montant vient d’une règle ACTIVE certifiée ; les taux certifiés ne peuvent pas être remplacés par une donnée de la requête.
- **Double validation** pour toute opération qui touche l’argent ou les recettes : remboursement, restitution, contrepassation, contre-écriture, changement de compte bénéficiaire (avec veto pendant le délai de carence), suspension ou levée d’une règle, remise, admission en non-valeur, correction à la baisse, correction d’un objet, dérogation de clôture, rapprochement d’un versement de point agréé.

**Menaces et contrôles.**

| Menace | Contrôle | Nature |
|---|---|---|
| Confirmation de paiement forgée (secret public) | Secrets des prestataires obligatoires hors démonstration ; valeurs de démonstration refusées ; webhooks désactivés sans secret réel | Bloqué |
| Données de démonstration en production | Aucun amorçage hors démonstration ; installation par fichier d’amorçage qui n’écrase jamais un compte | Bloqué |
| Référence expirée, double paiement, paiement sur obligation annulée | Référence expirée close ; paiement tardif ou en double porté en compte d’attente, sans quittance, remboursable une seule fois | Bloqué + détecté |
| Montant arrondi à la baisse (149,995) | Montants à plus de décimales que la devise refusés | Bloqué |
| Doublon remboursé deux fois | Ligne de relevé rapprochée du paiement non affecté ; une restitution par unité d’argent | Bloqué |
| Crédit bancaire orphelin ou règlement manquant « classé » | Exception d’argent close seulement par suspens, rapprochement ou opération exécutée, avec justificatif ; créances prestataires vieillies, alerte à 3 jours, clôture bloquée | Bloqué + détecté |
| Contre-écriture qui efface une recette | Interdite sur les écritures liées à un paiement, une obligation ou un suspens ; contrôle de cohérence grand livre ↔ états métier avec alerte | Bloqué + détecté |
| Remboursement vers un autre compte | Destination = instrument d’origine seulement ; référence du remboursement et pièce obligatoires ; troisième approbation au-delà d’un seuil | Bloqué |
| Détournement du compte bénéficiaire | Double validation, délai de carence avec veto, version du compte enregistrée sur chaque ordre et chaque ligne de relevé | Bloqué + détecté |
| Espèces gardées par un point agréé, faux bordereau | Délai compté depuis la fin de la journée de caisse ; versement « déclaré » jusqu’au rapprochement bancaire en double validation ; bordereau unique ; contrôle horaire des retards | Bloqué + détecté |
| Espèces sur une obligation annulée | Référence close à l’annulation ; encaissement refusé | Bloqué |
| Point suspendu rétabli par complicité | Rétablissement et rejet de proposition en double validation | Bloqué |
| Dette réduite à zéro par une seule personne | Remise calculée depuis le taux certifié, plafond cumulé sur toute la chaîne, instruction puis décision par des personnes distinctes ; mise à zéro seulement par admission en non-valeur, jamais « soldée » | Bloqué |
| Réclamation, correction de déclaration, exonération complaisantes | Montant justifié, instructeur ≠ décideur, conflit d’intérêts, taux plafonné par la règle, double validation des baisses | Bloqué |
| Rang de localité ou base d’imposition minorés | Rang déclaré provisoire, confirmé par une autre personne, re-liquidation ; base inférieure aux données connues soumise à approbation | Bloqué + détecté |
| Plan d’échelonnement abandonné | Défaut proposé automatiquement, alerte, obligation en retard à la dernière échéance | Détecté |
| Suspension d’un barème pour « oublier » des pénalités | Suspension et levée en double validation ; alerte si courte ou si des décisions ont eu lieu pendant la suspension | Bloqué + détecté |
| Commission sur de faux constats ou des paiements spontanés | Commission seulement sur dossiers retenus et constats validés avec photo ; présence GPS et délai de grâce ; premier contrôle classé à l’heure serveur ; attribution figée après rapprochement | Bloqué |
| Agent qui multiplie les constats | Signaux comparés aux pairs, alertes, contre-vérification aléatoire de 5 % des constats retenus | Détecté |
| Journal d’audit tronqué ou sauvegarde ancienne restaurée | Tête de la chaîne ancrée hors base ; démarrage refusé si la chaîne est plus courte ou différente ; restauration tracée, retour arrière sur confirmation explicite ; déclencheur d’ajout seul non contournable | Bloqué + détecté |
| Réductions dispersées, invisibles | Rapport des réductions de recettes (brut, réductions par type et par décideur, net, recouvré, rapproché au centime) ; alertes de concentration ; recettes potentielles non liquidées (sans montant inventé) | Détecté |
| Confirmation de paiement rejouée ou interceptée | Signature v2 couvrant horodatage, nonce et corps ; fenêtre de ± 5 min ; nonce déjà vu refusé, même après redémarrage (registre persisté) ; rotation des secrets par identifiant de clé | Bloqué |
| Paiement sur une référence restée ouverte après solde, annulation ou non-valeur | Références actives closes automatiquement dès que l’obligation n’est plus payable ; tout versement tardif porté en paiement non affecté, sans quittance | Bloqué |
| Versement de point agréé jamais rapproché | Rapprochement automatique à l’import du relevé du Trésor ou à la déclaration du versement ; écart de montant, mauvais compte ou double crédit → exception du Trésor ; crédits orphelins résolus avec référence, jamais supprimés | Bloqué + détecté |
| Commission versée sans contrôle humain | Commission payable seulement après validation par un superviseur distinct de l’agent et du vérificateur du constat ; montant recalculé à la validation | Bloqué |
| Binôme complice sous double validation | Détecteur de collusion (paires récurrentes, validations éclair, hors heures, approbateur qui ne refuse jamais) sur 17 circuits, exécuté chaque jour et à la demande ; rotation obligatoire activable | Détecté (bloquable) |
| Clé absente, de démonstration ou partagée entre deux usages | Démarrage refusé hors démonstration ; écran de santé des clés (empreinte, âge, alertes), sans jamais révéler un secret | Bloqué + détecté |
| Journées comptées en UTC (écart d’un jour à 23 h) | Échéances, journées de caisse, indicateurs du jour, transparence et rapports en journées de Kinshasa (UTC+1) | Bloqué |

**Mise en production : paramètres obligatoires.** Hors démonstration, le serveur refuse de démarrer sans : secrets des prestataires (`MOSOLO_PROVIDER_SECRET_*`), clés de signature des quittances et des clôtures (`MOSOLO_RECEIPT_SIGNING_KEY`, `MOSOLO_CLOSURE_SIGNING_KEY`), clé et ancre de l’audit (`MOSOLO_AUDIT_HMAC_KEY`, `MOSOLO_AUDIT_ANCHOR_PATH`), adresse publique (`MOSOLO_PUBLIC_URL`), origines autorisées (`MOSOLO_CORS_ORIGINS`), clé des jetons (`MOSOLO_JWT_PRIVATE_KEY`) et clé des sauvegardes (`MOSOLO_BACKUP_KEY`) ; il refuse aussi une clé de démonstration, trop courte, éphémère ou réutilisée pour deux usages. Rotation sans interruption : `MOSOLO_PROVIDER_SECRET_<PRESTATAIRE>=kid:secret,kid:secret` (la première clé signe, les suivantes restent acceptées) et `MOSOLO_RECEIPT_VERIFY_KEYS` pour les clés publiques retirées des quittances ; âge des clés déclaré par `MOSOLO_KEY_DATES`. Le détail figure dans `backend/README.md`.

**Risques organisationnels : ce que le logiciel outille.** Le logiciel ne peut pas supprimer une complicité humaine ; il la rend coûteuse et visible :

- **Collusion sous double validation** — détecteur quotidien sur tous les circuits à deux personnes (écran « Collusion », module Intégrité) ; alertes à l’audit interne, jamais de sanction automatique ; une personne ne voit jamais les signaux la concernant. **Rotation obligatoire** des binômes activable par une décision à deux (désactivée par défaut).
- **Seuils anti-fraude** — registre unique de 58 paramètres (valeur, unité, fichier source) : chacun est « PAR_DÉFAUT — à confirmer par le maître d’ouvrage » tant qu’un acte n’est pas enregistré par une double validation ; un écart entre le code et la valeur confirmée le fait revenir à « PAR_DÉFAUT ».
- **Gestion des clés** — écran de santé des clés et refus de démarrage sur toute anomalie critique ; rotation par identifiant de clé.

**Risques résiduels (hors logiciel).** Collusion de trois personnes habilitées ou plus ; fausses pièces d’identité à l’enrôlement ; complicité au sein d’un prestataire de paiement ou d’une banque ; accès physique aux serveurs ; garde des clés. Parades : rotation des agents, contrôles mystère, inspection des services, revue des alertes par l’audit interne, ancrage externe de l’audit conservé par une autorité distincte, coffre de secrets, contrats et audits des prestataires.

Tests : `backend/test/{tresor-fuites,fraude-agents,reductions,reductions-gouvernance,plateforme-integrite,securite,money-path,commissions-terrain,callback-hmac,obligation-closure,kinshasa-dates,canaux-releve,integrite-gouvernance,commissions-validation}.test.ts` et ajouts dans `acces`, `canaux`, `titres`.

## I.20 Ce qui reste ouvert

Les points suivants ne relèvent pas du logiciel seul ou attendent un acte, un protocole ou une convention ; ils sont signalés dans les écrans concernés et ne produisent aucun effet financier tant qu’ils ne sont pas levés.

| Domaine | Point ouvert | Condition de levée |
|---|---|---|
| Commission et surveillance | Arrêté fixant le taux de 10 % ; validation des seuils de surveillance des constats | Arrêté du Gouverneur ; avis de l’inspection des services |
| Publicité | Barème de la publicité sur véhicule ; régime des enseignes (taxe au m² ou barème propre) | Actes de l’Hôtel de Ville et fiches de règles certifiées |
| Contrôles anti-fraude | Confirmation des 58 seuils du registre anti-fraude (remboursement, alertes, grâce de stationnement, rayon de présence, contre-vérification, collusion, rotation) et des taux maximaux de remise par règle ; décision d’activer la rotation obligatoire des binômes ; table certifiée des rangs de localité | Acte enregistré dans le registre (double validation) ; inspection des services, Trésor, acte fixant les rangs |
| Prestataires de paiement | Passage des prestataires réels à la signature v2 (horodatage, nonce, identifiant de clé) | Avenant technique aux conventions ; l’ancienne signature est refusée |
| Tarifs et assiettes | Tarifs réels du pass wewa, du stationnement, des titres de transport, de la publicité, des redevances AVIA et portuaires, de la contribution plastique | Actes J21, J23, J24, J25, J28 et fiches de règles certifiées (quatre visas) |
| Quitus fiscal | Effet bloquant sur les mutations et services | Acte J6 ; le quitus reste informatif jusque-là |
| Répartition | Parts légales éventuelles entre entités | Lecture de l’OL 18/004 et actes provinciaux ; aucune clé paramétrée |
| Identité | Clés d’accès FIDO2 (passkeys), récupération de compte | Raccordement WebAuthn ; procédure de récupération validée |
| Canaux | Passerelles USSD, SMS, SVI et courrier réelles ; code court et numéro vert ; compte WhatsApp Business certifié et fournisseur contractualisé ; validation des textes lingala de l’assistant | Conventions opérateurs (J29), contrat du fournisseur WhatsApp, avis de l’autorité de protection des données |
| Données géographiques | Géométries PostGIS, référentiel officiel des codes de communes, cartographie de la population ; installation du fond OSM de Kinshasa sur le serveur de la Ville (`tools/maps/construire-tuiles-kinshasa.sh`) et complétion des quartiers | Protocoles de données et référentiel arrêté ; accès réseau à `build.protomaps.com` ou `download.geofabrik.de` depuis le serveur |
| Partenaires | Connecteurs BSP/GDS et IFA (AVIA), passerelle bancaire réelle (CALCU), immatriculations nationales | Accords et protocoles avec le pouvoir central et les partenaires |
| Exploitation | Persistance des états encore volatils (idempotence, brouillons serveur, lots terrain, boîtes in-app), clé de signature QR dédiée, secrets TOTP au coffre de secrets | Mise en production (hébergement souverain) |
| IA | Registre complet des modèles (évaluations, biais, dérive), OCR des baux, « 12 questions » par action | Gouvernance IA validée par le délégué à la protection des données |
| Catalogue des API | Simulation de liquidation par le contribuable : le Cahier (ch. 31) cite « Contribuable, agent » pour `POST /v1/liquidations/simulation`, la politique d'accès actuelle réserve la simulation aux rôles de liquidation et de contrôle (R06, R07, R11) ; non élargie | Arbitrage du maître d'ouvrage (élargir au contribuable sur ses seuls objets, ou maintenir) |

## I.21 Catalogue des API : routes françaises du Cahier (chapitre 31)

#### Module « catalogue-api » — 20 routes du Cahier, relais réels vers les routes construites

Les routes du noyau du Cahier (chapitre 31) existent désormais sous leur nom français, **en plus** des routes canoniques (inchangées). Chaque route relaie vers la route canonique par le pipeline complet du serveur (aucune règle métier dupliquée) : en-têtes conservés (`Authorization`, `Idempotency-Key`, `X-Request-Id`, cookies, signatures), corps brut conservé octet pour octet quand il n'est pas transformé (rappels des prestataires, lots signés des terminaux), adresse du client conservée (limitation par poste de la vérification publique), audit sous le même identifiant de corrélation, débit compté une seule fois, notifications au mandant émises une seule fois. Table lisible par machine : `GET /v1/catalogue-api` (méthode, route française, objet, acteur autorisé, contrôles, route canonique).

| # | Route française (Cahier) | Objet | Acteur autorisé | Contrôles | Route canonique relayée |
|---|---|---|---|---|---|
| 1 | `POST /v1/comptes` | Créer un compte | Public | Vérification téléphone, anti-doublon, journal | `POST /v1/registrations` |
| 2 | `POST /v1/identites/verification` | Élever le niveau de vérification | Contribuable, agent | Pièces, double validation N3 | POST /v1/acces/identity/{id}/otp · …/otp/verify · …/proofs · POST /v1/acces/identity-proofs/{id}/review (champ `etape`) |
| 3 | `POST /v1/objets` | Déclarer un objet | Contribuable, agent | Géolocalisation, catégorie, preuve | `POST /v1/fiscal-objects` |
| 4 | `POST /v1/baux` | Déclarer un bail | Bailleur, locataire | Cohérence loyer, unité, période | `POST /v1/leases` |
| 5 | `GET /v1/objets/{id}/obligations` | Obligations applicables | Contribuable, agent habilité | Filtrage par rôle et territoire | GET /v1/obligations?objectId={id} (filtre ajouté) |
| 6 | `POST /v1/liquidations/simulation` | Simuler une liquidation | Contribuable, agent | Règle publiée uniquement | POST /v1/assessments/calculate (simulate: true imposé ; règle non ACTIVE ⇒ 422 RULE_NOT_PUBLISHED) |
| 7 | `POST /v1/regles` | Proposer une règle | Juriste | Interdiction de créer, valider et publier par la même personne | `POST /v1/legal-rules` |
| 8 | `POST /v1/regles/{id}/publication` | Publier une règle | Approbateur | Quatre yeux, texte légal obligatoire | `POST /v1/legal-rules/{id}/approve` |
| 9 | `POST /v1/paiements/ordres` | Créer un ordre de paiement | Contribuable | Idempotence, référence unique, expiration | POST /v1/obligations/{id}/payment-orders (obligation dans le corps, Idempotency-Key relayée) |
| 10 | `POST /v1/paiements/callback` | Confirmation prestataire | Partenaire agréé | Signature, anti-rejeu, vérification serveur | POST /v1/providers/{provider}/callbacks (prestataire : en-tête X-Provider ou champ `provider` ; corps brut relayé octet pour octet) |
| 11 | `POST /v1/reglements/import` | Relevé de compte public | Trésorerie, banque | Contrôle d'intégrité, double validation | `POST /v1/settlements/statements` |
| 12 | `GET /v1/rapprochements/exceptions` | Files d'exception | Trésorerie, contrôle interne | Lecture seule, journalisée | `GET /v1/reconciliation/exceptions` |
| 13 | `GET /v1/quittances/{ref}/verification` | Vérifier une quittance | Public | Divulgation minimale | `GET /v1/public/receipts/{code}` |
| 14 | `POST /v1/missions/synchronisation` | Synchroniser le terrain | Agent | Appareil enregistré, résolution de conflits | POST /v1/field-sync/batches (corps brut signé par le terminal) |
| 15 | `POST /v1/constats` | Enregistrer un constat | Agent habilité | GPS, photo, horodatage, géorepérage | POST /v1/terrain/missions/{id}/findings (mission dans le corps) |
| 16 | `POST /v1/recours` | Introduire une contestation | Contribuable | Délai légal, accusé de réception | `POST /v1/appeals` |
| 17 | `GET /v1/alertes-fraude` | Consulter les alertes | Enquêteur, audit | Aucune action automatique | GET /v1/integrite/alerts (ou GET /v1/security/alerts avec `?source=securite`) |
| 18 | `GET /v1/tableaux/{profil}` | Données de tableau de bord | Selon rôle | Agrégation conforme au périmètre | GET /v1/tableaux/{profil} (déjà construite ; = GET /v1/pilotage/tableaux/{profil}) |
| 19 | `GET /v1/previsions` | Scénarios de recettes | Direction, Gouverneur | Hypothèses jointes | `GET /v1/pilotage/scenarios` |
| 20 | `POST /v1/affectations/scenarios` | Générer des scénarios d'affectation | Finances | Aucune exécution de dépense | `POST /v1/pilotage/projets/recommandations` |

Ajouts au socle : filtre facultatif `objectId` sur `GET /v1/obligations` (refus explicite sans droit sur l'objet, puis filtrage de chaque obligation par rôle et territoire) ; contrôle « règle publiée uniquement » propre à la simulation du catalogue (journalisé `assessment.simulation.refused`). Tests : `backend/test/catalogue-api.test.ts` (16 tests : chaque route, rôle non habilité refusé, même personne refusée à la publication, simulation sans obligation, rejeu idempotent de l'ordre de paiement, signature du rappel vérifiée sur le corps brut et rejeu refusé, vérification publique minimale, débit compté une fois, corrélation d'audit).


## I.21 Programme : risques, recette, versions, 100 premiers jours, décisions (Document maître FR 2, ch. 41–48)

Module d'extension « programme » (`backend/src/plugins/pilotage/programme/`), voisin de la planification. Il en réutilise
le circuit des instructions sans le modifier. Aucune action financière, aucune décision automatique.

| Écran | Route | Contenu |
|---|---|---|
| Registre des risques (`/pilotage/risques`) | `GET /v1/pilotage/programme/risques` ; revues et propriétaire | 13 risques cités ; carte de chaleur ; mesures reliées au code et aux tests ; revue par une personne, retard signalé |
| Recette — critères d'acceptation (`/pilotage/recette`) | `GET /v1/pilotage/programme/recette` ; suivis du monde réel | 15 critères (dont 5 à relier à la fusion du lot « postes de décision » — reliés à la fusion du 27/09/2026 : un test par critère dans `backend/test/postes-decision-acceptation.test.ts`) ; 10 récits ; 9 points de stratégie ; 8 suivis externes |
| Plan de livraison par versions (`/pilotage/versions`) | `GET /v1/pilotage/programme/versions` ; état de mise en service | V0.1 à V3.0, modules livrés vérifiés à l'exécution |
| Plan des 100 premiers jours (`/pilotage/cent-jours`) | `GET /v1/pilotage/programme/cent-jours` ; jour 1 ; actions ; instruction | 6 périodes, 18 actions, responsables |
| Décisions du Gouvernement provincial (`/pilotage/decisions-gouvernement`) | `GET /v1/pilotage/programme/decisions` ; enregistrement ; validation (second facteur) | 10 décisions, acte et empreinte, deux personnes, verrous calculés, contradiction du § 37A signalée, synthèse 48.2 |
| Carte des écarts (`/pilotage/assignations`) | `GET /v1/pilotage/assignations/ecarts/export` | Exportation signée (écarts et six états par commune), carte schématique des 24 communes |

Tests :

- `backend/test/recette-programme.test.ts` : textes cités mot pour mot, existence de chaque preuve citée, parcours complets ;
- `backend/test/recette-criteres.test.ts` : un test par critère du ch. 42, plus les tests de paiement de bout en bout et
  d'élévation de privilèges ;
- `backend/test/carnet-recits.test.ts` : un test par récit du ch. 43 ;
- `frontend/test/recette-programme.test.tsx` : pages, accessibilité et navigation ;
- `frontend/test/recette-hors-ligne.test.ts` : journée complète hors réseau.

Script de charge : `tools/charge/pic-fin-janvier.mjs`, Node seul, jamais lancé en intégration continue. La matrice de
couverture est dans `couverture-ch41-48.md`.

## I.21 Document maître FR 2 (nouvelle version) — chapitres 1 à 17 et 19 à 30 : analyse mot à mot et compléments

Le Document maître FR 2 reçu le 27/09/2026 a été rapproché, phrase par phrase, du logiciel construit. La matrice complète (exigence → code → test → statut) figure dans `docs/document-maitre/couverture-nouvelle-version-ch01-30.md` ; elle cite pour chaque exigence un emplacement du code et au moins un test automatisé. Les compléments ci-dessous s’ajoutent à l’existant, sans rien retirer.

| Exigence | Complément | Routes / écrans |
|---|---|---|
| § 17.2 identifiant géographique fiscal | Format du Cahier « KIN-<commune>-<quartier>-<voie>-<n°> » attribué EN PLUS du format territorial existant (conservé), comme alias stable et non réattribuable ; résolution dans les deux formats | `GET /v1/fiscal/igf/:code` ; fiche des biens, corrections d’objets |
| § 30 et § 17.3 cycle de vie de l’objet | Provisoire, actif, suspendu (litige de limites, contestation, habitat informel à qualifier), clos (quatre yeux) ; aucune nouvelle liquidation sur un objet suspendu ou clos ; litige affiché en bleu | `POST /v1/fiscal/objects/:id/suspension`, `/reactivation`, `/closure`, `POST /v1/fiscal/object-closures/:id/decision`, `GET /v1/fiscal/object-closures` ; panneau « Cycle de vie » |
| § 30 bail | État « résilié » : résiliation datée par une partie, autre partie notifiée, bail conservé | `POST /v1/fiscal/leases/:id/resiliation` ; attestations de bail |
| § 16.6 couverture locative | Indicateurs par avenue, quartier et commune (enregistré, occupé/loué, bailleurs et locataires, valeur locative annualisée par devise, obligations, concentration) ; estimé et taux de couverture « non mesurés » | `GET /v1/fiscal/couverture-locative` ; vagues de recensement |
| § 17.1 couches | Catalogue des 21 couches avec source, route et effectif ; couches sans données « non disponibles » | `GET /v1/fiscal/couches` ; carte fiscale |
| § 15.2 remise d’un avis | Signature recueillie (empreinte) ou refus consigné, position et témoin, par l’agent de constat ; valeur probante à vérifier | `POST /v1/recouvrement/avis/:id/remise` ; aperçu de l’avis |
| § 23 et § 13.4 recours | Propriétaire dès le dépôt (service compétent) puis agent désigné ; indicateurs de délai pour la direction de la régie et l’audit interne ; écran de traitement des recours (instruction, décision, effet suspensif) | `POST /v1/appeals/:id/assign`, `GET /v1/appeals/indicateurs`, `GET /v1/appeals/proprietaires` ; écrans « Réclamations et recours » et « Journal d’audit » |
| § 30 et § 12 | Modèle de données (29 entités, états du Cahier ↔ états du code, effectifs sans nom) et matrice des 16 rôles évaluée en direct | `GET /v1/referentiel/modele-donnees`, `GET /v1/referentiel/matrice-habilitations` ; « Modèle de données et habilitations » |

**Contradictions et différences signalées (arbitrage du maître d’ouvrage).** (1) Deux formats d’identifiant géographique coexistent (§ 17.2). (2) Le § 28.1 (« aucune part automatique pour l’administrateur de la plateforme ») contredit le modèle du promoteur (§ 37A) : le § 37A est conservé tel quel. (3) Les modules 59–61 du Cahier (RFCK) entrent en collision avec les numéros 59–61 déjà attribués (grand livre, coffre, découverte). (4) Lignes 41–44 du catalogue et chapitre 27 : repris par le lot « postes de décision ». Tests : `backend/test/document-maitre-fr2.test.ts`, `frontend/test/document-maitre-fr2.test.tsx`.

## I.22 Postes de décision des autorités et postes de travail des opérateurs (Cahier nouvelle version, ch. 27 ; catalogue n° 41 à 44, ajout du 27/09/2026)

**Noms du catalogue (ch. 11, 27/09/2026)** — le nom nouveau d'abord, l'ancien conservé (règle n° 1) : n° 41 « Postes de
décision des autorités » (ancien « Centre de commandement exécutif ») ; n° 42 « Poste de travail — régie fiscale »
(ancien « Tableau de bord régie fiscale ») ; n° 43 « Poste de travail — régie des taxes » (ancien « Tableau de bord régie
des taxes ») ; n° 44 « Postes ministériels » (ancien « Tableaux de bord ministériels »). Les tableaux existants restent
tous disponibles : tableau du Gouverneur (`/gouverneur`, libellé « Tableau de bord du Gouverneur (Centre de
commandement) »), tableaux par profil (`/v1/pilotage/tableaux/:profil`), centre de commandement et tableaux des régies et
des ministères du module « décision » (`/decision/*`, libellés renommés avec l'ancien nom entre parenthèses), instructions,
arbitrages, validations, élévations, portes de phase. Le rôle R03 s'affiche « Secrétaire exécutif du Gouvernement
provincial » ; « Secrétaire général » reste reconnu comme alias (`ROLE_ALIASES`).

Module d'extension « postes » (`backend/src/plugins/postes/`) construit **par-dessus** ces écrans. **Il ne modifie aucune
habilitation** : il présente ce qui attend une décision, relit les circuits des modules sources (lecture seule) et relaie
« Approuver » et « Refuser » vers la route de décision EXISTANTE de la source (mêmes gardes, mêmes quatre yeux, même
journal). Aucune route qui modifie une dette, un paiement, une quittance ou un compte bénéficiaire n'est jamais relayée.

| Fonction | Route | Écran | Garde-fous |
|---|---|---|---|
| Écran d'accueil sans aucune saisie (Gouverneur, cabinet, secrétariat exécutif, ministres, direction de régie, autorité habilitée) | `GET /v1/postes/accueil` ; export `GET /v1/postes/accueil/export?format=csv\|html[&vue=…]` | `/poste-de-decision` (écran d'accueil des autorités R01 à R05) | Exercice en cours et delta du jour par défaut ; budget d'attention du § 27.2 ; repères et règles communes des maquettes |
| Corbeille et fiche à neuf blocs | `GET /v1/postes/corbeille` ; `GET /v1/postes/fiches/:id[?finalite=]` ; `POST /v1/postes/fiches/:id/action` | `/poste-de-decision/decisions`, `/poste-de-decision/fiche/:id` | Dix catégories du § 27.4 au-delà de leurs seuils ; fiche sans fondement jamais présentée ; motif obligatoire ; dossier nominatif ouvert sur finalité déclarée et journalisée |
| Vues des menus (Recettes, Alertes, Communes ; Instruction, Ordre du jour, Suivi, Coordination ; Exécution, Retards, Documentation ; Mes décisions … Mes engagements ; Recettes, Réalisations, Mon habilitation) | `GET /v1/postes/vues/:vue` | `/poste-de-decision/:vue` | Menus des maquettes ; cinq entrées pour le Gouverneur |
| Dossiers d'orientation instruits par les services | `POST /v1/postes/dossiers` ; `POST /v1/postes/dossiers/:id/reponse` | fiches | Natures de production refusées (« ne remonte jamais ») ; circuit `POSTES_DOSSIER_ORIENTATION` (deux personnes) |
| Préparation et ordre du jour du cabinet | `POST /v1/postes/cabinet/dossiers/:id/preparation` ; `POST /v1/postes/cabinet/ordre-du-jour` | `/poste-de-decision/instruction`, `/ordre-du-jour` | Transmettre seulement un dossier instruit avec fondement ; différer avec date de réexamen ; trace consultable |
| Exécution des décisions (Secrétariat exécutif) | `POST /v1/postes/executions/:id/etat` ; `…/relance` ; `…/justification` | `/poste-de-decision/execution`, `/retards`, `/documentation` | État et blocage DÉCLARÉS par le service responsable ; suspension d'un centre agréé constatée à la source |
| Délégations (§ 27.11) | `GET/POST /v1/postes/delegations` ; `GET /v1/postes/delegations/candidats` ; `POST /v1/postes/delegations/:id/revocation` | `/poste-de-decision/delegations` | Personne nommée de rang inférieur, périmètre et durée déclarés, expiration automatique, révocation ; jamais un compte partagé ; mention « par délégation de … » ; délégation de RÔLE du module 51 reconnue |
| Autres autorités habilitées (§ 27.9) | `POST /v1/postes/habilitations` ; `…/:id/renouvellement` | `/poste-de-decision` (consultation) | Agrégats seulement ; aucune corbeille ni action ; consultations journalisées ; expiration automatique, renouvellement explicite |
| Note du lundi | `GET /v1/postes/notes` ; `POST /v1/postes/notes/production` ; `GET /v1/postes/notes/:id[/impression]` | `/poste-de-decision/note` (hors connexion) | Production automatique hebdomadaire ; empreinte SHA-256 reproductible ; historique ; sans IA |
| Postes de travail (§ 27.13) | `GET /v1/postes/travail` | `/poste-de-travail` | File de travail séparée de la corbeille ; liens vers les postes n° 42 et 43 (`/decision/regie-fiscale`, `/decision/regie-taxes`) |
| Recherche, notifications, indicateur de taille des corbeilles, référentiel | `GET /v1/postes/recherche` ; `GET /v1/postes/notifications` ; `POST …/plafond` ; `GET /v1/postes/indicateurs` ; `GET /v1/postes/referentiel` | `/poste-de-decision/rechercher`, `/indicateurs` | Recherche dans le périmètre ; plafond fixé par l'autorité puis synthèse unique ; alerte au-delà d'une dizaine d'éléments |

Seuils (registre des seuils, deux personnes, tous PAR_DEFAUT — à confirmer par le maître d'ouvrage) : `postes.seuil.*`
(dix catégories), `postes.remontee.*` (7 et 15 jours, 50 et 250 millions CDF, gravité critique), `postes.corbeille.*`
(10 éléments, 5 jours), `postes.delegation.duree_max_jours` (90), `postes.consultation.duree_max_jours` (730),
`postes.notifications.plafond_defaut` (5), `postes.session.duree_max_min` (30). Ordre de remontée et rangs des autorités :
PAR_DEFAUT. Données de démonstration [EXEMPLE] : fiches et chiffres illustratifs des maquettes, jamais présentés comme
réels. Matrice de couverture phrase par phrase : `couverture-ch27-postes-de-decision.md`. Tests :
`backend/test/postes.test.ts`, `backend/test/postes-decision-acceptation.test.ts` (critères C42-11 à C42-15),
`frontend/test/postes.test.tsx`.


## I.23 Préparation à la mise en production (audit du 27/09/2026)

Audit complet de préparation à la production (hygiène du dépôt, dépendances, hébergement, sécurité OWASP, PWA et mobile,
parcours fonctionnels par rôle, invariants financiers, sauvegarde et restauration, injection d'instructions contre l'IA,
charge) : rapport et verdict dans `docs/production-readiness.md` (NO-GO production tant que les conditions externes ne
sont pas réunies ; GO démonstration). Ajouts, sans rien retirer : mode production exigeant PostgreSQL et refusant le point
d'entrée en mémoire, aucun élément fictif en production (données de démonstration conservées et inchangées en mode
démonstration), en-têtes de sécurité (CSP, HSTS, COOP, Permissions-Policy), limitation de débit étendue, image Docker non
privilégiée. Tests : `mode-production`, `durcissement-http`, `refus-par-defaut`, `invariants-financiers`,
`sauvegarde-restauration`, `ia-injection` (backend) ; `api-url` (frontend).

## I.24 Deuxième passe adverse de préparation à la production (27/09/2026)

Seconde passe « testeur de réalité » sur les phases peu couvertes par l'audit I.23 : concurrence, faux succès,
téléversements, injection de pannes, notifications, droits des personnes, abus de session, accessibilité, menu et
droits. Rapport, preuves et fiches de défauts : `docs/production-readiness.md`, § 18. Ajouts, sans rien retirer :

| Ajout | Route / écran | Règle |
|---|---|---|
| Limitation et effacement (anonymisation) des données personnelles | `POST /v1/integrite/privacy/requests` (types `LIMITATION`, `EFFACEMENT`) ; `POST /v1/integrite/privacy/requests/:id/validation` | Deux personnes distinctes (délégué, puis un autre délégué) ; seules les données non exigées par la loi fiscale sont anonymisées ; identité fiscale, obligations, paiements, quittances, grand livre, preuves et journal d'audit conservés (durée fixée par acte — à confirmer) ; écran « Vos données » |
| Contrôle des fichiers déposés (module 38) | `POST /v1/documents`, `…/versions` | Liste fermée de types vérifiés par signature ; exécutables, HTML, SVG refusés ; nom assaini ; doublon signalé |
| Stockage en échec | toutes les écritures ; `GET /health` | Écritures refusées (503 `STOCKAGE_INDISPONIBLE`) tant que la base est en échec ; nouvelles tentatives bornées ; alerte `PERSISTANCE_EN_ECHEC` |
| Tâches planifiées | liquidation, répartition, ParkSmart, AVIA, réserve… | Échec journalisé (`system.job.failed`) et alerté une fois par jour ; jamais silencieux |
| Codes à usage unique | `auth.otp_code` | Jamais conservés en clair (boîte d'envoi, empreinte, avis apposé) |
| Menu aligné sur les droits de lecture | `shared/src/menu.ts` | Présentation seulement : entrées masquées, pages et routes conservées, aucun droit modifié |
| Accessibilité au clavier | fenêtres modales, fiche de décision, contrôle de plaque | Piège de focus, annonce globale, Entrée qui lance le contrôle ; script `tools/accessibilite/parcours-clavier.cjs` |

Tests : `concurrence-adverse`, `fuzz-ecritures`, `entrees-metier-hostiles`, `televersements-adverses`,
`injection-pannes`, `notifications-adverses`, `droits-des-personnes`, `sessions-abus`, `menu-droits`,
`limitation-debit-site` (backend) ; `accessibilite-clavier`, `labels-nav` (frontend).

## I.25 Trousse de visualisation partagée (27/09/2026)

Demande du maître d'ouvrage : une plateforme très visuelle, du Gouverneur à chaque écran. Ajouts, sans rien retirer
(palette, `ChartCard`, `useChartColors`, `ChartTooltip` et tous les graphiques existants conservés ; `ChartCard` étendue
par des propriétés facultatives) :

| Ajout | Emplacement | Règle |
|---|---|---|
| Trousse de graphiques : `KpiTile`/`KpiGrid`, `BarChartViz`, `StackedBarViz`, `LineAreaViz`, `DonutViz`, `GaugeMeter`/`ProgressMeter`, `StatusDistribution`, `HeatGrid`/`MatrixHeat`, `LadderFunnel`, `Sparkline`/`TrendBadge`, `TimelineStrip`, `ChartGrid` | `frontend/src/components/viz/` | Français, clair et sombre sélectionnés, 360 px d'abord, infobulle (survol, toucher, clavier), vue tableau, légende dès 2 séries, jamais la couleur seule, un seul axe, états chargement / vide / erreur / non mesuré |
| Agrégations pures | `frontend/src/lib/aggregate.ts` | Comptages, sommes exactes par devise (jamais de mélange), contre-valeur seulement avec un taux affiché, jours / semaines / mois de Kinshasa, « Autres », parts, tendances |
| Rampes validées (séquentielle sombre, ordinale des six états) | `frontend/src/lib/palette.ts` | Validation consignée dans la charte |
| Charte de visualisation | `docs/document-maitre/charte-visualisation.md` | Règles, résultats du validateur, catalogue avec exemples |
| Poste du Gouverneur visuel | `/poste-de-decision` | Structure des maquettes conservée ; tuiles + courbes (bloc 2), six états, vignette des communes en carte de chaleur |
| Tableau du Gouverneur visuel | `/gouverneur` | Tuiles, tendances, six états, jauge, carte de chaleur, anneaux, série ; graphiques existants conservés |
| Galerie | `/visualisation/galerie` (rôles internes) | Données réelles, sinon `[EXEMPLE]` |

Tests : `aggregate`, `viz` (frontend). Captures : `docs/captures/visualisation/`.
## I.25 Kit de déploiement : Google Cloud, VPS, Vercel / Firebase (27/09/2026)

Instruction du maître d'ouvrage : publier sur un VPS ou sur Google Cloud (Vercel / Firebase cités), **sans réduire la
plateforme** — la même image (tous les modules, API + application web) est publiée partout ; la production ne démarre
jamais en `--demo`. Kit prêt et répété localement (Docker Compose, PostgreSQL 16 réels) ; exécution sur le cloud et
sur un vrai serveur **EXTERNE / NON TESTÉE** (`docs/production-readiness.md`, § 19). Ajouts, sans rien retirer :

| Ajout | Emplacement | Règle |
|---|---|---|
| Google Cloud (transitoire) : Cloud Run une instance à CPU toujours alloué, Cloud SQL PostgreSQL 16 à IP privée (sauvegardes, restauration à un instant donné), Secret Manager, tâches de migration et de sauvegarde signée, Cloud Scheduler, domaine, retour arrière, restauration ; démonstration séparée (remplace Render) | `infra/gcp/` | Secrets générés une fois, jamais affichés ni remplacés ; moindre privilège par compte de service ; coûts donnés comme **estimation** ; hébergement national préféré (souveraineté) |
| VPS / centre de données national : application, PostgreSQL 16, HTTPS automatique, sauvegarde quotidienne signée, pare-feu, fail2ban, mises à jour de sécurité | `infra/vps/` | Retour automatique à l'image précédente si la santé échoue ; restauration par un opérateur distinct du rôle applicatif, retour arrière seulement sur décision écrite |
| Application web seule sur Vercel / Firebase, API réécrite vers le backend | `infra/static/` | Le backend n'y tourne pas (tâches planifiées, chaîne d'audit, processus permanent) ; `sw.js` et `index.html` jamais en cache |
| Migrations rejouables (journal, `IF NOT EXISTS`, verrou consultatif), tâche `npm run db:migrate`, rôle applicatif à droits minimaux | `backend/src/persistence/` | Aucune migration ne recrée un objet existant (contrôle automatique) |
| Bail de l'instance active (migration 004) | `backend/db/migrations/004_instance_lease.sql` | Une instance supplantée n'écrit plus jamais (503, alerte `INSTANCE_SUPPLANTEE`) : pas d'écrasement lors d'une mise à jour |

Tests : `deploiement` (backend) ; validation hors ligne `infra/valider.sh` (scripts, simulations `DRY_RUN=1`,
YAML / JSON, Compose), exécutée en intégration continue.

## I.26 Types de comptes ; départements, modules et variables (27/09/2026, § 12A et § 12.8)

Demande du maître d'ouvrage : « tous les types de comptes sont créés et l'administrateur rattache modules et variables
aux départements ». Ajouts, sans rien retirer (invitations en cascade, fiches de module, circuit de réattribution,
registre des seuils et son circuit à deux personnes, données de démonstration : tout est conservé et réutilisé) :

| Ajout | Emplacement | Règle |
|---|---|---|
| Référentiel des familles, parcours de création et natures d'entité (indicatives) des 37 rôles | `shared/src/comptes.ts` | Présentation ; les contrôles restent au serveur |
| Référentiel des types de comptes | `GET /v1/acces/types-de-comptes` ; écran `/acces/types-de-comptes` (tuiles, pile famille × état) | Décompte vivant dans le périmètre (R08 : son sous-arbre) ; exemples de démonstration marqués `[EXEMPLE]` |
| Contrats de partenariat (R32 à R34) | `GET/POST /v1/acces/contrats-partenaires`, `POST …/:id/decision` ; garde `PARTNER_CONTRACT_REQUIRED` de l'invitation | Enregistré par R26, approuvé par R02 ou R05, personne distincte (valideurs par défaut, à confirmer) |
| Inscription publique du mandataire (R31) | `POST /v1/acces/mandataires/inscriptions`, `POST …/:id/verification` | Téléphone vérifié par code ; un compte par numéro ; agit seulement sous mandat |
| Catalogue des modules rattachables | `backend/src/plugins/acces/catalogue-modules.ts` ; `GET /v1/acces/catalogue-modules` | `M01`–`M81` (spécification fonctionnelle), `V-<slug>` (verticales) ; fiches liées par compétence ; versions du plan de livraison ; domaines de compétence par défaut, à confirmer |
| Rattachement de modules aux entités | `GET /v1/acces/departements`, `GET /v1/acces/departements/:id`, `POST /v1/acces/departements/:id/modules`, `POST /v1/acces/departements/:id/modules/:code/detachement`, `GET /v1/acces/departements/liens`, `POST /v1/acces/departements/liens/:id/decision` | R26 partout, R08 dans son sous-arbre ; motif, dates, historique ; recettes : circuit existant des fiches (acte, seconde validation par une personne distincte) |
| Menu reflétant les rattachements | `GET /v1/acces/menu-rattachements` ; `frontend/src/hooks/useMenuRattachements.ts` (menu latéral et barre du bas) | Présentation seulement ; rôles transverses (audit, exploitation, sécurité) et comptes publics non concernés |
| Variables par département | `backend/src/plugins/integrite/gouvernance/parametres-entites.ts` ; `GET /v1/parametres/effectifs?entity=…`, `GET/POST /v1/parametres/surcharges` ; décision par la route existante `POST /v1/integrite/thresholds/change-requests/:id/decision` | Paramètres modulables par défaut (à confirmer) ; entité → parente → globale ; date d'effet ; barèmes juridiques jamais surchargés |
| Consommateurs branchés | `integrite/securite/surveillance.ts` (plafonds par agent, DLP), `postes/service.ts` (plafond de notifications, corbeille) | Valeur de l'entité de la personne concernée |
| Écran « Départements, modules et variables » | `/acces/departements` (R26, R08) | Arborescence, interrupteurs, historique, variables et provenance, comptes par type ; barres des modules par entité, anneau des comptes par famille ; 360 px |
| Sélecteur de démonstration regroupé par famille | `frontend/src/components/Selectors.tsx` | Les 37 rôles, dix familles |

Tests : `types-de-comptes` (un test par rôle : création par la voie réelle et lecture d'une route du rôle),
`departements` (catalogue, rattachement et historique, second facteur, circuit des recettes à deux personnes, périmètre
R08, cloisonnement, menu, date d'effet, résolution des variables pour deux entités, refus des surcharges), `menu-droits`
(nouvelles entrées) — backend ; `departements` — frontend.

Décisions demandées au maître d'ouvrage (valeurs par défaut en attendant) : liste des paramètres modulables par entité ;
valideurs des contrats de partenariat ; domaine de compétence associé à chaque module porteur de recettes ; natures
d'entité de chaque rôle ; faut-il que les rôles d'autorité (R01 à R05) échappent eux aussi à la restriction de menu.

## I.25 bis — Visuels du périmètre « fiscal » (27/09/2026)

Suite de I.25 : chaque écran des modules fiscal, parcours du citoyen (1 à 12), référentiel, juridique et opportunités
reçoit en tête un résumé visuel de la trousse partagée, tiré des données qu'il charge déjà (aucune route ni aucun droit
élargi, aucun chiffre inventé) ; rien n'est retiré.

| Ajout | Emplacement | Règle |
|---|---|---|
| Visuels fiscaux (biens, déclarations, exonérations, quitus, baux, corrections, carte, autour de moi, anomalies, assiette 2026, conditions, recensement, couverture locative, reprise) | `frontend/src/modules/fiscal/visuels.tsx` | Couleur de situation = état réservé avec icône et libellé ; maille masquée = non mesurée |
| Tuiles d'indicateurs des modules 1 à 12 et ventilations en barres ; visuels des écrans citoyens | `frontend/src/modules/citoyen/visuels.tsx` (`BlocIndicateurs` enrichi, liste conservée) | Valeur absente = « non mesuré » + raison |
| Référentiel des recettes et modèle de données | `frontend/src/modules/referentiel/visuels.tsx` | Aucun taux ni pourcentage |
| Points juridiques et gouvernance des données | `frontend/src/modules/juridique/visuels.tsx` | Progression « suivi (sans cible) » |
| Opportunités, recoupement, maximisation | `frontend/src/modules/opportunites/visuels.tsx` | Aucun potentiel inventé ; tableaux par nature jamais additionnés |
| Conversion du portail public sur la même période que les visites | `backend/src/plugins/citoyen/portail.ts` | Corrige un taux > 100 % |

Détail écran par écran : [couverture-visuelle-fiscal.md](couverture-visuelle-fiscal.md). Tests :
`frontend/test/visuels-fiscal.test.tsx`, `backend/test/citoyen.test.ts`. Captures : `docs/captures/visualisation/fiscal/`.

## I.25.b Visuels du périmètre « intégrité, accès, IA, socle, plateforme, documents, communication, preuves » (27/09/2026)

Chaque écran du périmètre reçoit, en tête, un résumé visuel construit avec la trousse partagée (aucune autre trousse),
dérivé des seules données que l'écran charge déjà, dans les droits de la personne qui consulte ; les tableaux,
formulaires et boutons existants restent en place (les anciennes rangées d'indicateurs sont conservées, repliées sous
« Détail des indicateurs » quand des tuiles les reprennent). Détail écran par écran : `couverture-visuelle-integrite.md`.

| Ajout | Emplacement | Règle |
|---|---|---|
| Visuels communs (états d'une liste, activité par jour de Kinshasa, indicateurs de module en tuiles et jauges) | `frontend/src/modules/plateforme/visuels.tsx` | Cible affichée seulement si le serveur la sert ; « non mesuré » avec motif, jamais zéro |
| Visuels par module | `modules/{integrite,acces,ia,socle,documents,communication}/visuels.tsx`, `modules/plateforme/visuelsPlateforme.tsx`, jauge de validité de `preuves/ProofVerify.tsx` | Tuiles, répartitions par état, anneaux, barres, jauges, carte de chaleur des communes, frises, activité quotidienne |
| Liste des demandes de purge | `GET /v1/documents/purges` (DPO, audit, sécurité) ; écran « Gestion documentaire » | L'approbateur décide depuis la liste (la saisie par identifiant reste disponible) ; décision toujours à deux personnes |
| Résultats visibles des actions | Console d'enquête, Collusion, Détecteurs | « N nouvelle(s) alerte(s) — aucun effet automatique » après chaque exécution |
| Circuit d'arbitrage chiffré | `/acces/arbitrages` | La liste « Circuit » affiche le nombre de dossiers à chaque marche |
| Libellés français d'abord | Délégations, Registre des modèles, Plateforme (clients, appels, livraisons, changements, incidents) | Codes bruts remplacés par leur libellé (code conservé en repli) |
| Appels inutiles supprimés | Gestion documentaire (contribuable) | Catégories et indicateurs lus seulement par les rôles internes (plus de 403) ; aucun droit modifié |

Tests : `visuels-integrite` (frontend, 15 cas), `documents-purges-liste` (backend). Captures :
`docs/captures/visualisation/integrite/`.

## I.26 Écrans généraux, terrain, apprentissage et prestataires : visuels et contrôle fonctionnel (27/09/2026)

Ajout par-dessus l'existant (aucun tableau, formulaire ni bouton retiré). Chaque écran reçoit en tête une synthèse
visuelle construite avec la trousse partagée (§ I.25), **dérivée des données qu'il charge déjà** (aucun droit élargi,
aucun chiffre inventé ; données de démonstration marquées `[EXEMPLE]` ; devises jamais additionnées).

| Écran | Visuels ajoutés |
|---|---|
| Accueil `/` | Catalogue d'événements par catégorie (obligatoires / facultatifs) |
| Espace contribuable `/espace` | Tuiles (obligations à régler, reste dû **par devise**, quittances, biens) ; obligations et quittances par état ; biens par statut probant et par commune ; frise des échéances |
| Inscription `/inscription` (guichet R06, R07, R11, R12) | Pièces en attente de revue par type et niveau de vérification, lien vers le registre d'identité |
| Trésor `/tresor` | Tuiles d'équilibre ; soldes des comptes, un graphique par devise ; demandes de changement du coffre par état |
| Audit `/audit` | Chaîne de hachage, volume par jour, domaines les plus actifs, issues (réussie / refusée / échec), recours |
| Terrain `/terrain` | Missions ouvertes, constats vs objectif, file hors ligne par état |
| Communications, registre des règles, services, verticales, IA, RakaPay | Remise des messages, envois par état, gravité ; règles par état, visas sur 4, devise ; statut juridique des services ; obligations et démarches ; recommandations par agent et niveau d'autonomie ; pass et commandes par état |
| Terrain : supervision, inspection, PV, sous-traitants, qualité, équipements, réserve, vérification d'agent | Missions et constats par état, constats par jour, **carte des 24 communes**, agents et sous-traitants ; PV et contestations ; rotation des zones (seuil servi, « par défaut — à confirmer ») ; terminaux ; points par agent et réserve par module et par devise ; contrôles mystère agrégés |
| Apprentissage : espace, certificats, certifications, procédures | Résultats d'épreuve vs seuil (non passés = non mesurés), exigences de certification, couverture par public, compréhension, publication des procédures |
| Prestataires connectés `/tresor/prestataires` | Ordres par prestataire, webhooks par issue, ordres par état |

Correctifs fonctionnels : relevé bancaire du Trésor contrôlé avant envoi (plus de refus 400 pour une ligne
incomplète) ; `GET /v1/drafts/:key?siAbsent=vide` (200 `{ draft: null }`, 404 inchangé sans le paramètre) supprime
l'erreur réseau des formulaires neufs ; `TimelineStrip` sans événement affiche l'état vide. Tests :
`frontend/test/visuels-ecrans.test.tsx`, `backend/test/brouillons-absents.test.ts`. Détail écran par écran :
`couverture-visuelle-pages.md`. Captures : `docs/captures/visualisation/pages/`.

## I.26 Verticales, stationnement, publicité et chaîne véhicule rendus visuels (27/09/2026)

Suite de I.25 : chaque écran des verticales de la Partie V (`/services/:slug`, 17 verticales), de la console des
verticales, de CALCU, du patrimoine, de l'environnement, des modules sectoriels, des fiches 13 à 25, des grands
redevables, du stationnement (usager, contrôle, régie, tableau de bord, ParkSmart, gains, validation et surveillance des
agents), de la publicité (exploitant, inspection, régie, supervision, carte, contrats) et de la chaîne véhicule
(contrôle technique, scan, fourrières, centres agréés, RFCK, mes véhicules) porte un bloc visuel en tête (tuiles et
graphiques de la trousse), dérivé des données déjà servies, sans droit élargi ; rien n'est retiré.

| Ajout | Emplacement | Règle |
|---|---|---|
| Adaptateurs communs | `frontend/src/verticals/visuels.tsx` | Répartition par état, montants par devise (un graphique par devise), courbes mensuelles de Kinshasa |
| Visuels par module | `modules/{verticales,parking,publicite,vehicules-controle}/visuels.tsx` | Données réelles des mêmes routes ; « EXEMPLE » ; « Suivi (sans cible) » |
| Fiche de verticale sans collision | `GET /v1/verticales/catalogue/:slug` (ancien chemin conservé) | `/services/actifs` n'est plus masqué par la liste réservée du patrimoine (403) |
| Corrections | Parcours de bout en bout (360 px) ; habilitations NFIU au seul périmètre DGIPK | Aucune fonction retirée |

Détail écran par écran : `couverture-visuelle-verticales.md`. Tests : `visuels-verticales` (frontend),
`verticales-fiche-catalogue` (backend). Captures : `docs/captures/visualisation/verticales/`.

## I.26 Périmètre « trésor » rendu visuel et vérifié (27/09/2026)

Trésor, recouvrement, canaux inclusifs, RakaPay et titres : chaque écran reçoit, **en plus** de l'existant (tableaux,
formulaires et boutons conservés), une synthèse visuelle construite avec la trousse partagée, à partir des données
réelles qu'il charge déjà (aucune route nouvelle, aucun droit élargi). Détail écran par écran :
[`couverture-visuelle-tresor.md`](couverture-visuelle-tresor.md).

| Ajout | Emplacement | Règle |
|---|---|---|
| Visuels du Trésor (synthèse de page, files d'exception, suspens, double validation, clôtures, comptabilisation, vérifications publiques, appariements, points agréés, grand livre, coffre, relevés) | `frontend/src/modules/tresor/visuels.tsx` | Soldes : un graphique par devise ; lignes de relevés comptées par devise |
| Visuels du recouvrement (file, espace contribuable, recours, remises, non-valeurs, campagnes, rendement, chronologie d'un avis) | `frontend/src/modules/recouvrement/visuels.tsx` | Balance âgée par devise ; jauges « Suivi (sans cible) » |
| Visuels des canaux (supervision du réseau, jour de caisse, « Où payer ? », enrôlement assisté, carte et avis, USSD/SVI, contestation au guichet) | `frontend/src/modules/canaux/visuels.tsx` | Indicateurs des canaux affichés aux seuls rôles d'agent (`canaux:indicators`) ; données de démonstration marquées EXEMPLE |
| Visuels RakaPay (pilotage, coopérative, opérateurs, analyse quotidienne) et titres (catalogue, indicateurs, constats) | `frontend/src/modules/rakapay/visuels.tsx`, `frontend/src/modules/titres/visuels.tsx` | Cible du paiement numérique lue telle que servie ; estimations du recensement marquées EXEMPLE ; aucun montant de constat |
| Appels voués au refus 403 évités (message clair à la place) | `/tresor` (balance, grand livre, coffre, analyse IA selon le rôle), `/rakapay/pilotage` (signalements), `/rakapay/operateurs` (deux circuits) | Mêmes règles que le serveur ; `useInsight` reçoit un paramètre facultatif `enabled` |
| Libellés d'état en français | Constats (`OUVERT` → « À instruire »…) dans `ConstatsPanel` et le contrôle terrain | Noms français d'abord |
| Débordement à 360 px corrigé | `/recouvrement/campagnes` (bouton des prorogations) | Retour à la ligne |

Tests : `frontend/test/visuels-tresor.test.tsx`. Captures : `docs/captures/visualisation/tresor/`.

## I.26 Pilotage et décision rendus visuels (27/09/2026)

Tous les écrans des modules `pilotage/*`, `decision/*`, `postes/*` et `chaine/*` (tableaux par profil, indicateurs,
répartition § 37A, réductions, piste d'audit, transparence, base de référence et RANV, pilote, feuille de route,
scénarios, assignations, instructions, accords de service, projets et budget voté, partage légal, risques, recette,
versions, 100 jours, décisions du Gouvernement, avis ; centre de commandement, régies, tableau ministériel, salle de
contrôle, audit, prévision ; postes de décision et de travail ; chaîne) reçoivent en tête des tuiles d'indicateurs et
des graphiques de la trousse partagée, calculés sur les données réelles déjà chargées. Rien n'est retiré (tableaux,
formulaires, boutons conservés). Ajouts fonctionnels : gravité du constat d'audit au choix, accès direct à la chaîne
des obligations du périmètre, états chargement / erreur de l'écart de prévision, libellés français des états débloqués
par les décisions, blocs du poste de décision contenus dans le cadre téléphone à 360 px. Détail écran par écran :
`couverture-visuelle-pilotage.md` ; captures : `docs/captures/visualisation/pilotage/` ; test :
`frontend/test/pilotage-visuels.test.tsx`.

## I.27 Prestataires de paiement BitriPay et KODA prêts pour les clés et le webhook (28/09/2026)

Ajout par-dessus les connecteurs existants (rien n'est retiré ; détail au § 18.16 et dans
[`docs/prestataires-paiement.md`](../prestataires-paiement.md)).

| Ajout | Emplacement | Règle |
|---|---|---|
| Confirmation serveur à serveur de l'état de l'intention avant quittance (webhook de production) | `backend/src/modules/payments/service.ts` (`receiveConnectorWebhook`), connecteurs `fetchIntentStatus` | Cahier § 19.2-19.3 ; 409 non final, 503 injoignable (non mémorisé), 422 + alerte critique si contredit |
| Suspens des événements non imputables (référence inconnue, écart de montant, de devise ou d'état) | `payments.providerSuspense` ; exceptions `PROVIDER_EVENT_UNKNOWN_REFERENCE`, `PROVIDER_EVENT_MISMATCH` | Jamais porté sur une obligation ; une entrée par événement |
| Journal des réceptions de webhooks (y compris refusées) et des interrogations d'état | `payments.webhookReceptions`, `payments.statusQueries` | Empreinte du corps, jamais le corps ni un secret |
| Disjoncteur des appels sortants, 503 clair avec `Retry-After` | `connectors/http-client.ts` | 5 échecs / 30 s, délai 10 s, 2 nouvelles tentatives — par défaut, à confirmer |
| Contrôles de démarrage supplémentaires (configuration partielle) | `connectors/registry.ts` | Message nommant la variable |
| Écran « Prestataires de paiement — état de raccordement » + « Tester la connexion » | `frontend/src/modules/prestataires/Raccordement.tsx` ; `GET /v1/providers/readiness`, `POST /v1/providers/{p}/test-connection` | R17, R26, R28 ; noms de variables et présence seulement |
| Hypothèses « À CONFIRMER AVEC LE PRESTATAIRE » affichées | `connectors/a-confirmer.ts` | Aucune supposition silencieuse |
| Saisie des secrets et raccordement Cloud Run | `infra/gcp/secrets-prestataires.sh`, `deploy.sh` (`PRESTATAIRES_SECRETS`, `PRESTATAIRES_ENV_FILE`), `prestataires.env.example` | Saisie sans écho ; secrets refusés dans le fichier non secret |
| Variables VPS commentées | `infra/vps/.env.example` | — |

Tests : `backend/test/prestataires-raccordement.test.ts` (28 tests, simulateur HTTP local).
## I.28 Compte unique appliqué à tous les modules ; liaison des biens et occupations (28/09/2026)

**Compte unique (ch. 9, § 9.9).** Registre de contributions `backend/src/modules/identity/compte-unique.ts` (socle :
`compte-unique-socle.ts` ; routes : `compte-unique-routes.ts`) et un fichier `compte-unique.ts` par module d'extension
(accès, titres, RakaPay, stationnement, publicité, verticales, chaîne véhicule, recouvrement, canaux, communication,
documents ; fiscal dans `plugins/fiscal/service.ts`). Routes : `GET /v1/compte-unique/me`,
`GET /v1/compte-unique/:taxpayerId` (titulaire, mandataire dans le mandat, agent avec consultation motivée),
`GET /v1/compte-unique/fiches-metier`. Crochets du compte (`TaxpayerService.hooks`) : gardes anti-doublon (NIF),
suites d'inscription (rôles ⇒ revendications BROUILLON), suites de vérification du téléphone (rattachement exact des
fiches de métier). Corrections sans retrait : NIF et rôles à l'inscription ; organisation déclarée par une personne
connectée ; NIF / RCCM en double refusés ; conducteur et moto wewa, contrôle des pièces, raison sociale des démarches et
enrôlement en centre agréé reprennent l'identité du compte ; USSD, SVI et canal texte du stationnement suivent la
fusion. Écran : section « Mon compte unique » de `/espace` (graphiques de la trousse). Audit : `compte-unique-audit.md`.
Tests : `backend/test/compte-unique.test.ts` (une inscription, parcelle, bail, revendication, entreprise, stationnement,
ticket et pass wewa, véhicule et contrôle technique, enseigne, paiement, recours — tout sous un compte, aucune seconde
fiche, aucune identité redemandée, doublons refusés, mandataire limité, 403), `frontend/test/compte-unique.test.tsx`.

**Liaison des biens et occupations (§ 16.10, spécification v1.0).** `backend/src/plugins/fiscal/biens-occupations.ts`
(revendications, candidats, pièces, invitations, dossiers de revue, fusion de biens, vue du propriétaire, vue datée),
`biens-config.ts` (paramètres du § 10, par défaut — à confirmer), `biens-routes.ts` (routes françaises
`/v1/revendications-biens`, `/v1/biens-candidats`, `/v1/invitations-biens/:jeton/reponse`, `/v1/dossiers-revue`,
`/v1/biens-declares`, `/v1/biens/:id/vue-proprietaire`, `/v1/relations-biens/effectives`,
`/v1/moi/relations-biens`, `/v1/biens-relations/configuration` ; alias anglais de la spécification
`/v1/property-claims…`, `/v1/property-candidates`, `/v1/invitations/:token/respond`, `/v1/review-cases/:id/decision`,
`/v1/me/property-relationships`). Module 7 étendu (`relations.ts` : rôles ajoutés, `applyValidation`, `effectiveAt`,
relation portée par la revendication) ; objets fiscaux étendus (`recordStatus`, `recordProvenance`, `officialRef`,
`addressEntered`, libellés, `createSelfReported`). Écrans : `/espace/biens-relations`, `/espace/biens/:id`,
`/biens-relations/revue` ; inscription à rôles multiples. Tests : `backend/test/liaison-biens-occupations.test.ts`
(CA-1 à CA-9 nommés, § 5, § 6–7, § 8, § 10, module 7 conservé). Couverture : `couverture-liaison-biens-occupations.md`.

## I.29 Troisième passe GO / NO-GO : durcissements de la liaison des biens, du compte unique et de la démonstration hébergée (28/09/2026)

Ajouts de la troisième passe (`docs/production-readiness.md`, § 21) ; rien n'est retiré (règle n° 1).

- **Invitations de la liaison des biens** (`biens-occupations.ts`) : le bien visé par une invitation
  (`target_unit_id`) doit appartenir à la branche du bien revendiqué (même parcelle, bâtiment ou unité) — un bien étranger
  ou inexistant reçoit la même erreur `INVITATION_TARGET_OUT_OF_CLAIM` (422, aucune sonde d'existence) ; à la réponse,
  la cible est résolue avant toute écriture (aucune pièce ajoutée si la réponse échoue).
- **Contestation** : la version n'est contrôlée qu'après l'autorisation (un tiers reçoit 403, jamais la version
  courante). **Fin d'une relation par un réviseur** : territoire et absence de conflit d'intérêts, comme la décision.
- **Compte unique** (`compte-unique-routes.ts`) : pour une personne du public (R30, R31), un identifiant inexistant
  reçoit le même refus qu'un compte existant d'autrui ; les agents gardent le 404.
- **Démonstration hébergée** (`backend/src/core/demo-gate.ts`) : mot de passe d'accès commun facultatif
  `MOSOLO_DEMO_ACCESS_PASSWORD` (démonstration seulement, ≥ 12 caractères, HTTP Basic puis témoin HttpOnly ; `/health`
  et webhooks signés exemptés). Kit Google Cloud : `DEMO_ACCESS=mot-de-passe` (défaut, secret
  `mosolo-demo-access-password`) ou `public` (comportement antérieur conservé) — choix à confirmer par le maître d'ouvrage.
- **Menu** (`shared/src/menu.ts`, présentation seulement) : entrée « Audit » masquée pour le super-administrateur (R26),
  dont les trois lectures de l'écran sont refusées par le serveur ; route, page et droits inchangés.
- Tests : `backend/test/liaison-biens-adverse.test.ts` (D3-01 à D3-04, en échec sur la version candidate 7168652),
  `backend/test/demo-acces.test.ts` (D3-06) ; contrôle ajouté à `infra/valider.sh`.

## I.30 Catalogue des indicateurs : synthèse des autorités (29/09/2026)

Application du § 27 (« Le Gouverneur n'a pas besoin de tout voir » : quatre à six chiffres, le détail atteint par un
clic, jamais par le menu). Ajout, rien de retiré :

- **Écran** `/pilotage/indicateurs` (`frontend/src/modules/pilotage/Indicateurs.tsx`) : pour les autorités (R01–R05),
  affichage par défaut d'une **synthèse** de six indicateurs de décision — rapprochement à J+1, réalisation des
  assignations, paiement des obligations émises, communes avec recette rapprochée, recours dans le délai, alertes
  critiques — avec définition, formule et source repliées sous « Comprendre ». Le **catalogue complet** (tous les
  indicateurs, graphiques, filtres par domaine) reste accessible en un clic. Les autres rôles voient le catalogue
  complet, inchangé. Sélection **par défaut — à confirmer par le maître d'ouvrage** (`SYNTHESE_AUTORITES`).
- Droits, API et calculs inchangés. Test : `frontend/test/indicateurs-synthese.test.tsx`.
- **Recette — critères d'acceptation** (`/pilotage/recette`, 29/09/2026) : les fichiers et titres de test (données
  brutes destinées aux équipes techniques et aux auditeurs) sont repliés sous « N tests automatisés — voir le détail
  technique » ; synthèse, graphiques, états et suivis inchangés et visibles d'abord. Aucun contenu retiré.
