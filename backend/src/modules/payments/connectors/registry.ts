/**
 * Registre des connecteurs, construit à partir des variables d'environnement (secrets côté serveur uniquement).
 * Sans clé API : mode SANDBOX_LOCAL (aucun appel réseau, intention simulée `sbx_…`) et, EN MODE DÉMONSTRATION
 * SEULEMENT, secret de webhook de démonstration, afin que la démo et les tests puissent signer des webhooks.
 * Hors démonstration, un connecteur sans secret de webhook réel n'est PAS enregistré (aucun webhook accepté) et un
 * secret égal à la valeur publique de démonstration est refusé au démarrage. En mode TEST/LIVE, le secret de
 * webhook est obligatoire.
 * Doctrine : `settlementAccountAlias` DOIT être un alias du coffre — sinon le démarrage échoue.
 *
 * Console « Clés et raccordements » (29/09/2026) : le registre peut être rattaché à une SOURCE de configuration
 * (`attachSource`) — variables d'environnement complétées par les valeurs approuvées à deux personnes dans la console.
 * À chaque accès, si l'empreinte de la configuration a changé, les connecteurs sont reconstruits SANS redémarrage ; une
 * configuration invalide ne remplace jamais les connecteurs en service (erreur exposée, sans valeur).
 */
import { BitriPayConnector, BITRIPAY_DEFAULT_BASE_URL, BITRIPAY_DEMO_WEBHOOK_SECRET, BITRIPAY_OPERATORS } from './bitripay.js';
import { KodaConnector, KODA_DEFAULT_BASE_URL, KODA_DEMO_WEBHOOK_SECRET, type ConnectorRuntime } from './koda.js';
import { isDemoMode, isProduction } from '../../../core/auth.js';
import { ConnectorConfigError, CONNECTOR_IDS, type ConnectorId, type PaymentConnector } from './types.js';

/** Alias par défaut : compte de recettes DGIPK de démonstration (voir seed.ts). */
export const DEFAULT_SETTLEMENT_ACCOUNT_ALIAS = 'KIN-DGIPK-RECETTES-01';
/** URL de retour de démonstration (portail local). En mode réel, KODA_SUCCESS_URL est obligatoire : aucun domaine n'est présumé. */
export const DEFAULT_KODA_SUCCESS_URL = 'http://localhost:5173/espace';
/** Page de retour MOSOLO après la page de paiement du prestataire (29/09/2026) : état RÉEL lu à l'API, jamais l'URL. */
export const RETURN_PATH = '/paiement/retour';
/** Retour de démonstration (portail local) quand MOSOLO_PUBLIC_URL est absente. */
export const DEFAULT_RETURN_URL = `http://localhost:5173${RETURN_PATH}`;

/** URL de retour vers MOSOLO construite depuis MOSOLO_PUBLIC_URL (https, ou boucle locale en essai) ; sinon undefined. */
export function returnUrlFrom(env: Record<string, string | undefined>): string | undefined {
  const raw = env.MOSOLO_PUBLIC_URL?.trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return undefined;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}${RETURN_PATH}`;
  } catch {
    return undefined;
  }
}

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
    { name: 'BITRIPAY_API_KEY', secret: true, requiredForReal: true, role: 'Clé secrète sk_test_… / sk_live_…, ou clé restreinte rk_… (portées payment_intents:write, payment_intents:read, verifications:write) — serveur uniquement' },
    { name: 'BITRIPAY_WEBHOOK_SECRET', secret: true, requiredForReal: true, role: 'Secret whsec_… du point de terminaison de webhook (HMAC)' },
    { name: 'BITRIPAY_ED25519_PUBLIC_KEY', secret: false, requiredForReal: false, role: 'Clé publique Ed25519 de la plateforme (GET /v1/keys), épinglée' },
    { name: 'BITRIPAY_HMAC_REQUIRED', secret: false, requiredForReal: false, role: 'Exiger la signature HMAC (défaut : true)' },
    { name: 'BITRIPAY_ED25519_REQUIRED', secret: false, requiredForReal: false, role: 'Exiger la signature Ed25519 (défaut : true dès qu’une clé BitriPay est configurée — décision du 29/09/2026)' },
    { name: 'BITRIPAY_BASE_URL', secret: false, requiredForReal: false, role: `URL de l'API (défaut : ${BITRIPAY_DEFAULT_BASE_URL})` },
    { name: 'BITRIPAY_SETTLEMENT_ACCOUNT_ALIAS', secret: false, requiredForReal: true, role: 'Alias du compte public de règlement, inscrit au coffre' },
    { name: 'BITRIPAY_SETTLEMENT_ACCOUNT_ALIASES', secret: false, requiredForReal: false, role: 'Autres comptes publics de règlement (un par régie), séparés par des virgules, inscrits au coffre' },
    { name: 'BITRIPAY_ALLOWED_OPERATORS', secret: false, requiredForReal: false, role: 'Opérateurs proposés (défaut : orange_cd, mpesa_cd, airtel_cd, africell_cd)' },
    { name: 'BITRIPAY_ACCOUNT_ID', secret: false, requiredForReal: false, role: 'Compte connecté acct_… de la Ville (clé d’intégrateur seulement)' },
    { name: 'BITRIPAY_CDF_EXPONENT', secret: false, requiredForReal: false, role: 'Décimales du CDF chez BitriPay : 0 ou 2 (défaut 2, à confirmer)' },
    { name: 'BITRIPAY_RETURN_URL_FIELD', secret: false, requiredForReal: false, role: 'Champ d’URL de retour SUPPLÉMENTAIRE (ancien paramétrage) : success_url et cancel_url sont désormais toujours envoyés (OpenAPI 2026-09-01)' },
    { name: 'BITRIPAY_RESOLUTION_CHECK', secret: false, requiredForReal: false, role: 'Confirmation supplémentaire par GET /payment_resolution avant quittance (défaut : true)' },
  ],
  koda: [
    { name: 'KODA_API_KEY', secret: true, requiredForReal: true, role: 'Clé secrète sk_… (serveur uniquement)' },
    { name: 'KODA_WEBHOOK_SECRET', secret: true, requiredForReal: true, role: 'Secret HMAC des webhooks' },
    { name: 'KODA_BASE_URL', secret: false, requiredForReal: false, role: `URL de l'API (défaut : ${KODA_DEFAULT_BASE_URL})` },
    { name: 'KODA_SETTLEMENT_ACCOUNT_ALIAS', secret: false, requiredForReal: true, role: 'Alias du compte public de règlement, inscrit au coffre' },
    { name: 'KODA_SETTLEMENT_ACCOUNT_ALIASES', secret: false, requiredForReal: false, role: 'Autres comptes publics de réception (un par régie), séparés par des virgules, inscrits au coffre' },
    { name: 'KODA_OPERATORS', secret: false, requiredForReal: false, role: 'Opérateurs proposés (défaut : orange_cd, mpesa_cd, airtel_cd, africell_cd — tous les opérateurs congolais ; codes à confirmer auprès de KODA)' },
    { name: 'KODA_SUCCESS_URL', secret: false, requiredForReal: false, role: 'URL de retour du portail officiel (sans valeur probante) ; à défaut : MOSOLO_PUBLIC_URL + /paiement/retour' },
  ],
};

/** Présence (jamais la valeur) des variables d'un prestataire, et état de la configuration. */
export interface ProviderSetup {
  id: ConnectorId;
  label: string;
  variables: { name: string; present: boolean; secret: boolean; requiredForReal: boolean; role: string; source?: 'ENVIRONNEMENT' | 'CONSOLE' | 'ABSENTE' }[];
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

/** Source de configuration vivante (console « Clés et raccordements ») : variables résolues et empreinte. */
export interface ConnectorConfigSource {
  /** Variables résolues (environnement prioritaire, valeur approuvée de la console à défaut). */
  env(): Record<string, string | undefined>;
  /** Empreinte des valeurs de la console : tout changement déclenche une reconstruction. */
  fingerprint(): string;
  runtime: ConnectorRuntime;
  /** Source active de chaque variable (affichage) ; absente : environnement. */
  sourceOf?(name: string): 'ENVIRONNEMENT' | 'CONSOLE' | 'ABSENTE';
}

export class ConnectorRegistry {
  private connectors = new Map<ConnectorId, PaymentConnector>();
  /** État de raccordement par prestataire (noms de variables et présence seulement). */
  private setupState: ProviderSetup[] = [];
  /** Mode démonstration au moment de la construction (bac à sable local admis pour les confirmations). */
  demoMode = false;
  /**
   * Comptes publics de règlement ADDITIONNELS par passerelle (30/09/2026) : un compte de réception par régie (DGIPK,
   * DGTK…). La doctrine reste entière : le paiement ne va qu'au compte public bénéficiaire de l'obligation, et chaque
   * alias doit exister au coffre (démarrage refusé sinon). Variables <PRESTATAIRE>_SETTLEMENT_ACCOUNT_ALIASES.
   */
  extraSettlementAliases = new Map<ConnectorId, string[]>();
  private demoSettlementAliases = new Map<ConnectorId, string[]>();
  private source?: ConnectorConfigSource;
  private builtFingerprint = '';
  /** Dernière reconstruction refusée (configuration invalide) : message sans valeur ; null si tout va bien. */
  configError: string | null = null;
  /** Nombre de reconstructions à chaud réussies (console) et date de la dernière. */
  reloads = 0;
  lastReloadAt: string | null = null;

  constructor(connectors: PaymentConnector[]) {
    for (const c of connectors) this.connectors.set(c.id, c);
  }

  get setup(): ProviderSetup[] {
    this.refresh();
    return this.setupState;
  }

  set setup(v: ProviderSetup[]) {
    this.setupState = v;
  }

  /**
   * Rattache la source vivante (console) : l'empreinte courante est retenue, la reconstruction n'aura lieu qu'au
   * prochain changement approuvé (ou après restauration de la persistance).
   */
  attachSource(source: ConnectorConfigSource): void {
    this.source = source;
    this.builtFingerprint = source.fingerprint();
    this.setupState = this.withSources(this.setupState);
  }

  private withSources(setup: ProviderSetup[]): ProviderSetup[] {
    const sourceOf = this.source?.sourceOf;
    if (!sourceOf) return setup;
    return setup.map((s) => ({ ...s, variables: s.variables.map((v) => ({ ...v, source: sourceOf(v.name) })) }));
  }

  /** Reconstruction à chaud si la configuration de la console a changé ; en cas d'erreur, les connecteurs restent. */
  refresh(): void {
    if (!this.source) return;
    const fp = this.source.fingerprint();
    if (fp === this.builtFingerprint) return;
    this.builtFingerprint = fp;
    try {
      const env = this.source.env();
      const next = buildConnectorRegistry(env, this.source.runtime, this.demoMode);
      if (this.aliasCheck) next.validate(this.aliasCheck);
      this.connectors = next.connectors;
      this.extraSettlementAliases = next.extraSettlementAliases;
      this.setupState = this.withSources(next.setupState);
      this.configError = null;
      this.reloads += 1;
      this.lastReloadAt = new Date(this.source.runtime.now ? this.source.runtime.now() : Date.now()).toISOString();
    } catch (e) {
      // Jamais la valeur : les messages de configuration ne nomment que des variables (voir ConnectorConfigError).
      // Même une valeur masquée (« reçu sk_…a1b2 ») est retirée du message affiché.
      this.configError = e instanceof Error ? e.message.replace(/\(reçu [^)]*\)/g, '(valeur non affichée)') : 'Configuration invalide.';
    }
  }

  get(id: string): PaymentConnector | undefined {
    this.refresh();
    return (CONNECTOR_IDS as readonly string[]).includes(id) ? this.connectors.get(id as ConnectorId) : undefined;
  }

  list(): PaymentConnector[] {
    this.refresh();
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
    for (const [id, aliases] of this.extraSettlementAliases) {
      for (const a of aliases) if (!aliasExists(a)) throw new ConnectorConfigError(`${id} : l'alias de compte de règlement « ${a} » n'existe pas dans le coffre.`);
    }
    // Démonstration : comptes publics de démonstration des autres régies, retenus seulement s'ils existent au coffre.
    for (const [id, aliases] of this.demoSettlementAliases) {
      const ok = aliases.filter((a) => aliasExists(a));
      if (ok.length) this.extraSettlementAliases.set(id, [...new Set([...(this.extraSettlementAliases.get(id) ?? []), ...ok])]);
    }
    for (const c of this.connectors.values()) {
      if (!c.settlementAccountAlias || !aliasExists(c.settlementAccountAlias)) {
        throw new ConnectorConfigError(
          `${c.label} : l'alias de compte de règlement « ${c.settlementAccountAlias} » n'existe pas dans le coffre. ` +
            'MOSOLO ne détient jamais les fonds : le règlement doit aller au compte public désigné.',
        );
      }
    }
  }

  setDemoSettlementAliases(id: ConnectorId, aliases: string[]): void { this.demoSettlementAliases.set(id, aliases); }

  /** Comptes publics où la passerelle peut régler : l'alias principal et les alias additionnels. */
  settlementAliases(id: ConnectorId): string[] {
    const c = this.connectors.get(id);
    return c ? [...new Set([c.settlementAccountAlias, ...(this.extraSettlementAliases.get(id) ?? [])])] : [];
  }

  /** Vue masquée (aucun secret). */
  describe(): Record<string, unknown>[] {
    return this.list().map((c) => c.describe());
  }
}

export function buildConnectorRegistry(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env, runtime: ConnectorRuntime = {}, demoMode = isDemoMode()): ConnectorRegistry {
  // Retour navigateur : KODA_SUCCESS_URL explicite, sinon la page MOSOLO « /paiement/retour » (MOSOLO_PUBLIC_URL).
  const returnUrl = returnUrlFrom(env);
  if (env.KODA_API_KEY && !env.KODA_SUCCESS_URL && !returnUrl) {
    throw new ConnectorConfigError('KODA_SUCCESS_URL est obligatoire en mode réel (URL de retour du portail officiel, à fournir par la Ville) — ou MOSOLO_PUBLIC_URL, qui donne la page de retour /paiement/retour.');
  }
  // Configurations partielles refusées au démarrage, avec un message nommant la variable manquante.
  if (env.BITRIPAY_ACCOUNT_ID && !env.BITRIPAY_API_KEY && !demoMode) {
    throw new ConnectorConfigError('BITRIPAY_ACCOUNT_ID fourni sans BITRIPAY_API_KEY : configuration partielle (le compte connecté n’a de sens qu’avec la clé de l’intégrateur).');
  }
  const kodaLive = /^sk_live_/.test(env.KODA_API_KEY ?? '');
  const bitriLive = /^(sk|rk)_live_/.test(env.BITRIPAY_API_KEY ?? '');
  if (env.KODA_API_KEY) {
    checkUrl('KODA', 'KODA_BASE_URL', env.KODA_BASE_URL || KODA_DEFAULT_BASE_URL, kodaLive);
    if (env.KODA_SUCCESS_URL) checkUrl('KODA', 'KODA_SUCCESS_URL', env.KODA_SUCCESS_URL, kodaLive);
    else checkUrl('KODA', 'MOSOLO_PUBLIC_URL', returnUrl!, kodaLive);
  }
  if (env.BITRIPAY_API_KEY) checkUrl('BitriPay', 'BITRIPAY_BASE_URL', env.BITRIPAY_BASE_URL || BITRIPAY_DEFAULT_BASE_URL, bitriLive);
  const kodaSecret = webhookSecret('KODA', env.KODA_API_KEY, env.KODA_WEBHOOK_SECRET, KODA_DEMO_WEBHOOK_SECRET, demoMode);
  const koda = kodaSecret === undefined ? null : new KodaConnector(
    {
      ...(env.KODA_API_KEY ? { apiKey: env.KODA_API_KEY } : {}),
      webhookSecret: kodaSecret,
      baseUrl: env.KODA_BASE_URL || KODA_DEFAULT_BASE_URL,
      settlementAccountAlias: env.KODA_SETTLEMENT_ACCOUNT_ALIAS || DEFAULT_SETTLEMENT_ACCOUNT_ALIAS,
      // KODA fonctionne avec tous les opérateurs congolais (maître d'ouvrage, 30/09/2026) : Orange, M-Pesa, Airtel, Africell ;
      // codes repris de BitriPay — à confirmer auprès de KODA.
      operators: list(env.KODA_OPERATORS, ['orange_cd', 'mpesa_cd', 'airtel_cd', 'africell_cd']),
      successUrl: env.KODA_SUCCESS_URL || returnUrl || DEFAULT_RETURN_URL,
    },
    runtime,
  );
  const cdf = env.BITRIPAY_CDF_EXPONENT === undefined || env.BITRIPAY_CDF_EXPONENT === '' ? 2 : Number(env.BITRIPAY_CDF_EXPONENT);
  if (cdf !== 0 && cdf !== 2) throw new ConnectorConfigError('BITRIPAY_CDF_EXPONENT doit valoir 0 ou 2.');
  const bitripaySecret = webhookSecret('BitriPay', env.BITRIPAY_API_KEY, env.BITRIPAY_WEBHOOK_SECRET, BITRIPAY_DEMO_WEBHOOK_SECRET, demoMode);
  // Parcours confirmé par BitriPay (29/09/2026) : les DEUX signatures (HMAC et Ed25519 de la plateforme) sont vérifiées.
  // Décision du maître d'ouvrage (29/09/2026) : la signature Ed25519 est EXIGÉE PARTOUT dès qu'une clé BitriPay est
  // configurée (test ou réelle, quel que soit l'environnement) ; seule la démonstration sans clé (simulateur) en est
  // dispensée. L'ancienne règle (production + clé réelle) reste couverte ; BITRIPAY_ED25519_REQUIRED=false l'écarte
  // explicitement (à justifier).
  const bitriEdDefault = (isProduction(process.env) && bitriLive) || !!env.BITRIPAY_API_KEY;
  const bitripay = bitripaySecret === undefined ? null : new BitriPayConnector(
    {
      ...(env.BITRIPAY_API_KEY ? { apiKey: env.BITRIPAY_API_KEY } : {}),
      webhookSecret: bitripaySecret,
      ...(env.BITRIPAY_ED25519_PUBLIC_KEY ? { ed25519PublicKey: env.BITRIPAY_ED25519_PUBLIC_KEY } : {}),
      hmacRequired: bool(env.BITRIPAY_HMAC_REQUIRED, true),
      ed25519Required: bool(env.BITRIPAY_ED25519_REQUIRED, bitriEdDefault),
      baseUrl: env.BITRIPAY_BASE_URL || BITRIPAY_DEFAULT_BASE_URL,
      settlementAccountAlias: env.BITRIPAY_SETTLEMENT_ACCOUNT_ALIAS || DEFAULT_SETTLEMENT_ACCOUNT_ALIAS,
      cdfExponent: cdf,
      allowedOperators: list(env.BITRIPAY_ALLOWED_OPERATORS, BITRIPAY_OPERATORS),
      ...(env.BITRIPAY_ACCOUNT_ID ? { connectedAccountId: env.BITRIPAY_ACCOUNT_ID } : {}),
      // OpenAPI 2026-09-01 : success_url / cancel_url documentés ⇒ la page de retour MOSOLO est toujours transmise.
      returnUrl: returnUrl ?? DEFAULT_RETURN_URL,
      ...(env.BITRIPAY_RETURN_URL_FIELD ? { returnUrlField: env.BITRIPAY_RETURN_URL_FIELD } : {}),
      resolutionCheck: bool(env.BITRIPAY_RESOLUTION_CHECK, true),
    },
    runtime,
  );
  const registry = new ConnectorRegistry([bitripay, koda].filter((c): c is BitriPayConnector | KodaConnector => c !== null));
  registry.demoMode = demoMode;
  for (const [id, v] of [['bitripay', env.BITRIPAY_SETTLEMENT_ACCOUNT_ALIASES], ['koda', env.KODA_SETTLEMENT_ACCOUNT_ALIASES]] as const) {
    if (v) registry.extraSettlementAliases.set(id, list(v, []));
    // Démonstration sans liste explicite : les comptes de démonstration des deux régies (DGIPK et DGTK).
    else if (demoMode) registry.setDemoSettlementAliases(id, [DEFAULT_SETTLEMENT_ACCOUNT_ALIAS, 'KIN-DGTK-RECETTES-01']);
  }
  registry.setup = CONNECTOR_IDS.map((id) => describeSetup(id, env, registry.get(id) !== undefined, demoMode));
  return registry;
}

/** Variables de TOUS les prestataires connectés (inventaire de la console « Clés et raccordements »). */
export function allProviderEnvVarNames(): string[] {
  return CONNECTOR_IDS.flatMap((id) => PROVIDER_ENV_VARS[id].map((v) => v.name));
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
