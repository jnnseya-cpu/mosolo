/**
 * Administration de la plateforme (module 53) — exploiter les environnements SANS pouvoir fiscal ni financier :
 *  - environnements : recette, pré-production, production (version en place, configuration technique, historique) ;
 *  - déploiements et RETOURS ARRIÈRE par demandes de changement validées par le comité de contrôle des changements
 *    (quorum de personnes distinctes du demandeur — PAR DÉFAUT 2, à confirmer), promotion ordonnée
 *    recette → pré-production → production (une version n'atteint un environnement qu'après succès au précédent) ;
 *  - configuration technique NON financière : toute clé à caractère fiscal ou financier est refusée (elle relève du
 *    registre juridique, du registre des seuils ou du coffre des bénéficiaires, jamais de l'exploitation) ;
 *  - indicateurs : déploiements réussis ; incidents post-déploiement (incidents d'exploitation rattachés ou déclarés
 *    dans la fenêtre suivant un déploiement en production).
 * Les administrateurs techniques n'ont aucune lecture métier libre : leurs rôles n'ouvrent aucune politique métier.
 */
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { HOUR_MS } from '../../core/clock.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';

export const ENVIRONMENTS = { RECETTE: 'Recette', PRE_PRODUCTION: 'Pré-production', PRODUCTION: 'Production' } as const;
export type EnvCode = keyof typeof ENVIRONMENTS;
const ORDER: EnvCode[] = ['RECETTE', 'PRE_PRODUCTION', 'PRODUCTION'];
/** Quorum du comité de contrôle des changements (personnes distinctes du demandeur) — PAR DÉFAUT, à confirmer. */
export const CAB_QUORUM = 2;
/** Fenêtre d'imputation d'un incident à un déploiement en production (heures) — PAR DÉFAUT, à confirmer. */
export const POST_DEPLOY_WINDOW_H = 72;
/** Clés refusées : tout paramètre fiscal ou financier (taux, tarifs, montants, bénéficiaires, comptes, seuils de recette). */
export const FINANCIAL_KEY = /(taux|tarif|montant|amount|rate|price|prix|benefici|compte|account|iban|penalit|commission|repartition|remise|exoner|bareme|seuil_recette|devise_change|fx)/i;

export type ChangeKind = 'DEPLOIEMENT' | 'RETOUR_ARRIERE' | 'CONFIGURATION';
export interface ChangeRequest {
  id: string;
  kind: ChangeKind;
  environment: EnvCode;
  version?: string;
  config?: { key: string; value: string };
  motif: string;
  rollbackPlan: string;
  requestedBy: string;
  requestedAt: string;
  approvals: { by: string; at: string; motif: string }[];
  status: 'DEMANDEE' | 'APPROUVEE' | 'REFUSEE' | 'EXECUTEE' | 'ECHOUEE';
  refusal?: { by: string; at: string; motif: string };
  execution?: { by: string; at: string; result: 'SUCCES' | 'ECHEC'; report: string; previousVersion: string | null };
}
export interface Environment { id: EnvCode; label: string; version: string | null; config: Record<string, string>; history: { at: string; changeId: string; kind: ChangeKind; version?: string; result: string }[] }

type OpsIncident = { detectedAt: string; deploymentId?: string };

export class PlatformAdminService {
  readonly environments = new InMemoryRepository<Environment>();
  readonly changes = new InMemoryRepository<ChangeRequest>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly incidents: () => OpsIncident[]) {
    for (const id of ORDER) this.environments.insert({ id, label: ENVIRONMENTS[id], version: null, config: {}, history: [] });
  }

  private now() { return this.ctx.clock.now().toISOString(); }

  private env(id: EnvCode) { return this.environments.get(id)!; }

  request(user: User, input: { kind: ChangeKind; environment: EnvCode; version?: string; config?: { key: string; value: string }; motif: string; rollbackPlan: string }) {
    authorize(user, 'plateforme:admin.request');
    const env = this.env(input.environment);
    if (input.kind === 'CONFIGURATION') {
      if (!input.config) throw badRequest('CONFIG_REQUIRED', 'Clé et valeur de configuration requises.');
      if (FINANCIAL_KEY.test(input.config.key) || FINANCIAL_KEY.test(input.config.value)) {
        throw forbidden('FINANCIAL_CONFIG_FORBIDDEN', 'Configuration à caractère fiscal ou financier refusée : elle relève du registre juridique, du registre des seuils ou du coffre des bénéficiaires, jamais de l’administration technique.');
      }
    } else {
      if (!input.version) throw badRequest('VERSION_REQUIRED', 'Version à déployer requise.');
      if (input.kind === 'DEPLOIEMENT') {
        const i = ORDER.indexOf(input.environment);
        if (i > 0) {
          const prev = this.env(ORDER[i - 1]!);
          if (!prev.history.some((h) => h.version === input.version && h.result === 'SUCCES' && h.kind !== 'CONFIGURATION')) {
            throw unprocessable('PROMOTION_ORDER', `La version ${input.version} doit d’abord être déployée avec succès en ${prev.label}.`);
          }
        }
      } else {
        const done = env.history.filter((h) => h.result === 'SUCCES' && h.version && h.kind !== 'CONFIGURATION').map((h) => h.version!);
        if (!done.includes(input.version) || input.version === env.version) throw unprocessable('ROLLBACK_TARGET', 'Retour arrière : cible = une version déjà déployée avec succès sur cet environnement, différente de la version en place.');
      }
    }
    const c = this.changes.insert({ id: this.ids.next('CHG'), kind: input.kind, environment: input.environment, ...(input.version ? { version: input.version } : {}), ...(input.config ? { config: input.config } : {}), motif: input.motif, rollbackPlan: input.rollbackPlan, requestedBy: user.id, requestedAt: this.now(), approvals: [], status: 'DEMANDEE' });
    this.ctx.audit.append({ actor: actorOf(user), action: 'plateforme.change.requested', resourceType: 'change_request', resourceId: c.id, details: { kind: c.kind, environment: c.environment, version: c.version ?? null, configKey: c.config?.key ?? null } });
    return c;
  }

  private change(id: string) {
    const c = this.changes.get(id);
    if (!c) throw notFound('CHANGE_NOT_FOUND', `Demande de changement inconnue : ${id}`);
    return c;
  }

  /** Avis du comité de contrôle des changements : chaque membre est distinct du demandeur et des autres membres. */
  review(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'plateforme:admin.cab');
    const c = this.change(id);
    if (c.status !== 'DEMANDEE') throw conflict('INVALID_STATE', `Demande au statut ${c.status}.`);
    assertDistinctPerson(user.id, [c.requestedBy, ...c.approvals.map((a) => a.by)], 'Comité de contrôle des changements : chaque avis vient d’une personne distincte du demandeur et des autres membres.');
    const at = this.now();
    const out = input.approve
      ? (() => { const approvals = [...c.approvals, { by: user.id, at, motif: input.motif }]; return this.changes.update({ ...c, approvals, status: approvals.length >= CAB_QUORUM ? 'APPROUVEE' : 'DEMANDEE' }); })()
      : this.changes.update({ ...c, status: 'REFUSEE', refusal: { by: user.id, at, motif: input.motif } });
    this.ctx.audit.append({ actor: actorOf(user), action: input.approve ? 'plateforme.change.cab_approved' : 'plateforme.change.cab_refused', resourceType: 'change_request', resourceId: id, details: { approvals: out.approvals.length, quorum: CAB_QUORUM, motif: input.motif } });
    return out;
  }

  /** Exécution d'une demande APPROUVÉE (déploiement, retour arrière, configuration) et compte rendu. */
  execute(user: User, id: string, input: { result: 'SUCCES' | 'ECHEC'; report: string }) {
    authorize(user, 'plateforme:admin.execute');
    const c = this.change(id);
    if (c.status !== 'APPROUVEE') throw conflict('CAB_APPROVAL_REQUIRED', 'Exécution impossible sans validation du comité de contrôle des changements.');
    const env = this.env(c.environment);
    const at = this.now();
    const previousVersion = env.version;
    if (input.result === 'SUCCES') {
      this.environments.update({
        ...env, version: c.kind === 'CONFIGURATION' ? env.version : c.version!, config: c.kind === 'CONFIGURATION' ? { ...env.config, [c.config!.key]: c.config!.value } : env.config,
        history: [...env.history, { at, changeId: c.id, kind: c.kind, ...(c.version ? { version: c.version } : {}), result: 'SUCCES' }],
      });
    } else {
      this.environments.update({ ...env, history: [...env.history, { at, changeId: c.id, kind: c.kind, ...(c.version ? { version: c.version } : {}), result: 'ECHEC' }] });
    }
    const out = this.changes.update({ ...c, status: input.result === 'SUCCES' ? 'EXECUTEE' : 'ECHOUEE', execution: { by: user.id, at, result: input.result, report: input.report, previousVersion } });
    this.ctx.audit.append({ actor: actorOf(user), action: c.kind === 'RETOUR_ARRIERE' ? 'plateforme.deployment.rolled_back' : c.kind === 'CONFIGURATION' ? 'plateforme.config.changed' : 'plateforme.deployment.executed', resourceType: 'environment', resourceId: c.environment, details: { changeId: c.id, version: c.version ?? null, previousVersion, result: input.result }, before: { version: previousVersion }, after: { version: input.result === 'SUCCES' && c.kind !== 'CONFIGURATION' ? c.version : previousVersion } });
    return out;
  }

  view(user: User) {
    authorize(user, 'plateforme:admin.read');
    const changes = this.changes.all().sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
    const deployments = changes.filter((c) => c.kind !== 'CONFIGURATION' && c.execution);
    const ok = deployments.filter((c) => c.execution!.result === 'SUCCES').length;
    const prodDeploys = deployments.filter((c) => c.environment === 'PRODUCTION' && c.execution!.result === 'SUCCES');
    const incidents = this.incidents();
    const post = incidents.filter((i) => (i.deploymentId && prodDeploys.some((d) => d.id === i.deploymentId))
      || prodDeploys.some((d) => { const t = Date.parse(d.execution!.at); const x = Date.parse(i.detectedAt); return x >= t && x - t <= POST_DEPLOY_WINDOW_H * HOUR_MS; }));
    return {
      environments: ORDER.map((id) => this.env(id)), changes,
      params: { cabQuorum: CAB_QUORUM, postDeployWindowHours: POST_DEPLOY_WINDOW_H, status: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage' },
      rule: 'Aucun pouvoir fiscal ni financier : configuration technique seulement ; aucune lecture métier libre pour les administrateurs techniques.',
      indicators: [
        deployments.length
          ? { code: 'DEPLOIEMENTS_REUSSIS', label: 'Déploiements réussis', measured: true, value: ((ok * 100) / deployments.length).toFixed(1), unit: '%', basis: { ok, total: deployments.length } }
          : { code: 'DEPLOIEMENTS_REUSSIS', label: 'Déploiements réussis', measured: false, value: null, unit: '%', reason: 'Aucun déploiement exécuté.' },
        { code: 'INCIDENTS_POST_DEPLOIEMENT', label: 'Incidents post-déploiement (production)', measured: prodDeploys.length > 0, value: prodDeploys.length ? String(post.length) : null, unit: 'incidents', ...(prodDeploys.length ? {} : { reason: 'Aucun déploiement en production.' }) },
      ],
    };
  }
}
