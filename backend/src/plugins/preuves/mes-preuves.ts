/**
 * « Mes preuves » (30/09/2026, demande du maître d'ouvrage) : en cas de contrôle, l'usager ouvre en UN CLIC toutes ses
 * preuves en cours de validité — stationnement en cours, titres et pass, vignettes, autorisations et permis, quitus,
 * supports publicitaires autorisés, gilet de conducteur, quittances — chacune avec son code de vérification, que
 * l'agent scanne ou saisit (résolveur universel des preuves : /preuve/<code>, SMS, WhatsApp, USSD, version légère).
 *
 * Lecture seulement, pour le TITULAIRE du compte (R30) ; chaque source garde ses propres droits : les listes sont lues
 * par les mêmes routes que les écrans de l'usager (appel interne avec les mêmes en-têtes d'authentification).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../core/auth.js';
import { forbidden } from '../../core/errors.js';

export interface MaPreuve {
  famille: 'STATIONNEMENT' | 'TITRE' | 'AUTORISATION' | 'QUITUS' | 'PUBLICITE' | 'CONDUCTEUR' | 'QUITTANCE';
  libelle: string;
  code: string;
  numero: string | null;
  sujet: string | null;
  valideDepuis: string | null;
  valideJusqua: string | null;
  montant: MoneyJSON | null;
}

const EN_TETES = ['authorization', 'x-demo-user', 'cookie', 'x-forwarded-for'] as const;
const QUITTANCES_MAX = 10;

export function registerMesPreuves(app: FastifyInstance, ctx: AppContext): void {
  /** Lecture interne d'une route de l'usager, avec ses propres droits ; toute erreur = source ignorée. */
  const lire = async <T>(req: FastifyRequest, url: string): Promise<T | null> => {
    const headers: Record<string, string> = {};
    for (const k of EN_TETES) { const v = req.headers[k]; if (typeof v === 'string') headers[k] = v; }
    const r = await app.inject({ method: 'GET', url, headers });
    return r.statusCode === 200 ? (r.json() as T) : null;
  };
  const encore = (until?: string | null) => !until || Date.parse(until) > ctx.clock.now().getTime();

  app.get('/v1/moi/preuves', async (req) => {
    const user = requireUser(req);
    const tid = user.taxpayerId;
    if (!tid || !user.roles.includes('R30')) throw forbidden('FORBIDDEN', '« Mes preuves » : réservé au titulaire d’un compte contribuable.');
    const preuves: MaPreuve[] = [];

    // 1. Stationnement en cours (le cas le plus fréquent de contrôle).
    const sessions = await lire<{ items: { status: string; ticketCode?: string; plate: string; zone?: { name?: string }; startAt?: string; paidUntil?: string; total?: MoneyJSON[] }[] }>(req, '/v1/parking/sessions/mine');
    for (const s of sessions?.items ?? []) {
      if (s.status !== 'ACTIVE' || !s.ticketCode) continue;
      preuves.push({ famille: 'STATIONNEMENT', libelle: `Stationnement en cours — ${s.zone?.name ?? 'zone'}`, code: s.ticketCode, numero: null, sujet: s.plate, valideDepuis: s.startAt ?? null, valideJusqua: s.paidUntil ?? null, montant: s.total?.[0] ?? null });
    }
    // 2. Titres, pass, abonnements, vignettes (module des titres).
    const titres = await lire<{ shortCode: string; number: string; typeLabel: string; state: string; validFrom?: string; validUntil?: string; subject?: { plate?: string; label?: string }; amount?: MoneyJSON }[]>(req, '/v1/titres');
    for (const t of titres ?? []) {
      if (!['EMIS', 'ACTIF', 'VALIDE'].includes(t.state) || !encore(t.validUntil)) continue;
      preuves.push({ famille: 'TITRE', libelle: t.typeLabel, code: t.shortCode, numero: t.number, sujet: t.subject?.label ?? t.subject?.plate ?? null, valideDepuis: t.validFrom ?? null, valideJusqua: t.validUntil ?? null, montant: t.amount ?? null });
    }
    // 3. Autorisations et permis des services (événements, chantier, marchés…).
    const vx = ctx.ext.verticales as { certificates?: { find(p: (c: { taxpayerId: string; status: string }) => boolean): { code: string; label: string; validFrom: string; validUntil?: string; status: string; taxpayerId: string }[] } } | undefined;
    for (const c of vx?.certificates?.find((x) => x.taxpayerId === tid && x.status === 'VALIDE') ?? []) {
      if (!encore(c.validUntil)) continue;
      preuves.push({ famille: 'AUTORISATION', libelle: c.label, code: c.code, numero: c.code, sujet: null, valideDepuis: c.validFrom, valideJusqua: c.validUntil ?? null, montant: null });
    }
    // 4. Quitus fiscal.
    const quitus = await lire<{ shortCode: string; number: string; status: string; validFrom?: string; validUntil?: string }[]>(req, '/v1/fiscal/clearances');
    for (const q of quitus ?? []) {
      if (q.status !== 'ACTIF' || !encore(q.validUntil ? `${q.validUntil}T23:59:59Z` : null)) continue;
      preuves.push({ famille: 'QUITUS', libelle: 'Quitus fiscal', code: q.shortCode, numero: q.number, sujet: null, valideDepuis: q.validFrom ?? null, valideJusqua: q.validUntil ?? null, montant: null });
    }
    // 5. Supports publicitaires autorisés (plaque QR du support).
    const pub = await lire<{ items: { qrToken?: string; reference: string; type: string; address?: string; status: string; authorization?: { reference: string; validFrom?: string; validUntil?: string } }[] }>(req, '/v1/publicite/devices/mine');
    for (const d of pub?.items ?? []) {
      if (!d.qrToken || d.status !== 'AUTORISE') continue;
      preuves.push({ famille: 'PUBLICITE', libelle: `Support publicitaire ${d.type.toLowerCase()} ${d.reference}`, code: d.qrToken, numero: d.authorization?.reference ?? d.reference, sujet: d.address ?? null, valideDepuis: d.authorization?.validFrom ?? null, valideJusqua: d.authorization?.validUntil ?? null, montant: null });
    }
    // 6. Conducteur (gilet numéroté, RakaPay).
    const rk = ctx.ext.rakapay as { drivers?: { find(p: (d: { taxpayerId?: string; status: string }) => boolean): { vestNumber: string; status: string }[] } } | undefined;
    for (const d of rk?.drivers?.find((x) => x.taxpayerId === tid && x.status === 'ACTIF') ?? []) {
      preuves.push({ famille: 'CONDUCTEUR', libelle: 'Conducteur de moto-taxi (gilet)', code: d.vestNumber, numero: d.vestNumber, sujet: null, valideDepuis: null, valideJusqua: null, montant: null });
    }
    // 7. Quittances (preuves de paiement permanentes), les plus récentes.
    const profil = await lire<{ receipts?: { code: string; number: string; revenueCategory?: string; amount?: MoneyJSON; paidAt?: string; status: string }[] }>(req, `/v1/taxpayers/${encodeURIComponent(tid)}`);
    for (const r of (profil?.receipts ?? []).filter((x) => x.status !== 'ANNULEE').sort((a, b) => (b.paidAt ?? '').localeCompare(a.paidAt ?? '')).slice(0, QUITTANCES_MAX)) {
      preuves.push({ famille: 'QUITTANCE', libelle: `Quittance ${r.number}${r.revenueCategory ? ` — ${r.revenueCategory}` : ''}`, code: r.code, numero: r.number, sujet: null, valideDepuis: r.paidAt ?? null, valideJusqua: null, montant: r.amount ?? null });
    }
    ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'preuves.mes_preuves.ouvert', resourceType: 'taxpayer', resourceId: tid, details: { preuves: preuves.length } });
    return {
      preuves, genereLe: ctx.clock.now().toISOString(),
      consigne: 'Montrez le code QR à l’agent : il le scanne ou saisit le code. Aucun paiement en espèces ne peut vous être demandé.',
    };
  });
}
