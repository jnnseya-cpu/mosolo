/**
 * Hypothèses des connecteurs NON étayées par une documentation du prestataire présente dans le dépôt : chacune est
 * « À CONFIRMER AVEC LE PRESTATAIRE » lors de la recette (voir docs/prestataires-paiement.md et document maître § 18.14).
 * Le 28/09/2026, les sites des prestataires (bitripay.com, kodajnn.com) n'étaient pas joignables depuis l'environnement
 * de construction : aucune de ces hypothèses n'a pu être vérifiée en ligne, aucune n'a été complétée par supposition.
 * Affichées telles quelles dans la vue « Prestataires de paiement — état de raccordement ».
 *
 * 29/09/2026 : le maître d'ouvrage a fourni la documentation publique des deux prestataires. Les points qu'elle tranche
 * sont passés dans `PROVIDER_CONFIRMED` (rien n'est effacé : l'hypothèse d'origine y reste citée) ; les autres restent
 * ci-dessous, « À CONFIRMER AVEC LE PRESTATAIRE ».
 */
import type { ConnectorId } from './types.js';

export interface ProviderAssumption {
  sujet: string;
  hypothese: string;
}

export const A_CONFIRMER = 'À CONFIRMER AVEC LE PRESTATAIRE';

export const PROVIDER_ASSUMPTIONS: Record<ConnectorId, ProviderAssumption[]> = {
  bitripay: [
    { sujet: 'Fenêtre de l’horodatage signé', hypothese: '±300 secondes (valeur MOSOLO ; la tolérance du prestataire n’est pas indiquée).' },
    { sujet: 'Signature Ed25519 : contenu signé et encodage', hypothese: 'En-tête « keyId,t,sig » (confirmé) : signature base64 de « <t>.<corps brut> », à défaut du corps brut ; clé de la plateforme (GET /keys) épinglée ; forme « base64 seule » antérieure tolérée.' },
    { sujet: 'Forme des événements', hypothese: '{ id, type, created, account?, data: { object: { id, amount_minor, currency, metadata, status… } } }.' },
    { sujet: 'Anciens noms d’événements', hypothese: 'payment_intent.canceled et payment_intent.payment_failed (page publique antérieure) restent traités ; l’OpenAPI emploie payment_intent.cancelled et payment_intent.failed (traités aussi).' },
    { sujet: 'Réponse de GET /payment_intents/{id}', hypothese: 'Champ status (succeeded | canceled | processing | requires_payment_method…), amount_minor, currency.' },
    { sujet: 'Exposant du CDF', hypothese: '2 décimales (ISO 4217), paramétrable par BITRIPAY_CDF_EXPONENT (0 ou 2).' },
    { sujet: 'Push Mobile Money (numéro du payeur)', hypothese: 'Non envoyé : paiement par page / QR du prestataire ; le champ du numéro pour un push direct n’est pas documenté.' },
    { sujet: 'Liste d’adresses IP d’émission des webhooks', hypothese: 'Inconnue : aucun filtrage par adresse n’est appliqué (la signature fait foi).' },
    { sujet: 'Corps de POST /verifications (Scan-to-Verify)', hypothese: '{ payment_intent, sms_code?, screenshot_sha256? } (pièce de dossier uniquement).' },
    { sujet: 'Rail carte', hypothese: 'Canal Carte : rails = ["card"] — retenu par le maître d’ouvrage (30/09/2026) : seules les clés API et le webhook restent à fournir.' },
    { sujet: 'Identifiants des rails (rails[])', hypothese: 'Mêmes valeurs que les opérateurs (orange_cd, mpesa_cd, airtel_cd, africell_cd) ; « allowed_operators » de la page publique n’est plus envoyé.' },
    { sujet: 'purpose_code par catégorie de recette', hypothese: 'DROIT_ADMINISTRATIF et REDEVANCE_SERVICE ⇒ GOVERNMENT_FEE ; toute autre catégorie ⇒ TAX (défaut) — à confirmer aussi par le maître d’ouvrage.' },
    { sujet: 'Forme de la réponse de GET /status', hypothese: 'Champ operating_state | state | status (operational = normal ; guardian, degraded = dégradé) ; drapeaux guardian / degraded tolérés.' },
    { sujet: 'Forme de la réponse de GET /payment_intents/{id}/timeline', hypothese: 'Non utilisée par MOSOLO (disponible pour un dossier de litige).' },
  ],
  koda: [
    { sujet: 'Niveau de confirmation (3 niveaux)', hypothese: 'KODA qualifie chaque vérification : recoupée par l’opérateur, ancrée à l’appareil (Sentinel), déclarée (collée ou relayée) ; le maître d’ouvrage (30/09/2026) n’exige pas ce champ — MOSOLO émet une quittance PROVISOIRE dans tous les cas et ne la rend définitive qu’au rapprochement du relevé de l’opérateur.' },
    { sujet: 'Codes des opérateurs', hypothese: 'orange_cd, mpesa_cd, airtel_cd, africell_cd — retenus par le maître d’ouvrage (30/09/2026) ; seules les clés API et le webhook restent à fournir.' },
    { sujet: 'Préfixe « sha256= » de la signature', hypothese: 'Toléré s’il est présent (x-koda-signature = HMAC-SHA256 hexadécimal du corps brut est confirmé).' },
    { sujet: 'Horodatage signé', hypothese: 'Aucun connu : pas de fenêtre temporelle ; anti-rejeu par identifiant d’événement persistant et unicité du reçu KODA.' },
    { sujet: 'Forme des événements', hypothese: 'Parseur tolérant : intent_id | intent.id | data.intent_id ; amount (unités mineures) ; currency ; receipt_id ; metadata.payment_reference ; id | event_id.' },
    { sujet: 'Événement d’échec de paiement', hypothese: 'Aucun traité ; seuls payment.verified et payment.verified.late.' },
    { sujet: 'Réponse de GET /intents/{id}', hypothese: 'Champ status (verified | paid | succeeded | completed = payé ; failed | canceled | expired = échec), amount, currency.' },
    { sujet: 'Prise en charge de l’en-tête Idempotency-Key', hypothese: 'Envoyé ; aucune nouvelle tentative automatique de POST tant que l’idempotence n’est pas confirmée.' },
    { sujet: 'Champ de description d’une intention', hypothese: 'Porté dans metadata.description.' },
    { sujet: 'Codes d’erreur, politique de renvoi, adresses IP d’émission', hypothese: 'Inconnus : toute réponse non 2xx est supposée renvoyée ; aucun filtrage par adresse.' },
    { sujet: 'Corps de POST /intents/{id}/verify', hypothese: '{ reference?, sms_code?, screenshot_sha256? } (pièce de dossier uniquement) ; réponse d’un défi (msisdn_suffix_mismatch) : forme inconnue.' },
    { sujet: 'Format du champ expiry de POST /intents', hypothese: 'Non documenté dans l’extrait fourni (secondes ? date ISO ?) : non envoyé ; l’expiration de la référence reste contrôlée par MOSOLO.' },
    { sujet: 'URL d’annulation (cancel_url)', hypothese: 'Non documentée : seule success_url est envoyée ; la page de retour MOSOLO lit l’état réel dans tous les cas.' },
  ],
};

/** Point tranché par la documentation publique du prestataire (fournie par le maître d'ouvrage le 29/09/2026). */
export interface ProviderConfirmedFact {
  sujet: string;
  fait: string;
  /** Hypothèse retenue jusque-là (conservée pour mémoire). */
  hypotheseAnterieure?: string;
}

export const CONFIRMED_SOURCE = 'Documentation publique du prestataire et, pour BitriPay, OpenAPI 3.1 version 2026-09-01 (résumé : docs/sources/BitriPay_OpenAPI_2026-09-01_resume.md), fournies par le maître d’ouvrage le 29/09/2026';

export const PROVIDER_CONFIRMED: Record<ConnectorId, ProviderConfirmedFact[]> = {
  bitripay: [
    { sujet: 'URL de base (bac à sable et réel)', fait: 'https://api.bitripay.com/v1 (page développeur, 29/09/2026) : les clés de test vont au bac à sable, les clés réelles aux rails réels, même URL. Variantes documentées (serveurs de l’OpenAPI) : https://www.bitripay.com/api/v1, https://www.bitripay.com/v1.', hypotheseAnterieure: 'Une seule URL ; le bac à sable est choisi par la clé sk_test_….' },
    { sujet: 'Parcours et double signature', fait: 'Intention → redirection vers checkout_url (ou affichage de qr_payload) → traitement de payment_intent.succeeded et payment_intent.settled après vérification des DEUX signatures : BitriPay-Signature (HMAC, secret whsec_ du point de terminaison) et clé Ed25519 de la plateforme (GET /v1/keys). En production déclarée, la clé Ed25519 épinglée est exigée pour une clé réelle.' },
    { sujet: 'Création d’une intention', fait: 'POST /payment_intents {amount_minor, currency, description, allowed_operators[orange_cd, mpesa_cd, airtel_cd, africell_cd]} avec Authorization: Bearer et Idempotency-Key → checkout_url, qr_payload, client_secret (le client_secret n’est ni conservé ni exposé).' },
    { sujet: 'Essai de connexion', fait: 'GET /status (état de fonctionnement : normal, gardien, dégradé) — utilisé par « Tester la connexion » et affiché avec le disjoncteur.', hypotheseAnterieure: 'GET /v1/keys (lecture seule ; authentification inconnue).' },
    { sujet: 'Corps de POST /payment_intents (OpenAPI 2026-09-01)', fait: 'amount_minor, currency, rails[], capture_method (automatic), reference (= référence MOSOLO), description, purpose_code (TAX / GOVERNMENT_FEE), expires_in_minutes (échéance de la référence), metadata (ordre, obligation), success_url et cancel_url (= page de retour MOSOLO), qr. Jamais splits ni application_fee_minor.', hypotheseAnterieure: 'allowed_operators ; URL de retour non documentée (BITRIPAY_RETURN_URL_FIELD).' },
    { sujet: 'Idempotence', fait: 'Idempotency-Key obligatoire sur tout POST qui engage de l’argent ; rejeu ⇒ même objet ; réutilisation avec un autre corps ou un autre point d’appel ⇒ 409 idempotency_key_reused (BP-2005) ; clés valables 24 h.' },
    { sujet: 'Signature des webhooks', fait: 'BitriPay-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, « <t>.<corps brut> »)> ET BitriPay-Signature-Ed25519: keyId,t,sig (clé plateforme de GET /keys).', hypotheseAnterieure: 'Schéma « à la Stripe » supposé ; en-tête Ed25519 en base64 seule.' },
    { sujet: 'Politique de renvoi des webhooks', fait: '10 s, 30 s, 2 min, 10 min, 30 min, puis toutes les 2 h pendant 24 h ; au moins une fois : dédoublonnage par identifiant d’événement.', hypotheseAnterieure: 'Durée et nombre de tentatives inconnus.' },
    { sujet: 'Événements', fait: 'payment_intent.created / requires_action / processing / authorised (informatifs), succeeded (capturé et écrit ⇒ quittance provisoire après vérification serveur), settled (règlement annoncé), failed / cancelled / expired (ordre fermé), ambiguous_hold (attente, jamais de quittance, ne pas faire renvoyer), disputed (alerte au Trésor) ; refund.*, checkout.session.*, verification.*, settlement.*, reconciliation.exception (journalisés) ; ping (200 sans effet).' },
    { sujet: 'Erreurs', fait: '{error:{code, bp, message, details}} ; familles BP-1xxx authentification, 2xxx validation, 3xxx grand livre (BP-3006 guardian_halt), 4xxx rails (BP-4002 connector_unavailable, BP-4005 degraded_mode), 5xxx conformité, 6xxx intelligence (BP-6005 rate_limited). Indisponibilités ⇒ disjoncteur et 503 + Retry-After ; scope_denied ⇒ erreur de configuration affichée.' },
    { sujet: 'GET /payment_resolution', fait: 'Paramètres reference, msisdn, amount_minor, currency, window_hours (MOSOLO envoie reference, amount_minor, currency) ; CONFIRMED = écriture au grand livre du prestataire.', hypotheseAnterieure: 'Paramètres payment_intent et reference.' },
    { sujet: 'Clés et portées', fait: 'Bearer sk_live_ / sk_test_ ; clés restreintes rk_ à portées (au minimum payment_intents:write, payment_intents:read, verifications:write ; webhooks:manage et events:read facultatives) — admises côté serveur ; pk_ (payment_intents:write seulement) jamais utilisée par le serveur.' },
    { sujet: 'Clé plateforme Ed25519', fait: 'Publique à GET /keys, mise en cache par ETag ; toujours épinglée par configuration (BITRIPAY_ED25519_PUBLIC_KEY) et comparée lors de l’essai.' },
    { sujet: 'Confirmation « ce paiement a-t-il eu lieu ? »', fait: 'GET /payment_resolution → CONFIRMED / PENDING / AMBIGUOUS / NOT_FOUND ; désormais exigée comme confirmation serveur à serveur supplémentaire avant quittance (BITRIPAY_RESOLUTION_CHECK=false pour la désactiver).' },
    { sujet: 'Attente ambiguë', fait: 'payment_intent.ambiguous_hold : jamais de quittance ; attente et revue manuelle (exception de rapprochement).' },
    { sujet: 'Livraison des webhooks', fait: 'Au moins une fois (GET /webhook_events/types) : dédoublonnage par identifiant d’événement.' },
    { sujet: 'Comptes connectés', fait: 'En-tête BitriPay-Account pour agir pour un compte connecté.' },
    { sujet: 'Bac à sable', fait: '+243000000501 réussit, +243000000404 échoue, +243000000408 ambigu, +243000000500 délai puis succès, +243000000503 prestataire indisponible ; tout numéro finissant par 0000 est refusé.' },
    { sujet: 'Autres points d’appel', fait: 'GET /payment_intents/{id}/timeline ; POST /verifications (Scan-to-Verify, pièce de dossier).' },
  ],
  koda: [
    { sujet: 'URL de base (bac à sable et réel)', fait: 'https://kodajnn.com/v1 pour les deux ; clés de test sk_test_…, clés réelles sk_live_….', hypotheseAnterieure: 'Préfixe des clés de test non documenté.' },
    { sujet: 'Authentification', fait: 'Authorization: Bearer sk_… (ou X-API-Key) ; clés pk_… limitées à write:intents (jamais dans le navigateur de MOSOLO) ; clés rk_… en lecture seule (refusées pour créer des intentions).' },
    { sujet: 'Essai de connexion', fait: 'GET /ping vérifie une clé : utilisé par « Tester la connexion » (prouve la validité de la clé).', hypotheseAnterieure: 'Aucun point « ping » connu : GET /v1/openapi.json (joignabilité seulement).' },
    { sujet: 'Création d’une intention', fait: 'POST /intents {amount (entier en unités mineures : CDF sans décimale, USD en cents), currency, operators[], metadata{order_id}, success_url, expiry} → {intent_id, client_secret, checkout_url}.' },
    { sujet: 'URL de retour', fait: 'success_url = MOSOLO_PUBLIC_URL + /paiement/retour?ref=<référence> (ou KODA_SUCCESS_URL si elle est fournie) : commodité, jamais la source de vérité.' },
    { sujet: 'Signature des webhooks', fait: 'x-koda-signature = HMAC-SHA256 hexadécimal du corps brut ; événements payment.verified et payment.verified.late.' },
    { sujet: 'Limitation de débit', fait: 'HTTP 429 avec Retry-After : délai respecté (attente bornée, par défaut 5 s — à confirmer), sinon 503 + Retry-After au client.' },
    { sujet: 'Bac à sable', fait: 'TEST-OK-25000 (vérifié aussitôt), TEST-LATE-90 (vérifié après 90 s, payment.verified.late), TEST-REPLAY (code_already_used), TEST-SUFFIX (msisdn_suffix_mismatch ⇒ défi).' },
    { sujet: 'Autres points d’appel', fait: 'GET /intents/{id}, POST /intents/{id}/cancel, POST /intents/{id}/verify, GET /checkout/{id}?cs= (côté payeur, non utilisé), GET /receipts, GET /usage, GET /billing/balance.' },
    { sujet: 'Principe', fait: '« Le retour navigateur est une commodité, jamais la source de vérité » : quittance après webhook signé et vérification serveur à serveur.' },
  ],
};
