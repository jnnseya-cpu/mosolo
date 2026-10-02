/**
 * Test de charge « pic de campagne de fin janvier / février » (Cahier § 44 : « tests de charge calés sur les pics de
 * campagne de fin janvier »), outil k6 (https://k6.io).
 *
 * Parcours simulés (les plus sollicités au pic) :
 *  - vérification publique d'une quittance par code (anti-énumération : un 429 est une protection attendue, pas une erreur) ;
 *  - création d'une référence de paiement par le contribuable (idempotente) ;
 *  - session USSD (téléphone basique) ;
 *  - liste publique des points de paiement agréés et tableau public de transparence.
 *
 * Profil : montée jusqu'au pic, plateau, descente. Le facteur de pic (PIC_FACTEUR, défaut 20 × le trafic moyen) et le
 * trafic moyen (VU_MOYEN) sont des HYPOTHÈSES DE TEST à caler sur la base de référence (§ 38.1) — par défaut, à confirmer.
 *
 * Lancement :  k6 run -e BASE_URL=http://localhost:8080 tools/charge/pic-fevrier.k6.js
 * (serveur en démonstration : `npm run dev -w backend` ; ne JAMAIS viser la production).
 */
import http from 'k6/http';
import { check, group, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const VU_MOYEN = Number(__ENV.VU_MOYEN || 5);
const PIC_FACTEUR = Number(__ENV.PIC_FACTEUR || 20);
const PALIER = __ENV.PALIER || '1m';
const PIC = VU_MOYEN * PIC_FACTEUR;

export const options = {
  scenarios: {
    pic_fevrier: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: PALIER, target: VU_MOYEN },
        { duration: PALIER, target: PIC },
        { duration: PALIER, target: PIC },
        { duration: PALIER, target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  // Seuils de réussite du test (hypothèses à confirmer par l'exploitant) : erreurs < 1 %, p95 < 1,5 s.
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1500'],
    'checks{parcours:verification}': ['rate>0.99'],
    'checks{parcours:paiement}': ['rate>0.99'],
  },
};

// 429 (limitation de débit, anti-énumération) : réponse attendue au pic depuis une même adresse.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 429));

const json = { 'content-type': 'application/json' };
const uuid = () => `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${__VU}-${__ITER}`;

export function setup() {
  const h = http.get(`${BASE}/health`);
  check(h, { 'serveur disponible': (r) => r.status === 200 });
  // Obligation de démonstration du contribuable fictif (mode démonstration requis : en-tête x-demo-user).
  const obs = http.get(`${BASE}/v1/obligations`, { headers: { 'x-demo-user': 'u-contribuable' } });
  let obligationId = null;
  try {
    const body = obs.json();
    const list = Array.isArray(body) ? body : body.items || [];
    obligationId = list.length ? list[0].id : null;
  } catch (_e) {
    obligationId = null;
  }
  return { obligationId };
}

export default function (data) {
  group('verification', () => {
    const r = http.get(`${BASE}/v1/public/receipts/Q26KIN0000000000`, { tags: { parcours: 'verification' } });
    check(r, { 'vérification : réponse ou protection': (x) => x.status === 200 || x.status === 429 }, { parcours: 'verification' });
  });
  if (data.obligationId) {
    group('paiement', () => {
      const r = http.post(`${BASE}/v1/obligations/${data.obligationId}/payment-orders`, JSON.stringify({ channel: 'MOBILE_MONEY' }), {
        headers: { ...json, 'x-demo-user': 'u-contribuable', 'idempotency-key': uuid() }, tags: { parcours: 'paiement' },
      });
      check(r, { 'référence de paiement émise (ou protection)': (x) => x.status === 200 || x.status === 201 || x.status === 429 }, { parcours: 'paiement' });
    });
  }
  group('ussd', () => {
    const msisdn = `+2438${String(100000000 + ((__VU * 7919 + __ITER) % 99999999)).slice(0, 8)}`;
    const r = http.post(`${BASE}/v1/ussd/sessions`, JSON.stringify({ msisdn, lang: 'fr' }), { headers: json, tags: { parcours: 'ussd' } });
    check(r, { 'session USSD ouverte (ou protection)': (x) => x.status === 201 || x.status === 429 });
  });
  group('public', () => {
    check(http.get(`${BASE}/v1/public/payment-points`, { tags: { parcours: 'public' } }), { 'points agréés': (x) => x.status === 200 || x.status === 429 });
    check(http.get(`${BASE}/v1/public/transparency`, { tags: { parcours: 'public' } }), { transparence: (x) => x.status === 200 || x.status === 429 });
  });
  sleep(1);
}
