/** Tableau de bord du Gouverneur (§ 26.2) : agrégats seulement, jamais de nominatif. */
import type { User } from '../../core/auth.js';
import type { Clock } from '../../core/clock.js';
import type { AuditLog } from '../../core/audit.js';
import { authorize } from '../../core/policy.js';
import type { AIService } from '../ai/service.js';
import type { CommuneRevenue } from '../payments/service.js';
import { categories, communeBreakdown, exampleAlerts, ladder, scenarios, tiles, trend } from './example-data.js';

export interface LiveCounters {
  obligations: number;
  paymentReferences: number;
  confirmedPayments: number;
  reconciledPayments: number;
  receipts: number;
  activeRules: number;
  securityAlerts: number;
  pendingBeneficiaryChanges: number;
}

export class DashboardService {
  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly ai: AIService,
    private readonly live: () => LiveCounters,
    /** Recettes réelles par commune du fait générateur (§ 20.3). */
    private readonly liveByCommune: () => CommuneRevenue[] = () => [],
  ) {}

  governor(user: User) {
    authorize(user, 'dashboard.governor');
    const liveCounters = this.live();
    const alerts = exampleAlerts();
    this.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'dashboard.viewed', resourceType: 'dashboard', resourceId: 'governor' });
    return {
      example: true,
      exampleNotice: 'EXEMPLE — valeurs illustratives, non opposables.',
      currency: 'CDF',
      generatedAt: this.clock.now().toISOString(),
      tiles: { ...tiles(), criticalAlerts: alerts.length + liveCounters.securityAlerts },
      ladder: ladder(),
      byCommune: communeBreakdown(),
      byCategory: categories(),
      trend: trend(),
      scenarios: scenarios(),
      criticalAlerts: alerts,
      actions: this.ai.governorActions(),
      live: { ...liveCounters, example: false, note: 'Compteurs réels du socle (agrégats, sans montant nominatif).' },
      liveByCommune: {
        example: false,
        rule: 'Commune du fait générateur (lieu de l’objet ou du service), jamais l’adresse du contribuable (§ 20.3).',
        note: '« Payé » inclut « rapproché » : ces deux niveaux ne s’additionnent pas. Seul le rapproché est une recette arrivée au compte public.',
        rows: this.liveByCommune(),
      },
    };
  }
}
