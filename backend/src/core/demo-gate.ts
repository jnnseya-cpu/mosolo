/**
 * Accès restreint à une DÉMONSTRATION hébergée (troisième passe GO / NO-GO, 28/09/2026, défaut D3-06).
 *
 * En mode démonstration, l'en-tête `x-demo-user` permet de se présenter sous n'importe quel rôle (c'est le principe du
 * sélecteur de démonstration). Un service de démonstration ouvert à tous sur Internet laisse donc n'importe qui agir
 * comme Gouverneur, Trésor ou administrateur sur les données fictives. Ce garde AJOUTE (sans rien retirer) un mot de
 * passe d'accès commun, en authentification HTTP « Basic » gérée nativement par les navigateurs :
 *
 *  - actif SEULEMENT en mode démonstration ET si `MOSOLO_DEMO_ACCESS_PASSWORD` est renseignée (sinon : comportement
 *    inchangé) ; hors démonstration, la variable est sans effet (l'authentification réelle s'applique) ;
 *  - mot de passe d'au moins 12 caractères (sinon refus de démarrer) ; comparaison à temps constant ; jamais journalisé ;
 *  - exemptés : sonde `/health` (Cloud Run, Docker), requêtes CORS `OPTIONS`, webhooks signés des prestataires ;
 *  - après un accès réussi, un témoin (cookie) HttpOnly SameSite=Strict est posé : les requêtes de l'application qui
 *    portent leur propre en-tête `Authorization: Bearer` (connexion par code) restent admises sans nouvelle saisie.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ConfigurationError, isDemoMode } from './auth.js';

export const DEMO_ACCESS_ENV = 'MOSOLO_DEMO_ACCESS_PASSWORD';
export const DEMO_ACCESS_COOKIE = 'mosolo_demo_acces';
const MIN_LENGTH = 12;

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Mot de passe d'accès configuré (null : garde inactif). Refus explicite d'un mot de passe trop court. */
export function demoAccessPassword(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env[DEMO_ACCESS_ENV]?.trim();
  if (!v || !isDemoMode(env)) return null;
  if (v.length < MIN_LENGTH) throw new ConfigurationError(`${DEMO_ACCESS_ENV} : au moins ${MIN_LENGTH} caractères (mot de passe d'accès à la démonstration).`);
  return v;
}

function exempt(method: string, url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return method === 'OPTIONS' || path === '/health' || /^\/v1\/providers\/[^/]+\/webhooks$/.test(path);
}

/** Installe le garde (premier crochet utile, avant la résolution de l'utilisateur de démonstration). */
export function installDemoAccessGate(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): boolean {
  const password = demoAccessPassword(env);
  if (!password) return false;
  const expected = digest(password);
  const cookieValue = createHmac('sha256', password).update('mosolo-demo-acces/1').digest('hex');
  const expectedCookie = digest(cookieValue);
  app.addHook('onRequest', async (req, reply) => {
    if (exempt(req.method, req.url)) return;
    const cookies = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
    const c = new RegExp(`(?:^|;\\s*)${DEMO_ACCESS_COOKIE}=([0-9a-f]{64})`).exec(cookies);
    if (c && timingSafeEqual(digest(c[1]!), expectedCookie)) return;
    const h = req.headers.authorization;
    const m = typeof h === 'string' ? /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(h.trim()) : null;
    if (m) {
      const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
      const given = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
      if (timingSafeEqual(digest(given), expected)) {
        // L'en-tête Basic n'est pas un jeton de session : retiré avant l'authentification des routes.
        delete req.headers.authorization;
        const secure = req.protocol === 'https' ? '; Secure' : '';
        void reply.header('set-cookie', `${DEMO_ACCESS_COOKIE}=${cookieValue}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`);
        return;
      }
    }
    return reply.code(401).header('www-authenticate', 'Basic realm="KINSHASA MOSOLO - demonstration", charset="UTF-8"')
      .type('application/problem+json')
      .send({ type: 'urn:mosolo:probleme:demo-access-required', title: 'Accès à la démonstration', status: 401, code: 'DEMO_ACCESS_REQUIRED', detail: 'Démonstration à accès restreint : saisissez le mot de passe communiqué par l’équipe du projet.' });
  });
  return true;
}
