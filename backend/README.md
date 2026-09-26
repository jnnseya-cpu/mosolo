# KINSHASA MOSOLO — backend (socle)

API du socle de la plateforme souveraine des recettes de la Ville-Province de Kinshasa.
Contrat d'interface : [`specs/contrat-api.md`](../specs/contrat-api.md) · spécification complète : [`specs/openapi.yaml`](../specs/openapi.yaml) (OpenAPI 3.1).

## Démarrer

Depuis la racine du dépôt :

```bash
npm run dev -w backend        # serveur avec rechargement (port PORT ou 8080, CORS actif)
npm test -w backend           # tests (vitest + fastify.inject)
npm run typecheck -w backend  # TypeScript strict
```

Le serveur démarre avec des **données de démonstration** en mémoire (voir « Utilisateurs de démonstration »).

```bash
curl localhost:8080/health
curl localhost:8080/v1/demo/users
curl -H 'x-demo-user: u-contribuable' localhost:8080/v1/taxpayers/TP-DEMO-0001
```

## Architecture : monolithe modulaire

```
src/
  app.ts              buildApp({ clock, secrets }) → instance Fastify (horloge et secrets injectables)
  server.ts           écoute sur PORT||8080
  context.ts          composition des modules (dépendances explicites, pas de singleton global)
  seed.ts             données de démonstration
  core/
    errors.ts         erreurs RFC 9457 (application/problem+json) avec `code` stable
    auth.ts           authentification de démonstration (en-tête x-demo-user), annuaire, refus des cumuls de rôles
    policy.ts         point de décision central authorize(user, action, ressource) : RBAC + ABAC + garde IA
    audit.ts          journal chaîné (sha256) et signé (HMAC), vérification d'intégrité
    idempotency.ts    clés d'idempotence (même clé + même contenu → même réponse ; sinon 409)
    repository.ts     Repository<T> / AppendOnlyRepository<T> + implémentations en mémoire
    decimal.ts        arithmétique décimale exacte (BigInt)
    clock.ts, crypto.ts, http.ts
  reference/kinshasa.ts   24 communes, entités émettrices
  modules/
    identity          inscription, profil contribuable
    objects           objets fiscaux, baux
    rules             registre juridique, cycle de vie, évaluateur de formules sûr (formula.ts)
    assessment        liquidation déterministe, obligations et explications
    payments          ordres de paiement, rappels prestataires signés, confirmFromProvider (contrôles communs)
      connectors/     BitriPay et KODA : types, minor-units, http-client, koda, bitripay, registry
    treasury          relevés, rapprochement à trois voies, grand livre en partie double (ledger.ts)
    receipts          quittances signées Ed25519, vérification publique minimale
    vault             coffre des comptes bénéficiaires (quorum, hors bande, 72 h)
    communications    moteur d'événements (239 événements), adaptateurs de canaux, aperçu courriel
    drafts            enregistrement automatique versionné
    ai                couche d'intelligence déterministe derrière l'interface AIProvider
    dashboards        tableau de bord du Gouverneur (données EXEMPLE)
    field             synchronisation terrain signée par appareil, conflits
    appeals           réclamations (instruction ≠ décision), obligations rectificatives
    fx                taux de change (démo, source déclarée)
    alerts, audit, system
db/schema.sql         DDL PostgreSQL de référence (tables en ajout seul protégées par déclencheurs)
test/                 tests d'acceptation (ch. 41) et tests unitaires
```

Règles de conception :

- **Frontières strictes** : chaque module expose un service ; les autres modules n'accèdent à ses données que par ce service.
- **Aucune décision d'accès hors de `core/policy.ts`** : chaque route appelle `authorize` ; ce qui n'est pas listé dans la matrice est refusé.
- **Montants exacts** : `Money` de `@mosolo/shared` (BigInt) ; `MoneyJSON` en chaîne décimale sur l'API ; aucun flottant.
- **Faits immuables** : journal d'audit, grand livre, constats terrain, journal de délivrance, versions de brouillon sont en ajout seul ;
  une correction financière est une contre-écriture liée à l'original ; une obligation rectifiée est conservée (`ANNULEE`, `supersededBy`).
- **Tout est journalisé** : écritures, refus d'accès (`access.denied`), consultations nominatives, tentatives de falsification.

## Garanties de sécurité testées (chapitre 41)

| Critère | Garantie | Test |
|---|---|---|
| AC-LEG-01 | Règle `A_VERIFIER` : liquidation refusée (422 `RULE_NOT_EXECUTABLE`), tentative journalisée ; simulation possible mais `nonOpposable: true` | `legal.test.ts` |
| AC-LEG-02 | Même personne ne peut rédiger et publier (403 `SEPARATION_OF_DUTIES`) ; cumul R13+R16 impossible | `legal.test.ts` |
| AC-LEG-03 | Instrument abrogé (`ol-13-001`) : publication bloquée (422 `ABROGATED_INSTRUMENT`) | `legal.test.ts` |
| AC-ASS-01 | Explication : règle, version, base légale, assiette, formule, taux, montant, échéance, voie de recours | `misc.test.ts` |
| AC-PAY-01 | Idempotence des ordres de paiement | `payments.test.ts` |
| AC-PAY-02 | Signature invalide / nonce rejoué / horodatage hors fenêtre rejetés + alerte | `payments.test.ts` |
| AC-PAY-04 | Quittance provisoire à la confirmation, définitive au rapprochement | `payments.test.ts` |
| AC-BEN-01 | Coffre : 2 approbateurs R19 distincts, hors bande, effet après 72 h (horloge injectée) | `treasury-vault.test.ts` |
| AC-LED-01 | Aucune suppression (405), contre-écriture liée, livre équilibré | `treasury-vault.test.ts` |
| AC-AUD-01 | Altération, suppression ou troncature du journal détectée par `/v1/audit/verify` | `audit-access.test.ts` |
| AC-ACC-01 | Super-administrateur : aucun montant nominatif, aucune écriture financière | `audit-access.test.ts` |
| AC-ACC-02 | Gouverneur : agrégats seulement, aucune écriture financière | `audit-access.test.ts` |
| AC-RCP-01 | Vérification publique minimale (aucun nom, IUC tronqué) ; quittance altérée → `FRAUD_SUSPECTED` | `payments.test.ts` |
| AC-COM-01 | Avis obligatoire délivré malgré la désinscription, jamais sur WhatsApp, preuve conservée | `communications.test.ts` |
| AC-COM-02 | Sans clé fournisseur : statut `journalise` (bac à sable) | `communications.test.ts` |
| § 18.7–18.12 | Connecteurs BitriPay / KODA : unités mineures exactes (CDF à zéro décimale chez KODA), signature invalide → 401 + alerte, rejeu d'événement sans effet, montant différent → 422, annonce de règlement sans `REGLE`, bac à sable sans réseau, clé jamais journalisée, alias hors coffre → refus de démarrer, pièce capture/SMS sans effet et interdite au contribuable | `connectors.test.ts` |
| AC-CUR-01 | Obligation USD : contre-valeur CDF indicative avec taux et source, sur l'ordre et la quittance (et montant payé en EUR) | `payments.test.ts` |
| AC-AI-01 | Recommandation IA sans effet tant qu'elle n'est pas décidée ; décision journalisée ; garde IA | `ai-drafts.test.ts` |
| AC-SAV-01 | Brouillons : une version par enregistrement, historique complet, résumé des changements | `ai-drafts.test.ts` |
| AC-FLD-02 | Terminal révoqué refusé ; conflits entre agents conservés | `field-appeals.test.ts` |
| § 22.2 | Réclamation : décideur ≠ instructeur ; obligation rectificative, originale conservée | `field-appeals.test.ts` |

## Utilisateurs de démonstration

Authentification : en-tête `x-demo-user: <id>`. Liste complète : `GET /v1/demo/users`.

| id | Rôle | Remarque |
|---|---|---|
| `u-gouverneur` | R01 Gouverneur | agrégats uniquement |
| `u-dircab` | R02 Directeur de cabinet | |
| `u-ministre-finances` | R05 Ministre provincial des Finances | |
| `u-dg-dgipk` | R06 DG DGIPK | nominatif dans son entité |
| `u-admin-entite` | R08 Administrateur d'entité | aucun montant |
| `u-superviseur` | R09 Superviseur terrain | |
| `u-agent-terrain`, `u-agent-terrain-2`, `u-agent-gombe` | R10 Agent de terrain | territoires différents (ABAC) |
| `u-controleur` | R11 Contrôleur | liquide / simule |
| `u-guichet` | R12 Agent de guichet | |
| `u-juriste-redacteur` / `-verificateur` | R13 / R14 | quatre personnes distinctes… |
| `u-validateur-financier` / `u-autorite-publication` | R15 / R16 | …pour publier une règle |
| `u-tresor` | R17 Trésor | relevés, grand livre, propositions au coffre |
| `u-analyste-rappro` | R18 | exceptions |
| `u-coffre-1`, `u-coffre-2`, `u-coffre-3` | R19 Coffre | quorum 2 sur 3 |
| `u-contentieux` / `u-decideur` | R20 / R21 | instruction ≠ décision |
| `u-auditeur` | R22 | journal intégral, lecture seule |
| `u-enqueteur`, `u-rssi` | R24, R28 | alertes |
| `u-superadmin` | R26 | technique, aucun pouvoir financier |
| `u-contribuable` | R30 | `TP-DEMO-0001` (bailleur fictif, parcelle et unité à Limete) |
| `u-locataire` | R30 | `TP-DEMO-0002` (locataire fictive) |
| `u-mandataire` | R31 | mandataire de `TP-DEMO-0001` |

Données semées : instruments juridiques (dont `ol-13-001` **ABROGE** le 13/03/2018 par `ol-18-004`), les quatre fiches modèles
`SAMPLE_RULES` (statut `A_VERIFIER`), une **règle fictive** `DEMO-IF-BATI` publiée par le circuit réel des quatre visas
(instrument fictif `demo-instrument-001`) et **une obligation payable de 🇺🇸 USD 150,00** pour `TP-DEMO-0001`, deux comptes du coffre
(numéros fictifs), trois terminaux terrain dont un révoqué.

### Parcours de paiement de bout en bout (démo)

```bash
OBL=$(curl -s -H 'x-demo-user: u-contribuable' localhost:8080/v1/obligations | node -pe 'JSON.parse(require("fs").readFileSync(0))[0].id')
REF=$(curl -s -X POST -H 'x-demo-user: u-contribuable' -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"channel":"MOBILE_MONEY"}' localhost:8080/v1/obligations/$OBL/payment-orders | node -pe 'JSON.parse(require("fs").readFileSync(0)).paymentReference')

# Rappel du prestataire « mm-operator-a » (secret de démo : demo-secret-mm-operator-a)
BODY="{\"providerTxnId\":\"TXN-$RANDOM\",\"paymentReference\":\"$REF\",\"amount\":{\"amount\":\"150.00\",\"currency\":\"USD\"},\"status\":\"SUCCESS\",\"completedAt\":\"$(date -u +%FT%TZ)\"}"
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac demo-secret-mm-operator-a -hex | awk '{print $2}')
curl -s -X POST -H 'content-type: application/json' -H "x-signature: $SIG" -H "x-nonce: $(uuidgen)" -H "x-timestamp: $(date -u +%FT%TZ)" \
  -d "$BODY" localhost:8080/v1/providers/mm-operator-a/callbacks
# → {"status":"CONFIRME","receiptCode":"Q26KIN…","receiptStatus":"PROVISOIRE"}

curl -s localhost:8080/v1/public/receipts/<receiptCode>        # PENDING
curl -s -X POST -H 'x-demo-user: u-tresor' -H 'content-type: application/json' localhost:8080/v1/settlements/statements \
  -d "{\"statementId\":\"REL-1\",\"lines\":[{\"accountAlias\":\"KIN-DGIPK-RECETTES-01\",\"amount\":{\"amount\":\"150.00\",\"currency\":\"USD\"},\"valueDate\":\"$(date -u +%F)\",\"paymentReference\":\"$REF\"}]}"
curl -s localhost:8080/v1/public/receipts/<receiptCode>        # VALID / RECONCILED
```

Terminaux terrain : `x-device-signature` = HMAC-SHA256 hexadécimal du corps brut avec la clé de l'appareil
(`dev-terrain-001` → `demo-device-key-001`, affecté à `u-agent-terrain`).

## Connecteurs de prestataires : BitriPay et KODA

Deux connecteurs de prestataires **candidats** (non désignés : agrément BCC, convention et passation préalables — voir
[`docs/document-maitre/18b-connecteurs-prestataires.md`](../docs/document-maitre/18b-connecteurs-prestataires.md)).
Code : `src/modules/payments/connectors/`. Ils partagent **exactement** les contrôles du rappel générique via
`PaymentService.confirmFromProvider` (référence, montant exact `Money`, doublon, écritures, quittance provisoire, audit).

- Ordre lié : `POST /v1/obligations/:id/payment-orders` avec `{"channel":"MOBILE_MONEY"|"QR","provider":"koda"|"bitripay"}`.
  L'intention est créée chez le prestataire **avant** l'enregistrement de l'ordre ; en cas d'échec : 502 `PROVIDER_UNAVAILABLE`,
  **aucun ordre enregistré** (le client réessaie avec une nouvelle clé d'idempotence). Idempotency-Key sortante = référence de paiement.
- Webhooks : `POST /v1/providers/koda/webhooks`, `POST /v1/providers/bitripay/webhooks` (corps brut, `content-type: application/json`).
- `payment_intent.settled` (BitriPay) = **annonce de règlement** : indice de rapprochement (`payments.settlementAnnouncements`) +
  audit `payment.settlement_announced` ; l'ordre reste `CONFIRME` jusqu'au relevé du compte public.
- Vérification capture / SMS chez le prestataire : **jamais** proposée au contribuable ; relais réservé à R17/R18/R20
  (`POST /v1/payment-orders/:reference/provider-verification-evidence`) → pièce de dossier `legalEffect: "AUCUN"`.

**Bac à sable local** : sans clé API, aucun appel réseau ; l'intention est simulée (`providerIntentId: "sbx_…"`,
`checkoutUrl: null`, `sandbox: true`) et les secrets de webhook de démonstration sont `demo-whsec-koda` et `demo-whsec-bitripay`.
Avec une clé `sk_test_…` : environnement de test du prestataire (`sandbox: true`) ; `sk_live_…` : réel. Une clé publiable `pk_…`
est refusée au démarrage ; hors bac à sable local, le secret de webhook est obligatoire.

| Variable | Rôle | Défaut |
|---|---|---|
| `KODA_API_KEY` | clé secrète `sk_…` (serveur uniquement) | absente ⇒ bac à sable local |
| `KODA_WEBHOOK_SECRET` | secret HMAC des webhooks | `demo-whsec-koda` en bac à sable local |
| `KODA_BASE_URL` | URL de l'API | `https://kodajnn.com/v1` |
| `KODA_SETTLEMENT_ACCOUNT_ALIAS` | alias du compte public de règlement (**doit exister dans le coffre**) | `KIN-DGIPK-RECETTES-01` |
| `KODA_OPERATORS`, `KODA_SUCCESS_URL` | opérateurs proposés ; URL de retour (sans valeur probante) | `orange_cd,mpesa_cd` ; démo : `http://localhost:5173/espace` — **obligatoire en mode réel** |
| `BITRIPAY_API_KEY` | clé secrète `sk_test_…` / `sk_live_…` | absente ⇒ bac à sable local |
| `BITRIPAY_WEBHOOK_SECRET` | secret `whsec_…` du point de terminaison | `demo-whsec-bitripay` en bac à sable local |
| `BITRIPAY_ED25519_PUBLIC_KEY` | clé publique plateforme (PEM ou 32 octets base64), épinglée depuis `GET /v1/keys` | absente |
| `BITRIPAY_HMAC_REQUIRED`, `BITRIPAY_ED25519_REQUIRED` | schémas de signature exigés | `true`, `false` |
| `BITRIPAY_BASE_URL` | URL de l'API | `https://api.bitripay.com/v1` |
| `BITRIPAY_SETTLEMENT_ACCOUNT_ALIAS` | alias du compte public de règlement (**doit exister dans le coffre**) | `KIN-DGIPK-RECETTES-01` |
| `BITRIPAY_CDF_EXPONENT` | décimales du CDF chez BitriPay (0 ou 2) [À VÉRIFIER] | `2` (ISO 4217) |
| `BITRIPAY_ALLOWED_OPERATORS` | opérateurs proposés | `orange_cd,mpesa_cd,airtel_cd,africell_cd` |

Un alias de règlement absent du coffre **empêche le démarrage** (`ConnectorConfigError`) : MOSOLO ne détient jamais les fonds.

### Simuler un webhook signé (bac à sable local)

Une seule référence active par obligation : jouez l'un **ou** l'autre des deux scénarios sur un serveur fraîchement démarré.

```bash
OBL=$(curl -s -H 'x-demo-user: u-contribuable' localhost:8080/v1/obligations | node -pe 'JSON.parse(require("fs").readFileSync(0))[0].id')

# KODA — montant en unités mineures KODA (USD : 2 décimales ; CDF : 0 décimale, 25000 = 25 000 FC)
ORDER=$(curl -s -X POST -H 'x-demo-user: u-contribuable' -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"channel":"MOBILE_MONEY","provider":"koda"}' localhost:8080/v1/obligations/$OBL/payment-orders)
REF=$(echo "$ORDER" | node -pe 'JSON.parse(require("fs").readFileSync(0)).paymentReference')
INTENT=$(echo "$ORDER" | node -pe 'JSON.parse(require("fs").readFileSync(0)).providerIntentId')
BODY="{\"id\":\"evt_$RANDOM\",\"type\":\"payment.verified\",\"data\":{\"intent_id\":\"$INTENT\",\"amount\":15000,\"currency\":\"USD\",\"receipt_id\":\"KR-$RANDOM\",\"metadata\":{\"payment_reference\":\"$REF\"}}}"
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac demo-whsec-koda -hex | awk '{print $2}')
curl -s -X POST -H 'content-type: application/json' -H "x-koda-signature: $SIG" -d "$BODY" localhost:8080/v1/providers/koda/webhooks
# → {"received":true,"results":[{"outcome":"PROCESSED","status":"CONFIRME","receiptStatus":"PROVISOIRE",…}]}

# BitriPay — en-tête t=<unix>,v1=HMAC-SHA256("<t>.<corps>")
ORDER=$(curl -s -X POST -H 'x-demo-user: u-contribuable' -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"channel":"QR","provider":"bitripay"}' localhost:8080/v1/obligations/$OBL/payment-orders)
REF=$(echo "$ORDER" | node -pe 'JSON.parse(require("fs").readFileSync(0)).paymentReference')
INTENT=$(echo "$ORDER" | node -pe 'JSON.parse(require("fs").readFileSync(0)).providerIntentId')
T=$(date +%s)
BODY="{\"id\":\"evt_$RANDOM\",\"type\":\"payment_intent.succeeded\",\"data\":{\"object\":{\"id\":\"$INTENT\",\"amount_minor\":15000,\"currency\":\"USD\",\"metadata\":{\"payment_reference\":\"$REF\"}}}}"
V1=$(printf '%s' "$T.$BODY" | openssl dgst -sha256 -hmac demo-whsec-bitripay -hex | awk '{print $2}')
curl -s -X POST -H 'content-type: application/json' -H "BitriPay-Signature: t=$T,v1=$V1" -d "$BODY" localhost:8080/v1/providers/bitripay/webhooks
# Puis la même commande avec "type":"payment_intent.settled" (nouvel id d'événement, nouveau T) :
# → outcome SETTLEMENT_ANNOUNCED ; l'ordre reste CONFIRME jusqu'à l'import du relevé (POST /v1/settlements/statements).
```

Rejouer exactement la même requête renvoie 200 avec `"replayed": true`, sans seconde quittance ni écriture.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `PORT`, `HOST` | écoute (défaut `8080`, `0.0.0.0`) |
| `MOSOLO_AUDIT_HMAC_KEY` | clé de signature du journal d'audit (aléatoire au démarrage si absente) |
| `MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A`, `…_BANK_A`, `…_CARD_GATEWAY` | secrets HMAC des prestataires (défauts de démo `demo-secret-…`) |
| `KODA_*`, `BITRIPAY_*` | connecteurs de prestataires (voir « Connecteurs de prestataires : BitriPay et KODA ») |
| `MOSOLO_EMAIL_PROVIDER_KEY`, `MOSOLO_SMS_PROVIDER_KEY`, `MOSOLO_PUSH_PROVIDER_KEY`, `MOSOLO_WHATSAPP_PROVIDER_KEY`, `MOSOLO_USSD_PROVIDER_KEY`, `MOSOLO_SVI_PROVIDER_KEY`, `MOSOLO_COURRIER_PROVIDER_KEY` | clés fournisseurs ; absente ⇒ canal en bac à sable (`journalise`) |

## Ce qui relève de la démonstration et ce qui est prêt pour la suite

| Domaine | Dans ce socle | Pour la production |
|---|---|---|
| Authentification | **Démo** : en-tête `x-demo-user` | OIDC + passkeys, MFA, jetons courts, appareil enrôlé (ch. 31) |
| Autorisation | **Réelle** : PDP central RBAC + ABAC (entité, territoire, dossier propre), séparation des tâches, garde IA | externaliser dans un moteur de politiques (OPA) avec la même matrice |
| Stockage | **Démo** : dépôts en mémoire derrière `Repository<T>` | adaptateur PostgreSQL sur `db/schema.sql` (déclencheurs d'ajout seul déjà écrits et vérifiés) |
| Journal d'audit | **Réel** : chaîne sha256 + HMAC, détection d'altération/suppression/troncature | clé en HSM, copie WORM, ancrage horodaté par un tiers, contrôle horaire |
| Grand livre | **Réel** : partie double, ajout seul, contre-écritures liées, chaînage | clôture quotidienne signée, export vers la comptabilité du Trésor |
| Quittances | **Réel** : numérotation, Ed25519, QR, vérification minimale | clé de la PKI provinciale en HSM, limitation de débit de la vérification publique |
| Paiements | **Réel** : idempotence, HMAC, fenêtre ±5 min, nonce, unicité `providerTxnId`, montant/référence, DOUBLON | mTLS + JWS asymétrique, appel de contrôle chez le prestataire, expiration des nonces |
| Coffre | **Réel** : quorum 2 R19, hors bande, 72 h, notifications | vérification bancaire hors bande outillée, numéros chiffrés au repos |
| Communications | **Réel** pour le moteur, la résolution des canaux et le journal ; in-app raccordé | connecteurs SMTP/SMS/USSD/SVI/courrier réels (les canaux avec clé sont mis « en_file ») ; objets des modèles traduits et validés |
| IA | **Démo** : moteur déterministe à base de règles (aucun appel externe) derrière `AIProvider` | fournisseur de modèle derrière la passerelle IA, registre des modèles |
| Taux de change | **Démo** : cours fixes « BCC (démo) » | import quotidien signé du cours BCC ; règle de taux applicable certifiée |
| Tableau du Gouverneur | **Exemple** : données `example: true` (+ compteurs réels du socle) | agrégats calculés sur l'échelle de la recette |
| Règles | modèles `A_VERIFIER` (non exécutables) + une règle **fictive** de démonstration | fiches certifiées par le service juridique provincial |

## Compléments au contrat v1

Toutes les routes du contrat sont implémentées à l'identique. Routes **ajoutées** (marquées `x-extension` dans l'OpenAPI, facultatives pour le frontend) :

- `GET /v1/legal-rules/:id` (avec `requiredInputs`), `GET /v1/legal-instruments` ;
- `POST /v1/ledger/entries/:id/reversals` (contre-écriture) ; `DELETE|PUT|PATCH /v1/ledger/entries/:id` et `/v1/audit/events/:id` → 405 ;
- `GET /v1/beneficiary-accounts` (vue masquée du coffre) ;
- `GET /v1/appeals/:id`, `POST /v1/appeals/:id/instruct` (instruction par R20, préalable à la décision R21) ;
- `GET /v1/security/alerts` ;
- `POST /v1/payment-orders/:reference/provider-verification-evidence` (R17/R18/R20 : pièce de dossier, sans effet sur le paiement).

Précisions de format (compatibles avec le contrat) : en-tête de signature des lots terrain `x-device-signature` ;
rappel prestataire : champ facultatif `payerAmount` (montant payé dans la devise du payeur) ;
`GET /v1/communications/preview/:eventCode` renvoie `text/html` (objet dans l'en-tête `x-mosolo-subject`) ;
`GET /v1/exchange-rates/:date` renvoie 404 `FX_RATE_MISSING` pour une date sans taux (422 lorsqu'une conversion est nécessaire à un paiement).
