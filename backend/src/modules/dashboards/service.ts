/** Tableau de bord du Gouverneur (§ 26.2) : agrégats seulement, jamais de nominatif. */
import type { User } from '../../core/auth.js';
import type { Clock } from '../../core/clock.js';
import type { AuditLog } from '../../core/audit.js';
import { authorize } from '../../core/policy.js';
import type { AIService } from '../ai/service.js';
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
    };
  }
}
