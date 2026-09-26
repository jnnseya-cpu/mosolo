/**
 * Limitation de débit (§ 25.1 « limites par canal et par acteur », § 30.1) — fenêtre glissante par compteurs pondérés :
 *   estimation = compteur de la fenêtre précédente × (1 − fraction écoulée) + compteur de la fenêtre courante.
 * Clé : utilisateur authentifié (`u:<id>`) sinon adresse IP (`ip:<adresse>`). Trois paliers : global, public, authentification.
 * Dépassement : 429 au format RFC 9457 + en-têtes Retry-After / RateLimit-* ; premier refus d'une fenêtre journalisé dans l'audit.
 * Aucune sanction : la limitation est temporaire et automatique, elle ne bloque aucun compte.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../core/errors.js';

export interface RateLimitTier {
  /** Requêtes autorisées par fenêtre. */
  limit: number;
  windowMs: number;
}

export interface RateLimitConfig {
  enabled: boolean;
  global: RateLimitTier;
  /** Routes publiques sans authentification (/v1/public/*, vérifications). */
  public: RateLimitTier;
  /** Connexion et codes à usage unique (/v1/auth/login, /v1/auth/otp) — par IP. */
  auth: RateLimitTier;
  /** Chemins exemptés (sonde de vie). */
  exempt: string[];
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  enabled: true,
  global: { limit: 600, windowMs: 60_000 },
  public: { limit: 60, windowMs: 60_000 },
  auth: { limit: 10, windowMs: 60_000 },
  exempt: ['/health'],
};

/** Configuration depuis l'environnement. Sous vitest, désactivée sauf MOSOLO_RATE_LIMIT=on (tests des autres lots). */
export function rateLimitFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  const flag = (env.MOSOLO_RATE_LIMIT ?? '').trim().toLowerCase();
  const enabled = flag === 'off' ? false : flag === 'on' ? true : !env.VITEST;
  const num = (v: string | undefined, d: number) => {
    const n = Number.parseInt(v ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    ...DEFAULT_RATE_LIMITS,
    enabled,
    global: { limit: num(env.MOSOLO_RATE_LIMIT_GLOBAL, DEFAULT_RATE_LIMITS.global.limit), windowMs: 60_000 },
    public: { limit: num(env.MOSOLO_RATE_LIMIT_PUBLIC, DEFAULT_RATE_LIMITS.public.limit), windowMs: 60_000 },
    auth: { limit: num(env.MOSOLO_RATE_LIMIT_AUTH, DEFAULT_RATE_LIMITS.auth.limit), windowMs: 60_000 },
  };
}

interface Counter {
  windowStart: number;
  current: number;
  previous: number;
  deniedLogged: boolean;
}

export class SlidingWindowLimiter {
  private readonly counters = new Map<string, Counter>();

  constructor(private readonly tier: RateLimitTier) {}

  /** Consomme une unité ; retourne l'état après consommation (ou le refus sans consommer). */
  hit(key: string, nowMs: number): { allowed: boolean; remaining: number; resetMs: number; retryAfterMs: number; firstDenial: boolean } {
    const { limit, windowMs } = this.tier;
    const start = Math.floor(nowMs / windowMs) * windowMs;
    let c = this.counters.get(key);
    if (!c) {
      c = { windowStart: start, current: 0, previous: 0, deniedLogged: false };
      this.counters.set(key, c);
    } else if (c.windowStart !== start) {
      c.previous = start - c.windowStart === windowMs ? c.current : 0;
      c.current = 0;
      c.windowStart = start;
      c.deniedLogged = false;
    }
    const elapsed = (nowMs - start) / windowMs;
    const estimate = c.previous * (1 - elapsed) + c.current;
    const resetMs = start + windowMs - nowMs;
    if (estimate + 1 > limit) {
      // Temps avant qu'une unité se libère : décroissance de la fenêtre précédente, sinon fin de fenêtre.
      let retryAfterMs = resetMs;
      if (c.previous > 0 && c.current < limit) {
        const needed = estimate + 1 - limit;
        retryAfterMs = Math.min(resetMs, Math.ceil((needed / c.previous) * windowMs));
      }
      const firstDenial = !c.deniedLogged;
      c.deniedLogged = true;
      return { allowed: false, remaining: 0, resetMs, retryAfterMs: Math.max(1000, retryAfterMs), firstDenial };
    }
    c.current++;
    if (this.counters.size > 50_000) this.prune(start);
    return { allowed: true, remaining: Math.max(0, Math.floor(limit - estimate - 1)), resetMs, retryAfterMs: 0, firstDenial: false };
  }

  private prune(currentStart: number): void {
    for (const [k, c] of this.counters) if (currentStart - c.windowStart > this.tier.windowMs) this.counters.delete(k);
  }
}

function tierOf(url: string): 'auth' | 'public' | 'global' {
  const path = url.split('?')[0] ?? url;
  if (path === '/v1/auth/login' || path === '/v1/auth/otp') return 'auth';
  if (path.startsWith('/v1/public/') || path.startsWith('/v1/verify') || path.startsWith('/.well-known/')) return 'public';
  return 'global';
}

export function clientKey(req: FastifyRequest): string {
  return req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
}

export function installRateLimit(app: FastifyInstance, ctx: AppContext, config: RateLimitConfig): void {
  if (!config.enabled) return;
  const limiters = {
    global: new SlidingWindowLimiter(config.global),
    public: new SlidingWindowLimiter(config.public),
    auth: new SlidingWindowLimiter(config.auth),
  };
  // Ajouté après le crochet d'identification (app.ts) : l'utilisateur est déjà résolu.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    const path = req.url.split('?')[0] ?? req.url;
    if (config.exempt.includes(path)) return;
    const now = ctx.clock.now().getTime();
    const tiers: ('auth' | 'public' | 'global')[] = tierOf(req.url) === 'global' ? ['global'] : [tierOf(req.url), 'global'];
    for (const t of tiers) {
      // Palier d'authentification : toujours par IP (on n'est pas encore authentifié).
      const key = t === 'auth' ? `ip:${req.ip}` : clientKey(req);
      const res = limiters[t].hit(`${t}|${key}`, now);
      const tier = config[t];
      if (t === tiers[0]) {
        reply.header('RateLimit-Limit', String(tier.limit));
        reply.header('RateLimit-Remaining', String(res.remaining));
        reply.header('RateLimit-Reset', String(Math.ceil(res.resetMs / 1000)));
      }
      if (!res.allowed) {
        const retryAfter = Math.ceil(res.retryAfterMs / 1000);
        reply.header('Retry-After', String(retryAfter));
        reply.header('RateLimit-Remaining', '0');
        if (res.firstDenial) {
          ctx.audit.append({
            actor: req.user ? { kind: 'user', id: req.user.id, roles: req.user.roles } : { kind: 'public', id: `ip:${req.ip}` },
            action: 'security.rate_limited', resourceType: 'route', resourceId: `${req.method} ${path}`, outcome: 'DENIED',
            details: { tier: t, limit: tier.limit, windowSeconds: tier.windowMs / 1000 },
          });
        }
        throw new ApiError(429, 'RATE_LIMITED', `Trop de requêtes : réessayez dans ${retryAfter} s.`, {
          retryAfter, limit: tier.limit, windowSeconds: tier.windowMs / 1000, tier: t,
        });
      }
    }
  });
}
