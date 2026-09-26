/**
 * Registre des connecteurs, construit à partir des variables d'environnement (secrets côté serveur uniquement).
 * Sans clé API : mode SANDBOX_LOCAL (aucun appel réseau, intention simulée `sbx_…`) et secret de webhook de
 * démonstration, afin que la démo et les tests puissent signer des webhooks. En mode TEST/LIVE, le secret de
 * webhook est obligatoire (jamais le secret de démonstration).
 * Doctrine : `settlementAccountAlias` DOIT être un alias du coffre — sinon le démarrage échoue.
 */
import { BitriPayConnector, BITRIPAY_DEFAULT_BASE_URL, BITRIPAY_DEMO_WEBHOOK_SECRET, BITRIPAY_OPERATORS } from './bitripay.js';
import { KodaConnector, KODA_DEFAULT_BASE_URL, KODA_DEMO_WEBHOOK_SECRET, type ConnectorRuntime } from './koda.js';
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

function webhookSecret(provider: string, apiKey: string | undefined, secret: string | undefined, demo: string): string {
  if (secret) return secret;
  if (apiKey) throw new ConnectorConfigError(`${provider} : secret de webhook obligatoire hors bac à sable local.`);
  return demo;
}

export class ConnectorRegistry {
  private readonly connectors = new Map<ConnectorId, PaymentConnector>();

  constructor(connectors: PaymentConnector[]) {
    for (const c of connectors) this.connectors.set(c.id, c);
  }

  get(id: string): PaymentConnector | undefined {
    return (CONNECTOR_IDS as readonly string[]).includes(id) ? this.connectors.get(id as ConnectorId) : undefined;
  }

  list(): PaymentConnector[] {
    return [...this.connectors.values()];
  }

  /** Validation au démarrage : chaque alias de règlement doit exister dans le coffre. */
  validate(aliasExists: (alias: string) => boolean): void {
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

export function buildConnectorRegistry(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env, runtime: ConnectorRuntime = {}): ConnectorRegistry {
  if (env.KODA_API_KEY && !env.KODA_SUCCESS_URL) {
    throw new ConnectorConfigError('KODA_SUCCESS_URL est obligatoire en mode réel (URL de retour du portail officiel, à fournir par la Ville).');
  }
  const koda = new KodaConnector(
    {
      ...(env.KODA_API_KEY ? { apiKey: env.KODA_API_KEY } : {}),
      webhookSecret: webhookSecret('KODA', env.KODA_API_KEY, env.KODA_WEBHOOK_SECRET, KODA_DEMO_WEBHOOK_SECRET),
      baseUrl: env.KODA_BASE_URL || KODA_DEFAULT_BASE_URL,
      settlementAccountAlias: env.KODA_SETTLEMENT_ACCOUNT_ALIAS || DEFAULT_SETTLEMENT_ACCOUNT_ALIAS,
      operators: list(env.KODA_OPERATORS, ['orange_cd', 'mpesa_cd']),
      successUrl: env.KODA_SUCCESS_URL || DEFAULT_KODA_SUCCESS_URL,
    },
    runtime,
  );
  const cdf = env.BITRIPAY_CDF_EXPONENT === undefined || env.BITRIPAY_CDF_EXPONENT === '' ? 2 : Number(env.BITRIPAY_CDF_EXPONENT);
  if (cdf !== 0 && cdf !== 2) throw new ConnectorConfigError('BITRIPAY_CDF_EXPONENT doit valoir 0 ou 2.');
  const bitripay = new BitriPayConnector(
    {
      ...(env.BITRIPAY_API_KEY ? { apiKey: env.BITRIPAY_API_KEY } : {}),
      webhookSecret: webhookSecret('BitriPay', env.BITRIPAY_API_KEY, env.BITRIPAY_WEBHOOK_SECRET, BITRIPAY_DEMO_WEBHOOK_SECRET),
      ...(env.BITRIPAY_ED25519_PUBLIC_KEY ? { ed25519PublicKey: env.BITRIPAY_ED25519_PUBLIC_KEY } : {}),
      hmacRequired: bool(env.BITRIPAY_HMAC_REQUIRED, true),
      ed25519Required: bool(env.BITRIPAY_ED25519_REQUIRED, false),
      baseUrl: env.BITRIPAY_BASE_URL || BITRIPAY_DEFAULT_BASE_URL,
      settlementAccountAlias: env.BITRIPAY_SETTLEMENT_ACCOUNT_ALIAS || DEFAULT_SETTLEMENT_ACCOUNT_ALIAS,
      cdfExponent: cdf,
      allowedOperators: list(env.BITRIPAY_ALLOWED_OPERATORS, BITRIPAY_OPERATORS),
    },
    runtime,
  );
  return new ConnectorRegistry([bitripay, koda]);
}
