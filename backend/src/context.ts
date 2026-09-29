/** Composition des modules (monolithe modulaire) : chaque domaine est un service aux frontières explicites. */
import type { KeyObject } from 'node:crypto';
import type { Channel } from '@mosolo/shared';
import { AuditLog } from './core/audit.js';
import { ConfigurationError, isDemoMode, UserDirectory } from './core/auth.js';
import { kinshasaDate, systemClock, type Clock } from './core/clock.js';
import { randomSecret } from './core/crypto.js';
import { IdempotencyStore } from './core/idempotency.js';
import { AIService } from './modules/ai/service.js';
import { DeterministicRuleProvider, type AIDataSnapshot, type AIProvider } from './modules/ai/provider.js';
import { AlertService } from './modules/alerts/service.js';
import { AppealService } from './modules/appeals/service.js';
import { AssessmentService } from './modules/assessment/service.js';
import { CommunicationService } from './modules/communications/service.js';
import { communeBreakdown, tiles, LADDER_EXAMPLE } from './modules/dashboards/example-data.js';
import { DashboardService } from './modules/dashboards/service.js';
import { DraftService } from './modules/drafts/service.js';
import { FieldService } from './modules/field/service.js';
import { FxService } from './modules/fx/service.js';
import { TaxpayerService } from './modules/identity/service.js';
import { CompteUniqueRegistry } from './modules/identity/compte-unique.js';
import { registerSocleContributions } from './modules/identity/compte-unique-socle.js';
import { ObjectService } from './modules/objects/service.js';
import type { ConnectorRuntime } from './modules/payments/connectors/koda.js';
import { buildConnectorRegistry } from './modules/payments/connectors/registry.js';
import { DEFAULT_KEY_ID, parseProviderKeyRing, type ProviderKey } from './modules/payments/callback-signing.js';
import { PaymentService } from './modules/payments/service.js';
import { loadReceiptSigningKey, loadReceiptVerificationKeys, ReceiptService } from './modules/receipts/service.js';
import { RuleService } from './modules/rules/service.js';
import { LedgerService } from './modules/treasury/ledger.js';
import { TreasuryService } from './modules/treasury/service.js';
import { VaultService } from './modules/vault/service.js';
import { Money } from '@mosolo/shared';
import type { MosoloPlugin } from './plugins/types.js';

export interface Secrets {
  /** Clé HMAC de signature du journal d'audit (production : HSM). */
  auditHmacKey: string;
  /** Secret HMAC COURANT par prestataire de paiement habilité (habilitation : absent ⇒ rappels refusés). */
  providerSecrets: Record<string, string>;
  /** Trousseaux de rotation (kid → secret) : clés encore acceptées en vérification, la première étant la courante. */
  providerKeyRings?: Record<string, ProviderKey[]>;
  /** Clés des fournisseurs de communication ; canal absent ⇒ bac à sable (« journalise »). */
  commsProviderKeys: Partial<Record<Channel, string>>;
  /** Clés HMAC des terminaux terrain enrôlés (démo). */
  deviceKeys: Record<string, string>;
  /** Clé privée Ed25519 de signature des quittances ; générée au démarrage si absente. */
  receiptSigningKey?: KeyObject;
  /** Clés publiques Ed25519 retirées, encore acceptées pour vérifier les quittances déjà émises (rotation). */
  receiptVerificationKeys?: KeyObject[];
}

/** Prestataires habilités : variable d'environnement du secret HMAC et valeur PUBLIQUE de démonstration. */
const PROVIDER_SECRET_VARS: Record<string, { env: string; demo: string }> = {
  'mm-operator-a': { env: 'MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A', demo: 'demo-secret-mm-operator-a' },
  'bank-a': { env: 'MOSOLO_PROVIDER_SECRET_BANK_A', demo: 'demo-secret-bank-a' },
  'card-gateway': { env: 'MOSOLO_PROVIDER_SECRET_CARD_GATEWAY', demo: 'demo-secret-card-gateway' },
};
/** Terminaux semés par les données de démonstration et leurs clés PUBLIQUES de démonstration. */
const DEMO_DEVICE_KEYS: Record<string, string> = {
  'dev-terrain-001': 'demo-device-key-001',
  'dev-terrain-002': 'demo-device-key-002',
  'dev-terrain-perdu': 'demo-device-key-perdu',
  'dev-canaux-enrol-01': 'demo-device-key-canaux-01',
  'dev-canaux-guichet-01': 'demo-device-key-canaux-02',
  'dev-rakapay-01': 'demo-device-key-rakapay-01',
};
const MIN_SECRET_LENGTH = 16;
/** Une valeur de démonstration est publique (dépôt, documentation) : elle ne vaut jamais secret hors démonstration. */
const isDemoValue = (v: string): boolean => /^demo-/i.test(v.trim()) || Object.values(PROVIDER_SECRET_VARS).some((p) => p.demo === v) || Object.values(DEMO_DEVICE_KEYS).includes(v);

/**
 * Trousseaux HMAC des prestataires. MOSOLO_PROVIDER_SECRET_<PRESTATAIRE> = secret seul (kid « default ») ou trousseau
 * « kid:secret[,kid:secret…] » (première clé = courante, suivantes acceptées en vérification pendant la rotation ; voir
 * modules/payments/callback-signing.ts). Démonstration : valeurs publiques par défaut. Hors démonstration : chaque clé
 * DOIT venir de l'environnement, sans valeur de démonstration et d'au moins 16 caractères — sinon le démarrage est
 * refusé (un rappel signé avec un secret public vaudrait quittance).
 */
export function providerKeyRingsFromEnv(env: NodeJS.ProcessEnv = process.env, demo = isDemoMode(env)): Record<string, ProviderKey[]> {
  const out: Record<string, ProviderKey[]> = {};
  const problems: string[] = [];
  for (const [provider, { env: name, demo: demoValue }] of Object.entries(PROVIDER_SECRET_VARS)) {
    let ring: ProviderKey[];
    try {
      ring = parseProviderKeyRing(env[name]);
    } catch (e) {
      problems.push(`${name} ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (demo) out[provider] = ring.length ? ring : [{ kid: DEFAULT_KEY_ID, secret: demoValue }];
    else if (!ring.length) problems.push(`${name} absente`);
    else if (ring.some((k) => isDemoValue(k.secret) || k.secret.length < MIN_SECRET_LENGTH)) problems.push(`${name} invalide (valeur de démonstration ou moins de ${MIN_SECRET_LENGTH} caractères)`);
    else out[provider] = ring;
  }
  if (problems.length) throw new ConfigurationError(`Secrets des prestataires de paiement : ${problems.join(' ; ')}. Hors mode démonstration, chaque secret doit être fourni par l’environnement.`);
  return out;
}

/** Secret COURANT de chaque prestataire (première clé de son trousseau). */
export function providerSecretsFromEnv(env: NodeJS.ProcessEnv = process.env, demo = isDemoMode(env)): Record<string, string> {
  return Object.fromEntries(Object.entries(providerKeyRingsFromEnv(env, demo)).map(([p, ring]) => [p, ring[0]!.secret]));
}

/**
 * Clés HMAC des terminaux : MOSOLO_DEVICE_KEYS=« id=clé,id=clé ». Démonstration : clés publiques par défaut.
 * Hors démonstration : jamais de clé publique ; un terminal semé sans clé fournie reçoit une clé aléatoire
 * (inutilisable tant qu'il n'est pas ré-enrôlé), de sorte qu'aucune clé de démonstration n'est jamais acceptée.
 */
export function deviceKeysFromEnv(env: NodeJS.ProcessEnv = process.env, demo = isDemoMode(env)): Record<string, string> {
  const given: Record<string, string> = {};
  for (const item of (env.MOSOLO_DEVICE_KEYS ?? '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const i = item.indexOf('=');
    if (i <= 0 || i === item.length - 1) throw new ConfigurationError('MOSOLO_DEVICE_KEYS : format attendu « identifiant=clé » séparés par des virgules.');
    const id = item.slice(0, i).trim();
    const key = item.slice(i + 1).trim();
    if (!demo && (isDemoValue(key) || key.length < MIN_SECRET_LENGTH)) {
      throw new ConfigurationError(`MOSOLO_DEVICE_KEYS : clé du terminal ${id} invalide (valeur de démonstration ou moins de ${MIN_SECRET_LENGTH} caractères).`);
    }
    given[id] = key;
  }
  if (demo) return { ...DEMO_DEVICE_KEYS, ...given };
  const out: Record<string, string> = { ...given };
  for (const id of Object.keys(DEMO_DEVICE_KEYS)) out[id] ??= randomSecret();
  return out;
}

/** Hors démonstration, aucun secret injecté ne peut être une valeur publique de démonstration. */
function assertNoDemoSecrets(secrets: Secrets): void {
  if (isDemoMode()) return;
  const bad = [
    ...Object.entries(secrets.providerSecrets).filter(([, v]) => isDemoValue(v)).map(([k]) => `prestataire ${k}`),
    ...Object.entries(secrets.providerKeyRings ?? {}).filter(([, ring]) => ring.some((k) => isDemoValue(k.secret))).map(([k]) => `trousseau ${k}`),
    ...Object.entries(secrets.deviceKeys).filter(([, v]) => isDemoValue(v)).map(([k]) => `terminal ${k}`),
  ];
  if (bad.length) throw new ConfigurationError(`Secrets de démonstration refusés hors mode démonstration : ${bad.join(', ')}.`);
}

/** Secrets (surchargeables par variables d'environnement ; valeurs publiques de DÉMONSTRATION en mode démo seulement). */
export function defaultSecrets(env: NodeJS.ProcessEnv = process.env, injected: Partial<Secrets> = {}): Secrets {
  const receiptKey = loadReceiptSigningKey(env.MOSOLO_RECEIPT_SIGNING_KEY);
  const receiptVerificationKeys = loadReceiptVerificationKeys(env.MOSOLO_RECEIPT_VERIFY_KEYS);
  // Trousseaux lus une seule fois ; des secrets injectés (tests, intégration) dispensent de l'environnement.
  const rings = injected.providerKeyRings ?? (injected.providerSecrets ? {} : providerKeyRingsFromEnv(env));
  return {
    auditHmacKey: env.MOSOLO_AUDIT_HMAC_KEY ?? randomSecret(),
    // Secrets injectés (tests, intégration) : l'environnement n'est pas exigé pour ce qui est déjà fourni.
    providerSecrets: injected.providerSecrets ?? Object.fromEntries(Object.entries(rings).map(([p, ring]) => [p, ring[0]!.secret])),
    providerKeyRings: rings,
    commsProviderKeys: CommunicationService.providerKeysFromEnv(env),
    deviceKeys: injected.deviceKeys ?? deviceKeysFromEnv(env),
    // Clé de signature des quittances stable entre redémarrages (MOSOLO_RECEIPT_SIGNING_KEY, PEM ou base64 PKCS#8).
    ...(receiptKey ? { receiptSigningKey: receiptKey } : {}),
    // Rotation : anciennes clés publiques (MOSOLO_RECEIPT_VERIFY_KEYS, SPKI PEM ou base64 DER, séparées par « ; »).
    ...(receiptVerificationKeys.length ? { receiptVerificationKeys } : {}),
  };
}

export interface AppOptions {
  clock?: Clock;
  secrets?: Partial<Secrets>;
  aiProvider?: AIProvider;
  /** Charger les données de démonstration (défaut : oui). */
  seed?: boolean;
  /**
   * Exemples COMPLÉMENTAIRES de démonstration (29/09/2026 : déclarations, relevés et rapprochements [EXEMPLE] des modules
   * sectoriels « acte requis ») : semés seulement avec les données de démonstration ET sur demande explicite des points
   * d'entrée lancés avec `--demo` (défaut : non — les tests historiques gardent leurs dépôts vides).
   */
  demoExamples?: boolean;
  /** Variables des connecteurs BitriPay / KODA (défaut : process.env). Sans clé API : bac à sable local. */
  connectorEnv?: Record<string, string | undefined>;
  /** `fetch`, journal masqué et temporisation injectables (tests : jamais de réseau réel). */
  connectorRuntime?: ConnectorRuntime;
  /** Modules d'extension (défaut : `DEFAULT_PLUGINS`). */
  plugins?: MosoloPlugin<unknown>[];
}

export function createContext(opts: AppOptions = {}) {
  const clock = opts.clock ?? systemClock;
  const secrets: Secrets = { ...defaultSecrets(process.env, opts.secrets), ...opts.secrets };
  assertNoDemoSecrets(secrets);
  const users = new UserDirectory();
  const audit = new AuditLog(clock, secrets.auditHmacKey);
  const idempotency = new IdempotencyStore();
  const comms = new CommunicationService(clock, secrets.commsProviderKeys);
  const alerts = new AlertService(clock, audit, comms, users);
  const fx = new FxService(clock);
  const taxpayers = new TaxpayerService(clock, audit, comms);
  const objects = new ObjectService(clock, audit, comms, taxpayers);
  const vault = new VaultService(clock, audit, comms, users);
  const rules = new RuleService(clock, audit, comms, users, (alias) => vault.aliasExists(alias));
  const ledger = new LedgerService(clock, audit);
  const assessment = new AssessmentService(clock, audit, comms, rules, taxpayers, objects, ledger);
  const receipts = new ReceiptService(clock, audit, alerts, secrets.receiptSigningKey, secrets.receiptVerificationKeys);
  const connectors = buildConnectorRegistry(opts.connectorEnv ?? process.env, opts.connectorRuntime ?? {});
  const payments = new PaymentService(clock, audit, comms, alerts, assessment, taxpayers, vault, fx, receipts, ledger, secrets.providerSecrets, connectors, secrets.providerKeyRings ?? {});
  const treasury = new TreasuryService(clock, audit, comms, users, payments, assessment, receipts, vault, ledger, taxpayers);
  const drafts = new DraftService(clock, audit);
  const field = new FieldService(clock, audit, comms, alerts, users, objects);
  const appeals = new AppealService(clock, audit, comms, assessment, taxpayers);
  // Compte unique (ch. 9) : registre des contributions de chaque module ; le socle déclare les siennes ici.
  const compteUnique = new CompteUniqueRegistry();
  registerSocleContributions(compteUnique, { objects, assessment, payments, receipts, appeals, comms });
  // Rattachement exact des fiches de métier au compte dont le téléphone vient d'être vérifié (jamais sur le nom).
  taxpayers.hooks.phoneVerified.push((t) => { if (t.phone) compteUnique.rattacher(t.id, t.phone); });

  // Vue en lecture seule offerte à la couche d'intelligence.
  const snapshot = (): AIDataSnapshot => {
    const now = clock.now();
    const weakest = communeBreakdown()
      .sort((a, b) => Number.parseFloat(a.complianceRate) - Number.parseFloat(b.complianceRate))
      .slice(0, 3)
      .map((c) => ({ commune: c.commune, complianceRate: c.complianceRate, collected: c.collected.amount }));
    const units = objects.objects.find((o) => o.category === 'UNITE_LOCATIVE');
    const leases = objects.leases.all();
    const overview = comms.overview();
    const confirmed = payments.orders.find((o) => o.status === 'CONFIRME');
    return {
      today: kinshasaDate(now),
      governor: { weakestCommunes: weakest, reconRateJ1: tiles().reconRateJ1, overdue: Money.fromMinor(LADDER_EXAMPLE.overdue * 100n, 'CDF').toDecimalString(), example: true },
      treasury: {
        openExceptions: treasury.exceptions.count(),
        missingSettlements: confirmed.filter((o) => o.confirmedAt && now.getTime() - new Date(o.confirmedAt).getTime() > 86_400_000).length,
        confirmedAwaitingSettlement: confirmed.length,
      },
      rental: {
        rentableUnits: units.length,
        declaredLeases: leases.length,
        unitsWithoutLease: units.filter((u) => !leases.some((l) => l.unitObjectId === u.id)).length,
      },
      communications: { attempted: overview.attempted, sandboxLogged: overview.sandboxLogged, channelsWired: overview.channelsWired, channelsTotal: overview.channelsTotal },
    };
  };
  const ai = new AIService(clock, audit, opts.aiProvider ?? new DeterministicRuleProvider(), snapshot);
  const dashboards = new DashboardService(clock, audit, ai, () => ({
    obligations: assessment.obligations.count(),
    paymentReferences: payments.orders.count(),
    confirmedPayments: payments.orders.find((o) => o.status === 'CONFIRME').length,
    reconciledPayments: payments.orders.find((o) => o.status === 'RAPPROCHE').length,
    receipts: receipts.receipts.count(),
    activeRules: rules.rules.find((r) => r.status === 'ACTIVE').length,
    securityAlerts: alerts.alerts.count(),
    pendingBeneficiaryChanges: vault.requests.find((r) => r.status !== 'EFFECTIF').length,
  }), () => payments.revenueByCommune());

  return {
    clock, secrets, users, audit, idempotency, comms, alerts, fx, taxpayers, objects, vault, rules, ledger, connectors,
    assessment, receipts, payments, treasury, drafts, field, appeals, ai, dashboards, compteUnique,
    /** Services des modules d'extension, par nom (voir plugins/). */
    ext: {} as Record<string, unknown>,
    /**
     * Données de démonstration semées dans cette application (fixé par `buildApp` avant la création des modules).
     * `undefined` (contexte construit hors `buildApp`) : comportement historique. `false` : aucun élément fictif,
     * même de configuration (types de titres « DÉMONSTRATION »), n'est créé — mode production.
     */
    demoData: undefined as boolean | undefined,
    /** Exemples complémentaires de démonstration demandés (fixé par `buildApp` : jamais sans données de démonstration). */
    demoExamples: false as boolean,
    /**
     * État du stockage persistant (fixé par le module « socle » quand une base est attachée) : `degraded` vrai après
     * plusieurs écritures consécutives en échec. Absent : stockage en mémoire (tests, démonstration sans base).
     */
    storageHealth: undefined as (() => { degraded: boolean; consecutiveFailures: number }) | undefined,
  };
}

export type AppContext = ReturnType<typeof createContext>;
