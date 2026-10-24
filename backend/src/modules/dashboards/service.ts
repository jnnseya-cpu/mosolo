/** Tableau de bord du Gouverneur (§ 26.2) : agrégats seulement, jamais de nominatif. */
import { isDemoMode, type User } from '../../core/auth.js';
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
    const reel = {
      live: { ...liveCounters, example: false, note: 'Compteurs réels du socle (agrégats, sans montant nominatif).' },
      liveByCommune: {
        example: false,
        rule: 'Commune du fait générateur (lieu de l’objet ou du service), jamais l’adresse du contribuable (§ 20.3).',
        note: '« Payé » inclut « rapproché » : ces deux niveaux ne s’additionnent pas. Seul le rapproché est une recette arrivée au compte public.',
        rows: this.liveByCommune(),
      },
    };
    // Hors démonstration (audit du 24/10/2026) : jamais de chiffres d'exemple — les tuiles illustratives et les actions
    // de l'IA qui en découlent ne sont pas servies ; seuls les compteurs réels font foi.
    if (!isDemoMode()) {
      return {
        example: false, exampleNotice: null, currency: 'CDF', generatedAt: this.clock.now().toISOString(),
        tiles: { criticalAlerts: liveCounters.securityAlerts }, ladder: [], byCommune: [], byCategory: [], trend: [], scenarios: [], criticalAlerts: [], actions: [],
        note: 'Synthèses détaillées : Centre de commandement et poste de décision (données réelles). Aucun chiffre d’exemple hors démonstration.',
        ...reel,
      };
    }
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
      ...reel,
    };
  }
}
