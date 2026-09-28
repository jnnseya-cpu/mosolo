/**
 * Hypothèses des connecteurs NON étayées par une documentation du prestataire présente dans le dépôt : chacune est
 * « À CONFIRMER AVEC LE PRESTATAIRE » lors de la recette (voir docs/prestataires-paiement.md et document maître § 18.14).
 * Le 28/09/2026, les sites des prestataires (bitripay.com, kodajnn.com) n'étaient pas joignables depuis l'environnement
 * de construction : aucune de ces hypothèses n'a pu être vérifiée en ligne, aucune n'a été complétée par supposition.
 * Affichées telles quelles dans la vue « Prestataires de paiement — état de raccordement ».
 */
import type { ConnectorId } from './types.js';

export interface ProviderAssumption {
  sujet: string;
  hypothese: string;
}

export const A_CONFIRMER = 'À CONFIRMER AVEC LE PRESTATAIRE';

export const PROVIDER_ASSUMPTIONS: Record<ConnectorId, ProviderAssumption[]> = {
  bitripay: [
    { sujet: 'URL de base (bac à sable et réel)', hypothese: 'Une seule URL https://api.bitripay.com/v1 ; le bac à sable est choisi par la clé sk_test_… (pas d’URL distincte connue).' },
    { sujet: 'En-tête de signature HMAC', hypothese: 'BitriPay-Signature: t=<unix>,v1=<hex HMAC-SHA256 de « <t>.<corps brut> »> ; plusieurs v1 admis (rotation).' },
    { sujet: 'Fenêtre de l’horodatage signé', hypothese: '±300 secondes.' },
    { sujet: 'Signature Ed25519', hypothese: 'En-tête BitriPay-Signature-Ed25519, signature base64 (64 octets) du corps brut ; clé publique lue à GET /v1/keys puis épinglée.' },
    { sujet: 'Forme des événements', hypothese: '{ id, type, created, account?, data: { object: { id, amount_minor, currency, metadata, status… } } }.' },
    { sujet: 'Noms d’événements', hypothese: 'payment_intent.succeeded, payment_intent.canceled, payment_intent.payment_failed, payment_intent.ambiguous_hold, payment_intent.settled.' },
    { sujet: 'Réponse de GET /payment_intents/{id}', hypothese: 'Champ status (succeeded | canceled | processing | requires_payment_method…), amount_minor, currency.' },
    { sujet: 'Exposant du CDF', hypothese: '2 décimales (ISO 4217), paramétrable par BITRIPAY_CDF_EXPONENT (0 ou 2).' },
    { sujet: 'GET /v1/keys comme essai de connexion', hypothese: 'Lecture seule et sans effet ; authentification exigée ou non : inconnu.' },
    { sujet: 'Push Mobile Money (numéro du payeur)', hypothese: 'Non envoyé : paiement par page / QR du prestataire ; le champ du numéro pour un push direct n’est pas documenté.' },
    { sujet: 'Codes d’erreur et politique de renvoi des webhooks', hypothese: 'Toute réponse non 2xx est renvoyée plus tard par le prestataire (durée et nombre de tentatives inconnus).' },
    { sujet: 'Liste d’adresses IP d’émission des webhooks', hypothese: 'Inconnue : aucun filtrage par adresse n’est appliqué (la signature fait foi).' },
    { sujet: 'Paramètres de GET /payment_resolution, corps de POST /verifications', hypothese: 'payment_intent et reference ; { payment_intent, sms_code?, screenshot_sha256? } (pièces de dossier uniquement).' },
  ],
  koda: [
    { sujet: 'URL de base (bac à sable et réel)', hypothese: 'https://kodajnn.com/v1 pour les deux ; clé sk_live_… = réel, autre sk_… = test (préfixe des clés de test non documenté).' },
    { sujet: 'En-tête de signature', hypothese: 'x-koda-signature = HMAC-SHA256 hexadécimal du corps brut ; préfixe « sha256= » toléré.' },
    { sujet: 'Horodatage signé', hypothese: 'Aucun connu : pas de fenêtre temporelle ; anti-rejeu par identifiant d’événement persistant et unicité du reçu KODA.' },
    { sujet: 'Forme des événements', hypothese: 'Parseur tolérant : intent_id | intent.id | data.intent_id ; amount (unités mineures) ; currency ; receipt_id ; metadata.payment_reference ; id | event_id.' },
    { sujet: 'Événement d’échec de paiement', hypothese: 'Aucun traité ; seuls payment.verified et payment.verified.late.' },
    { sujet: 'Réponse de GET /intents/{id}', hypothese: 'Champ status (verified | paid | succeeded | completed = payé ; failed | canceled | expired = échec), amount, currency.' },
    { sujet: 'Prise en charge de l’en-tête Idempotency-Key', hypothese: 'Envoyé ; aucune nouvelle tentative automatique de POST tant que l’idempotence n’est pas confirmée.' },
    { sujet: 'Essai de connexion', hypothese: 'Aucun point « ping » ou « solde » documenté : GET /v1/openapi.json (joignabilité seulement, la clé n’est pas éprouvée).' },
    { sujet: 'Champ de description d’une intention', hypothese: 'Porté dans metadata.description.' },
    { sujet: 'Codes d’erreur, politique de renvoi, adresses IP d’émission', hypothese: 'Inconnus : toute réponse non 2xx est supposée renvoyée ; aucun filtrage par adresse.' },
    { sujet: 'Corps de POST /intents/{id}/verify', hypothese: '{ sms_code?, screenshot_sha256? } (pièce de dossier uniquement).' },
  ],
};
