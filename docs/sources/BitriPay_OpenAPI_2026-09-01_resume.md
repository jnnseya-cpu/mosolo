# BitriPay — API de paiement, OpenAPI 3.1 version 2026-09-01 : résumé des faits utiles à MOSOLO

Résumé rédigé le 29/09/2026 à partir du document OpenAPI transmis par le maître d'ouvrage (ce n'est pas une copie du
document). Il sert de source aux connecteurs (`backend/src/modules/payments/connectors/bitripay.ts`, liste « confirmé /
à confirmer » dans `a-confirmer.ts`) et à [`docs/prestataires-paiement.md`](../prestataires-paiement.md) § 9.4.
Prestataire **candidat, non désigné** : aucune activation en production sans agrément, convention et passation.

## Serveurs

- Déclarés : `https://www.bitripay.com/api/v1` et `https://www.bitripay.com/v1`.
- La page développeur de BitriPay (29/09/2026) indique `https://api.bitripay.com/v1`, partagée par les clés de test
  (bac à sable) et réelles : c'est l'adresse retenue par défaut par MOSOLO ; les deux serveurs de l'OpenAPI restent des
  variantes documentées (`BITRIPAY_BASE_URL`).

## Authentification et clés

- `Authorization: Bearer <clé>` ; clés secrètes `sk_live_…` / `sk_test_…` (même serveur).
- Clés restreintes `rk_…` à portées. Portées nécessaires à MOSOLO : `payment_intents:write`, `payment_intents:read`,
  `verifications:write` (pour `GET /payment_resolution`) ; facultatives : `webhooks:manage`, `events:read`.
- Clés publiables `pk_…` : `payment_intents:write` seulement — jamais utilisées ni détenues par le serveur MOSOLO.

## Montants et idempotence

- Montants : entiers en unités mineures (`amount_minor`).
- `Idempotency-Key` **obligatoire** sur tout POST qui engage de l'argent (intentions, sessions de paiement, liens,
  remboursements, versements, transferts, routes, envois, capture, demandes de paiement).
- Rejeu avec la même clé : le même objet est renvoyé. Même clé avec un autre corps ou un autre point d'appel :
  409 `idempotency_key_reused` (BP-2005). Validité des clés : 24 heures.

## Intentions de paiement

- `POST /payment_intents` — champs : `amount_minor`, `currency`, `rails[]`, `capture_method` (`automatic` | `manual`),
  `payment_method_policy`, `reference`, `description`, `purpose_code` (énumération incluant `GOVERNMENT_FEE` et `TAX`),
  `expires_in_minutes`, `metadata`, `customer_msisdn`, `customer_country`, `success_url`, `cancel_url`, `qr` (booléen),
  `splits[{recipient, bps, fixed_minor, label}]`, `application_fee_minor`. Réponse : notamment `checkout_url`,
  `qr_payload`, `client_secret`.
- Usage MOSOLO : `reference` = référence de paiement MOSOLO ; `purpose_code` `TAX` (défaut) ou `GOVERNMENT_FEE` selon la
  catégorie de recette (correspondance à confirmer) ; `success_url` / `cancel_url` = page de retour MOSOLO ;
  `metadata` = ordre et obligation ; `capture_method` `automatic`. **Jamais** `splits` ni `application_fee_minor`.
- `GET /payment_intents/{id}`, `GET /payment_intents/{id}/timeline`, `POST /payment_intents/{id}/cancel`,
  `POST /payment_intents/{id}/capture` (avec `Idempotency-Key`).

## Confirmation, vérification, état, clés publiques

- `GET /payment_resolution?reference=&msisdn=&amount_minor=&currency=&window_hours=` → `CONFIRMED` (écriture au grand
  livre du prestataire) | `PENDING` | `AMBIGUOUS` | `NOT_FOUND`. MOSOLO l'utilise comme confirmation serveur à serveur.
- `POST /verifications` (« Scan-to-Verify ») : pièce de dossier seulement.
- `GET /keys` : registre public des clés Ed25519 de la plateforme (mise en cache par ETag).
- `GET /status` : état de fonctionnement (mode gardien, drapeaux de dégradation) — essai de connexion et disjoncteur.
- `GET /webhook_events/types` : catalogue des événements.

## Webhooks

- Signatures : `BitriPay-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret du point de terminaison, « <t>.<corps brut> »)>`
  et `BitriPay-Signature-Ed25519: keyId,t,sig` (clé de la plateforme publiée à `GET /keys`).
- Renvois : 10 s, 30 s, 2 min, 10 min, 30 min, puis toutes les 2 h pendant 24 h. Livraison au moins une fois :
  dédoublonnage par identifiant d'événement.
- Événements : `payment_intent.created`, `requires_action`, `processing`, `authorised`, `succeeded`, `settled`, `failed`,
  `cancelled`, `expired`, `ambiguous_hold`, `disputed` ; `refund.*` ; `checkout.session.completed` / `expired` ;
  `verification.completed` / `confirmed` ; `settlement.created` / `completed` ; `reconciliation.exception` ; `ping` ;
  événements `payment.*` du commutateur national.
- Traitement MOSOLO : `succeeded` (capturé et écrit) ⇒ quittance provisoire seulement après vérification serveur à
  serveur ; `settled` ⇒ annonce de règlement (le relevé du compte public fait foi) ; `ambiguous_hold` ⇒ attente,
  jamais de quittance, pas de renvoi demandé ; `failed` / `cancelled` / `expired` ⇒ ordre fermé ; `disputed` ⇒ alerte au
  Trésor ; `ping` ⇒ 200 sans effet.

## Erreurs

- Forme : `{ "error": { "code", "bp", "message", "details" } }`.
- Familles : BP-1xxx authentification ; 2xxx validation ; 3xxx grand livre (BP-3006 `guardian_halt`) ; 4xxx rails
  (BP-4002 `connector_unavailable`, BP-4005 `degraded_mode`) ; 5xxx conformité ; 6xxx intelligence (BP-6005 `rate_limited`).
- Traitement MOSOLO : `guardian_halt`, `degraded_mode`, `connector_unavailable` / `rail_unavailable`, `rate_limited` ⇒
  disjoncteur et 503 avec `Retry-After` ; `scope_denied` ⇒ erreur de configuration affichée dans l'écran de raccordement.

## Points restant à confirmer avec le prestataire

- Contenu exact signé par Ed25519 et forme précise de l'en-tête `keyId,t,sig`.
- Identifiants des `rails` (MOSOLO transmet `orange_cd`, `mpesa_cd`, `airtel_cd`, `africell_cd`).
- Correspondance catégorie de recette ⇒ `purpose_code` (aussi à confirmer par le maître d'ouvrage).
- Corps de `POST /verifications`.
