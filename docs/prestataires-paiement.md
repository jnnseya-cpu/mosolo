# Prestataires de paiement BitriPay et KODA — raccordement, clés, webhook, mise en service

Mode d'emploi d'exploitation (28/09/2026). Il complète, sans les remplacer, le document maître (§ 18.7 à 18.16),
`backend/README.md` (« Connecteurs de prestataires ») et `docs/production-readiness.md` (bloqueur B1).

BitriPay et KODA sont des **prestataires candidats, non désignés** : leur raccordement technique ne vaut ni
désignation ni engagement de la Province. Principes constants : MOSOLO orchestre, il ne détient jamais les fonds ; le
règlement va au **compte public inscrit au coffre** ; les agents de terrain ne reçoivent jamais d'espèces ; aucune
quittance sur capture d'écran ou SMS.

> **Sources.** Le 28/09/2026, les sites des prestataires (`bitripay.com`, `docs.bitripay.com`, `kodajnn.com`) n'étaient
> **pas joignables** depuis l'environnement de construction (refus du mandataire réseau / nom inconnu). L'audit ci-dessous
> repose donc **uniquement** sur les notes d'API déjà présentes dans le dépôt (en-têtes des connecteurs, document maître
> § 18.7-18.15). Tout ce qui n'y est pas établi est marqué **« À CONFIRMER AVEC LE PRESTATAIRE »** — rien n'a été
> complété par supposition silencieuse. La même liste est affichée dans l'écran « état de raccordement ».

---

## 1. Audit des connecteurs face au contrat d'API des prestataires

Légende : **Documenté** = figure dans les notes d'API du dépôt ; **À CONFIRMER** = hypothèse du socle, isolée dans le
connecteur et paramétrable, à valider sur l'OpenAPI du prestataire lors de la recette.

### 1.1 BitriPay (`backend/src/modules/payments/connectors/bitripay.ts`)

| Point | Implémentation | Statut |
|---|---|---|
| Authentification | `Authorization: Bearer sk_…` (clé secrète serveur ; `pk_…` refusée au démarrage) | Documenté |
| Mode | `sk_test_…` = bac à sable du prestataire ; `sk_live_…` = réel ; sans clé = bac à sable local (aucun appel) | Documenté (préfixes) |
| URL de base | `https://api.bitripay.com/v1` pour les deux modes (paramètre `BITRIPAY_BASE_URL`) | **À CONFIRMER** (URL de bac à sable distincte ?) |
| Initiation | `POST /payment_intents {amount_minor, currency, description, allowed_operators, metadata}` → `{id, checkout_url, qr_payload, client_secret}` ; paiement par page / QR du prestataire | Documenté |
| Push Mobile Money direct (numéro du payeur) | Non envoyé | **À CONFIRMER** (champ non documenté) |
| USSD / carte | Non proposés par ce connecteur (canaux `MOBILE_MONEY` et `QR` seulement) | — |
| Interrogation d'état | `GET /payment_intents/{id}` : **confirmation serveur à serveur avant toute quittance** | Point d'appel documenté ; **forme de la réponse À CONFIRMER** (`status` = `succeeded`…) |
| Annulation | `POST /payment_intents/{id}/cancel` + `Idempotency-Key` | Documenté |
| Webhook — événements | `payment_intent.succeeded`, `payment_intent.settled` | Documenté |
| Webhook — autres événements | `payment_intent.canceled`, `payment_intent.payment_failed`, `payment_intent.ambiguous_hold` | **À CONFIRMER** (noms) |
| Webhook — forme | `{id, type, created, account?, data:{object:{id, amount_minor, currency, metadata}}}` | **À CONFIRMER** |
| Signature HMAC | En-tête `BitriPay-Signature` (secret `whsec_…` du point de terminaison) | Nom de l'en-tête documenté |
| Format de la signature | `t=<unix>,v1=<hex HMAC-SHA256 de "<t>.<corps brut>">`, plusieurs `v1` admis (rotation) | **À CONFIRMER** |
| Fenêtre de l'horodatage | ±300 s | **À CONFIRMER** |
| Signature Ed25519 | Clé plateforme publiée à `GET /v1/keys`, épinglée par `BITRIPAY_ED25519_PUBLIC_KEY` ; en-tête `BitriPay-Signature-Ed25519`, base64 sur le corps brut | Clé à `GET /v1/keys` documentée ; **en-tête et encodage À CONFIRMER** |
| Unités | Entiers en unités mineures ; USD 2 décimales ; CDF 2 décimales par défaut (`BITRIPAY_CDF_EXPONENT` = 0 ou 2) | **Exposant du CDF À CONFIRMER** |
| Devises | CDF, USD ; toute autre refusée (`CURRENCY_NOT_SUPPORTED_BY_PROVIDER`) | Documenté (usage) |
| Opérateurs | `orange_cd`, `mpesa_cd`, `airtel_cd`, `africell_cd` | Documenté |
| Idempotence | `Idempotency-Key` = référence MOSOLO sur tout POST financier ; POST rejoué sans double effet ⇒ nouvelles tentatives admises | Documenté |
| Comptes connectés | En-tête `BitriPay-Account: acct_…` sur chaque requête ; champ `account` exigé sur chaque webhook | Documenté (en-tête) ; **présence du champ `account` À CONFIRMER** |
| Codes d'erreur | 4xx définitif (hors 408/429) ; 5xx, 408, 429, réseau, délai ⇒ nouvelles tentatives bornées | **Codes métier À CONFIRMER** |
| Politique de renvoi des webhooks | Toute réponse non 2xx supposée renvoyée plus tard | **À CONFIRMER** (durée, nombre) |
| Adresses IP d'émission | Aucun filtrage (la signature fait foi) | **À CONFIRMER** (liste éventuelle) |
| « Tester la connexion » | `GET /v1/keys` (lecture seule) ; compare la clé Ed25519 épinglée | Point d'appel documenté ; **authentification exigée ou non À CONFIRMER** |
| Bac à sable | Numéros magiques `+243000000501` (réussite), `…404`, `…408` (ambigu), `…500`, `…503` | Documenté |

### 1.2 KODA (`backend/src/modules/payments/connectors/koda.ts`)

| Point | Implémentation | Statut |
|---|---|---|
| Authentification | `Authorization: Bearer sk_…` | Documenté |
| Mode | `sk_live_…` = réel ; autre `sk_…` = test | **Préfixe des clés de test À CONFIRMER** |
| URL de base | `https://kodajnn.com/v1` (paramètre `KODA_BASE_URL`) | Documenté ; **URL de bac à sable À CONFIRMER** |
| Initiation | `POST /intents {amount, currency, operators[], metadata{}, success_url}` → `{intent_id, client_secret, checkout_url}` | Documenté |
| Interrogation d'état | `GET /intents/{id}` : confirmation serveur à serveur avant toute quittance | Point d'appel documenté ; **forme de la réponse À CONFIRMER** (`status` = `verified`…) |
| Annulation | `POST /intents/{id}/cancel` | Documenté |
| Webhook — événements | `payment.verified`, `payment.verified.late` | Documenté |
| Événement d'échec | Aucun traité | **À CONFIRMER** |
| Webhook — forme | Parseur tolérant : `intent_id`, `amount`, `currency`, `receipt_id`, `metadata.payment_reference`, `id` | **À CONFIRMER** |
| Signature | `x-koda-signature` = HMAC-SHA256 hexadécimal du corps brut | Documenté |
| Préfixe `sha256=` | Toléré | **À CONFIRMER** |
| Horodatage signé | Aucun connu ⇒ pas de fenêtre ; anti-rejeu par identifiant d'événement **persistant** et unicité du reçu KODA | **À CONFIRMER** |
| Unités | CDF **0 décimale** (25000 = 25 000 FC) ; USD 2 décimales ; montant non représentable refusé, jamais arrondi | Documenté |
| Opérateurs | `orange_cd`, `mpesa_cd` par défaut (`KODA_OPERATORS`) | **Liste À CONFIRMER** |
| Idempotence | `Idempotency-Key` envoyé ; **aucune** nouvelle tentative automatique de POST | **Prise en charge À CONFIRMER** |
| URL de retour | `KODA_SUCCESS_URL` (https, requise avec une clé) ; sans valeur probante | Documenté |
| « Tester la connexion » | `GET /v1/openapi.json` : joignabilité seulement, **la clé n'est pas éprouvée** | Aucun « ping » ou « solde » documenté |
| Codes d'erreur, renvoi des webhooks, adresses IP | Comme BitriPay | **À CONFIRMER** |

### 1.3 Commun aux deux connecteurs

| Mesure | Réglage (valeurs **par défaut — à confirmer par le maître d'ouvrage** avec l'exploitant et les niveaux de service) |
|---|---|
| Délai maximal d'un appel sortant | 10 s |
| Nouvelles tentatives | 2 (lectures ; POST seulement si l'idempotence est documentée), attente 200 ms puis 400 ms |
| Disjoncteur | ouvert après 5 échecs consécutifs (réseau, délai, 5xx, 408, 429) pendant 30 s ; puis un appel d'essai |
| Réponse à l'usager, prestataire en panne | `502 PROVIDER_UNAVAILABLE` (appel en échec, aucun ordre créé) ; `503 PROVIDER_CIRCUIT_OPEN` + `Retry-After` (prestataire déclaré indisponible, aucun appel tenté) ; `503 PROVIDER_NOT_CONFIGURED` (clé absente hors démonstration) |

---

## 2. Chaîne de sécurité d'un webhook (ce que fait MOSOLO, dans l'ordre)

1. **Signature vérifiée sur le corps BRUT** (octets reçus, avant tout analyseur JSON), comparaison **à temps constant**.
   Échec ⇒ `401` + alerte de sécurité (critique si signature invalide) ; la réception est journalisée
   (« signature invalide », « horodatage hors fenêtre »…), sans aucun appel au prestataire.
2. **Fenêtre de l'horodatage** (BitriPay : ±300 s). KODA n'en signe pas : voir 3.
3. **Anti-rejeu par identifiant d'événement**, mémorisé dans le dépôt persistant `payments.webhookEvents` : un rejeu,
   même **après un redémarrage**, renvoie `200` avec la réponse mémorisée, **sans double effet** ni appel au prestataire.
4. **Confirmation serveur à serveur** (Cahier § 19.2 et 19.3 : « quittance définitive seulement sur confirmation serveur à
   serveur ») : pour chaque paiement réussi non encore traité, MOSOLO interroge l'état de l'intention chez le
   prestataire (BitriPay `GET /payment_intents/{id}`, KODA `GET /intents/{id}`) :
   - payé et montant concordant ⇒ poursuite ; l'ordre porte `serverToServerCheck` (méthode, date, statut lu) ;
   - état non final ⇒ `409 PROVIDER_STATUS_NOT_FINAL`, rien n'est mémorisé (le prestataire renverra) ;
   - prestataire injoignable ⇒ `503 PROVIDER_STATUS_UNAVAILABLE` + `Retry-After: 60`, rien n'est mémorisé ;
   - état contredit (échec, montant différent) ⇒ `422 PROVIDER_STATUS_CONTRADICTION`, **alerte critique** (secret de
     webhook possiblement compromis), **mise en suspens**, aucune quittance.
   En bac à sable local (démonstration seulement), aucune interrogation n'est possible : l'ordre porte
   `serverToServerCheck.method = BAC_A_SABLE_LOCAL`. Hors démonstration, un connecteur sans clé API ne confirme rien.
5. **Contrôles communs** (`confirmFromProvider`, inchangés) : référence connue, liaison ordre ↔ intention ↔ prestataire,
   montant et devise **exactement** égaux au dû (jamais d'arrondi), doublon, référence expirée ou fermée.
   - Référence inconnue ⇒ `422 UNKNOWN_PAYMENT_REFERENCE` + **suspens** `REFERENCE_INCONNUE` (file « paiement sans
     obligation ») ; montant ou devise différents ⇒ `422 AMOUNT_MISMATCH` + suspens `ECART_MONTANT` / `ECART_DEVISE`
     (file « écart de montant »). **Jamais porté sur l'obligation.** Une seule mise en suspens par événement, même s'il
     est renvoyé.
   - Second paiement sur une référence payée ⇒ `DOUBLON`, fonds en compte d'attente, remboursement en double validation.
   - Événement d'échec arrivé après la réussite (hors ordre) ⇒ **ignoré et journalisé** (`payment.failure_ignored`),
     ordre inchangé, aucun avis au contribuable.
6. **Quittance provisoire** (en attente de règlement) ; **quittance définitive** seulement au rapprochement à trois
   voies avec le **relevé du compte public** (§ 20.1). Une annonce de règlement du prestataire n'est qu'un indice.
7. **Compte de règlement** : toujours l'alias verrouillé du coffre (`*_SETTLEMENT_ACCOUNT_ALIAS`, contrôlé au démarrage ;
   toute modification du compte passe par proposition, quorum, vérification hors bande et refroidissement). Aucun compte
   lu dans un webhook n'est jamais utilisé.

---

## 3. Ce qu'il faut demander à chaque prestataire

### 3.1 BitriPay

| # | Élément | Où le mettre |
|---|---|---|
| 1 | Clé API **secrète** de bac à sable `sk_test_…` puis de production `sk_live_…` (jamais une clé publiable `pk_…`) | Secret `mosolo-bitripay-api-key` / `BITRIPAY_API_KEY` |
| 2 | Secret de signature du point de terminaison de webhook `whsec_…` (un par environnement) | Secret `mosolo-bitripay-webhook-secret` / `BITRIPAY_WEBHOOK_SECRET` |
| 3 | Clé publique Ed25519 de la plateforme (`GET /v1/keys`) et la confirmation de l'en-tête `BitriPay-Signature-Ed25519` | Secret `mosolo-bitripay-ed25519-public-key` / `BITRIPAY_ED25519_PUBLIC_KEY` ; puis `BITRIPAY_ED25519_REQUIRED=true` si on l'exige |
| 4 | URL de base de bac à sable et de production | `BITRIPAY_BASE_URL` |
| 5 | Spécification OpenAPI à jour : format exact de `BitriPay-Signature`, fenêtre de l'horodatage, forme des événements et de `GET /payment_intents/{id}`, noms des événements d'échec, codes d'erreur, politique de renvoi des webhooks | Recette (§ 18.14) ; lever chaque « À CONFIRMER » |
| 6 | Exposant du CDF (0 ou 2) | `BITRIPAY_CDF_EXPONENT` |
| 7 | Liste des opérateurs ouverts au compte de la Ville | `BITRIPAY_ALLOWED_OPERATORS` |
| 8 | Profil de règlement : compte public de la Ville vers lequel le **brut** est réglé, délai, fichier de détail | Coffre (alias `BITRIPAY_SETTLEMENT_ACCOUNT_ALIAS`), convention |
| 9 | Si intégrateur : identifiant du compte connecté `acct_…` de la Ville, lien de revendication | `BITRIPAY_ACCOUNT_ID` |
| 10 | Liste des adresses IP d'émission des webhooks (s'il y en a) | Pare-feu / équilibreur (facultatif ; la signature fait foi) |
| 11 | Preuve de l'habilitation BCC de BitriPay (agrégation, monnaie électronique) | Dossier de mise en service (§ 5) |

### 3.2 KODA

| # | Élément | Où le mettre |
|---|---|---|
| 1 | Clé API **secrète** de test puis de production (préfixes à confirmer ; `sk_live_…` = réel pour le socle) | Secret `mosolo-koda-api-key` / `KODA_API_KEY` |
| 2 | Secret HMAC des webhooks (en-tête `x-koda-signature`) | Secret `mosolo-koda-webhook-secret` / `KODA_WEBHOOK_SECRET` |
| 3 | URL de base de test et de production | `KODA_BASE_URL` |
| 4 | Spécification `/v1/openapi.json` à jour : forme exacte du webhook, horodatage signé éventuel, préfixe `sha256=`, événement d'échec, forme de `GET /intents/{id}`, prise en charge de `Idempotency-Key`, codes d'erreur, renvoi des webhooks, point d'appel « ping » ou « solde » authentifié | Recette ; lever chaque « À CONFIRMER » |
| 5 | Liste des opérateurs | `KODA_OPERATORS` |
| 6 | URL de retour à déclarer (portail officiel, https) | `KODA_SUCCESS_URL` |
| 7 | Compte public de règlement, délai, fichier de détail | Coffre (alias `KODA_SETTLEMENT_ACCOUNT_ALIAS`), convention |
| 8 | Adresses IP d'émission des webhooks (s'il y en a) | Pare-feu (facultatif) |
| 9 | Preuve de l'habilitation BCC de KODA | Dossier de mise en service |

---

## 4. Où coller chaque valeur

**Règle :** une clé API, un secret de webhook ou une clé Ed25519 ne s'écrit **jamais** dans un fichier versionné, un
ticket, un courriel ou une conversation. Aucune valeur secrète n'est jamais affichée par MOSOLO : l'écran de
raccordement ne montre que les **noms** des variables et leur **présence**.

### 4.1 Google Cloud (Cloud Run + Secret Manager)

```bash
# 1. Secrets (saisie SANS ÉCHO, transmis à gcloud par l'entrée standard, jamais affichés ni écrits sur disque)
PROJECT_ID=<projet> ./infra/gcp/secrets-prestataires.sh bitripay
PROJECT_ID=<projet> ./infra/gcp/secrets-prestataires.sh koda
#    Réponse vide = version existante conservée. DRY_RUN=1 montre les commandes sans rien demander.

# 2. Variables NON secrètes (URL, opérateurs, alias du coffre, URL de retour KODA)
cp infra/gcp/prestataires.env.example infra/gcp/prestataires.env   # fichier ignoré par le gestionnaire de versions
nano infra/gcp/prestataires.env                                     # deploy.sh refuse tout nom de secret ici

# 3. Raccordement au service (nouvelle révision ; image inchangée)
PROJECT_ID=<projet> DOMAIN=<domaine> SKIP_BUILD=1 IMAGE_TAG=<image en service> ./infra/gcp/deploy.sh
```

`deploy.sh` (paramètre `PRESTATAIRES_SECRETS=auto`, défaut) ajoute à `EXTRA_SECRETS` chaque secret
`mosolo-bitripay-*` / `mosolo-koda-*` qui possède une version, donne au compte de service d'exécution le droit de le lire,
et écrit `MOSOLO_PUBLIC_URL` (`https://<DOMAIN>`, sinon l'adresse `*.run.app`). `PRESTATAIRES_SECRETS=non` désactive ce
raccordement automatique ; `EXTRA_SECRETS` explicite reste possible.

### 4.2 Serveur privé virtuel (VPS / centre national)

Dans `infra/vps/.env` (modèle commenté : `infra/vps/.env.example`), renseigner `MOSOLO_PUBLIC_URL`, puis les variables
`KODA_*` et `BITRIPAY_*` ; `chmod 600 .env` ; puis `./infra/vps/deploy.sh`. Les variables vides sont ignorées au démarrage.

### 4.3 Démarrage : ce qui est refusé (message clair nommant la variable)

Clé API sans secret de webhook ; secret de démonstration (`demo-whsec-…`) hors démonstration **ou** avec une vraie clé ;
clé publiable `pk_…` ; clé KODA sans `KODA_SUCCESS_URL` ; `BITRIPAY_ACCOUNT_ID` sans `BITRIPAY_API_KEY` ; Ed25519 exigée
sans clé publique ; aucun schéma de signature exigé ; URL de l'API ou URL de retour non https en réel (http admis
seulement vers la boucle locale avec une clé de test) ; alias de règlement absent du coffre. Un **secret de webhook sans
clé API** hors démonstration est admis mais signalé « configuration partielle » : aucune intention, aucune quittance.

---

## 5. Adresse du webhook à déclarer chez le prestataire

| Prestataire | Adresse (construite depuis `MOSOLO_PUBLIC_URL`, https obligatoire) | Méthode | Corps |
|---|---|---|---|
| BitriPay | `https://<domaine>/v1/providers/bitripay/webhooks` | POST | JSON brut, signé |
| KODA | `https://<domaine>/v1/providers/koda/webhooks` | POST | JSON brut, signé |

L'adresse exacte (avec le vrai domaine) est affichée, avec un bouton « Copier », dans **Trésor → Prestataires connectés
→ « Prestataires de paiement — état de raccordement »** (rôles R17 Trésor, R26 administration de la plateforme, R28
sécurité). Aucun jeton ni secret ne figure dans l'adresse.

---

## 6. Essai de bout en bout en bac à sable

1. Clés de **test** saisies (§ 4), service redéployé, écran de raccordement : configuration « Complète », mode « Bac à
   sable du prestataire (clé de test) », alias « Coffre, verrouillé ».
2. **Tester la connexion** : BitriPay = appel réel `GET /v1/keys` ; KODA = appel réel `GET /v1/openapi.json`
   (joignabilité seulement). Le résultat dit explicitement « Appel réel » ou « Validation à blanc ».
3. Créer un ordre depuis l'espace contribuable (canal Monnaie mobile ou QR, prestataire choisi) ; payer sur la page du
   prestataire (BitriPay : numéro `+243000000501` pour une réussite).
4. Vérifier dans l'écran : dernier webhook « Signature valide · HTTP 200 », dernière interrogation serveur à serveur
   « Confirmé » ; l'ordre passe à « Confirmé », la quittance provisoire est émise.
5. Cas négatifs à rejouer : `+243000000408` (résultat ambigu ⇒ exception, aucune quittance) ; renvoyer un webhook depuis
   la console du prestataire (rejeu ⇒ 200 sans effet) ; secret erroné (⇒ 401 et alerte).
6. Importer le relevé du compte public (Trésor → Relevés, double validation) : l'ordre passe à « Rapproché », la
   quittance devient définitive.

Automatisé dans le dépôt (simulateur HTTP local, jamais Internet) : `backend/test/prestataires-raccordement.test.ts`
(parcours complet et cas négatifs pour les **deux** prestataires : mauvaise signature, horodatage ancien, rejeu y compris
après redémarrage, référence inconnue, écart de montant ou de devise, doublon, événement hors ordre, délai dépassé et
disjoncteur, configuration partielle).

---

## 7. Liste de contrôle de mise en service (réel)

- [ ] Essai de bout en bout en bac à sable **réussi** (§ 6), y compris les cas négatifs ; chaque « À CONFIRMER » du § 1
      levé par écrit par le prestataire (ou l'hypothèse ajustée dans le connecteur).
- [ ] **Rapprochement avec un relevé bancaire réel** : au moins un paiement de bac à sable (ou un paiement réel de faible
      montant) apparié sur le relevé du compte public, écart nul.
- [ ] **Habilitation BCC** de l'agrégateur ou de l'émetteur prouvée (Cahier § 19.4 : « l'habilitation des agrégateurs et
      les conventions de règlement doivent être confirmées auprès de la Banque Centrale du Congo avant la mise en
      production ») ; convention signée (délais, fichiers de détail, pénalités, commissions facturées séparément,
      sécurité des webhooks, réversibilité) ; procédure de passation conforme.
- [ ] **Compte de règlement validé à deux personnes dans le coffre** : proposition, approbation par une autre personne
      avec vérification hors bande, délai de refroidissement écoulé ; l'alias configuré est celui-là.
- [ ] Clés de **production** saisies (`sk_live_…`, nouveau secret de webhook), `MOSOLO_PUBLIC_URL` en https sur le domaine
      officiel ; écran : mode « Réel (production) », « Tester la connexion » réussi.
- [ ] Adresse du webhook de production déclarée chez le prestataire ; premier webhook reçu « Signature valide ».
- [ ] Alertes (signature invalide, état contredit, disjoncteur ouvert) acheminées vers l'astreinte.

---

## 8. Retour au bac à sable (ou désactivation)

- **Google Cloud** : désactiver la version de production du secret et réactiver la version de test
  (`gcloud secrets versions disable <version> --secret=mosolo-bitripay-api-key` puis `… enable <version de test>`),
  de même pour le secret de webhook, puis redéployer (`SKIP_BUILD=1`). Ou ressaisir les valeurs de test avec
  `secrets-prestataires.sh`. Pour **désactiver** un prestataire : `PRESTATAIRES_SECRETS=non` (ou retirer ses secrets de
  `EXTRA_SECRETS`) puis redéployer : hors démonstration, un connecteur sans secret de webhook n'est pas enregistré et
  aucun webhook n'est accepté.
- **VPS** : remettre les valeurs de test dans `.env` (ou vider `*_API_KEY` et `*_WEBHOOK_SECRET`), puis `./deploy.sh`.
- Revenir à l'adresse du webhook de test dans la console du prestataire.
- Les références déjà émises restent tracées ; un paiement arrivé après la bascule sur une intention de production est
  refusé ou mis en suspens, jamais perdu (rapprochement avec le relevé).
