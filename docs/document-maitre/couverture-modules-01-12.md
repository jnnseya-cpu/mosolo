# Matrice de couverture — Spécification fonctionnelle, modules 1 à 12 (+ principes de la Partie I)

Légende : **BUILT** = existant, avec test ; **BUILT-NOW** = construit (ou complété) dans ce lot, avec test ; **ADAPTER** = système externe sous convention : adaptateur/bac à sable + interface + test + mention [À RACCORDER — convention requise].
Abréviations : `be:` = backend/test, `fe:` = frontend/test ; `cit` = `backend/src/plugins/citoyen/` ; écrans `frontend/src/modules/citoyen/` sauf mention.

## Partie I — principes communs appliqués aux modules 1 à 12

| Module | Item (short) | Implementation (file/route/screen) | Test (file:test name) | Status |
|---|---|---|---|---|
| I | Légalité : aucun montant sans règle publiée | simulateurs `cit/portail.ts` (INDISPONIBLE sans règle), liquidation véhicules `cit/vehicules.ts` (REGLE_NON_PUBLIEE), transport `cit/transport.ts` (EN_ATTENTE_REGLE) | be:citoyen.test.ts:« IRL : illustration non opposable… », « liquidation par catégorie… refus sans règle ACTIVE », « sans règle ACTIVE : autorisation… NON OPPOSABLE » | BUILT-NOW |
| I | Compte unique / objet | toutes les routes citoyen rattachent compte+objet (relations, attestations, titres) | be:citoyen.test.ts:« le contribuable obtient son attestation… » | BUILT |
| I | Zéro espèce | aucun encaissement dans `cit/*` ; paiement Mobile Money via circuit commun ; inscription USSD « gratuit » | be:canaux.test.ts:« refuse l’encaissement par un agent public… » | BUILT |
| I | Preuve : audit horodaté signé | chaque action `cit/*` → `ctx.audit.append` (ex. cadastre.geometry.recorded avec avant/après) | be:citoyen.test.ts:« géométrie avec précision et source… » (audit) ; be:integration.test.ts:« la chaîne d’audit reste intègre » | BUILT-NOW |
| I | Accès : rôles/attributs, cloisonnement | politiques `citoyen:*` (`definePolicy`), `inTerritory` | be:citoyen.test.ts:« rôle non habilité ⇒ loyer… masqués », « Un contribuable ne voit pas le tableau » | BUILT-NOW |
| I | Séparation des pouvoirs | suspension transport à deux personnes, décisions de revue par une personne, preuves contrôlées par une personne distincte | be:citoyen.test.ts:« suspension par décision motivée à deux personnes » | BUILT-NOW |
| I | IA assistive (ne crée ni dette ni sanction) | détections (patentes, superpositions, anomalies) = listes de revue | be:citoyen.test.ts:« détection ⇒ signaux de vérification… aucune obligation » | BUILT-NOW |
| I | Recours contestables avec délai | `/v1/appeals`, MyArrears (décompte) ; contestation USSD | be:fiscalite-parcours-campagnes.test.ts:« SVI : option « Contester »… » | BUILT |
| I | Inclusion (USSD, SVI, SMS, guichet, agent ; langues) | `canaux/ussd.ts` (+ inscription USSD/SVI BUILT-NOW), enrôlement assisté | be:citoyen.test.ts:« numéro inconnu : option « S’inscrire »… » | BUILT-NOW |
| I | Hors ligne avec synchronisation sûre | portefeuille chiffré `frontend/src/lib/mobile.ts` ; paquet signé titres | fe:citoyen.test.tsx:« portefeuille chiffré (AES-GCM)… » ; be:titres.test.ts:« paquet signé Ed25519… » | BUILT-NOW |
| I | Heure de référence serveur | `x-mosolo-server-time`, contrôle transport/véhicule/pièces à l’heure serveur | be:citoyen.test.ts:« Zone et horaire évalués à l’heure du serveur » ; be:preuves.test.ts:« chaque réponse porte l’heure du serveur » | BUILT |
| I | Définition de terminé (tests) | backend/test/citoyen.test.ts (31), frontend/test/citoyen.test.tsx (16), mobile-capacitor.test.ts (2) | — | BUILT-NOW |

## Module 1 — Identité et compte contribuable

| Module | Item (short) | Implementation (file/route/screen) | Test (file:test name) | Status |
|---|---|---|---|---|
| 1 | Compte unique, espaces personnel + entreprise | `fiscal/enrolment.ts` `GET /v1/enrolement/espaces` ; écran `/mon-espace/profils` | be:fiscalite-parcours-campagnes.test.ts:« espaces sous une seule connexion… » | BUILT |
| 1 | Clés d’identité : NIF / tél. vérifié + pièce / NIF en arrière-plan / RCCM | `acces` proofs+organisations, `fiscal/enrolment.ts` NifRequest ; écran `/acces/identite` | be:acces.test.ts:« personne morale : identifiants déclarés… », be:fiscalite…:« … NIF provisoire… » | BUILT |
| 1 | Niveaux N0, N0-A, N1, N2, N3 | `acces/model.ts` LEVEL_RIGHTS, preuves | be:acces.test.ts:« niveaux par preuves… », « enrôlement assisté N0-A… » | BUILT |
| 1 | Rôles multiples | profils `shared/profiles.ts`, déclarations de rôle | be:fiscalite…:« 19 profils et plus… » | BUILT |
| 1 | Mandats limités, datés, révocables ; notification au mandant | `acces` mandates ; `notifyMandateActs` ; écran `/acces/mandats` | be:acces.test.ts:« mandats : périmètre, durée, révocation… » ; be:securite-acces-audit.test.ts:« un acte du mandataire est notifié au mandant… » | BUILT |
| 1 | Profil unifié | `GET /v1/taxpayers/:id` ; `/espace` (TaxpayerSpace) | be:misc.test.ts:« inscription publique, anti-doublon… » | BUILT |
| 1 | Récupération de compte (tél., pièce, guichet, contrôle renforcé) | `/v1/public/enrolement/recuperations` + vérif. guichet + 2e personne ; écran `/recuperation-compte` | be:fiscalite…:« … récupération : guichet puis seconde personne » | BUILT |
| 1 | Séparation profil contribuable / profil de travail | invitations `acces` (§ 12A.1) | be:acces.test.ts:« AC-INV-01 : le parcours public refuse tout rôle de travail » | BUILT |
| 1 | Identité provisoire puis élévation sur preuves | acces preuves + `cit/pieces.ts` (preuve déclarée + score) | be:acces.test.ts:« niveaux par preuves… » ; be:citoyen.test.ts:« pièce cohérente ⇒ score élevé, preuve déclarée… » | BUILT |
| 1 | Rattacher/détacher un rôle avec pièce et date d’effet | relations datées `fiscal/relations.ts` (preuves, from/to) | be:fiscal.test.ts:« aucune relation sans preuve… » | BUILT |
| 1 | Fusion sur preuve, double validation, réversible | `acces` merges | be:acces.test.ts:« fusion sur preuve avec double validation… réversible » | BUILT |
| 1 | Droits ouverts selon le niveau | politiques + N2 forte valeur | be:fiscal.test.ts:« … objet de forte valeur ⇒ niveau N2 » | BUILT |
| 1 | Journaliser les modifications sensibles et notifier le titulaire | `identity/service.ts` changePhone (audit + avis ancien/nouveau n°) | be:citoyen.test.ts:« changement de téléphone : audit… notifiés » | BUILT (test ajouté) |
| 1 | Aucune fusion automatique sur similitude de nom | `acces.duplicateCandidates` nameOnly | be:acces.test.ts:« aucune fusion sur la seule similitude de noms… » | BUILT |
| 1 | Données sensibles masquées selon le rôle | `taxpayer.read` minimal, maskPhone | be:citoyen.test.ts:« dossier consulté par un agent au périmètre minimal… » ; be:audit-access.test.ts:« ABAC… » | BUILT |
| 1 | Consultation d’un dossier journalisée avec motif | `acces` consultations ; écran `/acces/consultation` | be:acces.test.ts:« motif de consultation : bris de glace… » | BUILT |
| 1 | Données : Person, Organisation, Account, Role, Mandate, Address, contacts, consentements | `identity/service.ts`, `acces/model.ts`, `canaux/model.ts` (consentement) | (tests ci-dessus) | BUILT |
| 1 | Intégration registre NIF (DGI) / RCCM | suivi de demande NIF (statuts saisis par agent), RCCM déclaré | be:fiscalite…:« … NIF provisoire… » | ADAPTER |
| 1 | Indicateurs : comptes par niveau, taux NIF, doublons, délai de vérification | `cit/indicateurs.ts` `GET /v1/citoyen/indicateurs` ; écran `/citoyen/indicateurs` | be:citoyen.test.ts:« douze modules, valeurs réelles… » ; fe:citoyen.test.tsx:« indicateurs : valeur réelle ou « non mesuré »… » | BUILT-NOW |

## Module 2 — Enrôlement et vérification

| Module | Item (short) | Implementation (file/route/screen) | Test (file:test name) | Status |
|---|---|---|---|---|
| 2 | Parcours par profil | `shared/profiles.ts`, `fiscal/enrolment.ts` ; `/mon-espace/profils` | be:fiscalite…:« 19 profils et plus… » | BUILT |
| 2 | Formulaires adaptatifs | champs par profil (ENROLMENT_PROFILES.fields) | idem | BUILT |
| 2 | Contrôle des pièces : photo, lecture auto, cohérence, OCR | `cit/pieces.ts` `POST /v1/citoyen/enrolement/pieces` ; OCR sur l’appareil `frontend/src/lib/documentOcr.ts` ; écran `/citoyen/pieces` | be:citoyen.test.ts:« chiffres de contrôle OACI 9303… », « pièce cohérente ⇒ score élevé… » ; fe:citoyen.test.tsx:« analyse OCR : zone MRZ… », « écran : score de confiance expliqué… » | BUILT-NOW |
| 2 | Anti-doublon probabiliste + suggestions | `cit/pieces.ts` rapprochements ; `canaux/enrolment.ts` doublons ; `acces.duplicateCandidates` | be:citoyen.test.ts:« … même pièce sur un autre compte ⇒ … rapprochement » ; be:canaux.test.ts:« doublon possible : dossier à revoir… » | BUILT-NOW |
| 2 | Enrôlement assisté (lecture à voix haute, empreinte ou témoin) | `canaux/enrolment.ts` ; écran `/canaux/enrolement` | be:canaux.test.ts:« AC-INC-02… », « refuse et journalise tout enrôlement sans lecture du résumé… » | BUILT |
| 2 | Enrôlement par lots (e-DGRK) | `fiscal/imports.ts` ; écran `/fiscal/reprise` | be:fiscalite…:« validation à blanc, intégration par une seconde personne… » | BUILT |
| 2 | Démarrer selon le canal : app, web, USSD, SVI, guichet, agent | USSD/SVI : option « S’inscrire » `canaux/ussd.ts` ; web/app : `/v1/registrations` (+ canal mesuré) ; guichet/agent | be:citoyen.test.ts:« numéro inconnu : option « S’inscrire »… », « inscription web ou application : canal mesuré » | BUILT-NOW |
| 2 | Contrôler chaque pièce, score de confiance | `cit/pieces.ts` (pondération PAR_DEFAUT) | be:citoyen.test.ts:« pièce cohérente ⇒ score élevé… » | BUILT-NOW |
| 2 | Proposer les rapprochements | idem | idem | BUILT-NOW |
| 2 | Cas à risque en revue humaine | `GET /v1/citoyen/enrolement/pieces/revues`, décision `…/decision` (→ contrôle de preuve) | idem (COMPLEMENT_DEMANDE) | BUILT-NOW |
| 2 | Récapitulatif par SMS, appel vocal ou imprimé | USSD/SVI : SMS `account.registration.requested` ; SVI vocal ; carte/avis imprimé `/canaux/carte/:number` | be:citoyen.test.ts:« … Récapitulatif par SMS » ; be:canaux.test.ts:« avis à pictogrammes… » | BUILT-NOW |
| 2 | Déclarer un rôle ≠ propriété ni dette | ROLE_DECLARATION_NOTICE | be:fiscalite…:« … déclarer un rôle ouvre une instruction… » | BUILT |
| 2 | Enrôlement gratuit sur tous les canaux | `noPaymentAttested`, textes « gratuit » | be:canaux.test.ts:« AC-INC-02 : … aucun paiement » | BUILT |
| 2 | Horodatage, GPS, terminal (assisté) | `enrolmentRecordSchema` (capturedAt, gps, deviceId signé) | be:canaux.test.ts:« exige un terminal enrôlé… » | BUILT |
| 2 | Données : dossiers, pièces, scores, consentements | AssistedEnrolment, ControlePiece, RoleDeclaration | (ci-dessus) | BUILT-NOW |
| 2 | Intégrations 1, 6, 38, 63, 64, 65 ; import e-DGRK | canaux/fiscal/acces | (ci-dessus) | BUILT |
| 2 | Indicateurs : par canal, complets du 1er coup, délai moyen, rejet | `cit/indicateurs.ts` | be:citoyen.test.ts:« … Indicateurs : un enrôlement USSD compté », « canal mesuré » | BUILT-NOW |

## Module 3 — Portail contribuable

| Module | Item (short) | Implementation (file/route/screen) | Test (file:test name) | Status |
|---|---|---|---|---|
| 3 | « Mon espace MOSOLO » vert/ambre/rouge | `pages/TaxpayerSpace.tsx`, `fiscal/situation.ts` | be:fiscal.test.ts:« public : agrégats par commune… contribuable : ses biens… » | BUILT |
| 3 | Obligations expliquées (règle, version, assiette, formule, recours) | explanation d’obligation ; TaxpayerSpace | be:misc.test.ts:« AC-ASS-01 : l’explication d’une obligation contient… » | BUILT |
| 3 | Déclarations préremplies (confirmer/contester) | `fiscal/declarations.ts` ; `/fiscal/declarations` | be:fiscal.test.ts:« pré-remplissage IRL… » | BUILT |
| 3 | Paiement : canal, référence unique, quittance immédiate | `modules/payments` | be:payments.test.ts:« AC-PAY-04… » | BUILT |
| 3 | Titres et quittances : téléchargement, QR, historique | receipts PDF, titres | be:titres.test.ts:« commande → référence… » | BUILT |
| 3 | « Contester une donnée » sur chaque objet | MesBiens « Contester », ContestForm | be:fiscal.test.ts:« copropriété : … contestation par l’intéressé » | BUILT |
| 3 | Échéancier et rappels (si légalement autorisé) | `recouvrement` échéanciers ; `/mes-arrieres` | be:recouvrement.test.ts (échéanciers) | BUILT |
| 3 | Espace entreprise : établissements, mandataires, télédéclaration | espaces d’organisation, mandats, déclarations ; établissements `/citoyen/activites` (R30) | be:citoyen.test.ts:« Le contribuable voit ses établissements seulement » | BUILT |
| 3 | N’afficher que les obligations applicables | obligations issues de règles ACTIVE par objet/période | be:integration.test.ts:« jamais de double perception… » | BUILT |
| 3 | Avis de paiement + référence unique | payments, avis `canaux` | be:canaux.test.ts:« paie : génère la référence… idempotente » | BUILT |
| 3 | Suivre chaque recours avec délai légal et décompte | appeals deadlines ; MyArrears | be:field-appeals.test.ts | BUILT |
| 3 | Exporter attestation de situation / quitus | `cit/situation.ts` `POST /v1/citoyen/situation/attestations`, `GET /v1/public/attestations-situation/:n` ; écran `/mon-espace/situation` ; quitus `fiscal/clearances.ts` | be:citoyen.test.ts:« le contribuable obtient son attestation… » ; fe:citoyen.test.tsx:« émission et QR de vérification » ; be:fiscal.test.ts:« délivré sans obligation exigible impayée… » | BUILT-NOW |
| 3 | Aucune donnée de tiers visible | politiques ownTaxpayer | be:payments.test.ts:« un autre contribuable ne peut pas payer (ni voir)… » | BUILT |
| 3 | Authentification forte pour opérations sensibles | `CitoyenService.gardeAuthForte` (mandats, clôture de relation) | be:citoyen.test.ts:« session réelle sans second facteur… » | BUILT-NOW |
| 3 | Session courte sur appareil partagé | `socle` (30 min, non prolongée) ; + verrouillage de l’application | be:socle.test.ts:« jeton : … appareil partagé non prolongé » | BUILT |
| 3 | Indicateurs : actifs, paiement en ligne, délai décl.→paiement, satisfaction | `cit/indicateurs.ts` (SuiviActivite, satisfaction planification) | be:citoyen.test.ts:« douze modules… » | BUILT-NOW |

## Module 4 — Application citoyenne Android et iOS (décision : Android ET iOS)

| Module | Item (short) | Implementation (file/route/screen) | Test (file:test name) | Status |
|---|---|---|---|---|
| 4 | Enveloppe native Android + iOS | `mobile/` Capacitor 6 (config, scripts `construire:android`/`construire:ios`, README) | fe:mobile-capacitor.test.ts:« configuration : deux cibles… » | BUILT-NOW (binaires : SDK absents) |
| 4 | Mode faible débit (2G, reprise) | PWA légère, file hors ligne, pages légères `/preuve` | be:preuves.test.ts:« pages HTML sans script, < 10 Ko… » | BUILT |
| 4 | Paiement mobile (MM, carte, banque) | circuit commun ; transactions mobiles comptées (`x-mosolo-installation`) | be:citoyen.test.ts:« installation à identifiant aléatoire… » | BUILT-NOW |
| 4 | Portefeuille de titres + QR dynamique + compte à rebours | `/application` (DynamicQr, portefeuille) | fe:citoyen.test.tsx:« écran : installation enregistrée… » ; be:titres.test.ts:« QR dynamique régénéré toutes les 30 s… » | BUILT-NOW |
| 4 | Scanner de vérification (quittance, titre, badge) | `/fiscal/verifier`, `/verifier-agent`, QrScanner | fe:qr-scan.test.tsx | BUILT |
| 4 | Notifications | comms in-app/SMS | be:communications.test.ts | BUILT |
| 4 | Multilingue (6 langues, pictogrammes, audio) | i18n, SVI | fe:language-selector.test.tsx | BUILT |
| 4 | Titres chiffrés hors connexion | `frontend/src/lib/mobile.ts` (AES-GCM, PBKDF2) | fe:citoyen.test.tsx:« portefeuille chiffré (AES-GCM)… » | BUILT-NOW |
| 4 | QR régénéré toutes les 30 s | `titres/tokens.ts`, DynamicQr | be:titres.test.ts:« QR dynamique régénéré toutes les 30 s… » | BUILT |
| 4 | Prolonger/renouveler depuis l’application | bouton « Prolonger ou renouveler » → `POST /v1/titres/:id/prolongations` | be:titres.test.ts:« prolongation (nouveau paiement, continuité)… » | BUILT-NOW (écran) |
| 4 | Code et verrouillage automatique (appareil partagé) | `definirCode`/`verifierCode`/`verrouillageAuto` | fe:citoyen.test.tsx:« code d’accès : PBKDF2… », « verrouillage automatique… » | BUILT-NOW |
| 4 | Aucune validité sur l’horloge du téléphone | état serveur conservé ; heure serveur | fe:citoyen.test.tsx:« portefeuille chiffré… état serveur conservé » | BUILT-NOW |
| 4 | Détection d’appareil modifié (fonctions sensibles) | natif `mobile/native/{android,ios}` + `verifierIntegrite` + refus serveur `cit/application.ts` | be:citoyen.test.ts:« … appareil modifié ⇒ fonctions sensibles refusées… » ; fe:citoyen.test.tsx:« crochet « appareil modifié »… » ; fe:mobile-capacitor.test.ts:« module natif… » | BUILT-NOW |
| 4 | Cache chiffré minimal : titres, quittances, préférences | Portefeuille {titres, quittances, preferences} | fe:citoyen.test.tsx:« portefeuille chiffré… » | BUILT-NOW |
| 4 | Indicateurs : installations, transactions, échec, note | `GET /v1/citoyen/application/indicateurs` | be:citoyen.test.ts:« installation à identifiant aléatoire… » | BUILT-NOW |
| 4 | Publication magasins (Google Play, App Store) | comptes développeur de la Ville | — | ADAPTER |

## Module 5 — Portail web public

| Module | Item (short) | Implementation (file/route/screen) | Test (file:test name) | Status |
|---|---|---|---|---|
| 5 | Information : guides, textes, calendrier, points de paiement | `GET /v1/public/informations` ; écran `/simulateurs` | be:citoyen.test.ts:« information publique, visites anonymes… » | BUILT-NOW |
| 5 | Simulateurs IF, IRL, vignette, patente sur règles publiées | `POST /v1/public/simulations` | be:citoyen.test.ts:« IRL : illustration non opposable sur la fiche v2… » ; fe:citoyen.test.tsx:« simulateur IRL… » | BUILT-NOW |
| 5 | Vérification par code ou QR (quittances, titres, cartes, badges) | `/verifier`, `/canaux/verifier-carte`, `/verifier-agent`, carte conducteur publique | be:payments.test.ts:« AC-RCP-01… » ; be:citoyen.test.ts:« carte conducteur rattachée… vérification publique minimale » | BUILT |
| 5 | Transparence par commune | `/transparence`, `pilotage/transparency.ts` | be:integration.test.ts:« routes publiques des modules : transparence… » | BUILT |
| 5 | Inscription publique (compte contribuable seulement) | `/inscription` | be:acces.test.ts:« AC-INV-01… » | BUILT |
| 5 | Simulation sans données personnelles | audit famille+règle seulement | be:citoyen.test.ts:« IRL : … aucune donnée personnelle » | BUILT-NOW |
| 5 | Statut minimal d’un document vérifié | vérifications publiques minimales | be:fiscal.test.ts:« vérification publique minimale… » | BUILT |
| 5 | Statistiques testées contre la ré-identification | `reidentificationCheck` | be:pilotage.test.ts | BUILT |
| 5 | Aucune donnée individuelle publiée | idem | idem | BUILT |
| 5 | Limitation de fréquence des vérifications | `receipts/limiter.ts`, `canaux/limiter.ts` | be:canaux.test.ts:« vérification par code court… limitation anti-énumération » | BUILT |
| 5 | Protection anti-robots | défi SHA-256 `cit/portail.ts` (+ résolution automatique `lib/api.ts`) | be:citoyen.test.ts:« anti-robots : défi SHA-256… » ; fe:citoyen.test.tsx:« 428 DEFI_REQUIS… », « défi : solution valide » | BUILT-NOW |
| 5 | Indicateurs : visites, simulations, vérifications, conversion | `PortailPublicService.indicateurs` | be:citoyen.test.ts:« information publique, visites anonymes… » | BUILT-NOW |

## Module 6 — USSD et SMS

| Module | Item (short) | Implementation (file/route/screen) | Test (file:test name) | Status |
|---|---|---|---|---|
| 6 | Code court gratuit, menus numérotés | `canaux/ussd.ts` ; `/canaux/ussd` | be:canaux.test.ts:« consulte le solde après code secret… » | BUILT |
| 6 | Consultation par objet, plaque ou carte | carte (auth), plaques NFIU/biens (preuves), plaque véhicule (BUILT-NOW) | be:citoyen.test.ts:« USSD : « Vérifier un code » avec la plaque » | BUILT-NOW |
| 6 | Paiement : référence + Mobile Money | `issueOrReuseReference` | be:canaux.test.ts:« paie : génère la référence… » | BUILT |
| 6 | Quittance SMS : numéro et code de vérification | `payments/service.ts` (vars numero+code), `templates.ts` | be:citoyen.test.ts:« le SMS de quittance porte le numéro et le code… » | BUILT-NOW |
| 6 | Rappels (échéances, ambre, relances) | titres amber reminder, recouvrement relances (sms/ussd) | be:titres.test.ts ; be:fiscalite…:« … relances » | BUILT |
| 6 | Vérification par envoi de code au numéro court | `preuves` SMS entrant « V <code> » | be:preuves.test.ts:« « V <code> » répond en moins de 320 caractères… » | BUILT |
| 6 | Router vers le bon objet/obligation | sessions USSD | be:canaux.test.ts | BUILT |
| 6 | Référence idempotente | idem | be:canaux.test.ts:« … (idempotente pour la même obligation) » | BUILT |
| 6 | Confirmation minimale après règlement | `payment.confirmed` | be:payments.test.ts | BUILT |
| 6 | Messages < 160 caractères, sans lien suspect | `smsText` appliqué au canal SMS | be:citoyen.test.ts:« SMS : 160 caractères au plus et aucun lien… » | BUILT-NOW |
| 6 | Aucune donnée sensible complète à l’écran | ussd.ts (AC-INC-03), nom saisi masqué au journal | be:canaux.test.ts:« … sans donnée sensible… » ; be:citoyen.test.ts:« … nom masqué au journal » | BUILT |
| 6 | Messages anti-hameçonnage | aucun lien ; « aucun agent ne demande d’espèces » | be:citoyen.test.ts:« SMS … aucun lien » | BUILT-NOW |
| 6 | Limitation de fréquence | limiter | be:canaux.test.ts | BUILT |
| 6 | Données : sessions, messages, preuves de délivrance | sessions+journal, comms deliveries | be:communications.test.ts | BUILT |
| 6 | Opérateurs télécoms (passerelle USSD, SMS) | simulateur USSD, fournisseur SMS bac à sable | be:canaux.test.ts ; be:connectors.test.ts | ADAPTER |
| 6 | Indicateurs : sessions, paiements USSD, délivrance SMS, coût | `indicateursModule6` (délivrance/coût : non mesuré + raison) | be:citoyen.test.ts:« douze modules… coutParMessage… À RACCORDER » | BUILT-NOW |

## Module 7 — Relations contribuable–objet

| Module | Item (short) | Implementation (file/route/screen) | Test (file:test name) | Status |
|---|---|---|---|---|
| 7 | Rattachement (rôle, dates, pièces) | `fiscal/relations.ts` ; `/fiscal/biens` | be:fiscal.test.ts:« aucune relation sans preuve… » | BUILT |
| 7 | Détachement (vente, fin de bail, fermeture, mutation) | `close` + gardes/suites (patch) | be:citoyen.test.ts:« vente close : obligations… mises en revue » | BUILT-NOW |
| 7 | Revendication d’un objet provisoire | fiscal relations | be:fiscal.test.ts:« revendication d’un objet provisoire… » | BUILT |
| 7 | Historique | relation.history | be:fiscal.test.ts | BUILT |
| 7 | Conflits | disputes | be:fiscal.test.ts:« revendications concurrentes… conflit ouvert… » | BUILT |
| 7 | Valider selon le risque (N2 forte valeur) | fiscal | be:fiscal.test.ts:« … forte valeur ⇒ niveau N2 » | BUILT |
| 7 | Mettre à jour les obligations à la date d’effet | `cit/relations.ts` revues ; écran `/citoyen/relations` | be:citoyen.test.ts:« vente close… décision humaine motivée » ; fe:citoyen.test.tsx:« cadastre… relations… rendus » | BUILT-NOW |
| 7 | Dossier de litige si revendications concurrentes | fiscal disputes | be:fiscal.test.ts | BUILT |
| 7 | Blocage de mutation sans quitus (si la règle l’exige) | garde `avantDetachement` → moteur de dépendances | be:citoyen.test.ts:« mutation foncière : garde branchée… » | BUILT-NOW |
| 7 | Aucune relation sans preuve minimale | fiscal | be:fiscal.test.ts | BUILT |
| 7 | Indicateurs : rattachés, délai, litiges | `RelationsSuiviService.indicateurs` | be:citoyen.test.ts:« vente close… » | BUILT-NOW |

## Module 8 — Cadastre fiscal géospatial

| Module | Item (short) | Implementation (file/route/screen) | Test (file:test name) | Status |
|---|---|---|---|---|
| 8 | Hiérarchie commune → … → activité | `cit/cadastre.ts` hierarchie ; `/citoyen/cadastre` | be:citoyen.test.ts:« géométrie avec précision… » (hiérarchie) | BUILT-NOW |
| 8 | Couches (10) | `couches` ; public agrégé | be:citoyen.test.ts:« couches : sensibles restreintes par rôle… » | BUILT-NOW |
| 8 | Identifiant géofiscal (UUID + code lisible) + QR | `fiscal/geo.ts` | be:fiscal.test.ts:« IGF au format du document maître… QR émis à la validation » | BUILT |
| 8 | Cartes de chaleur (potentiel, conformité, couverture, recettes) | `chaleur` | be:citoyen.test.ts:« couches… chaleur… » | BUILT-NOW |
| 8 | Cas difficiles | `ouvrirCas`/`deciderCas` | be:citoyen.test.ts:« cas difficiles… » | BUILT-NOW |
| 8 | Historique spatial | géométries versionnées | be:citoyen.test.ts:« … historique spatial… » | BUILT-NOW |
| 8 | Point/polygone avec précision et source | `enregistrerGeometrie` | idem | BUILT-NOW |
| 8 | Attribuer l’identifiant, QR sécurisé | fiscal geo | be:fiscal.test.ts | BUILT |
| 8 | Objets superposés ou dupliqués | `detecter` (revue) | be:citoyen.test.ts:« … superposition ⇒ revue, jamais fusion » | BUILT-NOW |
| 8 | Couverture par zone et catégorie | `couverture` | be:citoyen.test.ts:« couches… couverture » | BUILT-NOW |
| 8 | Ne tranche pas les droits réels | renvoi service foncier | be:citoyen.test.ts:« cas difficiles… ne tranche pas… » | BUILT-NOW |
| 8 | Couches sensibles restreintes | `citoyen:cadastre.sensible` | be:citoyen.test.ts:« couches : sensibles restreintes… » ; fe:citoyen.test.tsx:« cadastre : couche sensible réservée… » | BUILT-NOW |
| 8 | Géométries PostGIS | géométries en mémoire/persistance du socle (PostGIS non requis pour les calculs) | — | BUILT (PostGIS = choix d’hébergement) |
| 8 | Cadastre foncier, imagerie sous licence | source IMAGERIE_SOUS_LICENCE / CADASTRE_FONCIER acceptées à la saisie | be:citoyen.test.ts (source imagerie) | ADAPTER |
| 8 | Indicateurs : couverture, géolocalisés, précision moyenne | `indicateurs` | be:citoyen.test.ts:« … precisionMoyenne… » | BUILT-NOW |

## Module 9 — Intelligence foncière et locative (décision IRL 22 % / 20 %–15 %)

| Module | Item (short) | Implementation (file/route/screen) | Test (file:test name) | Status |
|---|---|---|---|---|
| 9 | Registre parcelle → bâtiment → unité → bail | objects/leases | be:misc.test.ts:« … objet provisoire et bail » | BUILT |
| 9 | Déclaration du bail (bailleur/locataire) + attestation | declareLease ; attestations | be:fiscal.test.ts:« délivrée aux parties du bail… » | BUILT |
| 9 | Taux et retenue par rang, arrêté de référence | fiches IRL v2 (22 %, 20 %/15 %), v1 conservées ; simulation non opposable sur v2 (`declarations.ts`) | be:fiscal.test.ts:« pré-remplissage IRL… (v2, 1188.00) » ; be:repartition.test.ts:« versions 2 au statut A_VERIFIER… » | BUILT-NOW |
| 9 | Détection d’anomalies | `fiscal/anomalies.ts` | be:fiscalite…:« six signaux + unités sans bail… » | BUILT |
| 9 | Élargissement 2026 | `fiscal/assiette2026.ts` | be:fiscalite…:« trois fiches au registre… » | BUILT |
| 9 | Carte à deux couches | `fiscal/map.ts` | be:fiscal.test.ts:« public : agrégats par commune… » | BUILT |
| 9 | Calcul retenue + IRL annuel sur baux vérifiés | `cit/locatif.ts` `GET /v1/citoyen/locatif/calcul` ; `/citoyen/locatif` | be:citoyen.test.ts:« bail vérifié ⇒ illustration non opposable… » ; fe:citoyen.test.tsx (locatif) | BUILT-NOW |
| 9 | Signal ⇒ dossier, jamais dette | anomalies | be:fiscalite…:« … aucune obligation créée » | BUILT |
| 9 | Préremplir la campagne annuelle | campagnes | be:fiscalite…:« … lot pré-rempli… » | BUILT |
| 9 | Couverture locative par avenue/quartier/commune | `couverture` | be:citoyen.test.ts (niveau avenue) | BUILT-NOW |
| 9 | Loyer et locataire aux seuls rôles habilités | `citoyen:locatif.loyer` | be:citoyen.test.ts:« … masqués » | BUILT-NOW |
| 9 | Énergie, eau, employeurs sous protocole | anomalies PARTNER_SOURCES (protocole requis) | be:fiscalite…:« sans protocole actif, aucune donnée… » | ADAPTER |
| 9 | Indicateurs : baux, couverture, assiette vérifiée, conformité | `LocatifService.indicateurs` | be:citoyen.test.ts | BUILT-NOW |

## Module 10 — Activités et patentes

| Module | Item (short) | Implementation (file/route/screen) | Test (file:test name) | Status |
|---|---|---|---|---|
| 10 | Registre des établissements (dirigeants, catégorie, localisation) | `cit/activites.ts` `GET /v1/citoyen/activites` ; `/citoyen/activites` | be:citoyen.test.ts:« registre ; obligations… » ; fe:citoyen.test.tsx | BUILT-NOW |
| 10 | Patente annuelle, QR « en règle » | titre PAT-ANNUELLE (acte J1) | be:titres.test.ts:« refuse un type sans acte (J21)… » | BUILT |
| 10 | Commerces de marché (module 20) | verticale marchés | be:verticales.test.ts:« demande d’emplacement… » | BUILT |
| 10 | Débits de boissons (autorisation, horaires, catégorie) | démarche DEMANDE_AUTORISATION (entreprises) | be:verticales.test.ts:« dépôt idempotent… » | BUILT |
| 10 | Recoupement (codes marchands, livraisons, RCCM) | `recouper` (fichier transmis) | be:citoyen.test.ts:« recoupement : fichier transmis… » | BUILT-NOW (connexion directe : ADAPTER) |
| 10 | Obligations selon activité, lieu, catégorie, période | `obligations` | be:citoyen.test.ts:« … obligations sans règle ACTIVE ⇒ aucune » | BUILT-NOW |
| 10 | Certificat de patente QR vérifiable | titres + preuves | be:preuves.test.ts:« reconnaît titres… » | BUILT |
| 10 | Signaler commerces sans patente active | `detecter`/`signaler` | be:citoyen.test.ts:« détection ⇒ signaux… » | BUILT-NOW |
| 10 | Renouveler par Mobile Money + rappel ambre | titres extend + amber | be:titres.test.ts:« prolongation… » | BUILT |
| 10 | Activité ≠ assujettissement | notice + obligations par règle | be:citoyen.test.ts | BUILT-NOW |
| 10 | Pas de visite sans mission autorisée | `planifierVisite` (mission terrain) | be:citoyen.test.ts:« … visite seulement en mission » | BUILT-NOW |
| 10 | Indicateurs | `ActivitesService.indicateurs` | be:citoyen.test.ts:« recoupement… indicateurs » | BUILT-NOW |

## Module 11 — Véhicules et circulation

| Module | Item (short) | Implementation (file/route/screen) | Test (file:test name) | Status |
|---|---|---|---|---|
| 11 | Référentiel (plaque, catégorie, usage, propriétaire, mutations) | `cit/vehicules.ts` `GET /v1/citoyen/vehicules` ; `/citoyen/vehicules` | be:citoyen.test.ts:« contrôle par plaque… Référentiel : propriétaire masqué » | BUILT-NOW |
| 11 | Vignette (liquidation, paiement, autocollant QR, titre lié à la plaque) | titres VIG-ANNUELLE, liquidation par catégorie | be:citoyen.test.ts:« liquidation par catégorie et exercice… » ; be:verticales.test.ts:« paiement du titre… » | BUILT-NOW |
| 11 | Taxe de circulation, même objet, même scan | TSC-ANNUELLE, `situation` | be:citoyen.test.ts ; fe:citoyen.test.tsx:« véhicules : contrôle… » | BUILT-NOW |
| 11 | Mutation bloquée sans quitus si la règle l’exige | PROCEDURE_SERVICES DECLARATION_MUTATION → MUTATION_VEHICULE ; `mutation-verification` | be:citoyen.test.ts:« la déclaration de mutation porte la condition… », « mutation : vérification… » | BUILT-NOW |
| 11 | Contrôle par plaque en ligne/hors ligne | `controle` + paquet signé | be:citoyen.test.ts ; be:titres.test.ts:« paquet signé Ed25519… » | BUILT-NOW |
| 11 | Importer et rapprocher le registre des immatriculations | `importer`/`deciderEcart` | be:citoyen.test.ts:« … import et rapprochement » | BUILT-NOW (flux direct : ADAPTER) |
| 11 | Liquider par catégorie et exercice | `liquider` | be:citoyen.test.ts:« liquidation… sans doublon » | BUILT-NOW |
| 11 | « Payée / non régularisée » + date du dernier paiement | `situation` | be:citoyen.test.ts ; fe:citoyen.test.tsx | BUILT-NOW |
| 11 | Relance avant échéance | titres amber reminder | be:titres.test.ts | BUILT |
| 11 | Consultation par plaque journalisée | `vehicule.plate.consulted` | be:citoyen.test.ts:« … journalisé » | BUILT-NOW |
| 11 | Aucune immobilisation par l’algorithme | notice ; aucune action | be:citoyen.test.ts | BUILT-NOW |
| 11 | Registre des immatriculations, assurances | fichier transmis | be:citoyen.test.ts | ADAPTER |
| 11 | Indicateurs : couverture, paiement, contrôles/jour, mutations bloquées puis régularisées | `VehiculesService.indicateurs` | be:citoyen.test.ts:« mutation : … indicateur… » | BUILT-NOW |

## Module 12 — Autorisations de transport

| Module | Item (short) | Implementation (file/route/screen) | Test (file:test name) | Status |
|---|---|---|---|---|
| 12 | Licences taxi, bus, minibus, moto-taxi, poids lourds | `cit/transport.ts` (+ MOTO_TAXI au catalogue de la verticale) ; `/citoyen/transport` | be:citoyen.test.ts:« sans règle ACTIVE… » | BUILT-NOW |
| 12 | Corridors et zones (validité géographique et horaire) | zones/corridor/horaires, heure serveur | be:citoyen.test.ts:« … Zone et horaire… » | BUILT-NOW |
| 12 | Carte conducteur rattachée | `emettreCarte`, QR signé, vérification publique | be:citoyen.test.ts:« carte conducteur rattachée… » | BUILT-NOW |
| 12 | Taxe journalière via billetterie (module 76), sous base légale | mention acte requis (J28) | be:rakapay.test.ts | BUILT (acte requis) |
| 12 | Renouvellement : rappels, renouvellement mobile | `rappels`, `demanderRenouvellement` | be:citoyen.test.ts:« renouvellement : rappel ambre unique… » | BUILT-NOW |
| 12 | Conditionner à la vignette valide (si la règle l’exige) | moteur de dépendances AUTORISATION_TRANSPORT | be:fiscalite…:« informatif tant que l’acte… puis bloquant » | BUILT |
| 12 | Autocollant QR et titre à durée | certificat TRP + titres LIC | be:verticales.test.ts:« certificat public minimal… » | BUILT |
| 12 | Contrôle par plaque ou QR : couleur, temps restant | `controler` | be:citoyen.test.ts ; fe:citoyen.test.tsx:« transport… » | BUILT-NOW |
| 12 | Autorisation sans règle publiée impossible | EN_ATTENTE_REGLE, activation refusée | be:citoyen.test.ts | BUILT-NOW |
| 12 | Suspension par décision motivée | proposer/approuver (2 personnes) | be:citoyen.test.ts | BUILT-NOW |
| 12 | Indicateurs : actives, conformité aux contrôles, renouvellements à temps | `TransportService.indicateurs` | be:citoyen.test.ts | BUILT-NOW |
