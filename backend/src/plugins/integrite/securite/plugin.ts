/**
 * Module d'extension « Intégrité — sécurité technique » (après `integrite-gouvernance`) : scellement du journal
 * (copie WORM, racine quotidienne horodatée et publiée, contrôle d'intégrité horaire), surveillance transverse
 * (lecture massive DLP, empreintes et attestation des appareils, plausibilité GPS, plafonds de références par canal
 * et par agent) et ouverture automatique de la revue mensuelle des accès privilégiés. Alertes seulement : aucune
 * sanction ni révocation automatique.
 */
import { runScheduledJob } from '../../../core/jobs.js';
import { withCorrelation } from '../../../core/audit.js';
import { kinshasaDate } from '../../../core/clock.js';
import { definePolicy, GRANTS } from '../../../core/policy.js';
import { definePlugin } from '../../types.js';
import type { IntegriteService } from '../service.js';
import { securityBool, securityNum } from '../gouvernance/parametres-securite.js';
import { publicationFromEnv, tsaFromEnv } from './horodatage.js';
import { registerSecuriteRoutes } from './routes.js';
import { ScellementService } from './scellement.js';
import { SurveillanceService } from './surveillance.js';
import { wormFromEnv } from './worm.js';
import type { AppContext } from '../../../context.js';

const { always } = GRANTS;

export function declareSecuritePolicies(): void {
  definePolicy('integrite:scellement.read', { R22: always, R23: always, R28: always, R26: always, R27: always });
  definePolicy('integrite:scellement.run', { R28: always, R27: always, R22: always });
  definePolicy('integrite:appareils.read', { R28: always, R22: always, R24: always, R09: always, R27: always });
  definePolicy('integrite:appareils.attest', { R28: always, R27: always });
  definePolicy('integrite:gps.evaluate', { R28: always, R22: always, R24: always, R09: always, R10: always, R11: always });
  definePolicy('integrite:plafonds.read', { R28: always, R22: always, R24: always, R17: always, R18: always, R06: always, R09: always });
}

export class SecuriteService {
  readonly scellement: ScellementService;
  readonly surveillance: SurveillanceService;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastCheck = 0;

  constructor(readonly ctx: AppContext) {
    this.scellement = new ScellementService(ctx, wormFromEnv(), tsaFromEnv(), publicationFromEnv());
    this.surveillance = new SurveillanceService(ctx);
  }

  /**
   * Passage du planificateur : contrôle d'intégrité à l'intervalle du registre (`scellement.controle_intervalle_h`,
   * 0 = désactivé) précédé d'une copie WORM ; racine de la veille si absente ; revue mensuelle des accès privilégiés.
   */
  tick(): { copied: number; checked: boolean; rootPublished: boolean; reviewLaunched: boolean } {
    return withCorrelation(`planif-${this.ctx.clock.now().toISOString()}`, () => {
      const out = { copied: 0, checked: false, rootPublished: false, reviewLaunched: false };
      const hours = securityNum(this.ctx, 'scellement.controle_intervalle_h');
      const now = this.ctx.clock.now().getTime();
      if (hours > 0 && now - this.lastCheck >= hours * 3_600_000) {
        this.lastCheck = now;
        out.copied = this.scellement.copy('system').copied;
        this.scellement.check('system', 'PLANIFIE');
        out.checked = true;
      }
      const day = kinshasaDate(new Date(now - 86_400_000));
      if (!this.scellement.roots.findOne((r) => r.day === day && !r.partial) && this.ctx.audit.length > 0) {
        try { this.scellement.publishRoot('system', day); out.rootPublished = true; } catch { /* échec journalisé et alerté */ }
      }
      const integrite = this.ctx.ext.integrite as IntegriteService | undefined;
      if (integrite && securityBool(this.ctx, 'acces.revue_privileges_auto') && integrite.privilegedReviewDue()) {
        try { integrite.launchPrivilegedReview('system'); out.reviewLaunched = true; } catch { /* revue précédente encore ouverte */ }
      }
      return out;
    });
  }

  startScheduler(tickMs = 300_000): void {
    this.stopScheduler();
    this.timer = setInterval(() => { runScheduledJob(this.ctx, 'integrite.securite', () => { this.tick(); }); }, tickMs);
    this.timer.unref?.();
  }
  stopScheduler(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  get schedulerActive(): boolean { return this.timer !== undefined; }
}

/** Planificateur actif par défaut, désactivé sous les tests (VITEST) ; MOSOLO_SCELLEMENT_SCHEDULER=off|on. */
export function scellementSchedulerEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = (env.MOSOLO_SCELLEMENT_SCHEDULER ?? '').trim().toLowerCase();
  if (flag === 'off') return false;
  if (flag === 'on') return true;
  return !env.VITEST;
}

export const integriteSecuritePlugin = definePlugin<SecuriteService>({
  name: 'integrite-securite',
  create: (ctx) => {
    declareSecuritePolicies();
    const svc = new SecuriteService(ctx);
    if (scellementSchedulerEnabled(process.env)) svc.startScheduler();
    return svc;
  },
  routes: (app, ctx, svc) => {
    registerSecuriteRoutes(app, ctx, svc);
    app.addHook('onClose', async () => svc.stopScheduler());
  },
});
