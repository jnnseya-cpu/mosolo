/**
 * Routes de la console « Clés et raccordements » (29/09/2026). ÉCRITURE SEULE : aucune route ne renvoie une valeur de
 * configuration, pas même masquée — seulement des noms, des présences, des sources et des versions.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { notFound } from '../../core/errors.js';
import { parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { publicBaseUrl } from '../payments/readiness.js';
import { CONNECTOR_IDS } from '../payments/connectors/types.js';
import { INBOUND_WEBHOOKS, INTEGRATION_GROUPS, INVENTORY, type IntegrationGroupId } from './inventory.js';
import { checkFormat, RESOLUTION_RULE } from './service.js';

const proposalSchema = z.object({
  kind: z.enum(['DEFINIR', 'RETIRER']),
  value: z.string().max(4096).optional(),
  motif: z.string().trim().min(3).max(500),
}).strict();
const decisionSchema = z.object({ motif: z.string().trim().min(3).max(500).optional() }).strict();
const rejectSchema = z.object({ motif: z.string().trim().min(3).max(500) }).strict();

const DOCTRINE = [
  'Écriture seule : aucune valeur n’est jamais renvoyée, pas même masquée — seuls le nom, la présence, la source active et la version sont affichés.',
  'Chiffrement au repos AES-256-GCM avec la clé maîtresse MOSOLO_CONFIG_MASTER_KEY (environnement) ; sans elle, la console refuse toute écriture.',
  'Deux personnes : le super-administrateur (R26) propose, une personne distincte (R26 ou responsable sécurité R28) approuve ; rien ne s’applique avant.',
  'Chaque proposition, décision et essai est journalisé dans la piste d’audit — jamais la valeur.',
  RESOLUTION_RULE,
  'Prise en compte sans redéploiement : les connecteurs de paiement sont reconstruits à chaud ; une configuration invalide ne remplace jamais les connecteurs en service.',
];

export function registerIntegrationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const svc = ctx.integrations;

  app.get('/v1/integrations/keys', async (req, reply) => {
    const user = requireUser(req);
    reply.header('cache-control', 'no-store');
    const variables = svc.inventory(user);
    // Lecture à chaud : reconstruction éventuelle des connecteurs avant d'en afficher l'état.
    ctx.connectors.refresh();
    return {
      generatedAt: ctx.clock.now().toISOString(),
      masterKey: {
        state: svc.masterKeyState,
        label: svc.masterKeyState === 'PRESENTE' ? 'Clé maîtresse présente : écriture possible (chiffrement AES-256-GCM).'
          : svc.masterKeyState === 'EPHEMERE_DEMO' ? 'Démonstration : clé maîtresse éphémère — les valeurs saisies seront illisibles après redémarrage.'
            : 'Clé maîtresse MOSOLO_CONFIG_MASTER_KEY absente : la console refuse toute écriture.',
        writable: svc.masterKeyState !== 'ABSENTE',
      },
      resolutionRule: RESOLUTION_RULE,
      groups: INTEGRATION_GROUPS.map((g) => ({
        ...g,
        variables: variables.filter((v) => v.group === g.id),
        pending: variables.filter((v) => v.group === g.id && v.pending).length,
        missingRequired: variables.filter((v) => v.group === g.id && v.required === 'OBLIGATOIRE_EN_REEL' && v.activeSource === 'ABSENTE').map((v) => v.name),
      })),
      connectors: { configError: ctx.connectors.configError, reloads: ctx.connectors.reloads, lastReloadAt: ctx.connectors.lastReloadAt },
      publicUrl: publicBaseUrl(svc.connectorEnv()),
      doctrine: DOCTRINE,
    };
  });

  app.get('/v1/integrations/proposals', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return svc.listProposals(requireUser(req));
  });

  app.post<{ Params: { name: string } }>('/v1/integrations/keys/:name/proposals', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(proposalSchema, req.body);
    reply.header('cache-control', 'no-store');
    return reply.code(201).send(svc.propose(user, req.params.name, body));
  });

  app.post<{ Params: { id: string } }>('/v1/integrations/proposals/:id/approve', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(decisionSchema, req.body ?? {});
    const res = svc.approve(user, req.params.id, body.motif);
    // Les connecteurs relisent la configuration tout de suite (et signalent une configuration invalide, sans valeur).
    ctx.connectors.refresh();
    reply.header('cache-control', 'no-store');
    return { ...res, configurationWarning: ctx.connectors.configError };
  });

  app.post<{ Params: { id: string } }>('/v1/integrations/proposals/:id/reject', async (req) => {
    const user = requireUser(req);
    const body = parse(rejectSchema, req.body);
    return svc.reject(user, req.params.id, body.motif);
  });

  // Webhooks ENTRANTS : URL exacte à communiquer, signature attendue, secret (nom et source), dernière réception.
  app.get('/v1/integrations/webhooks', async (req) => {
    const user = requireUser(req);
    authorize(user, 'integration.read');
    const base = publicBaseUrl(svc.connectorEnv());
    return {
      publicUrl: base,
      webhooks: INBOUND_WEBHOOKS.map((w) => {
        const provider = (CONNECTOR_IDS as readonly string[]).includes(w.id) ? w.id : null;
        const rec = provider ? ctx.payments.webhookReceptions.find((r) => r.provider === provider).at(-1) : undefined;
        const other = provider ? undefined : svc.inbound.get(w.id);
        return {
          ...w,
          url: `${base.value ?? 'https://<domaine>'}${w.path}`, urlReady: base.valid,
          secretSource: w.secretVariable ? svc.sourceOf(w.secretVariable) : null,
          lastDelivery: rec
            ? { at: rec.receivedAt, verification: rec.verification === 'VALIDE' ? 'VALIDE' : 'REFUSEE', code: rec.verification === 'VALIDE' ? (rec.httpStatus >= 400 ? rec.outcome : null) : rec.verification, httpStatus: rec.httpStatus }
            : other ? { at: other.at, verification: other.verification, code: other.code, httpStatus: null } : null,
        };
      }),
    };
  });

  // « Tester » : appel réel inoffensif (prestataires de paiement) ou validation de configuration seule (le résultat le dit).
  app.post<{ Params: { group: string } }>('/v1/integrations/:group/test', async (req) => {
    const user = requireUser(req);
    authorize(user, 'integration.read');
    const group = INTEGRATION_GROUPS.find((g) => g.id === req.params.group);
    if (!group) throw notFound('UNKNOWN_INTEGRATION', `Intégration inconnue : ${req.params.group}`);
    if ((CONNECTOR_IDS as readonly string[]).includes(group.id)) {
      const r = await ctx.payments.testProviderConnection(user, group.id);
      ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'integration.config.tested', resourceType: 'integration', resourceId: group.id, outcome: r.ok ? 'SUCCESS' : 'FAILURE', details: { kind: r.kind } });
      return { integration: group.id, ...r };
    }
    const vars = INVENTORY.filter((v) => v.group === (group.id as IntegrationGroupId));
    const checks: { label: string; ok: boolean; detail?: string }[] = [];
    for (const v of vars) {
      const source = svc.sourceOf(v.name);
      const value = svc.value(v.name);
      const present = source !== 'ABSENTE';
      checks.push({
        label: `${v.name} ${present ? `présente (${source === 'CONSOLE' ? 'console' : 'environnement'})` : 'absente'}`,
        ok: present || v.required === 'FACULTATIVE',
        ...(v.proposedName ? { detail: 'nom proposé — à confirmer ; aucun module ne la lit encore' } : {}),
      });
      // Format revérifié sur la valeur active (jamais affichée) ; les clés internes du socle ne sont pas relues ici.
      if (value !== undefined && v.effect !== 'ENVIRONNEMENT_SEUL') {
        const problem = checkFormat(v, value, { production: false });
        checks.push({ label: `Format de ${v.name}`, ok: !problem, ...(problem ? { detail: problem } : {}) });
      }
    }
    if (group.id === 'plateforme') {
      const base = publicBaseUrl(svc.connectorEnv());
      checks.push({ label: 'Adresse publique utilisable par les prestataires (https)', ok: base.valid, detail: base.note });
    }
    const commsChannels: Record<string, string[]> = { email: ['email'], 'sms-ussd': ['sms', 'ussd', 'svi'], whatsapp: ['whatsapp'], notifications: ['push', 'courrier'] };
    const channels = ctx.comms.channelStatus();
    for (const ch of commsChannels[group.id] ?? []) {
      const c = channels.find((x) => x.channel === ch);
      if (c) checks.push({ label: `Canal « ${ch} » : ${c.wired ? 'raccordé à un fournisseur (file sortante)' : 'bac à sable (messages journalisés)'}`, ok: true });
    }
    const ok = checks.every((c) => c.ok);
    const result = {
      integration: group.id, kind: 'VALIDATION_A_BLANC' as const, ok, checks, at: ctx.clock.now().toISOString(), by: user.id,
      proves: 'Validation de configuration seulement : présence des variables requises et format des valeurs actives. Aucun appel n’a été fait à un service externe (aucun connecteur réel n’est raccordé pour cette intégration, ou son essai inoffensif n’est pas documenté).',
      detail: ok ? 'Configuration cohérente.' : 'Configuration incomplète ou invalide : voir les points en échec.',
    };
    ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'integration.config.tested', resourceType: 'integration', resourceId: group.id, outcome: ok ? 'SUCCESS' : 'FAILURE', details: { kind: result.kind } });
    return result;
  });
}
