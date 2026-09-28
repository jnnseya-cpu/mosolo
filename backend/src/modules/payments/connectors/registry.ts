/**
 * Registre des connecteurs, construit à partir des variables d'environnement (secrets côté serveur uniquement).
 * Sans clé API : mode SANDBOX_LOCAL (aucun appel réseau, intention simulée `sbx_…`) et, EN MODE DÉMONSTRATION
 * SEULEMENT, secret de webhook de démonstration, afin que la démo et les tests puissent signer des webhooks.
 * Hors démonstration, un connecteur sans secret de webhook réel n'est PAS enregistré (aucun webhook accepté) et un
 * secret égal à la valeur publique de démonstration est refusé au démarrage. En mode TEST/LIVE, le secret de
 * webhook est obligatoire.
 * Doctrine : `settlementAccountAlias` DOIT être un alias du coffre — sinon le démarrage échoue.
 */
import { BitriPayConnector, BITRIPAY_DEFAULT_BASE_URL, BITRIPAY_DEMO_WEBHOOK_SECRET, BITRIPAY_OPERATORS } from './bitripay.js';
import { KodaConnector, KODA_DEFAULT_BASE_URL, KODA_DEMO_WEBHOOK_SECRET, type ConnectorRuntime } from './koda.js';
import { isDemoMode } from '../../../core/auth.js';
import { ConnectorConfigError, CONNECTOR_IDS, type ConnectorId, type PaymentConnector } from './types.js';

/** Alias par défaut : compte de recettes DGIPK de démonstration (voir seed.ts). */
export const DEFAULT_SETTLEMENT_ACCOUNT_ALIAS = 'KIN-DGIPK-RECETTES-01';
/** URL de retour de démonstration (portail local). En mode réel, KODA_SUCCESS_URL est obligatoire : aucun domaine n'est présumé. */
export const DEFAULT_KODA_SUCCESS_URL = 'http://localhost:5173/espace';

function list(v: string | undefined, fallback: readonly string[]): string[] {
  const items = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : [...fallback];
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'oui', 'yes'].includes(v.toLowerCase());
}

/** Secret de webhook ; `undefined` : connecteur non configuré hors démonstration (il n'est pas enregistré). */
function webhookSecret(provider: string, apiKey: string | undefined, secret: string | undefined, demo: string, demoMode: boolean): string | undefined {
  if (secret) {
    if (!demoMode && secret === demo) throw new ConnectorConfigError(`${provider} : le secret de webhook de démonstration est public, il est refusé hors mode démonstration.`);
    // Avec une vraie clé API (test ou réel), le secret public de démonstration est refusé, même en démonstration.
    if (apiKey && secret === demo) throw new ConnectorConfigError(`${provider} : le secret de webhook de démonstration est public, il est refusé avec une clé API réelle.`);
    return secret;
  }
  if (apiKey) throw new ConnectorConfigError(`${provider} : secret de webhook obligatoire hors bac à sable local.`);
  return demoMode ? demo : undefined;
}

/** Variables d'environnement de chaque prestataire (noms seulement ; `secret` : valeur jamais affichée, ni masquée). */
export const PROVIDER_ENV_VARS: Record<ConnectorId, { name: string; secret: boolean; requiredForReal: boolean; role: string }[]> = {
  bitripay: [
    { name: 'BITRIPAY_API_KEY', secret: true, requiredForReal: true, role: 'Clé secrète sk_test_… / sk_live_… (serveur uniquement)' },
    { name: 'BITRIPAY_WEBHOOK_SECRET', secret: true, requiredForReal: true, role: 'Secret whsec_… du point de terminaison de webhook (HMAC)' },
    { name: 'BITRIPAY_ED25519_PUBLIC_KEY', secret: false, requiredForReal: false, role: 'Clé publique Ed25519 de la plateforme (GET /v1/keys), épinglée' },
    { name: 'BITRIPAY_HMAC_REQUIRED', secret: false, requiredForReal: false, role: 'Exiger la signature HMAC (défaut : true)' },
    { name: 'BITRIPAY_ED25519_REQUIRED', secret: false, requiredForReal: false, role: 'Exiger la signature Ed25519 (défaut : false)' },
    { name: 'BITRIPAY_BASE_URL', secret: false, requiredForReal: false, role: `URL de l'API (défaut : ${BITRIPAY_DEFAULT_BASE_URL})` },
    { name: 'BITRIPAY_SETTLEMENT_ACCOUNT_ALIAS', secret: false, requiredForReal: true, role: 'Alias du compte public de règlement, inscrit au coffre' },
    { name: 'BITRIPAY_ALLOWED_OPERATORS', secret: false, requiredForReal: false, role: 'Opérateurs proposés (défaut : orange_cd, mpesa_cd, airtel_cd, africell_cd)' },
    { name: 'BITRIPAY_ACCOUNT_ID', secret: false, requiredForReal: false, role: 'Compte connecté acct_… de la Ville (clé d’intégrateur seulement)' },
    { name: 'BITRIPAY_CDF_EXPONENT', secret: false, requiredForReal: false, role: 'Décimales du CDF chez BitriPay : 0 ou 2 (défaut 2, à confirmer)' },
  ],
  koda: [
    { name: 'KODA_API_KEY', secret: true, requiredForReal: true, role: 'Clé secrète sk_… (serveur uniquement)' },
    { name: 'KODA_WEBHOOK_SECRET', secret: true, requiredForReal: true, role: 'Secret HMAC des webhooks' },
    { name: 'KODA_BASE_URL', secret: false, requiredForReal: false, role: `URL de l'API (défaut : ${KODA_DEFAULT_BASE_URL})` },
    { name: 'KODA_SETTLEMENT_ACCOUNT_ALIAS', secret: false, requiredForReal: true, role: 'Alias du compte public de règlement, inscrit au coffre' },
    { name: 'KODA_OPERATORS', secret: false, requiredForReal: false, role: 'Opérateurs proposés (défaut : orange_cd, mpesa_cd)' },
    { name: 'KODA_SUCCESS_URL', secret: false, requiredForReal: true, role: 'URL de retour du portail officiel (sans valeur probante)' },
  ],
};

/** Présence (jamais la valeur) des variables d'un prestataire, et état de la configuration. */
export interface ProviderSetup {
  id: ConnectorId;
  label: string;
  variables: { name: string; present: boolean; secret: boolean; requiredForReal: boolean; role: string }[];
  /** NON_CONFIGURE : rien ; BAC_A_SABLE_DEMO : démonstration ; PARTIELLE : webhooks sans clé API (aucun paiement réel) ; COMPLETE : clé + secret. */
  configuration: 'NON_CONFIGURE' | 'BAC_A_SABLE_DEMO' | 'PARTIELLE' | 'COMPLETE';
  registered: boolean;
  /** Valeurs non secrètes affichables (URL, opérateurs, alias) — jamais une clé ni un secret. */
  publicValues: Record<string, string>;
}

/** Adresse https (ou boucle locale en http, pour les essais contre un simulateur local). */
function checkUrl(provider: string, name: string, url: string, live: boolean): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ConnectorConfigError(`${provider} : ${name} n'est pas une URL valide.`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol === 'https:') return;
  if (u.protocol === 'http:' && loopback && !live) return;
  throw new ConnectorConfigError(`${provider} : ${name} doit être en https${live ? '' : ' (http admis seulement vers la boucle locale, en clé de test)'}.`);
}

export class ConnectorRegistry {
  private readonly connectors = new Map<ConnectorId, PaymentConnector>();
  /** État de raccordement par prestataire (noms de variables et présence seulement). */
  setup: ProviderSetup[] = [];
  /** Mode démonstration au moment de la construction (bac à sable local admis pour les confirmations). */
  demoMode = false;

  constructor(connectors: PaymentConnector[]) {
    for (const c of connectors) this.connectors.set(c.id, c);
  }

  get(id: string): PaymentConnector | undefined {
    return (CONNECTOR_IDS as readonly string[]).includes(id) ? this.connectors.get(id as ConnectorId) : undefined;
  }

  list(): PaymentConnector[] {
    return [...this.connectors.values()];
  }

  private aliasCheck?: (alias: string) => boolean;

  /** Alias présent dans le coffre (après validation au démarrage). */
  validAlias(alias: string): boolean {
    return this.aliasCheck ? this.aliasCheck(alias) : false;
  }

  /** Validation au démarrage : chaque alias de règlement doit exister dans le coffre. */
  validate(aliasExists: (alias: string) => boolean): void {
    this.aliasCheck = aliasExists;
    for (const c of this.connectors.values()) {
      if (!c.settlementAccountAlias || !aliasExists(c.settlementAccountAlias)) {
        throw new ConnectorConfigError(
          `${c.label} : l'alias de compte de règlement « ${c.settlementAccountAlias} » n'existe pas dans le coffre. ` +
            'MOSOLO ne détient jamais les fonds : le règlement doit aller au compte public désigné.',
        );
      }
    }
  }

  /** Vue masquée (aucun secret). */
  describe(): Record<string, unknown>[] {
    return this.list().map((c) => c.describe());
  }
}

export function buildConnectorRegistry(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env, runtime: ConnectorRuntime = {}, demoMode = isDemoMode()): ConnectorRegistry {
  if (env.KODA_API_KEY && !env.KODA_SUCCESS_URL) {
    throw new ConnectorConfigError('KODA_SUCCESS_URL est obligatoire en mode réel (URL de retour du portail officiel, à fournir par la Ville).');
  }
  // Configurations partielles refusées au démarrage, avec un message nommant la variable manquante.
  if (env.BITRIPAY_ACCOUNT_ID && !env.BITRIPAY_API_KEY && !demoMode) {
    throw new ConnectorConfigError('BITRIPAY_ACCOUNT_ID fourni sans BITRIPAY_API_KEY : configuration partielle (le compte connecté n’a de sens qu’avec la clé de l’intégrateur).');
  }
  const kodaLive = /^sk_live_/.test(env.KODA_API_KEY ?? '');
  const bitriLive = /^sk_live_/.test(env.BITRIPAY_API_KEY ?? '');
  if (env.KODA_API_KEY) {
    checkUrl('KODA', 'KODA_BASE_URL', env.KODA_BASE_URL || KODA_DEFAULT_BASE_URL, kodaLive);
    checkUrl('KODA', 'KODA_SUCCESS_URL', env.KODA_SUCCESS_URL!, kodaLive);
  }
  if (env.BITRIPAY_API_KEY) checkUrl('BitriPay', 'BITRIPAY_BASE_URL', env.BITRIPAY_BASE_URL || BITRIPAY_DEFAULT_BASE_URL, bitriLive);
  const kodaSecret = webhookSecret('KODA', env.KODA_API_KEY, env.KODA_WEBHOOK_SECRET, KODA_DEMO_WEBHOOK_SECRET, demoMode);
  const koda = kodaSecret === undefined ? null : new KodaConnector(
    {
      ...(env.KODA_API_KEY ? { apiKey: env.KODA_API_KEY } : {}),
      webhookSecret: kodaSecret,
      baseUrl: env.KODA_BASE_URL || KODA_DEFAULT_BASE_URL,
      settlementAccountAlias: env.KODA_SETTLEMENT_ACCOUNT_ALIAS || DEFAULT_SETTLEMENT_ACCOUNT_ALIAS,
      operators: list(env.KODA_OPERATORS, ['orange_cd', 'mpesa_cd']),
      successUrl: env.KODA_SUCCESS_URL || DEFAULT_KODA_SUCCESS_URL,
    },
    runtime,
  );
  const cdf = env.BITRIPAY_CDF_EXPONENT === undefined || env.BITRIPAY_CDF_EXPONENT === '' ? 2 : Number(env.BITRIPAY_CDF_EXPONENT);
  if (cdf !== 0 && cdf !== 2) throw new ConnectorConfigError('BITRIPAY_CDF_EXPONENT doit valoir 0 ou 2.');
  const bitripaySecret = webhookSecret('BitriPay', env.BITRIPAY_API_KEY, env.BITRIPAY_WEBHOOK_SECRET, BITRIPAY_DEMO_WEBHOOK_SECRET, demoMode);
  const bitripay = bitripaySecret === undefined ? null : new BitriPayConnector(
    {
      ...(env.BITRIPAY_API_KEY ? { apiKey: env.BITRIPAY_API_KEY } : {}),
      webhookSecret: bitripaySecret,
      ...(env.BITRIPAY_ED25519_PUBLIC_KEY ? { ed25519PublicKey: env.BITRIPAY_ED25519_PUBLIC_KEY } : {}),
      hmacRequired: bool(env.BITRIPAY_HMAC_REQUIRED, true),
      ed25519Required: bool(env.BITRIPAY_ED25519_REQUIRED, false),
      baseUrl: env.BITRIPAY_BASE_URL || BITRIPAY_DEFAULT_BASE_URL,
      settlementAccountAlias: env.BITRIPAY_SETTLEMENT_ACCOUNT_ALIAS || DEFAULT_SETTLEMENT_ACCOUNT_ALIAS,
      cdfExponent: cdf,
      allowedOperators: list(env.BITRIPAY_ALLOWED_OPERATORS, BITRIPAY_OPERATORS),
      ...(env.BITRIPAY_ACCOUNT_ID ? { connectedAccountId: env.BITRIPAY_ACCOUNT_ID } : {}),
    },
    runtime,
  );
  const registry = new ConnectorRegistry([bitripay, koda].filter((c): c is BitriPayConnector | KodaConnector => c !== null));
  registry.demoMode = demoMode;
  registry.setup = CONNECTOR_IDS.map((id) => describeSetup(id, env, registry.get(id) !== undefined, demoMode));
  return registry;
}

function describeSetup(id: ConnectorId, env: Record<string, string | undefined>, registered: boolean, demoMode: boolean): ProviderSetup {
  const vars = PROVIDER_ENV_VARS[id];
  const variables = vars.map((v) => ({ ...v, present: !!env[v.name] }));
  const key = id === 'koda' ? 'KODA_API_KEY' : 'BITRIPAY_API_KEY';
  const secret = id === 'koda' ? 'KODA_WEBHOOK_SECRET' : 'BITRIPAY_WEBHOOK_SECRET';
  const configuration: ProviderSetup['configuration'] = env[key] && env[secret] ? 'COMPLETE'
    : env[secret] ? 'PARTIELLE' : registered && demoMode ? 'BAC_A_SABLE_DEMO' : 'NON_CONFIGURE';
  const publicValues: Record<string, string> = {};
  for (const v of vars) if (!v.secret && env[v.name]) publicValues[v.name] = env[v.name]!;
  return { id, label: id === 'koda' ? 'KODA' : 'BitriPay', variables, configuration, registered, publicValues };
}
