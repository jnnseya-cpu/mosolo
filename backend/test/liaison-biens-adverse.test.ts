/**
 * Troisième passe GO / NO-GO (28/09/2026) — attaques sur la liaison des biens et occupations et le compte unique.
 * Chaque test reproduit un défaut constaté par requêtes HTTP réelles contre le serveur de démonstration
 * (docs/production-readiness.md § 21) : il échouait sur la version candidate 7168652 et passe après correctif.
 *  - D3-01 : invitation vers un bien étranger à la revendication (ou inexistant) acceptée ; écriture partielle à la réponse ;
 *  - D3-02 : contestation par un tiers avec une version fausse ⇒ 409 révélant la version courante (au lieu de 403) ;
 *  - D3-03 : fin d'une relation par un réviseur hors territoire ou lié à la personne ;
 *  - D3-04 : compte unique — identifiant inexistant (404) discernable d'un compte existant d'autrui (403).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { accesPlugin, type AccesService } from '../src/plugins/acces/plugin.js';
import { fiscalPlugin } from '../src/plugins/fiscal/plugin.js';
import type { FiscalService } from '../src/plugins/fiscal/service.js';
import { createSoclePlugin } from '../src/plugins/socle/plugin.js';
import { DEFAULT_RATE_LIMITS } from '../src/plugins/socle/rate-limit.js';
import type { MosoloPlugin } from '../src/plugins/types.js';

async function env() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    plugins: [accesPlugin as MosoloPlugin<unknown>, fiscalPlugin as MosoloPlugin<unknown>, createSoclePlugin({ rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: false }, persistence: null }) as MosoloPlugin<unknown>],
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
  });
  await app.ready();
  const call = (method: string, url: string, o: { user?: string; token?: string; body?: unknown } = {}) => app.inject({
    method: method as 'GET', url,
    headers: {
      ...(o.user ? { 'x-demo-user': o.user } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(o.body !== undefined ? { payload: JSON.stringify(o.body) } : {}),
  });
  const svc = app.ctx.ext.fiscal as FiscalService;
  const acces = app.ctx.ext.acces as AccesService;
  const person = async (phone: string, fullName: string) => {
    const reg = await call('POST', '/v1/registrations', { body: { phone, fullName, language: 'fr', situation: 'tenant' } });
    expect(reg.statusCode, reg.body).toBe(201);
    const taxpayerId = reg.json().taxpayerId as string;
    const otp = await call('POST', `/v1/acces/identity/${taxpayerId}/otp`);
    const code = /(\d{6})/.exec(acces.sandboxMessages(phone).at(-1)!.text)![1]!;
    await call('POST', `/v1/acces/identity/${taxpayerId}/otp/verify`, { body: { challengeId: otp.json().challengeId, code } });
    const ch = (await call('POST', '/v1/auth/login', { body: { method: 'phone', phone } })).json();
    const token = (await call('POST', '/v1/auth/otp', { body: { challengeId: ch.challengeId, code: ch.demoCode } })).json().accessToken as string;
    return { taxpayerId, phone, fullName, as: (m: string, u: string, body?: unknown) => call(m, u, { token, ...(body !== undefined ? { body } : {}) }) };
  };
  return { app, clock, call, svc, person };
}

const plot = (avenue: string) => ({ commune: 'Limete', quartier: 'Kingabwa', avenue, number: '7', lat: -4.3712, lon: 15.3441 });

describe('Troisième passe — attaques sur la liaison des biens et le compte unique', () => {
  it('D3-01 — une invitation ne vise qu’un bien de la branche revendiquée ; bien étranger et bien inexistant : même refus, aucune écriture partielle', async () => {
    const e = await env();
    const owner = await e.person('+243899610001', 'Propriétaire D3-01 (fictif)');
    const guest = await e.person('+243899610002', 'Invité D3-01 (fictif)');
    const other = await e.person('+243899610003', 'Autre propriétaire D3-01 (fictif)');
    const mine = (await owner.as('POST', '/v1/biens-declares', { plot: plot('Branche'), units: [{ label: '1' }] })).json();
    const foreign = (await other.as('POST', '/v1/biens-declares', { plot: { ...plot('Ailleurs'), lat: -4.39, lon: 15.36 }, units: [{ label: '9' }] })).json();
    const foreignUnit = foreign.units[0].id as string;
    const bad = await owner.as('POST', `/v1/revendications-biens/${mine.claimId}/invitations`, { contact: guest.phone, invite_role: 'TENANT', target_unit_id: foreignUnit });
    const ghost = await owner.as('POST', `/v1/revendications-biens/${mine.claimId}/invitations`, { contact: guest.phone, invite_role: 'TENANT', target_unit_id: 'OBJ-INEXISTANT-0001' });
    expect(bad.statusCode, bad.body).toBe(422);
    expect(ghost.statusCode, ghost.body).toBe(422);
    expect(bad.json().code).toBe('INVITATION_TARGET_OUT_OF_CLAIM');
    expect(ghost.json().code).toBe(bad.json().code);
    expect(ghost.json().detail).toBe(bad.json().detail);
    // Une unité de SON bâtiment reste invitable (comportement existant conservé) et l'acceptation crée la revendication.
    const ok = await owner.as('POST', `/v1/revendications-biens/${mine.claimId}/invitations`, { contact: guest.phone, invite_role: 'TENANT', target_unit_id: mine.units[0].id });
    expect(ok.statusCode, ok.body).toBe(201);
    const acc = await guest.as('POST', `/v1/invitations-biens/${ok.json().jetonBacASable}/reponse`, { reponse: 'ACCEPTER', creer_ma_revendication: true });
    expect(acc.statusCode, acc.body).toBe(200);
    expect(e.svc.biens.claim(acc.json().maRevendication).targetId).toBe(mine.units[0].id);
    // Invitation ancienne (antérieure au correctif) visant un bien disparu : la réponse échoue AVANT toute écriture.
    const legacy = await owner.as('POST', `/v1/revendications-biens/${mine.claimId}/invitations`, { contact: guest.phone, invite_role: 'TENANT' });
    const inv = e.svc.biens.invitations.get(legacy.json().invitationId)!;
    e.svc.biens.invitations.update({ ...inv, targetUnitId: 'OBJ-INEXISTANT-0002' });
    const before = e.svc.biens.evidence.find((x) => x.claimId === mine.claimId).length;
    const r = await guest.as('POST', `/v1/invitations-biens/${legacy.json().jetonBacASable}/reponse`, { reponse: 'ACCEPTER', creer_ma_revendication: true });
    expect(r.statusCode).toBe(422);
    expect(e.svc.biens.evidence.find((x) => x.claimId === mine.claimId).length).toBe(before);
    expect(e.svc.biens.invitations.get(inv.id)!.status).toBe('EN_ATTENTE');
  });

  it('D3-02 — un tiers qui conteste avec une version quelconque reçoit 403, jamais la version courante', async () => {
    const e = await env();
    const owner = await e.person('+243899610011', 'Propriétaire D3-02 (fictif)');
    const intruder = await e.person('+243899610012', 'Tiers D3-02 (fictif)');
    const mine = (await owner.as('POST', '/v1/biens-declares', { plot: plot('Version') })).json();
    for (const version of [1, 2, 99]) {
      const r = await intruder.as('POST', `/v1/revendications-biens/${mine.claimId}/contestations`, { motif: 'Contestation par un tiers', version });
      expect(r.statusCode, r.body).toBe(403);
      expect(r.body).not.toContain('currentVersion');
    }
    // Le titulaire garde le contrôle de version (409 sur version périmée).
    expect((await owner.as('POST', `/v1/revendications-biens/${mine.claimId}/contestations`, { motif: 'Contestation du titulaire', version: 1 })).statusCode).toBe(409);
  });

  it('D3-03 — un réviseur ne termine une relation que dans son territoire (le titulaire et le réviseur du territoire le peuvent toujours)', async () => {
    const e = await env();
    e.app.ctx.users.add({ id: 'u-controleur-gombe-test', name: 'Contrôleur Gombe (test)', roles: ['R11'], entity: 'DGIPK', territory: ['Gombe'] });
    const owner = await e.person('+243899610021', 'Propriétaire D3-03 (fictif)');
    const mine = (await owner.as('POST', '/v1/biens-declares', { plot: plot('Fin'), target: 'PLOT' })).json();
    await owner.as('POST', `/v1/revendications-biens/${mine.claimId}/preuves`, { evidence_type: 'TITRE_FONCIER', sha256: 'e'.repeat(64) });
    const rc = e.svc.biens.cases.find((c) => c.claimId === mine.claimId && c.reasonCode === 'VERIFICATION')[0]!;
    expect((await e.call('POST', `/v1/dossiers-revue/${rc.id}/decision`, { user: 'u-controleur', body: { decision: 'VERIFIED', motif: 'Titre contrôlé (test)' } })).statusCode).toBe(200);
    const out = await e.call('POST', `/v1/revendications-biens/${mine.claimId}/fin`, { user: 'u-controleur-gombe-test', body: { valid_to: '2026-09-30', motif: 'Fin hors territoire' } });
    expect(out.statusCode, out.body).toBe(403);
    expect(out.json().code).toBe('OUT_OF_TERRITORY');
    expect(e.svc.biens.claim(mine.claimId).status).toBe('VERIFIED');
    const inside = await e.call('POST', `/v1/revendications-biens/${mine.claimId}/fin`, { user: 'u-controleur', body: { valid_to: '2026-09-30', motif: 'Fin par le réviseur du territoire' } });
    expect(inside.statusCode, inside.body).toBe(200);
    expect(e.svc.biens.claim(mine.claimId).status).toBe('ENDED');
  });

  it('D3-04 — compte unique : pour une personne du public, un identifiant inexistant reçoit le même refus qu’un compte d’autrui ; les agents gardent le 404', async () => {
    const e = await env();
    const a = await e.person('+243899610031', 'Titulaire D3-04 (fictif)');
    const b = await e.person('+243899610032', 'Curieux D3-04 (fictif)');
    const existing = await b.as('GET', `/v1/compte-unique/${a.taxpayerId}`);
    const missing = await b.as('GET', '/v1/compte-unique/TP-999999');
    expect(existing.statusCode).toBe(403);
    expect(missing.statusCode, missing.body).toBe(403);
    expect(missing.json().code).toBe(existing.json().code);
    expect(missing.json().detail).toBe(existing.json().detail);
    const mand = await e.call('GET', '/v1/compte-unique/TP-999999', { user: 'u-mandataire' });
    expect(mand.statusCode).toBe(403);
    expect((await e.call('GET', '/v1/compte-unique/TP-999999', { user: 'u-guichet' })).statusCode).toBe(404);
    // Le titulaire lit toujours son compte.
    expect((await a.as('GET', `/v1/compte-unique/${a.taxpayerId}`)).statusCode).toBe(200);
  });
});
