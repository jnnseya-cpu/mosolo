/**
 * Module d'extension « documents » (spécification fonctionnelle, module 38 — Gestion documentaire) : stockage chiffré,
 * versions, empreintes, sceau, OCR et classification proposée, conservation par catégorie et purge à deux personnes
 * (jamais les preuves d'audit), exports filigranés et expirables, contrôle d'intégrité, indicateurs.
 */
import { z } from 'zod';
import { requireUser } from '../../core/auth.js';
import { parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { definePlugin } from '../types.js';
import { DOCUMENT_CATEGORIES, DOCUMENT_CATEGORY_CODES, DocumentService, type DocumentCategory } from './service.js';

const category = z.enum(DOCUMENT_CATEGORY_CODES as [DocumentCategory, ...DocumentCategory[]]);
const content = {
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(3).max(120).regex(/^[\w.+-]+\/[\w.+-]+$/),
  contentBase64: z.string().min(4).max(14_000_000),
  ocrText: z.string().max(200_000).optional(),
};
const motif = z.string().trim().min(3).max(1000);

export const documentsPlugin = definePlugin<DocumentService>({
  name: 'documents',
  create: (ctx) => new DocumentService(ctx),
  routes: (app, _ctx, svc) => {
    type P = { Params: { id: string } };
    app.get('/v1/documents/categories', async (req) => {
      authorize(requireUser(req), 'documents:read');
      return Object.entries(DOCUMENT_CATEGORIES).map(([code, c]) => ({ code, label: c.label, auditProof: c.auditProof, keywords: c.keywords }));
    });
    app.get('/v1/documents/indicateurs', async (req) => {
      authorize(requireUser(req), 'documents:read');
      return svc.indicators();
    });
    app.get<{ Querystring: { category?: string; taxpayerId?: string; module?: string; ref?: string } }>('/v1/documents', async (req) => svc.list(requireUser(req), req.query));
    app.post('/v1/documents', { bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => reply.code(201).send(svc.upload(requireUser(req), parse(z.object({
      title: z.string().trim().min(3).max(200), ...content, category: category.optional(),
      link: z.object({ module: z.string().min(2).max(40), ref: z.string().min(1).max(100) }).strict().optional(), taxpayerId: z.string().min(1).max(60).optional(),
    }).strict(), req.body))));
    app.get<P>('/v1/documents/:id', async (req) => {
      const u = requireUser(req);
      const d = svc.get(req.params.id);
      authorize(u, 'documents:read', d.taxpayerId ? { taxpayerId: d.taxpayerId } : {});
      return svc.view(d);
    });
    app.get<{ Params: { id: string }; Querystring: { version?: string } }>('/v1/documents/:id/contenu', async (req) => svc.content(requireUser(req), req.params.id, req.query.version ? Number(req.query.version) : undefined));
    app.post<P>('/v1/documents/:id/versions', { bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => reply.code(201).send(svc.addVersion(requireUser(req), req.params.id, parse(z.object(content).strict(), req.body))));
    app.post<P>('/v1/documents/:id/classification', async (req) => svc.confirmClassification(requireUser(req), req.params.id, parse(z.object({ category, motif }).strict(), req.body)));
    app.post<P>('/v1/documents/:id/gel-juridique', async (req) => svc.setLegalHold(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif));
    app.post<P>('/v1/documents/:id/exports', async (req, reply) => reply.code(201).send(svc.requestExport(requireUser(req), req.params.id, parse(z.object({ motif }).strict(), req.body).motif)));
    app.get<{ Params: { token: string } }>('/v1/documents/exports/:token', async (req) => svc.fetchExport(requireUser(req), req.params.token));
    app.post('/v1/documents/filigranes/verification', async (req) => {
      authorize(requireUser(req), 'documents:read');
      return { valid: svc.verifyWatermark(parse(z.object({ text: z.string().min(1).max(2000), signature: z.string().regex(/^[0-9a-f]{64}$/), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(), req.body)) };
    });
    app.get('/v1/documents/purges/apercu', async (req) => svc.purgePreview(requireUser(req)));
    app.post('/v1/documents/purges', async (req, reply) => reply.code(201).send(svc.proposePurge(requireUser(req), parse(z.object({ documentIds: z.array(z.string().min(1)).min(1).max(500), motif }).strict(), req.body))));
    app.post<P>('/v1/documents/purges/:id/decision', async (req) => svc.decidePurge(requireUser(req), req.params.id, parse(z.object({ approve: z.boolean(), motif }).strict(), req.body)));
    app.post('/v1/documents/integrite/verification', async (req) => svc.verifyIntegrity(requireUser(req)));
  },
});

export { DocumentService } from './service.js';
