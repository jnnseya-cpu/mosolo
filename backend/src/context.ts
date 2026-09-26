/** Composition des modules (monolithe modulaire) : chaque domaine est un service aux frontières explicites. */
import type { KeyObject } from 'node:crypto';
import type { Channel } from '@mosolo/shared';
import { AuditLog } from './core/audit.js';
import { UserDirectory } from './core/auth.js';
import { isoDate, systemClock, type Clock } from './core/clock.js';
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
import { ObjectService } from './modules/objects/service.js';
import type { ConnectorRuntime } from './modules/payments/connectors/koda.js';
import { buildConnectorRegistry } from './modules/payments/connectors/registry.js';
import { PaymentService } from './modules/payments/service.js';
import { ReceiptService } from './modules/receipts/service.js';
import { RuleService } from './modules/rules/service.js';
import { LedgerService } from './modules/treasury/ledger.js';
import { TreasuryService } from './modules/treasury/service.js';
import { VaultService } from './modules/vault/service.js';
import { Money } from '@mosolo/shared';
import type { MosoloPlugin } from './plugins/types.js';

export interface Secrets {
  /** Clé HMAC de signature du journal d'audit (production : HSM). */
  auditHmacKey: string;
  /** Secrets HMAC par prestataire de paiement habilité. */
  providerSecrets: Record<string, string>;
  /** Clés des fournisseurs de communication ; canal absent ⇒ bac à sable (« journalise »). */
  commsProviderKeys: Partial<Record<Channel, string>>;
  /** Clés HMAC des terminaux terrain enrôlés (démo). */
  deviceKeys: Record<string, string>;
  /** Clé privée Ed25519 de signature des quittances ; générée au démarrage si absente. */
  receiptSigningKey?: KeyObject;
}

/** Secrets de DÉMONSTRATION (surchargeables par variables d'environnement). */
export function defaultSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  return {
    auditHmacKey: env.MOSOLO_AUDIT_HMAC_KEY ?? randomSecret(),
    providerSecrets: {
      'mm-operator-a': env.MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A ?? 'demo-secret-mm-operator-a',
      'bank-a': env.MOSOLO_PROVIDER_SECRET_BANK_A ?? 'demo-secret-bank-a',
      'card-gateway': env.MOSOLO_PROVIDER_SECRET_CARD_GATEWAY ?? 'demo-secret-card-gateway',
    },
    commsProviderKeys: CommunicationService.providerKeysFromEnv(env),
    deviceKeys: {
      'dev-terrain-001': 'demo-device-key-001',
      'dev-terrain-002': 'demo-device-key-002',
      'dev-terrain-perdu': 'demo-device-key-perdu',
    },
  };
}

export interface AppOptions {
  clock?: Clock;
  secrets?: Partial<Secrets>;
  aiProvider?: AIProvider;
  /** Charger les données de démonstration (défaut : oui). */
  seed?: boolean;
  /** Variables des connecteurs BitriPay / KODA (défaut : process.env). Sans clé API : bac à sable local. */
  connectorEnv?: Record<string, string | undefined>;
  /** `fetch`, journal masqué et temporisation injectables (tests : jamais de réseau réel). */
  connectorRuntime?: ConnectorRuntime;
  /** Modules d'extension (défaut : `DEFAULT_PLUGINS`). */
  plugins?: MosoloPlugin<any>[];
}

export function createContext(opts: AppOptions = {}) {
  const clock = opts.clock ?? systemClock;
  const secrets: Secrets = { ...defaultSecrets(), ...opts.secrets };
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
  const receipts = new ReceiptService(clock, audit, alerts, secrets.receiptSigningKey);
  const connectors = buildConnectorRegistry(opts.connectorEnv ?? process.env, opts.connectorRuntime ?? {});
  const payments = new PaymentService(clock, audit, comms, alerts, assessment, taxpayers, vault, fx, receipts, ledger, secrets.providerSecrets, connectors);
  const treasury = new TreasuryService(clock, audit, comms, users, payments, assessment, receipts, vault, ledger, taxpayers);
  const drafts = new DraftService(clock, audit);
  const field = new FieldService(clock, audit, comms, alerts, users, objects);
  const appeals = new AppealService(clock, audit, comms, assessment, taxpayers);

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
      today: isoDate(now),
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
    assessment, receipts, payments, treasury, drafts, field, appeals, ai, dashboards,
    /** Services des modules d'extension, par nom (voir plugins/). */
    ext: {} as Record<string, unknown>,
  };
}

export type AppContext = ReturnType<typeof createContext>;
