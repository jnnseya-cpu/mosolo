/**
 * Routes « preuves » : vérification universelle (JSON), pages légères sans JavaScript (/l), SMS entrant, WhatsApp.
 * Les passerelles SMS et WhatsApp sont authentifiées par signature HMAC du corps brut (secret de l'opérateur) ;
 * sans secret configuré, elles ne répondent qu'en mode démonstration (simulateur).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { isDemoMode } from '../../core/auth.js';
import { ApiError, forbidden } from '../../core/errors.js';
import { header, parse } from '../../core/http.js';
import { ext } from '../types.js';
import type { CanauxService } from '../canaux/service.js';
import { PILOT_COMMUNES } from '../canaux/model.js';
import type { IntegriteService } from '../integrite/service.js';
import * as lite from './lite.js';
import type { PreuvesService } from './service.js';
import type { WhatsAppAssistant } from './whatsapp.js';

/**
 * Clé du limiteur anti-énumération : `req.ip` seulement. Jamais X-Forwarded-For lu directement (un client en changerait
 * à chaque requête pour contourner la limite) ; derrière un mandataire inverse, Fastify le résout via MOSOLO_TRUST_PROXY.
 */
function clientKey(req: FastifyRequest): string {
  return `ip:${req.ip || 'inconnu'}`;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex'); const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Passerelle opérateur : HMAC-SHA256(secret, corps brut) ; démonstration seulement si aucun secret n'est configuré. */
export function gatewayGuard(req: FastifyRequest, secret: string | undefined, headerName: string, prefix = ''): { simulated: boolean } {
  if (!secret) {
    if (!isDemoMode()) throw forbidden('GATEWAY_NOT_CONFIGURED', 'Passerelle non configurée : secret de signature absent (production).');
    return { simulated: true };
  }
  const got = (header(req, headerName) ?? '').replace(prefix, '');
  const want = createHmac('sha256', secret).update(req.rawBody ?? '').digest('hex');
  if (!sameHex(got, want)) throw forbidden('BAD_SIGNATURE', 'Signature de la passerelle invalide.');
  return { simulated: false };
}

/** Pages légères : aucun script, aucune ressource externe — la politique de sécurité du contenu l'impose au navigateur. */
const LITE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const html = (reply: FastifyReply, body: string, status = 200) =>
  reply.code(status).type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', LITE_CSP).send(body);
const msisdn = z.string().trim().regex(/^\+?[0-9]{8,15}$/, 'numéro attendu');

export function registerPreuvesRoutes(app: FastifyInstance, ctx: AppContext, svc: PreuvesService, wa: WhatsAppAssistant): void {
  // Formulaires des pages légères (sans JavaScript) : application/x-www-form-urlencoded.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    req.rawBody = raw;
    done(null, Object.fromEntries(new URLSearchParams(raw)));
  });

  // ---------- Vérification universelle (application, impression) ----------
  app.get<{ Params: { code: string } }>('/v1/public/preuves/:code', async (req) => svc.resolve(req.params.code, clientKey(req), 'WEB'));
  // Forme par paramètre de requête : jetons signés de QR statique (plus longs que la limite d'un segment de chemin).
  app.get<{ Querystring: { c?: string } }>('/v1/public/preuves', async (req) => svc.resolve(String(req.query.c ?? '').slice(0, 600), clientKey(req), 'WEB'));
  app.get<{ Params: { code: string } }>('/v1/public/preuves/:code/impression', async (req) => {
    const r = svc.resolve(req.params.code, clientKey(req), 'IMPRIME');
    ctx.audit.append({ actor: { kind: 'public', id: 'impression' }, action: 'proof.printed', resourceType: 'proof', resourceId: `${r.kind}:${r.code}`, details: { found: r.found } });
    return { ...r, printedAt: ctx.clock.now().toISOString(), channels: channelsInfo() };
  });

  // ---------- SMS entrant (secours universel, téléphone basique) ----------
  app.post('/v1/sms/inbound', async (req) => {
    const g = gatewayGuard(req, process.env.SMS_GATEWAY_SECRET, 'x-mosolo-signature');
    const b = parse(z.object({ from: msisdn, text: z.string().trim().min(1).max(640) }).strict(), req.body);
    return { ...smsReply(ctx, svc, b.from, b.text), simulated: g.simulated };
  });

  // ---------- WhatsApp (API officielle du fournisseur contractualisé) ----------
  app.get<{ Querystring: Record<string, string> }>('/v1/whatsapp/webhook', async (req, reply) => {
    const q = req.query;
    const token = process.env.WHATSAPP_VERIFY_TOKEN;
    if (q['hub.mode'] === 'subscribe' && token && typeof q['hub.verify_token'] === 'string' && sameText(q['hub.verify_token'], token)) return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    throw forbidden('BAD_VERIFY_TOKEN', 'Jeton de vérification du webhook invalide.');
  });
  app.post('/v1/whatsapp/webhook', async (req) => {
    const g = gatewayGuard(req, process.env.WHATSAPP_APP_SECRET, 'x-hub-signature-256', 'sha256=');
    const msgs = extractWhatsApp(req.body);
    if (!msgs.length) throw new ApiError(400, 'NO_MESSAGE', 'Aucun message texte dans la requête.');
    const results = msgs.map((m) => ({ to: m.from, ...wa.handle(m.from, m.text) }));
    return { results, simulated: g.simulated };
  });
  // Historique d'une conversation de démonstration (simulateur uniquement).
  app.get<{ Params: { msisdn: string } }>('/v1/whatsapp/simulator/:msisdn', async (req) => {
    if (!isDemoMode()) throw forbidden('SIMULATION_FORBIDDEN', 'Simulateur disponible en démonstration uniquement.');
    const c = wa.conversations.get(req.params.msisdn);
    return { conversation: c ?? null };
  });

  // ---------- Pages légères (/l) ----------
  app.get('/l', async (_req, reply) => html(reply, lite.home()));
  app.get<{ Querystring: { c?: string } }>('/l/v', async (req, reply) => {
    const c = (req.query.c ?? '').trim();
    if (!c) return html(reply, lite.home());
    try {
      return html(reply, lite.result(svc.resolve(c, clientKey(req), 'LITE')));
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) return html(reply, lite.page('Trop de vérifications', '<p>Trop de vérifications depuis cet appareil. Réessayez dans quelques minutes.</p><p><a href="/l">Accueil</a></p>'), 429);
      throw e;
    }
  });
  app.get<{ Querystring: { c?: string } }>('/l/imprimer', async (req, reply) => {
    // Adresse du QR imprimé : MOSOLO_PUBLIC_URL. L'en-tête Host (choisi par le client) n'est utilisé qu'en démonstration :
    // sinon un domaine tiers pointant sur ce serveur produirait un document officiel renvoyant vers lui (hameçonnage).
    const base = process.env.MOSOLO_PUBLIC_URL?.trim().replace(/\/+$/, '') || (isDemoMode() ? `${req.protocol}://${req.headers.host ?? 'localhost'}` : null);
    if (!base) return html(reply, lite.page('Impression indisponible', '<p>Version imprimable indisponible : adresse publique officielle non configurée (MOSOLO_PUBLIC_URL).</p><p><a href="/l">Accueil</a></p>'), 503);
    const r = svc.resolve((req.query.c ?? '').trim(), clientKey(req), 'IMPRIME');
    return html(reply, await lite.printable(r, base));
  });
  app.get<{ Querystring: { commune?: string } }>('/l/points', async (req, reply) => {
    const commune = PILOT_COMMUNES.find((c) => c === req.query.commune);
    const list = commune ? ext<CanauxService>(ctx, 'canaux').points.publicList(commune).filter((p) => p.status === 'ACTIF') : [];
    return html(reply, lite.points(commune, list));
  });
  app.get('/l/payer', async (_req, reply) => html(reply, lite.howToPay()));
  app.get('/l/signaler', async (_req, reply) => html(reply, lite.reportForm()));
  app.post('/l/signaler', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const text = String(b.t ?? '').trim();
    if (text.length < 5) return html(reply, lite.reportForm(null, 'Décrivez les faits en quelques mots (5 caractères au moins).'), 400);
    const integ = ctx.ext.integrite as IntegriteService | undefined;
    if (!integ) return html(reply, lite.reportForm(null, 'Service de signalement indisponible.'), 503);
    // Page légère : pas de contact collecté → signalement anonyme, suivi par code.
    const r = integ.submit({ category: 'AUTRE', description: text.slice(0, 600), anonymous: true }, 'WEB', 'public');
    return html(reply, lite.reportForm({ reference: r.reference, trackingCode: r.trackingCode }));
  });
}

function channelsInfo() {
  return {
    ussd: '*[code court À RACCORDER — convention opérateur requise]#', sms: 'SMS « V <code> » au [numéro court À RACCORDER — convention opérateur requise]', whatsapp: 'WhatsApp : compte certifié MOSOLO [numéro À RACCORDER — convention requise]',
    lite: '/l — version légère sans application',
  };
}

/** Commandes SMS : « V <code> », « SIGNAL … », « POINTS <commune> », « AIDE ». Réponses sans accents (GSM-7). */
export function smsReply(ctx: AppContext, svc: PreuvesService, from: string, text: string): { reply: string; command: string } {
  const words = text.trim().split(/\s+/);
  const head = (words[0] ?? '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (['V', 'VERIF', 'VERIFIER', 'VERIFY', 'CODE'].includes(head) && words[1]) {
    return { command: 'VERIFIER', reply: svc.smsText(svc.resolve(words.slice(1).join(''), `sms:${from}`, 'SMS')) };
  }
  if (head === 'SIGNAL' && ctx.ext.integrite) {
    const r = (ctx.ext.integrite as IntegriteService).fromSms({ from, text });
    return { command: 'SIGNAL', reply: r.reply.normalize('NFD').replace(/[̀-ͯ]/g, '') };
  }
  if (head === 'POINTS' || head === 'PAYER') {
    const commune = PILOT_COMMUNES.find((c) => c.toUpperCase() === (words[1] ?? '').toUpperCase());
    if (!commune) return { command: 'POINTS', reply: `MOSOLO: envoyez POINTS suivi de la commune (${PILOT_COMMUNES.join(', ')}).` };
    const pts = ext<CanauxService>(ctx, 'canaux').points.publicList(commune).filter((p) => p.status === 'ACTIF').slice(0, 3);
    const list = pts.map((p) => `${p.name}, ${p.address}`).join(' / ') || 'aucun point actif';
    return { command: 'POINTS', reply: `MOSOLO ${commune}: ${list}. Aucun agent ne recoit d'especes.`.normalize('NFD').replace(/[̀-ͯ]/g, '').slice(0, 320) };
  }
  // Un code seul est vérifié directement.
  if (words.length === 1 && head.length >= 6 && /\d/.test(head)) return { command: 'VERIFIER', reply: svc.smsText(svc.resolve(words[0]!, `sms:${from}`, 'SMS')) };
  return { command: 'AIDE', reply: 'MOSOLO: V <code> pour verifier un ticket, une place, une quittance ou un badge. POINTS <commune> pour payer. SIGNAL <faits> pour denoncer. Gratuit.' };
}

/** Accepte le format simplifié du simulateur ({ from, text }) et celui de l'API WhatsApp Business (entry/changes/messages). */
export function extractWhatsApp(body: unknown): { from: string; text: string }[] {
  const b = body as Record<string, unknown> | undefined;
  if (b && typeof b.from === 'string' && typeof b.text === 'string') {
    const from = parse(msisdn, b.from);
    return [{ from, text: b.text.slice(0, 640) }];
  }
  const out: { from: string; text: string }[] = [];
  const entries = Array.isArray(b?.entry) ? (b!.entry as Record<string, unknown>[]) : [];
  for (const e of entries) {
    for (const ch of (Array.isArray(e.changes) ? e.changes : []) as Record<string, unknown>[]) {
      const value = ch.value as Record<string, unknown> | undefined;
      for (const m of (Array.isArray(value?.messages) ? value!.messages : []) as Record<string, unknown>[]) {
        const t = (m.text as { body?: unknown } | undefined)?.body;
        if (typeof m.from === 'string' && typeof t === 'string' && /^\+?[0-9]{8,15}$/.test(m.from)) out.push({ from: m.from, text: t.slice(0, 640) });
      }
    }
  }
  return out;
}
