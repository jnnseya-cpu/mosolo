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

Ensemble : **555 routes** (catalogue : `specs/routes-api.md`), **70 écrans** en plus des 13 écrans du socle, **335 tests backend**, 37 tests d’interface et 16 tests du paquet partagé, tous au vert ; l’application complète (socle et 14 modules) est couverte par un test d’intégration. Chaque écran a été contrôlé à 390 px et 1 440 px sans défilement horizontal.

**Garde-fous vérifiés par les tests, pour tous les modules.** Aucun montant sans règle ACTIVE ; aucune sanction, pénalité, immobilisation, suspension ou blocage automatique (le système constate et propose, une personne habilitée décide avec motif, séparation des tâches) ; fonds uniquement vers les comptes publics du coffre ; aucun encaissement par un agent, un contrôleur, une coopérative ou un sous-traitant ; aucune quittance sur capture d’écran ou SMS ; jamais de double perception d’un même fait générateur (garde du moteur de liquidation et revendication unique par entité) ; vérifications publiques sans nom ni adresse ; l’IA propose, l’humain décide.

## I.1 Socle technique : persistance, identité et sécurité

Le module « socle » donne au monolithe modulaire les fonctions transverses qu'exige la mise en service : une persistance PostgreSQL, une authentification réelle, une limitation de débit et une chaîne d'intégration continue. Rien de cela ne change le fonctionnement par défaut. Sans `DATABASE_URL`, les données restent en mémoire. L'en-tête de démonstration `x-demo-user` reste accepté tant que `MOSOLO_DEMO_MODE` ne vaut pas `false`. Les tests existants et les écrans de démonstration continuent donc de fonctionner.

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
| Démonstration | `x-demo-user`, codes affichés, comptes fictifs | `MOSOLO_DEMO_MODE` (défaut actif) | Désactivation en production |
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

## I.15 Terrain ParkSmart : lecture de plaque, caméra de preuve, pénalités visibles, commission des agents

Décisions du maître d’ouvrage du 27/09/2026, construites et testées.

**1. Lecture de la plaque à la caméra.** Sur le terminal de contrôle, « Scanner la plaque (caméra) » ouvre la caméra arrière avec un cadre de visée au format plaque. La reconnaissance de caractères (Tesseract) est **servie par MOSOLO lui-même** (`/ocr/`, environ 7 Mo) : aucun service externe, et elle fonctionne hors réseau après la première utilisation. Elle n’est pas dans le pré-cache d’installation de l’application.

**La machine propose, l’agent décide** : le texte lu (normalisé au format KN-0000-XX) s’affiche avec sa confiance. L’agent le corrige si besoin, puis « Confirmer et contrôler ». Un secours par photo existe.

Essai réel dans Chromium, caméra simulée filmant l’arrière d’un véhicule : KN-0777-DM lu correctement en moins de 0,3 s une fois le moteur chargé.

**2. Caméra de preuve géolocalisée (plaque ROUGE).** Quand le contrôle est rouge, la caméra de preuve s’ouvre d’elle-même.

- **Vues** : l’agent prend **jusqu’à 5 photos** — avant, arrière (plaque), côté droit, côté gauche avec les abords, une autre vue (signalisation, contexte).
- **Mentions incrustées dans l’image**, dans un bandeau et en filigrane :
  - date et heure (horloge du **serveur**, Kinshasa) ;
  - nom et identifiant de l’agent, numéro du contrôle ;
  - coordonnées GPS avec leur précision ;
  - **lieu saisi par l’agent** (obligatoire) ;
  - plaque et vue.
- **Empreinte et versement** : l’empreinte SHA-256 de l’image finale est calculée sur l’appareil. Le serveur **vérifie l’empreinte**, n’accepte que du JPEG (900 Ko au plus), dans les 30 minutes du contrôle rouge et par l’agent qui l’a fait. Il **conserve l’image telle que reçue** et note l’écart entre l’heure incrustée et l’heure de réception (signalé au-delà de 5 minutes).
- **Protection des photos** :
  - une même image ne peut servir deux fois ;
  - une reprise conserve l’ancienne photo, marquée « remplacée » ;
  - une photo jointe à un constat ne peut plus être remplacée.
- **Sans GPS** : l’agent peut utiliser la position de la zone, **signalée au vérificateur**.
- **Constat et lecture des photos** :
  - le constat référence les photos ;
  - le superviseur les voit pour vérifier, la régie pour décider ;
  - le titulaire de la plaque les voit aussi, pour pouvoir contester ;
  - toute consultation est journalisée.

Le circuit RW1 est inchangé : le **constat ne sanctionne pas**. Vérification et décision restent confiées à deux autres personnes.

**3. Pénalités visibles.**

- **Dans le module** : tout agent du stationnement voit, au contrôle d’une plaque, les pénalités de l’usager (par plaque et par titulaire déclaré). Il voit leur montant, leur état de paiement et l’ancienneté de l’impayé. Consultation journalisée.
- **Dans tous les modules, après 30 jours d’impayé** : une pénalité non payée 30 jours après sa décision devient visible de **tout agent de tout module, à l’occasion d’un contrôle**. Contrôles concernés :
  - titres et tickets ;
  - pass wewa ;
  - scan d’une plaque d’étal, de chantier ou de site ;
  - inspection publicitaire.
- **Garde-fous** :
  - visible **seulement après un contrôle réel** (divulgation journalisée avec la référence du contrôle) ;
  - jamais pour un usager ;
  - **aucun montant** hors du module d’origine, pour réduire le risque d’extorsion ;
  - consigne : inviter l’usager à régulariser par les canaux officiels, **aucun encaissement ni mesure sur place** ;
  - une pénalité contestée, payée ou annulée sort du registre.

**4. Commission des agents : 10 %.** L’agent perçoit 10 % de deux recettes :

- **les pénalités issues de ses constats** : constat vérifié par le superviseur et décidé par la régie, pénalité émise ;
- **les paiements de stationnement générés par ses contrôles** : session ouverte pour la plaque dans l’heure qui suit son contrôle rouge. Un paiement n’est attribué qu’une fois, au premier contrôle.

Chaque ligne passe par des états :

- **en attente** (l’usager n’a pas payé) ;
- **payée, rapprochement en cours** ;
- **acquise** (rapprochée au compte public, à verser) ;
- **annulée** (pénalité annulée sur recours).

**Garde-fous** :
- La commission est calculée sur des recettes **arrivées au compte public** et **versée par le Trésor (paie)**. **Un agent ne reçoit jamais d’argent de l’usager.**
- Aucune pénalité n’existe sans deux autres personnes (vérification, décision).
- Sommes par devise, sans addition de devises.

Tableaux de bord :
- **l’agent** : « Mes gains (10 %) », sur `/stationnement/mes-gains` ;
- **la régie et le pilotage** : « Commissions des agents ».

**Le taux est une décision du maître d’ouvrage : un arrêté est requis avant tout versement réel.**

Risque de conflit d’intérêts à surveiller (indicateurs par agent, contrôles mystère, § 15A) : une rémunération liée aux pénalités incite à multiplier les constats. Les garde-fous ci-dessus (preuve photographique vérifiée, décision par un tiers, recours, annulation de la commission) doivent rester actifs.

Routes :

| Route | Rôle |
|---|---|
| `POST /v1/parking/evidence-photos` | Verser une photo de preuve |
| `GET /v1/parking/evidence-photos/:id` | Lire une photo de preuve |
| `GET /v1/parking/penalties?plate=` | Pénalités d’un usager (agents du module) |
| `GET /v1/parking/agents/me/earnings` | Gains de l’agent |
| `GET /v1/parking/agents/earnings` | Commissions de tous les agents (régie, pilotage) |
| Champ `penalitesImpayees` | Ajouté aux réponses des contrôles des autres modules |

Tests (`backend/test/parking-field.test.ts`) :
- empreintes, formats, délais et verrouillage des photos ;
- constat lié à ses photos, droits de lecture ;
- visibilité à 30 jours et absence de montant ;
- états de la commission, attribution des paiements, droits d’accès.

## I.16 Ce qui reste ouvert

Les points suivants ne relèvent pas du logiciel seul ou attendent un acte, un protocole ou une convention ; ils sont signalés dans les écrans concernés et ne produisent aucun effet financier tant qu’ils ne sont pas levés.

| Domaine | Point ouvert | Condition de levée |
|---|---|---|
| Tarifs et assiettes | Tarifs réels du pass wewa, du stationnement, des titres de transport, de la publicité, des redevances AVIA et portuaires, de la contribution plastique | Actes J21, J23, J24, J25, J28 et fiches de règles certifiées (quatre visas) |
| Quitus fiscal | Effet bloquant sur les mutations et services | Acte J6 ; le quitus reste informatif jusque-là |
| Répartition | Parts légales éventuelles entre entités | Lecture de l’OL 18/004 et actes provinciaux ; aucune clé paramétrée |
| Identité | Clés d’accès FIDO2 (passkeys), récupération de compte | Raccordement WebAuthn ; procédure de récupération validée |
| Canaux | Passerelles USSD, SMS, SVI et courrier réelles ; code court et numéro vert ; compte WhatsApp Business certifié et fournisseur contractualisé ; validation des textes lingala de l’assistant | Conventions opérateurs (J29), contrat du fournisseur WhatsApp, avis de l’autorité de protection des données |
| Données géographiques | Géométries PostGIS, référentiel officiel des codes de communes, cartographie de la population | Protocoles de données et référentiel arrêté |
| Partenaires | Connecteurs BSP/GDS et IFA (AVIA), passerelle bancaire réelle (CALCU), immatriculations nationales | Accords et protocoles avec le pouvoir central et les partenaires |
| Exploitation | Persistance des états encore volatils (idempotence, brouillons serveur, lots terrain, boîtes in-app), clé de signature QR dédiée, secrets TOTP au coffre de secrets | Mise en production (hébergement souverain) |
| IA | Registre complet des modèles (évaluations, biais, dérive), OCR des baux, « 12 questions » par action | Gouvernance IA validée par le délégué à la protection des données |
