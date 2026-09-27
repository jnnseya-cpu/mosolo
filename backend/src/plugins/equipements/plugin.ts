/**
 * Module d'extension « equipements » — Gestion des équipements terrain (module 58). Voir service.ts.
 * Échéancier d'expiration des données : toutes les heures hors tests (MOSOLO_EQUIPEMENTS_ECHEANCIER=off / on).
 */
import { runScheduledJob } from '../../core/jobs.js';
import { z } from 'zod';
import type { RoleCode } from '@mosolo/shared';
import { requireUser } from '../../core/auth.js';
import { header, parse } from '../../core/http.js';
import { authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { definePlugin } from '../types.js';
import { echeancierEnabled } from '../acces/delegations-plugin.js';
import { EquipementService } from './service.js';

const { always, sameEntity } = GRANTS;
const g = (roles: RoleCode[]) => Object.fromEntries(roles.map((r) => [r, always]));
definePolicy('equipements:read', { ...g(['R28', 'R22', 'R24', 'R26']), R08: always, R09: always, R06: always });
definePolicy('equipements:manage', { R08: sameEntity, R28: always, R09: always });
definePolicy('equipements:wipe', g(['R28', 'R08']));
definePolicy('equipements:policy', g(['R28']));

const motif = z.string().trim().min(10).max(2000);
const report = z.object({
  osVersion: z.number().int().min(0).max(100), appSignatureSha256: z.string().regex(/^[0-9a-fA-F]{64}$/), rooted: z.boolean(), bootloaderUnlocked: z.boolean(),
  emulator: z.boolean(), debuggable: z.boolean(), encrypted: z.boolean(), oldestCachedDataAt: z.string().datetime({ offset: true }).optional(), acknowledgedCommands: z.array(z.string().max(40)).max(50).optional(),
}).strict();

export const equipementsPlugin = definePlugin<EquipementService>({
  name: 'equipements',
  create: (ctx) => new EquipementService(ctx),
  routes: (app, ctx, svc) => {
    if (echeancierEnabled(process.env.MOSOLO_EQUIPEMENTS_ECHEANCIER)) {
      const t = setInterval(() => { runScheduledJob(ctx, 'equipements.expiration-donnees', () => { svc.expireData(); }); }, 3_600_000);
      t.unref();
      app.addHook('onClose', async () => clearInterval(t));
    }
    type P = { Params: { id: string } };
    app.get('/v1/equipements', async (req) => svc.view(requireUser(req)));
    app.post('/v1/equipements/terminaux', async (req, reply) => reply.code(201).send(svc.enroll(requireUser(req), parse(z.object({ deviceId: z.string().regex(/^[a-z0-9-]{3,60}$/), userId: z.string().max(80), policyCode: z.string().max(40).optional(), model: z.string().trim().min(2).max(80), os: z.string().trim().min(2).max(80) }).strict(), req.body))));
    app.post<P>('/v1/equipements/terminaux/:id/attestation/defi', async (req) => svc.challenge(requireUser(req), req.params.id));
    app.post<P>('/v1/equipements/terminaux/:id/attestation', async (req) => svc.attest(requireUser(req), req.params.id, parse(z.object({ nonce: z.string().max(100), signature: z.string().regex(/^[0-9a-fA-F]{64}$/) }).strict(), req.body)));
    // Signalement signé : x-device-signature = HMAC-SHA256(clé du terminal, corps brut), comme les lots de synchronisation.
    app.post<P>('/v1/equipements/terminaux/:id/signalement', async (req) => svc.checkIn(requireUser(req), req.params.id, req.rawBody ?? '', header(req, 'x-device-signature'), parse(report, req.body)));
    app.post<P>('/v1/equipements/terminaux/:id/effacement', async (req) => svc.wipe(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif));
    app.post<P>('/v1/equipements/terminaux/:id/revocation', async (req) => svc.revoke(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif));
    app.post<P>('/v1/equipements/terminaux/:id/perte', async (req) => svc.revoke(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif, true));
    app.post<P>('/v1/equipements/terminaux/:id/levee-quarantaine', async (req) => svc.lift(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif));
    app.post('/v1/equipements/politiques', async (req, reply) => reply.code(201).send(svc.publishPolicy(requireUser(req), parse(z.object({
      code: z.string().regex(/^[A-Z0-9-]{3,40}$/), label: z.string().trim().min(3).max(200), screenLockMinutes: z.number().int().min(1).max(60), minOsVersion: z.number().int().min(1).max(100),
      offlineDataTtlDays: z.number().int().min(1).max(90), encryptionRequired: z.boolean(), sideloadingAllowed: z.boolean(), approvedAppSignatures: z.array(z.string().regex(/^[0-9a-fA-F]{64}$/)).min(1).max(20),
    }).strict(), req.body))));
    app.post('/v1/equipements/echeancier', async (req) => { authorize(requireUser(req), 'equipements:wipe'); return { dataExpired: svc.expireData() }; });
  },
});
