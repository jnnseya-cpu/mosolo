/**
 * TLS mutuel (mTLS) pour les partenaires sensibles, les points de paiement agréés et les terminaux (§ 30.1, § 31.1).
 *
 * Désactivé par défaut (MOSOLO_MTLS_MODE absent ou « off ») : le comportement historique est inchangé.
 *  - « direct » : le serveur termine lui-même TLS (MOSOLO_TLS_CERT_FILE, MOSOLO_TLS_KEY_FILE, MOSOLO_TLS_CA_FILE
 *    facultatif) et DEMANDE un certificat client ; l'empreinte SHA-256 du certificat présenté est lue sur la socket.
 *  - « proxy » : TLS terminé par le mandataire inverse, qui transmet l'empreinte du certificat client vérifié dans
 *    l'en-tête MOSOLO_MTLS_HEADER (défaut x-client-cert-sha256). Le mandataire DOIT supprimer cet en-tête s'il est
 *    fourni par le client (configuration d'infrastructure).
 * Liste d'autorisation : MOSOLO_MTLS_ALLOWLIST = « empreinte[=libellé],… » (hexadécimal, deux-points facultatifs).
 * Routes protégées : MOSOLO_MTLS_PATHS (préfixes séparés par des virgules) ; défaut : rappels des prestataires, points
 * de paiement agréés, synchronisation des terminaux et contrôles hors ligne des titres.
 * Toute présentation refusée est journalisée (qui, quoi, pourquoi) et renvoie 403.
 */
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { ConfigurationError } from '../../core/auth.js';
import { forbidden } from '../../core/errors.js';

export type MtlsMode = 'off' | 'direct' | 'proxy';

export const DEFAULT_MTLS_PATHS = ['/v1/providers/', '/v1/payment-points/', '/v1/field-sync/', '/v1/titres/hors-ligne/'];

export interface MtlsConfig {
  mode: MtlsMode;
  header: string;
  /** Empreinte normalisée (hexadécimal minuscule sans séparateur) → libellé. */
  allow: Map<string, string>;
  paths: string[];
}

export const normalizeFingerprint = (fp: string): string => fp.replace(/[^0-9a-fA-F]/g, '').toLowerCase();

export function mtlsFromEnv(env: NodeJS.ProcessEnv = process.env): MtlsConfig {
  const raw = (env.MOSOLO_MTLS_MODE ?? 'off').trim().toLowerCase();
  if (!['off', 'direct', 'proxy', ''].includes(raw)) throw new ConfigurationError(`MOSOLO_MTLS_MODE invalide : « ${raw} » (off, direct ou proxy).`);
  const mode = (raw || 'off') as MtlsMode;
  const allow = new Map<string, string>();
  for (const item of (env.MOSOLO_MTLS_ALLOWLIST ?? '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const [fp, label] = item.split('=');
    const n = normalizeFingerprint(fp ?? '');
    if (n.length !== 64) throw new ConfigurationError(`MOSOLO_MTLS_ALLOWLIST : empreinte SHA-256 invalide (${item.slice(0, 20)}…).`);
    allow.set(n, (label ?? '').trim() || n.slice(0, 12));
  }
  if (mode !== 'off' && allow.size === 0) throw new ConfigurationError('mTLS activé sans liste d’autorisation (MOSOLO_MTLS_ALLOWLIST) : aucun partenaire ne pourrait se connecter.');
  const paths = (env.MOSOLO_MTLS_PATHS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { mode, header: (env.MOSOLO_MTLS_HEADER ?? 'x-client-cert-sha256').trim().toLowerCase(), allow, paths: paths.length ? paths : DEFAULT_MTLS_PATHS };
}

/** Options HTTPS du serveur (mode « direct ») : certificat client DEMANDÉ, vérifié par la liste d'autorisation. */
export function httpsOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): { key: Buffer; cert: Buffer; ca?: Buffer; requestCert: true; rejectUnauthorized: false } | null {
  const certFile = env.MOSOLO_TLS_CERT_FILE?.trim();
  const keyFile = env.MOSOLO_TLS_KEY_FILE?.trim();
  if (!certFile || !keyFile) return null;
  const caFile = env.MOSOLO_TLS_CA_FILE?.trim();
  return { key: readFileSync(keyFile), cert: readFileSync(certFile), ...(caFile ? { ca: readFileSync(caFile) } : {}), requestCert: true, rejectUnauthorized: false };
}

/** Empreinte du certificat client présenté (socket TLS ou en-tête du mandataire selon le mode). */
export function clientFingerprint(req: FastifyRequest, cfg: MtlsConfig): string | null {
  if (cfg.mode === 'proxy') {
    const v = req.headers[cfg.header];
    const s = Array.isArray(v) ? v[0] : v;
    return s ? normalizeFingerprint(s) : null;
  }
  if (cfg.mode === 'direct') {
    const sock = req.raw.socket as { getPeerCertificate?: () => { fingerprint256?: string } };
    const fp = sock.getPeerCertificate?.()?.fingerprint256;
    return fp ? normalizeFingerprint(fp) : null;
  }
  return null;
}

/** Garde mTLS : sur les préfixes protégés, un certificat client de la liste d'autorisation est exigé. */
export function installMtls(app: FastifyInstance, ctx: AppContext, cfg: MtlsConfig): void {
  if (cfg.mode === 'off') return;
  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0] ?? '';
    if (!cfg.paths.some((p) => path.startsWith(p))) return;
    const fp = clientFingerprint(req, cfg);
    const label = fp ? cfg.allow.get(fp) : undefined;
    if (label) return;
    ctx.audit.append({
      actor: { kind: 'public', id: fp ? `certificat:${fp.slice(0, 16)}` : 'sans-certificat' }, action: 'socle.mtls.refused', resourceType: 'route',
      resourceId: `${req.method} ${path}`, outcome: 'DENIED', details: { mode: cfg.mode, reason: fp ? 'CERTIFICAT_NON_AUTORISE' : 'CERTIFICAT_ABSENT' },
    });
    throw forbidden('MTLS_REQUIRED', fp ? 'Certificat client non autorisé pour cette interface.' : 'Certificat client (TLS mutuel) requis pour cette interface.');
  });
}

export function mtlsStatus(cfg: MtlsConfig) {
  return { mode: cfg.mode, paths: cfg.paths, allowed: [...cfg.allow.entries()].map(([fp, label]) => ({ label, fingerprint: `${fp.slice(0, 16)}…` })) };
}
