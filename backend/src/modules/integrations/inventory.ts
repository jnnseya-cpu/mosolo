/**
 * « Clés et raccordements » — inventaire des variables de configuration des services EXTERNES (paiement, IA, SMS/USSD,
 * e-mail, WhatsApp, cartes, MDM, identité…) et des clés internes du socle, établi le 29/09/2026 par relecture de toutes
 * les lectures de `process.env` du serveur. L'inventaire ne porte que des NOMS : aucune valeur n'y figure, jamais.
 *
 * Effet d'une valeur saisie dans la console :
 *  - IMMEDIAT : relue sans redémarrage (connecteurs de paiement reconstruits, passerelles lues à chaque requête,
 *    fournisseurs de canaux de communication raccordés) ;
 *  - AUCUN_LECTEUR : nom PROPOSÉ (« à confirmer »), aucun module ne la lit encore — conservée pour le raccordement ;
 *  - ENVIRONNEMENT_SEUL : lue au démarrage ou par le socle (clés internes, contrôles de démarrage) — la console affiche
 *    sa présence mais refuse de la définir (un secret de démarrage ne peut dépendre de la base qu'il protège).
 */
import { PROVIDER_ENV_VARS } from '../payments/connectors/registry.js';
import { PROVIDER_ENV_KEYS } from '../communications/providers.js';
import { CONNECTOR_IDS } from '../payments/connectors/types.js';

export const INTEGRATION_GROUPS = [
  { id: 'bitripay', label: 'Paiement — BitriPay', test: 'APPEL_REEL' },
  { id: 'koda', label: 'Paiement — KODA', test: 'APPEL_REEL' },
  { id: 'paiement-rappels', label: 'Paiement — autres opérateurs et banques (rappels signés)', test: 'CONFIGURATION' },
  { id: 'plateforme', label: 'Adresse publique et webhooks', test: 'CONFIGURATION' },
  { id: 'ia', label: 'Intelligence artificielle (IA)', test: 'CONFIGURATION' },
  { id: 'sms-ussd', label: 'SMS, USSD et serveur vocal (SVI)', test: 'CONFIGURATION' },
  { id: 'email', label: 'Courrier électronique (e-mail)', test: 'CONFIGURATION' },
  { id: 'whatsapp', label: 'Messagerie WhatsApp', test: 'CONFIGURATION' },
  { id: 'notifications', label: 'Notifications (push) et courrier postal', test: 'CONFIGURATION' },
  { id: 'cartes', label: 'Cartes (fonds de carte)', test: 'CONFIGURATION' },
  { id: 'mdm', label: 'Gestion des terminaux (MDM)', test: 'CONFIGURATION' },
  { id: 'identite', label: 'Identité, NIF et authentification (OIDC)', test: 'CONFIGURATION' },
  { id: 'horodatage', label: 'Horodatage qualifié (TSA)', test: 'CONFIGURATION' },
  { id: 'socle', label: 'Socle — clés internes (environnement seulement)', test: 'CONFIGURATION' },
] as const;
export type IntegrationGroupId = (typeof INTEGRATION_GROUPS)[number]['id'];

/** Règle de format (contrôlée à la saisie ; un refus ne renvoie jamais la valeur). */
export type FormatRule =
  | 'CLE_SECRETE_SK' | 'CLE_SECRETE_SK_OU_RK' | 'SECRET_WHSEC' | 'SECRET' | 'URL_HTTPS' | 'BOOLEEN' | 'EXPOSANT_0_2' | 'LISTE_OPERATEURS'
  | 'ALIAS_COFFRE' | 'COMPTE_CONNECTE' | 'NOM_CHAMP' | 'CLE_PUBLIQUE_ED25519' | 'TEXTE';

export type Effect = 'IMMEDIAT' | 'AUCUN_LECTEUR' | 'ENVIRONNEMENT_SEUL';

export interface IntegrationVariable {
  name: string;
  group: IntegrationGroupId;
  purpose: string;
  secret: boolean;
  required: 'OBLIGATOIRE_EN_REEL' | 'FACULTATIVE';
  effect: Effect;
  format: FormatRule;
  /** Nom proposé par la plateforme (aucun module ne la lit encore) : « nom proposé — à confirmer ». */
  proposedName?: boolean;
  /** Modules qui lisent la variable (affichage). */
  readBy: string[];
}

const PAYMENT_FORMAT: Record<string, FormatRule> = {
  // BitriPay admet une clé restreinte rk_… à portées (OpenAPI 2026-09-01) ; KODA : rk_ = lecture seule, refusée.
  BITRIPAY_API_KEY: 'CLE_SECRETE_SK_OU_RK', KODA_API_KEY: 'CLE_SECRETE_SK',
  BITRIPAY_WEBHOOK_SECRET: 'SECRET_WHSEC', KODA_WEBHOOK_SECRET: 'SECRET',
  BITRIPAY_ED25519_PUBLIC_KEY: 'CLE_PUBLIQUE_ED25519',
  BITRIPAY_HMAC_REQUIRED: 'BOOLEEN', BITRIPAY_ED25519_REQUIRED: 'BOOLEEN', BITRIPAY_RESOLUTION_CHECK: 'BOOLEEN',
  BITRIPAY_BASE_URL: 'URL_HTTPS', KODA_BASE_URL: 'URL_HTTPS', KODA_SUCCESS_URL: 'URL_HTTPS',
  BITRIPAY_SETTLEMENT_ACCOUNT_ALIAS: 'ALIAS_COFFRE', KODA_SETTLEMENT_ACCOUNT_ALIAS: 'ALIAS_COFFRE',
  BITRIPAY_ALLOWED_OPERATORS: 'LISTE_OPERATEURS', KODA_OPERATORS: 'LISTE_OPERATEURS',
  BITRIPAY_ACCOUNT_ID: 'COMPTE_CONNECTE', BITRIPAY_CDF_EXPONENT: 'EXPOSANT_0_2', BITRIPAY_RETURN_URL_FIELD: 'NOM_CHAMP',
};

const payment: IntegrationVariable[] = CONNECTOR_IDS.flatMap((id) => PROVIDER_ENV_VARS[id].map((v) => ({
  name: v.name, group: id, purpose: v.role, secret: v.secret, required: v.requiredForReal ? 'OBLIGATOIRE_EN_REEL' as const : 'FACULTATIVE' as const,
  effect: 'IMMEDIAT' as const, format: PAYMENT_FORMAT[v.name] ?? 'TEXTE', readBy: [`Connecteur ${id === 'koda' ? 'KODA' : 'BitriPay'}`],
})));

const env = (name: string, group: IntegrationGroupId, purpose: string, secret: boolean, readBy: string[], required: IntegrationVariable['required'] = 'FACULTATIVE'): IntegrationVariable => ({
  name, group, purpose, secret, required, effect: 'ENVIRONNEMENT_SEUL', format: secret ? 'SECRET' : 'TEXTE', readBy,
});
const reserved = (name: string, group: IntegrationGroupId, purpose: string, secret: boolean): IntegrationVariable => ({
  name, group, purpose, secret, required: 'FACULTATIVE', effect: 'AUCUN_LECTEUR', format: secret ? 'SECRET' : 'URL_HTTPS', proposedName: true, readBy: [],
});

/** Canal de communication de chaque clé de fournisseur (voir modules/communications/providers.ts). */
const COMMS_GROUP: Record<string, IntegrationGroupId> = {
  email: 'email', sms: 'sms-ussd', ussd: 'sms-ussd', svi: 'sms-ussd', whatsapp: 'whatsapp', push: 'notifications', courrier: 'notifications',
};
const comms: IntegrationVariable[] = Object.entries(PROVIDER_ENV_KEYS).map(([channel, name]) => ({
  name, group: COMMS_GROUP[channel] ?? 'notifications', purpose: `Clé du fournisseur du canal « ${channel} » (sans clé : bac à sable journalisé)`,
  secret: true, required: 'OBLIGATOIRE_EN_REEL' as const, effect: 'IMMEDIAT' as const, format: 'SECRET' as const, readBy: ['Communications'],
}));

export const INVENTORY: IntegrationVariable[] = [
  ...payment,
  // Rappels signés génériques (HMAC v2) : lus au démarrage et exigés par le contrôle de démarrage hors démonstration.
  env('MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A', 'paiement-rappels', 'Trousseau HMAC des rappels de l’opérateur de monnaie mobile A (kid:secret[,…])', true, ['Paiements (rappels signés)'], 'OBLIGATOIRE_EN_REEL'),
  env('MOSOLO_PROVIDER_SECRET_BANK_A', 'paiement-rappels', 'Trousseau HMAC des rappels de la banque A', true, ['Paiements (rappels signés)'], 'OBLIGATOIRE_EN_REEL'),
  env('MOSOLO_PROVIDER_SECRET_CARD_GATEWAY', 'paiement-rappels', 'Trousseau HMAC des rappels de la passerelle de cartes', true, ['Paiements (rappels signés)'], 'OBLIGATOIRE_EN_REEL'),
  { name: 'MOSOLO_PUBLIC_URL', group: 'plateforme', purpose: 'Adresse publique https de la plateforme : URL des webhooks à communiquer, page de retour /paiement/retour', secret: false, required: 'OBLIGATOIRE_EN_REEL', effect: 'IMMEDIAT', format: 'URL_HTTPS', readBy: ['Raccordement des prestataires', 'Connecteurs de paiement'] },
  env('MOSOLO_WEBHOOK_DELIVERY', 'plateforme', 'Livraison réelle des webhooks sortants aux partenaires (« http ») ; sinon journal de bac à sable', false, ['Plateforme — partenaires']),
  env('MOSOLO_CORS_ORIGINS', 'plateforme', 'Origines autorisées (navigateur)', false, ['Socle']),
  reserved('MOSOLO_AI_PROVIDER_URL', 'ia', 'Adresse du fournisseur de modèle d’IA (l’IA propose, une personne décide) — nom proposé, à confirmer', false),
  reserved('MOSOLO_AI_PROVIDER_KEY', 'ia', 'Clé du fournisseur de modèle d’IA — nom proposé, à confirmer ; aujourd’hui : moteur déterministe interne, sans clé', true),
  // Fournisseurs d'IA raccordés (01/10/2026) : Claude, OpenAI, Gemini — FACULTATIFS. Sans clé, les agents fonctionnent
  // avec leurs règles internes. Clés saisies par le super-administrateur seul (R26), approuvées par une seconde personne.
  ...([
    ['ANTHROPIC_API_KEY', 'Clé de l’API Claude (Anthropic) — analyses et réponses des agents IA de recettes'],
    ['OPENAI_API_KEY', 'Clé de l’API OpenAI — analyses et réponses des agents IA de recettes'],
    ['GEMINI_API_KEY', 'Clé de l’API Gemini (Google) — analyses et réponses des agents IA de recettes'],
  ] as const).map(([name, purpose]): IntegrationVariable => ({ name, group: 'ia', purpose, secret: true, required: 'FACULTATIVE', effect: 'IMMEDIAT', format: 'SECRET', readBy: ['Agents IA de recettes'] })),
  ...([
    ['MOSOLO_IA_ORDRE', 'Ordre d’essai des fournisseurs d’IA (ex. claude,openai,gemini) : le suivant prend le relais en cas d’échec — par défaut claude,openai,gemini, à confirmer'],
    ['MOSOLO_IA_MODELE_CLAUDE', 'Modèle Claude utilisé — par défaut claude-opus-5-5, à confirmer'],
    ['MOSOLO_IA_MODELE_OPENAI', 'Modèle OpenAI utilisé — par défaut gpt-4.1-mini, à confirmer'],
    ['MOSOLO_IA_MODELE_GEMINI', 'Modèle Gemini utilisé — par défaut gemini-2.5-flash, à confirmer'],
  ] as const).map(([name, purpose]): IntegrationVariable => ({ name, group: 'ia', purpose, secret: false, required: 'FACULTATIVE', effect: 'IMMEDIAT', format: 'TEXTE', readBy: ['Agents IA de recettes'] })),
  { name: 'MOSOLO_IA_DOLEANCES', group: 'ia', purpose: 'Autoriser l’envoi du TEXTE des doléances (numéros et courriels masqués) au fournisseur d’IA pour une suggestion de tri — désactivé par défaut (protection des données)', secret: false, required: 'FACULTATIVE', effect: 'IMMEDIAT', format: 'BOOLEEN', readBy: ['Agents IA de recettes'] },
  ...comms,
  { name: 'SMS_GATEWAY_SECRET', group: 'sms-ussd', purpose: 'Secret HMAC de la passerelle SMS entrante (en-tête x-mosolo-signature) : /v1/sms/inbound, signalements par SMS', secret: true, required: 'OBLIGATOIRE_EN_REEL', effect: 'IMMEDIAT', format: 'SECRET', readBy: ['Preuves (SMS entrant)', 'Intégrité (signalements SMS)'] },
  { name: 'SVI_GATEWAY_SECRET', group: 'sms-ussd', purpose: 'Secret HMAC de la passerelle du serveur vocal (signalements SVI)', secret: true, required: 'OBLIGATOIRE_EN_REEL', effect: 'IMMEDIAT', format: 'SECRET', readBy: ['Intégrité (signalements SVI)'] },
  { name: 'WHATSAPP_APP_SECRET', group: 'whatsapp', purpose: 'Secret d’application WhatsApp : signature x-hub-signature-256 des webhooks entrants', secret: true, required: 'OBLIGATOIRE_EN_REEL', effect: 'IMMEDIAT', format: 'SECRET', readBy: ['Preuves (assistant WhatsApp)'] },
  { name: 'WHATSAPP_VERIFY_TOKEN', group: 'whatsapp', purpose: 'Jeton de vérification de l’abonnement au webhook WhatsApp (GET hub.verify_token)', secret: true, required: 'OBLIGATOIRE_EN_REEL', effect: 'IMMEDIAT', format: 'SECRET', readBy: ['Preuves (assistant WhatsApp)'] },
  reserved('MOSOLO_MAPS_API_KEY', 'cartes', 'Clé du fournisseur de fonds de carte — nom proposé, à confirmer (aujourd’hui : aucun fournisseur externe)', true),
  reserved('MOSOLO_MDM_API_URL', 'mdm', 'Adresse de l’outil MDM du fournisseur — nom proposé, à confirmer (aujourd’hui : bac à sable intégré, convention requise)', false),
  reserved('MOSOLO_MDM_API_KEY', 'mdm', 'Clé de l’outil MDM — nom proposé, à confirmer', true),
  reserved('MOSOLO_NIF_API_URL', 'identite', 'Adresse du service de vérification du NIF / de l’identité — nom proposé, à confirmer', false),
  reserved('MOSOLO_NIF_API_KEY', 'identite', 'Clé du service de vérification du NIF / de l’identité — nom proposé, à confirmer', true),
  env('MOSOLO_OIDC_ISSUER', 'identite', 'Émetteur OIDC du fournisseur d’identité souverain (lu au démarrage)', false, ['Socle — authentification']),
  env('MOSOLO_WEBAUTHN_RP_ID', 'identite', 'Identifiant de la partie de confiance des clés d’accès (passkeys)', false, ['Socle — clés d’accès']),
  env('MOSOLO_WEBAUTHN_ORIGINS', 'identite', 'Origines admises des clés d’accès', false, ['Socle — clés d’accès']),
  env('MOSOLO_TSA_MODE', 'horodatage', 'Mode d’horodatage (rfc3161 : autorité externe)', false, ['Intégrité — horodatage']),
  env('MOSOLO_TSA_URL', 'horodatage', 'Adresse de l’autorité d’horodatage RFC 3161', false, ['Intégrité — horodatage']),
  env('MOSOLO_TSA_PRIVATE_KEY', 'horodatage', 'Clé privée de l’horodatage interne', true, ['Intégrité — horodatage']),
  env('MOSOLO_CONFIG_MASTER_KEY', 'socle', 'Clé maîtresse AES-256-GCM du chiffrement des valeurs de la console (32 octets, hexadécimal ou base64)', true, ['Clés et raccordements'], 'OBLIGATOIRE_EN_REEL'),
  env('DATABASE_URL', 'socle', 'Base de données PostgreSQL (persistance)', true, ['Socle — persistance'], 'OBLIGATOIRE_EN_REEL'),
  env('MOSOLO_AUDIT_HMAC_KEY', 'socle', 'Clé HMAC de la piste d’audit chaînée', true, ['Socle — audit'], 'OBLIGATOIRE_EN_REEL'),
  env('MOSOLO_RECEIPT_SIGNING_KEY', 'socle', 'Clé de signature des quittances', true, ['Quittances'], 'OBLIGATOIRE_EN_REEL'),
  env('MOSOLO_RECEIPT_VERIFY_KEYS', 'socle', 'Anciennes clés publiques de vérification des quittances (rotation)', false, ['Quittances']),
  env('MOSOLO_JWT_PRIVATE_KEY', 'socle', 'Clé privée des jetons de session', true, ['Socle — authentification'], 'OBLIGATOIRE_EN_REEL'),
  env('MOSOLO_BACKUP_KEY', 'socle', 'Clé des exports et sauvegardes signés', true, ['Socle — sauvegardes']),
  env('MOSOLO_CLOSURE_SIGNING_KEY', 'socle', 'Clé de signature des clôtures du Trésor', true, ['Trésor — clôtures']),
  env('MOSOLO_INTEGRITE_KEY', 'socle', 'Clé du module Intégrité', true, ['Intégrité']),
  env('MOSOLO_PAYMENT_POINT_MASTER_KEY', 'socle', 'Clé maîtresse des points de paiement agréés', true, ['Points agréés']),
  env('MOSOLO_DEVICE_KEYS', 'socle', 'Clés des terminaux de terrain', true, ['Terrain']),
  env('MOSOLO_METRICS_TOKEN', 'socle', 'Jeton d’accès aux métriques d’exploitation', true, ['Plateforme — supervision']),
];

export function variable(name: string): IntegrationVariable | undefined {
  return INVENTORY.find((v) => v.name === name);
}

/** Variables de paiement : leur environnement de base est celui des connecteurs (injectable en test). */
export const CONNECTOR_BASE_VARS = new Set<string>([...payment.map((v) => v.name), 'MOSOLO_PUBLIC_URL']);

/** Signature attendue de chaque webhook ENTRANT (affichage « Clés et raccordements »). */
export interface InboundWebhook {
  id: string;
  label: string;
  method: 'POST' | 'GET';
  path: string;
  signature: string;
  secretVariable: string | null;
  group: IntegrationGroupId;
}

export const INBOUND_WEBHOOKS: InboundWebhook[] = [
  { id: 'bitripay', label: 'BitriPay — webhooks de paiement', method: 'POST', path: '/v1/providers/bitripay/webhooks', signature: 'HMAC-SHA256 « t=<unix>,v1=<hex> » sur « <t>.<corps brut> » (en-tête BitriPay-Signature, secret whsec_…) ± Ed25519 (en-tête BitriPay-Signature-Ed25519 « keyId,t,sig », clé plateforme GET /keys) ; renvois : 10 s, 30 s, 2 min, 10 min, 30 min puis toutes les 2 h pendant 24 h', secretVariable: 'BITRIPAY_WEBHOOK_SECRET', group: 'bitripay' },
  { id: 'koda', label: 'KODA — webhooks de paiement', method: 'POST', path: '/v1/providers/koda/webhooks', signature: 'HMAC-SHA256 hexadécimal du corps brut (en-tête x-koda-signature)', secretVariable: 'KODA_WEBHOOK_SECRET', group: 'koda' },
  { id: 'callback:mm-operator-a', label: 'Rappels signés — opérateur de monnaie mobile A', method: 'POST', path: '/v1/providers/mm-operator-a/callbacks', signature: 'HMAC-SHA256 v2 (en-têtes x-signature, x-nonce, x-timestamp, x-key-id ; fenêtre ±5 min)', secretVariable: 'MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A', group: 'paiement-rappels' },
  { id: 'callback:bank-a', label: 'Rappels signés — banque A', method: 'POST', path: '/v1/providers/bank-a/callbacks', signature: 'HMAC-SHA256 v2 (en-têtes x-signature, x-nonce, x-timestamp, x-key-id ; fenêtre ±5 min)', secretVariable: 'MOSOLO_PROVIDER_SECRET_BANK_A', group: 'paiement-rappels' },
  { id: 'callback:card-gateway', label: 'Rappels signés — passerelle de cartes', method: 'POST', path: '/v1/providers/card-gateway/callbacks', signature: 'HMAC-SHA256 v2 (en-têtes x-signature, x-nonce, x-timestamp, x-key-id ; fenêtre ±5 min)', secretVariable: 'MOSOLO_PROVIDER_SECRET_CARD_GATEWAY', group: 'paiement-rappels' },
  { id: 'sms', label: 'SMS entrant (passerelle opérateur)', method: 'POST', path: '/v1/sms/inbound', signature: 'HMAC-SHA256 hexadécimal du corps brut (en-tête x-mosolo-signature)', secretVariable: 'SMS_GATEWAY_SECRET', group: 'sms-ussd' },
  { id: 'integrite-sms', label: 'Signalements par SMS (intégrité)', method: 'POST', path: '/v1/public/integrite/reports/sms', signature: 'HMAC-SHA256 hexadécimal du corps brut (en-tête x-mosolo-signature)', secretVariable: 'SMS_GATEWAY_SECRET', group: 'sms-ussd' },
  { id: 'integrite-svi', label: 'Signalements par serveur vocal (intégrité)', method: 'POST', path: '/v1/public/integrite/reports/svi', signature: 'HMAC-SHA256 hexadécimal du corps brut (en-tête x-mosolo-signature)', secretVariable: 'SVI_GATEWAY_SECRET', group: 'sms-ussd' },
  { id: 'whatsapp', label: 'WhatsApp — messages entrants', method: 'POST', path: '/v1/whatsapp/webhook', signature: 'HMAC-SHA256 du corps brut, en-tête x-hub-signature-256 « sha256=<hex> »', secretVariable: 'WHATSAPP_APP_SECRET', group: 'whatsapp' },
  { id: 'whatsapp-verify', label: 'WhatsApp — vérification de l’abonnement', method: 'GET', path: '/v1/whatsapp/webhook', signature: 'Jeton hub.verify_token comparé en temps constant', secretVariable: 'WHATSAPP_VERIFY_TOKEN', group: 'whatsapp' },
];
