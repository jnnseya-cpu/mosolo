#!/usr/bin/env node
/**
 * Test de charge « pic de campagne de fin janvier » (Document maître FR 2, ch. 45 : « Tests de charge calés sur les
 * pics de campagne de fin janvier ») — Node.js seul (fetch natif, aucune dépendance), à lancer contre un serveur
 * LOCAL en démonstration. JAMAIS exécuté en intégration continue ; JAMAIS contre la production.
 * Complète, sans le remplacer, le scénario k6 tools/charge/pic-fevrier.k6.js.
 *
 * Parcours simulés (les plus sollicités au pic) : vérification publique d'une quittance, création d'une référence de
 * paiement par le contribuable (idempotente), session USSD, points de paiement agréés et tableau public de
 * transparence. Un 429 (limitation de débit, anti-énumération) est une protection attendue, comptée à part ; de même le
 * 409 ACTIVE_PAYMENT_REFERENCE_EXISTS (une seule référence active par obligation : le jeu de démonstration n'en a qu'une).
 *
 * Profil : palier moyen → montée au pic → plateau → descente. Le trafic moyen (VU_MOYEN) et le facteur de pic
 * (PIC_FACTEUR) sont des HYPOTHÈSES DE TEST — par défaut, à confirmer par le maître d'ouvrage sur la base de
 * référence (§ 38.1). Seuils de réussite (erreurs < 1 %, p95 < 1 500 ms) : par défaut, à confirmer par l'exploitant.
 *
 * Lancement :
 *   npm run dev -w backend                      # serveur de démonstration local
 *   node tools/charge/pic-fin-janvier.mjs --base http://localhost:8080 --vu-moyen 5 --pic-facteur 20 --palier 60
 * Options : --base, --vu-moyen, --pic-facteur, --palier (secondes par palier), --json (rapport JSON seul).
 * Code de sortie : 0 si les seuils sont tenus, 1 sinon, 2 si le serveur est injoignable.
 */

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage : node tools/charge/pic-fin-janvier.mjs [--base URL] [--vu-moyen N] [--pic-facteur N] [--palier secondes] [--json]');
  process.exit(0);
}

export const BASE = opt('base', process.env.BASE_URL ?? 'http://localhost:8080');
export const VU_MOYEN = Number(opt('vu-moyen', process.env.VU_MOYEN ?? 5));
export const PIC_FACTEUR = Number(opt('pic-facteur', process.env.PIC_FACTEUR ?? 20));
const PALIER_S = Number(opt('palier', process.env.PALIER_S ?? 60));
const JSON_ONLY = args.includes('--json');
/** Seuils par défaut — à confirmer par l'exploitant. */
const SEUILS = { tauxErreurMax: 0.01, p95MaxMs: 1500 };

const PALIERS = [
  { nom: 'moyen', vu: VU_MOYEN },
  { nom: 'montée', vu: Math.round((VU_MOYEN + VU_MOYEN * PIC_FACTEUR) / 2) },
  { nom: 'pic', vu: VU_MOYEN * PIC_FACTEUR },
  { nom: 'descente', vu: VU_MOYEN },
];

const stats = new Map();
function record(parcours, ms, status, attendus = []) {
  const s = stats.get(parcours) ?? { n: 0, erreurs: 0, protections: 0, durees: [] };
  s.n += 1;
  if (status === 429 || attendus.includes(status)) s.protections += 1;
  else if (status === 0 || status >= 400) s.erreurs += 1;
  s.durees.push(ms);
  stats.set(parcours, s);
}

/** Percentile (méthode du rang le plus proche). */
export function percentile(values, p) {
  if (!values.length) return null;
  const xs = [...values].sort((a, b) => a - b);
  return xs[Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1))];
}

async function call(parcours, method, path, body, headers = {}, attendus = []) {
  const t0 = performance.now();
  let status = 0;
  try {
    const r = await fetch(`${BASE}${path}`, {
      method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    status = r.status;
    await r.arrayBuffer();
  } catch {
    status = 0;
  }
  record(parcours, performance.now() - t0, status, attendus);
  return status;
}

let seq = 0;
async function iteration(ctx) {
  await call('verification', 'GET', '/v1/public/receipts/Q26KIN0000000000');
  if (ctx.obligationId) {
    await call('paiement', 'POST', `/v1/obligations/${ctx.obligationId}/payment-orders`, { channel: 'MOBILE_MONEY' }, { 'x-demo-user': 'u-contribuable', 'idempotency-key': `charge-${process.pid}-${Date.now()}-${seq++}` }, [409]);
  }
  const msisdn = `+2438${String(10_000_000 + (seq++ % 89_999_999)).slice(0, 8)}`;
  await call('ussd', 'POST', '/v1/ussd/sessions', { msisdn, lang: 'fr' });
  await call('public', 'GET', '/v1/public/payment-points');
  await call('public', 'GET', '/v1/public/transparency');
}

async function palier(ctx, vu, secondes) {
  const fin = Date.now() + secondes * 1000;
  const worker = async () => { while (Date.now() < fin) { await iteration(ctx); await new Promise((r) => setTimeout(r, 1000)); } };
  await Promise.all(Array.from({ length: vu }, worker));
}

async function main() {
  try {
    const h = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
    if (!h.ok) throw new Error(`santé ${h.status}`);
  } catch (e) {
    console.error(`Serveur injoignable (${BASE}) : ${e instanceof Error ? e.message : e}. Lancer d'abord « npm run dev -w backend ».`);
    process.exit(2);
  }
  let obligationId = null;
  try {
    const r = await fetch(`${BASE}/v1/obligations`, { headers: { 'x-demo-user': 'u-contribuable' } });
    const b = await r.json();
    const list = Array.isArray(b) ? b : b.items ?? [];
    obligationId = list.length ? list[0].id : null;
  } catch { obligationId = null; }
  const ctx = { obligationId };
  const debut = Date.now();
  for (const p of PALIERS) {
    if (!JSON_ONLY) console.log(`Palier « ${p.nom} » : ${p.vu} utilisateurs virtuels pendant ${PALIER_S} s…`);
    await palier(ctx, p.vu, PALIER_S);
  }
  const parcours = [...stats.entries()].map(([nom, s]) => ({
    parcours: nom, requetes: s.n, erreurs: s.erreurs, protections: s.protections,
    tauxErreur: s.n ? s.erreurs / s.n : 0, p50ms: Math.round(percentile(s.durees, 50) ?? 0), p95ms: Math.round(percentile(s.durees, 95) ?? 0),
  }));
  const toutes = [...stats.values()];
  const total = toutes.reduce((a, s) => a + s.n, 0);
  const erreurs = toutes.reduce((a, s) => a + s.erreurs, 0);
  const p95 = Math.round(percentile(toutes.flatMap((s) => s.durees), 95) ?? 0);
  const rapport = {
    base: BASE, hypotheses: { VU_MOYEN, PIC_FACTEUR, PALIER_S, statut: 'par défaut — à confirmer par le maître d’ouvrage' },
    dureeS: Math.round((Date.now() - debut) / 1000), total, tauxErreur: total ? erreurs / total : 0, p95ms: p95, seuils: SEUILS, parcours,
  };
  const ok = rapport.tauxErreur < SEUILS.tauxErreurMax && p95 < SEUILS.p95MaxMs;
  console.log(JSON.stringify({ ...rapport, resultat: ok ? 'SEUILS_TENUS' : 'SEUILS_DEPASSES' }, null, JSON_ONLY ? 0 : 2));
  process.exit(ok ? 0 : 1);
}

// Exécution seulement en ligne de commande (import possible pour réutiliser `percentile`).
if (import.meta.url === `file://${process.argv[1]}`) void main();
