/**
 * Liaison des biens et occupations — spécification « Property and Occupancy Linkage » v1.0 du 28/09/2026
 * (docs/sources/Specification_Liaison_Biens_Occupations_v1.0.md). Un test nommé par critère d'acceptation (§ 9, CA-1 à
 * CA-9), puis les règles de confidentialité (§ 8), de rapprochement (§ 5), d'états (§ 6), d'API (§ 7) et de
 * paramétrage (§ 10). Construit sur le module 7 (relations) : chaque revendication porte une relation du module 7.
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
import { recordStatusOf } from '../src/modules/objects/service.js';

const SHA = (c: string) => c.repeat(64).slice(0, 64);

async function env() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    plugins: [accesPlugin as MosoloPlugin<unknown>, fiscalPlugin as MosoloPlugin<unknown>, createSoclePlugin({ rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: false }, persistence: null }) as MosoloPlugin<unknown>],
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
  });
  await app.ready();
  const call = (method: string, url: string, o: { user?: string; token?: string; body?: unknown; key?: string | false; headers?: Record<string, string> } = {}) => app.inject({
    method: method as 'GET', url,
    headers: {
      ...(o.user ? { 'x-demo-user': o.user } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method === 'POST' && o.key !== false ? { 'idempotency-key': o.key ?? randomUUID() } : {}), ...(o.headers ?? {}),
    },
    ...(o.body !== undefined ? { payload: JSON.stringify(o.body) } : {}),
  });
  const svc = app.ctx.ext.fiscal as FiscalService;
  const acces = app.ctx.ext.acces as AccesService;
  /** Une personne : inscription, code, connexion par code. */
  const person = async (phone: string, fullName: string, extra: Record<string, unknown> = {}) => {
    const reg = await call('POST', '/v1/registrations', { key: false, body: { phone, fullName, language: 'fr', situation: 'tenant', ...extra } });
    expect(reg.statusCode, reg.body).toBe(201);
    const taxpayerId = reg.json().taxpayerId as string;
    const otp = await call('POST', `/v1/acces/identity/${taxpayerId}/otp`, { key: false });
    const code = /(\d{6})/.exec(acces.sandboxMessages(phone).at(-1)!.text)![1]!;
    await call('POST', `/v1/acces/identity/${taxpayerId}/otp/verify`, { key: false, body: { challengeId: otp.json().challengeId, code } });
    const login = async () => {
      const ch = (await call('POST', '/v1/auth/login', { key: false, body: { method: 'phone', phone } })).json();
      const r = await call('POST', '/v1/auth/otp', { key: false, body: { challengeId: ch.challengeId, code: ch.demoCode } });
      expect(r.statusCode, r.body).toBe(200);
      return r.json().accessToken as string;
    };
    let token = await login();
    /** Nouvelle connexion (la session expire quand l'horloge avance de plusieurs heures). */
    const refresh = async () => { token = await login(); return token; };
    const seen: string[] = [];
    /** Appel de la personne ; toutes les réponses sont conservées pour les contrôles de confidentialité. */
    const as = async (method: string, url: string, body?: unknown, o: { key?: string; headers?: Record<string, string> } = {}) => {
      const r = await call(method, url, { token, ...(body !== undefined ? { body } : {}), ...(o.key ? { key: o.key } : {}), ...(o.headers ? { headers: o.headers } : {}) });
      seen.push(r.body);
      return r;
    };
    return { taxpayerId, get token() { return token; }, phone, fullName, as, seen, refresh };
  };
  /** Bien de référence (CANONICAL) : parcelle → bâtiment → unités, créés par un agent puis validés par une autre personne. */
  const canonical = async (addr: { avenue: string; numero: string; lat: number; lon: number }, units: string[], building = 'A') => {
    const mk = async (category: string, parent: string | undefined, attributes: Record<string, unknown>) => {
      const r = await call('POST', '/v1/fiscal-objects', { user: 'u-agent-terrain', key: false, body: { category, commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: addr.lat, lon: addr.lon, avenue: addr.avenue, attributes, ...(parent ? { parentObjectId: parent } : {}) } });
      expect(r.statusCode, r.body).toBe(201);
      const v = await call('POST', `/v1/fiscal/objects/${r.json().id}/validate`, { user: 'u-controleur', key: false, body: {} });
      expect(v.statusCode, v.body).toBe(200);
      return r.json().id as string;
    };
    const plot = await mk('PARCELLE', undefined, { numero: addr.numero });
    const bld = await mk('BATIMENT', plot, { libelle: building });
    const unitIds: Record<string, string> = {};
    for (const u of units) unitIds[u] = await mk('UNITE_LOCATIVE', bld, { unite: u });
    return { plot, building: bld, units: unitIds };
  };
  const reviewCaseOf = (claimId: string, reason = 'VERIFICATION') => svc.biens.cases.find((c) => c.claimId === claimId && c.reasonCode === reason && c.status !== 'DECIDE')[0]!;
  const verify = async (claimId: string, owner: { as: (m: string, u: string, b?: unknown) => Promise<{ statusCode: number; body: string; json: () => unknown }> }, evidenceType: string, extra: Record<string, unknown> = {}) => {
    const ev = await owner.as('POST', `/v1/revendications-biens/${claimId}/preuves`, { evidence_type: evidenceType, sha256: `${randomUUID()}${randomUUID()}`.replace(/-/g, '') });
    expect(ev.statusCode, ev.body).toBe(201);
    const rc = reviewCaseOf(claimId);
    const d = await call('POST', `/v1/dossiers-revue/${rc.id}/decision`, { user: 'u-controleur', body: { decision: 'VERIFIED', motif: 'Pièce contrôlée par le réviseur (test)', ...extra } });
    expect(d.statusCode, d.body).toBe(200);
    return d.json();
  };
  const claimTo = async (p: Awaited<ReturnType<typeof person>>, body: Record<string, unknown>, pick?: (c: { libelle: string }) => boolean) => {
    const c = await p.as('POST', '/v1/revendications-biens', body);
    expect(c.statusCode, c.body).toBe(201);
    const claimId = c.json().claimId as string;
    if (c.json().suite !== 'CHOISIR_CANDIDAT') return { claimId, created: c.json() };
    const cands = (await p.as('GET', `/v1/biens-candidats?revendication=${claimId}`)).json();
    const chosen = pick ? cands.candidats.find(pick) : cands.candidats[0];
    const sel = await p.as('POST', `/v1/revendications-biens/${claimId}/choix-candidat`, { candidate_id: chosen.candidateId });
    expect(sel.statusCode, sel.body).toBe(200);
    return { claimId, created: c.json(), selected: sel.json(), candidates: cands };
  };
  return { app, clock, call, svc, acces, person, canonical, verify, claimTo, reviewCaseOf };
}

const ADDR = { avenue: 'Kasa-Vubu', numero: '12', lat: -4.3712, lon: 15.3441 };
const addr = (extra: Record<string, unknown> = {}) => ({ commune: 'Limete', quartier: 'Kingabwa', avenue: 'Kasa-Vubu', number: '12', ...extra });

describe('Liaison des biens et occupations — critères d’acceptation (§ 9)', () => {
  it('CA-1 — propriétaire et locataire, inscrits séparément, revendiquent la même unité canonique dans les deux ordres, sans doublon de compte ni vérification automatique', async () => {
    const e = await env();
    const before = e.app.ctx.taxpayers.taxpayers.count();
    // Ordre 1 : propriétaire d'abord.
    const c1 = await e.canonical(ADDR, ['1', '2']);
    const owner = await e.person('+243899600001', 'Propriétaire Un (fictif)', { intention: 'PROPRIETAIRE' });
    const o = await e.claimTo(owner, { role: 'OWNER', target_type: 'BUILDING', address: addr() });
    expect(o.selected.statut).toBe('MATCHED_PENDING_VERIFICATION');
    expect(o.selected.bien.id).toBe(c1.building);
    const tenant = await e.person('+243899600002', 'Locataire Un (fictif)', { intention: 'LOCATAIRE' });
    const t = await e.claimTo(tenant, { role: 'TENANT', address: addr({ unit_label: '2' }) });
    expect(t.selected.bien.id).toBe(c1.units['2']);
    expect(t.selected.statut).toBe('MATCHED_PENDING_VERIFICATION');
    // Ordre 2 : locataire d'abord, sur un autre bien canonique.
    const c2 = await e.canonical({ avenue: 'Lukusa', numero: '40', lat: -4.3721, lon: 15.3452 }, ['B1']);
    const tenant2 = await e.person('+243899600003', 'Locataire Deux (fictif)');
    const t2 = await e.claimTo(tenant2, { role: 'TENANT', address: { commune: 'Limete', quartier: 'Kingabwa', avenue: 'Lukusa', number: '40', unit_label: 'B1' } });
    const owner2 = await e.person('+243899600004', 'Propriétaire Deux (fictif)');
    const o2 = await e.claimTo(owner2, { role: 'OWNER', target_type: 'BUILDING', address: { commune: 'Limete', quartier: 'Kingabwa', avenue: 'Lukusa', number: '40' } });
    expect(t2.selected.bien.id).toBe(c2.units.B1);
    expect(o2.selected.bien.id).toBe(c2.building);
    // Aucun compte en double, aucune vérification automatique.
    expect(e.app.ctx.taxpayers.taxpayers.count()).toBe(before + 4);
    for (const id of [o.claimId, t.claimId, t2.claimId, o2.claimId]) expect(e.svc.biens.claim(id).status).not.toBe('VERIFIED');
    // Le choix fait à l'inscription n'a ouvert qu'un BROUILLON (jamais vérifié, jamais relié).
    const drafts = e.svc.biens.claims.find((c) => c.accountId === owner.taxpayerId && c.origin === 'INSCRIPTION');
    expect(drafts.map((c) => [c.status, c.targetId ?? null])).toEqual([['DRAFT', null]]);
  });

  it('CA-2 — une unité provisoire créée par le locataire n’est reliée à l’unité canonique du propriétaire qu’après une revue auditée ; identifiants, pièces et revendications restent traçables', async () => {
    const e = await env();
    const tenant = await e.person('+243899600010', 'Locataire provisoire (fictif)');
    const t = await e.claimTo(tenant, { role: 'TENANT', address: { commune: 'Limete', quartier: 'Kingabwa', avenue: 'des Palmiers', number: '99', unit_label: '2' }, valid_from: '2026-01-01' });
    expect(t.created.candidats).toBe(0);
    const provisional = e.svc.biens.claim(t.claimId).targetId!;
    const provObj = e.app.ctx.objects.get(provisional);
    expect(provObj).toMatchObject({ recordStatus: 'PROVISIONAL', recordProvenance: 'SELF_REPORTED', unitLabel: '2' });
    const ev = await tenant.as('POST', `/v1/revendications-biens/${t.claimId}/preuves`, { evidence_type: 'CONTRAT_DE_LOCATION', sha256: SHA('a') });
    expect(ev.statusCode).toBe(201);
    // Le propriétaire déclare ensuite son bien : doublons PROPOSÉS en revue, aucune fusion automatique.
    const owner = await e.person('+243899600011', 'Propriétaire tardif (fictif)');
    const decl = await owner.as('POST', '/v1/biens-declares', { plot: { commune: 'Limete', quartier: 'Kingabwa', avenue: 'des Palmiers', number: '99', lat: -4.3712, lon: 15.3441 }, building: { label: 'A' }, units: [{ label: '1' }, { label: '2' }] });
    expect(decl.statusCode, decl.body).toBe(201);
    expect(decl.json().doublonsEnRevue).toBeGreaterThan(0);
    expect(e.svc.biens.claim(t.claimId).targetId).toBe(provisional);
    const ownerUnit = decl.json().units.find((u: { label: string }) => u.label === '2').id as string;
    // Le bien du propriétaire devient canonique par le circuit de validation existant (personne distincte).
    for (const id of [decl.json().plotId, decl.json().buildingId, ownerUnit]) expect((await e.call('POST', `/v1/fiscal/objects/${id}/validate`, { user: 'u-controleur', key: false, body: {} })).statusCode).toBe(200);
    const mergeCase = e.svc.biens.cases.find((c) => c.reasonCode === 'FUSION_BIENS' && !!c.merge && c.merge.recordIds.includes(provisional) && c.merge.recordIds.includes(ownerUnit))[0]!;
    // Écran de revue : les deux arbres, identifiants, positions, nombre de revendications et conflits.
    const detail = (await e.call('GET', `/v1/dossiers-revue/${mergeCase.id}`, { user: 'u-dg-dgipk' })).json();
    expect(detail.fusion.enregistrements).toHaveLength(2);
    expect(detail.fusion.enregistrements[0]).toHaveProperty('enfants');
    // Cible canonique explicite obligatoire.
    expect((await e.call('POST', `/v1/dossiers-revue/${mergeCase.id}/decision`, { user: 'u-dg-dgipk', body: { decision: 'FUSIONNER', motif: 'Même logement (test)' } })).json().code).toBe('CANONICAL_TARGET_REQUIRED');
    const merge = await e.call('POST', `/v1/dossiers-revue/${mergeCase.id}/decision`, { user: 'u-dg-dgipk', body: { decision: 'FUSIONNER', motif: 'Même logement : adresse, unité et position concordent (test)', canonical_target_id: ownerUnit } });
    expect(merge.statusCode, merge.body).toBe(200);
    const claim = e.svc.biens.claim(t.claimId);
    expect(claim.targetId).toBe(ownerUnit);
    expect(claim.originalTargetId).toBe(provisional);
    expect(e.app.ctx.objects.get(provisional)).toMatchObject({ recordStatus: 'ARCHIVED_ALIAS', aliasOf: ownerUnit });
    expect(e.svc.relations.get(claim.relationId!)).toMatchObject({ objectId: ownerUnit, originalObjectId: provisional });
    expect(e.svc.biens.evidence.find((x) => x.claimId === t.claimId).map((x) => x.sha256)).toEqual([SHA('a')]);
    const audit = e.app.ctx.audit.list({ action: 'property_merge.applied', limit: 10 }).items;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor.id).toBe('u-dg-dgipk');
    expect(audit[0]!.details).toMatchObject({ canonicalId: ownerUnit, reason: expect.stringMatching(/Même logement/), beforeHash: expect.any(String), afterHash: expect.any(String), after: { recordStatus: 'ARCHIVED_ALIAS' } });
  });

  it('CA-3 — un même compte possède une unité et en loue une autre ; copropriété et plusieurs occupants ne violent aucune contrainte', async () => {
    const e = await env();
    const c = await e.canonical(ADDR, ['1', '2']);
    const other = await e.canonical({ avenue: 'Lukusa', numero: '40', lat: -4.3721, lon: 15.3452 }, ['B1']);
    const a = await e.person('+243899600020', 'Copropriétaire A (fictif)');
    const b = await e.person('+243899600021', 'Copropriétaire B (fictif)');
    const oa = await e.claimTo(a, { role: 'OWNER', target_type: 'BUILDING', address: addr(), share: '50' });
    const ob = await e.claimTo(b, { role: 'OWNER', target_type: 'BUILDING', address: addr(), share: '50' });
    await e.verify(oa.claimId, a, 'TITRE_FONCIER');
    await e.verify(ob.claimId, b, 'TITRE_FONCIER');
    // A loue aussi une unité ailleurs (même compte).
    const ta = await e.claimTo(a, { role: 'TENANT', address: { commune: 'Limete', quartier: 'Kingabwa', avenue: 'Lukusa', number: '40', unit_label: 'B1' } });
    await e.verify(ta.claimId, a, 'CONTRAT_DE_LOCATION');
    // Plusieurs occupants de l'unité 2 : deux colocataires et un occupant.
    const occ = [await e.person('+243899600022', 'Colocataire 1'), await e.person('+243899600023', 'Colocataire 2'), await e.person('+243899600024', 'Occupant 3')];
    for (const [i, p] of occ.entries()) {
      const cl = await e.claimTo(p, { role: i < 2 ? 'TENANT' : 'OCCUPANT', joint_tenancy: i < 2, address: addr({ unit_label: '2' }) });
      await e.verify(cl.claimId, p, i < 2 ? 'CONTRAT_DE_LOCATION' : 'FACTURE_SERVICE');
    }
    const eff = await e.call('GET', `/v1/relations-biens/effectives?objet=${c.units['2']}&date=2026-09-26`, { user: 'u-controleur' });
    expect(eff.json().relations).toHaveLength(3);
    const own = await e.call('GET', `/v1/relations-biens/effectives?objet=${c.building}&date=2026-09-26`, { user: 'u-controleur' });
    expect(own.json().relations.map((r: { quotePart: string }) => r.quotePart).sort()).toEqual(['50', '50']);
    const mineA = (await a.as('GET', '/v1/moi/relations-biens')).json();
    expect(mineA.actuelles.map((x: { role: string; statut: string }) => `${x.role}:${x.statut}`).sort()).toEqual(['OWNER:VERIFIED', 'TENANT:VERIFIED']);
    expect(other.units.B1).toBe(e.svc.biens.claim(ta.claimId).targetId);
    // Aucune alerte de chevauchement pour une colocation déclarée.
    expect(e.svc.biens.cases.find((x) => x.reasonCode === 'CHEVAUCHEMENT_LOCATION_EXCLUSIVE')).toHaveLength(0);
  });

  it('CA-4 — aucune réponse à un revendicateur non vérifié ne révèle le nom, le téléphone, le compte ni les pièces de l’autre partie', async () => {
    const e = await env();
    await e.canonical(ADDR, ['1', '2']);
    const owner = await e.person('+243899600030', 'Mbala Propriétaire Secret');
    const tenant = await e.person('+243899600031', 'Kanku Locataire Secret');
    const o = await e.claimTo(owner, { role: 'OWNER', target_type: 'BUILDING', address: addr() });
    await owner.as('POST', `/v1/revendications-biens/${o.claimId}/preuves`, { evidence_type: 'TITRE_FONCIER', sha256: SHA('b') });
    const inv = await owner.as('POST', `/v1/revendications-biens/${o.claimId}/invitations`, { contact: tenant.phone, invite_role: 'TENANT' });
    const t = await e.claimTo(tenant, { role: 'TENANT', address: addr({ unit_label: '2' }) });
    await tenant.as('POST', `/v1/revendications-biens/${t.claimId}/preuves`, { evidence_type: 'CONTRAT_DE_LOCATION', sha256: SHA('c') });
    await tenant.as('POST', `/v1/invitations-biens/${inv.json().jetonBacASable}/reponse`, { reponse: 'ACCEPTER' });
    await tenant.as('GET', '/v1/moi/relations-biens');
    await owner.as('GET', '/v1/moi/relations-biens');
    // Vue du propriétaire refusée tant que sa relation n'est pas vérifiée.
    expect((await owner.as('GET', `/v1/biens/${e.svc.biens.claim(o.claimId).targetId}/vue-proprietaire`)).statusCode).toBe(403);
    const leak = (seen: string[], p: { fullName: string; phone: string; taxpayerId: string }, sha: string) => seen.filter((b) => b.includes(p.fullName) || b.includes(p.phone) || b.includes(p.taxpayerId) || b.includes(sha));
    expect(leak(tenant.seen, owner, SHA('b'))).toEqual([]);
    expect(leak(owner.seen, tenant, SHA('c'))).toEqual([]);
  });

  it('CA-5 — jetons invalides, expirés ou réutilisés refusés ; un refus laisse la revendication non vérifiée et ne révèle pas l’existence d’un compte', async () => {
    const e = await env();
    await e.canonical(ADDR, ['1', '2']);
    const owner = await e.person('+243899600040', 'Propriétaire invitations (fictif)');
    const tenant = await e.person('+243899600041', 'Locataire invité (fictif)');
    const o = await e.claimTo(owner, { role: 'OWNER', target_type: 'BUILDING', address: addr() });
    const unknown = await owner.as('POST', `/v1/revendications-biens/${o.claimId}/invitations`, { contact: '+243899699999' });
    const known = await owner.as('POST', `/v1/revendications-biens/${o.claimId}/invitations`, { contact: tenant.phone });
    // Même forme de réponse, qu'un compte existe ou non.
    expect(Object.keys(unknown.json()).sort()).toEqual(Object.keys(known.json()).sort());
    expect(unknown.json().statut).toBe(known.json().statut);
    const tok = known.json().jetonBacASable as string;
    const acc = await tenant.as('POST', `/v1/invitations-biens/${tok}/reponse`, { reponse: 'ACCEPTER', creer_ma_revendication: false });
    expect(acc.statusCode, acc.body).toBe(200);
    expect(e.svc.biens.claim(o.claimId).status).not.toBe('VERIFIED');
    expect((await tenant.as('POST', `/v1/invitations-biens/${tok}/reponse`, { reponse: 'ACCEPTER' })).json().code).toBe('INVITATION_INVALID');
    expect((await tenant.as('POST', `/v1/invitations-biens/jeton-inexistant-0000/reponse`, { reponse: 'ACCEPTER' })).json().code).toBe('INVITATION_INVALID');
    const late = await owner.as('POST', `/v1/revendications-biens/${o.claimId}/invitations`, { contact: '+243899600049' });
    const declined = await owner.as('POST', `/v1/revendications-biens/${o.claimId}/invitations`, { contact: tenant.phone });
    const dec = await tenant.as('POST', `/v1/invitations-biens/${declined.json().jetonBacASable}/reponse`, { reponse: 'REFUSER' });
    expect(dec.json()).toMatchObject({ statut: 'REFUSEE' });
    e.clock.advance(8 * 86_400_000);
    await tenant.refresh();
    await owner.refresh();
    expect((await tenant.as('POST', `/v1/invitations-biens/${late.json().jetonBacASable}/reponse`, { reponse: 'ACCEPTER' })).json().code).toBe('INVITATION_INVALID');
    // Côté propriétaire : refus et expiration indiscernables (« SANS_SUITE ») ; revendication toujours non vérifiée.
    const view = (await owner.as('GET', '/v1/moi/relations-biens')).json();
    const invs = view.actuelles.find((c: { claimId: string }) => c.claimId === o.claimId).invitations as { id: string; statut: string }[];
    expect(invs.find((i) => i.id === declined.json().invitationId)!.statut).toBe('SANS_SUITE');
    expect(invs.find((i) => i.id === late.json().invitationId)!.statut).toBe('SANS_SUITE');
    expect(e.svc.biens.claim(o.claimId).status).not.toBe('VERIFIED');
  });

  it('CA-6 — un déménagement conserve les dates de l’occupation précédente ; la requête datée renvoie la bonne relation vérifiée', async () => {
    const e = await env();
    const c = await e.canonical(ADDR, ['1', '2']);
    const tenant = await e.person('+243899600050', 'Locataire qui déménage (fictif)');
    const first = await e.claimTo(tenant, { role: 'TENANT', address: addr({ unit_label: '1' }), valid_from: '2025-01-01' });
    await e.verify(first.claimId, tenant, 'CONTRAT_DE_LOCATION');
    const ended = await tenant.as('POST', `/v1/revendications-biens/${first.claimId}/fin`, { valid_to: '2026-03-31', motif: 'Déménagement (test)' });
    expect(ended.statusCode, ended.body).toBe(200);
    const second = await e.claimTo(tenant, { role: 'TENANT', address: addr({ unit_label: '2' }), valid_from: '2026-04-01' });
    await e.verify(second.claimId, tenant, 'CONTRAT_DE_LOCATION');
    const at = async (unit: string, date: string) => (await e.call('GET', `/v1/relations-biens/effectives?objet=${unit}&date=${date}`, { user: 'u-controleur' })).json().relations as { compte: string; du: string; au: string | null }[];
    expect((await at(c.units['1']!, '2025-06-01')).map((r) => [r.compte, r.du, r.au])).toEqual([[tenant.taxpayerId, '2025-01-01', '2026-03-31']]);
    expect(await at(c.units['1']!, '2026-06-01')).toEqual([]);
    expect((await at(c.units['2']!, '2026-06-01')).map((r) => r.compte)).toEqual([tenant.taxpayerId]);
    const mine = (await tenant.as('GET', '/v1/moi/relations-biens')).json();
    expect(mine.historiques.map((h: { claimId: string; statut: string; au: string }) => [h.claimId, h.statut, h.au])).toEqual([[first.claimId, 'ENDED', '2026-03-31']]);
    // Date invalide : 422.
    expect((await tenant.as('POST', `/v1/revendications-biens/${second.claimId}/fin`, { valid_to: '2020-01-01', motif: 'Date antérieure (test)' })).statusCode).toBe(422);
  });

  it('CA-7 — deux locations exclusives vérifiées qui se chevauchent ouvrent un dossier de revue ; aucune n’est retirée', async () => {
    const e = await env();
    await e.canonical(ADDR, ['1', '2']);
    const t1 = await e.person('+243899600060', 'Locataire exclusif 1');
    const t2 = await e.person('+243899600061', 'Locataire exclusif 2');
    const c1 = await e.claimTo(t1, { role: 'TENANT', address: addr({ unit_label: '2' }), valid_from: '2026-01-01' });
    const c2 = await e.claimTo(t2, { role: 'TENANT', address: addr({ unit_label: '2' }), valid_from: '2026-06-01' });
    await e.verify(c1.claimId, t1, 'CONTRAT_DE_LOCATION');
    await e.verify(c2.claimId, t2, 'CONTRAT_DE_LOCATION');
    const overlap = e.svc.biens.cases.find((x) => x.reasonCode === 'CHEVAUCHEMENT_LOCATION_EXCLUSIVE');
    expect(overlap).toHaveLength(1);
    expect(overlap[0]!.relatedClaimIds.sort()).toEqual([c1.claimId, c2.claimId].sort());
    expect([e.svc.biens.claim(c1.claimId).status, e.svc.biens.claim(c2.claimId).status]).toEqual(['VERIFIED', 'VERIFIED']);
  });

  it('CA-8 — un conflit d’identifiants officiels vérifiés bloque la fusion ; rejouer une soumission ou une fusion avec la même clé ne duplique rien', async () => {
    const e = await env();
    const c = await e.canonical(ADDR, ['1']);
    e.app.ctx.objects.setRecordMeta(c.plot, { officialRef: { value: 'KIN-CAD-0001', namespace: 'KIN-CADASTRE', issuer: 'Intégration autorisée (test)', verified: true } });
    const owner = await e.person('+243899600070', 'Propriétaire conflit (fictif)');
    const decl = await owner.as('POST', '/v1/biens-declares', { plot: { commune: 'Limete', quartier: 'Kingabwa', avenue: 'Kasa-Vubu', number: '12', lat: ADDR.lat, lon: ADDR.lon }, units: [{ label: '1' }] });
    expect(decl.statusCode, decl.body).toBe(201);
    const plotCase = e.svc.biens.cases.find((x) => x.reasonCode === 'FUSION_BIENS' && !!x.merge && x.merge.recordIds.includes(c.plot) && x.merge.recordIds.includes(decl.json().plotId))[0]!;
    await e.call('POST', `/v1/fiscal/objects/${decl.json().plotId}/validate`, { user: 'u-controleur', key: false, body: {} });
    e.app.ctx.objects.setRecordMeta(decl.json().plotId, { officialRef: { value: 'KIN-CAD-0002', namespace: 'KIN-CADASTRE', issuer: 'Intégration autorisée (test)', verified: true } });
    const blocked = await e.call('POST', `/v1/dossiers-revue/${plotCase.id}/decision`, { user: 'u-dg-dgipk', body: { decision: 'FUSIONNER', motif: 'Tentative de fusion (test)', canonical_target_id: c.plot } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('MERGE_BLOCKED_OFFICIAL_REF_CONFLICT');
    expect(e.svc.biens.reviewCase(plotCase.id).status).toBe('ESCALADE');
    expect(recordStatusOf(e.app.ctx.objects.get(decl.json().plotId))).toBe('CANONICAL');
    // Idempotence : même clé, même contenu ⇒ même réponse, aucune seconde revendication ; autre contenu ⇒ 409.
    const key = randomUUID();
    const body = { role: 'OCCUPANT', address: addr({ unit_label: '1' }) };
    const r1 = await owner.as('POST', '/v1/revendications-biens', body, { key });
    const n = e.svc.biens.claims.count();
    const r2 = await owner.as('POST', '/v1/revendications-biens', body, { key });
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.json().claimId).toBe(r1.json().claimId);
    expect(e.svc.biens.claims.count()).toBe(n);
    expect((await owner.as('POST', '/v1/revendications-biens', { ...body, role: 'TENANT' }, { key })).json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    // Fusion rejouée avec la même clé : aucun second travail (autre bien, sans conflit d'identifiants).
    const c2 = await e.canonical({ avenue: 'Lukusa', numero: '40', lat: -4.3721, lon: 15.3452 }, ['B1']);
    const tenant = await e.person('+243899600071', 'Locataire provisoire (fictif)');
    const prov = await tenant.as('POST', '/v1/revendications-biens', { role: 'TENANT', address: { commune: 'Limete', quartier: 'Kingabwa', avenue: 'Lukusa bis', number: '41', unit_label: 'B1' } });
    const provUnit = e.svc.biens.claim(prov.json().claimId).targetId!;
    const unitCaseId = e.svc.biens['openCase']({ kind: 'system', id: 'test' }, { reasonCode: 'FUSION_BIENS', commune: 'Limete', relatedClaimIds: [prov.json().claimId], merge: { recordIds: [c2.units.B1!, provUnit], signals: ['REVUE_MANUELLE'] } }).id;
    const unitCase = e.svc.biens.reviewCase(unitCaseId);
    const mk = randomUUID();
    const mBody = { decision: 'FUSIONNER', motif: 'Même unité (test)', canonical_target_id: c2.units.B1 };
    const m1 = await e.call('POST', `/v1/dossiers-revue/${unitCase.id}/decision`, { user: 'u-dg-dgipk', key: mk, body: mBody });
    expect(m1.statusCode, m1.body).toBe(200);
    const m2 = await e.call('POST', `/v1/dossiers-revue/${unitCase.id}/decision`, { user: 'u-dg-dgipk', key: mk, body: mBody });
    expect(m2.headers['idempotent-replayed']).toBe('true');
    expect(e.app.ctx.audit.list({ action: 'property_merge.applied', limit: 10 }).items).toHaveLength(1);
  });

  it('CA-9 — vérification, rejet, contestation, fin et fusion : acteur, horodatage, motif, références avant / après', async () => {
    const e = await env();
    await e.canonical(ADDR, ['1', '2']);
    const t = await e.person('+243899600080', 'Locataire audité (fictif)');
    const a = await e.claimTo(t, { role: 'TENANT', address: addr({ unit_label: '1' }) });
    await e.verify(a.claimId, t, 'CONTRAT_DE_LOCATION');
    await t.as('POST', `/v1/revendications-biens/${a.claimId}/fin`, { valid_to: '2026-12-31', motif: 'Fin du bail (test)' });
    const b = await e.claimTo(t, { role: 'OCCUPANT', address: addr({ unit_label: '2' }) });
    const rcB = e.reviewCaseOf(b.claimId);
    await e.call('POST', `/v1/dossiers-revue/${rcB.id}/decision`, { user: 'u-controleur', body: { decision: 'REJECTED', motif: 'Aucune pièce probante (test)' } });
    const c = await e.claimTo(t, { role: 'TENANT', joint_tenancy: true, address: addr({ unit_label: '2' }) });
    await t.as('POST', `/v1/revendications-biens/${c.claimId}/contestations`, { motif: 'Je conteste l’unité retenue (test)' });
    for (const action of ['property_claim.verified', 'property_claim.ended', 'property_claim.rejected', 'property_claim.disputed']) {
      const items = e.app.ctx.audit.list({ action, limit: 20 }).items;
      expect(items.length, action).toBeGreaterThan(0);
      for (const r of items) {
        expect(r.actor.id, action).toBeTruthy();
        expect(r.at, action).toBeTruthy();
        expect(r.details.reason, action).toBeTruthy();
        expect(r.details.beforeHash, action).toMatch(/^[0-9a-f]{64}$/);
        expect(r.details.afterHash, action).toMatch(/^[0-9a-f]{64}$/);
        expect(r.details.before, action).toHaveProperty('status');
        expect(r.details.after, action).toHaveProperty('status');
      }
    }
    // Les fusions sont couvertes par CA-2 (property_merge.applied : acteur, motif, empreintes, références).
  });
});

describe('Liaison des biens — règles de la spécification (§ 5, § 6, § 7, § 8, § 10)', () => {
  it('§ 5 — un téléphone ou un nom seuls ne produisent jamais de candidat ; le GPS seul non plus ; aucun score ne vérifie', async () => {
    const e = await env();
    await e.canonical(ADDR, ['1']);
    const owner = await e.person('+243899600090', 'Nom Très Particulier');
    await e.claimTo(owner, { role: 'OWNER', target_type: 'BUILDING', address: addr() });
    const other = await e.person('+243899600091', 'Chercheur (fictif)');
    // Téléphone et nom du propriétaire, mais adresse différente : aucun candidat, indices signalés comme ignorés.
    const r = await other.as('POST', '/v1/revendications-biens', { role: 'TENANT', address: { commune: 'Limete', quartier: 'Kingabwa', avenue: 'Autre avenue', number: '77' }, indices: { nom: 'Nom Très Particulier', telephone: '+243899600090' } });
    expect(r.json()).toMatchObject({ candidats: 0, indicesIgnores: ['nom', 'telephone'] });
    // GPS seul (même position) sans composante d'adresse : aucun candidat.
    const g = e.svc.biens.findCandidates({ commune: 'Kalamu', lat: ADDR.lat, lon: ADDR.lon }, 'BUILDING');
    expect(g).toEqual([]);
    // Un candidat choisi n'est jamais vérifié.
    const ok = await e.claimTo(other, { role: 'TENANT', address: addr({ unit_label: '1' }) });
    expect(ok.selected.statut).toBe('MATCHED_PENDING_VERIFICATION');
    // Les candidats ne portent ni signaux, ni score, ni personne.
    expect(JSON.stringify(ok.candidates)).not.toMatch(/score|signal|IDENTIFIANT_OFFICIEL|ADRESSE_EXACTE|TP-/);
  });

  it('§ 6 et § 7 — version périmée ⇒ 409 ; dates invalides ⇒ 422 ; idempotence obligatoire ; alias anglais de la spécification', async () => {
    const e = await env();
    const c = await e.canonical(ADDR, ['1']);
    const p = await e.person('+243899600100', 'Personne API (fictive)');
    const draft = await p.as('POST', '/v1/revendications-biens', { role: 'TENANT', submit: false, address: addr({ unit_label: '1' }) });
    expect(draft.json().statut).toBe('DRAFT');
    expect((await p.as('POST', '/v1/revendications-biens', { role: 'TENANT', claim_id: draft.json().claimId, version: 99, address: addr({ unit_label: '1' }) })).json().code).toBe('STALE_VERSION');
    expect((await p.as('POST', '/v1/revendications-biens', { role: 'TENANT', valid_from: '2026-05-01', valid_to: '2026-01-01', address: addr() })).statusCode).toBe(422);
    expect((await e.call('POST', '/v1/revendications-biens', { token: p.token, key: false, body: { role: 'TENANT', address: addr() } })).json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    // Alias anglais → routes françaises (mêmes contrôles).
    const en = await e.call('POST', '/v1/property-claims', { token: p.token, body: { role: 'TENANT', target_type: 'UNIT', address: addr({ unit_label: '1' }), valid_from: '2026-06-01', use_type: 'RESIDENTIAL' } });
    expect(en.statusCode, en.body).toBe(201);
    expect(en.headers['x-mosolo-route-canonique']).toBe('POST /v1/revendications-biens');
    const cands = await e.call('GET', `/v1/property-candidates?claim_id=${en.json().claimId}`, { token: p.token });
    expect(cands.json().candidats[0].libelle).toMatch(/Unité 1/);
    const sel = await e.call('POST', `/v1/property-claims/${en.json().claimId}/select-candidate`, { token: p.token, body: { candidate_id: cands.json().candidats[0].candidateId } });
    expect(sel.json().bien.id).toBe(c.units['1']);
    expect((await e.call('GET', '/v1/me/property-relationships', { token: p.token })).json().actuelles.length).toBeGreaterThan(0);
    // Le compte vient toujours de la session : aucun champ « account_id » accepté.
    expect((await p.as('POST', '/v1/revendications-biens', { role: 'TENANT', account_id: 'TP-DEMO-0001', address: addr() })).statusCode).toBe(400);
  });

  it('§ 8 — propriétaire : ni identité ni pièce des occupants ; locataire : ni titre ni autres locataires ; administrateur : aucune décision ; agent de terrain : dossier affecté, territoire et durée', async () => {
    const e = await env();
    const c = await e.canonical(ADDR, ['1', '2']);
    const owner = await e.person('+243899600110', 'Propriétaire Confidentiel');
    const tenant = await e.person('+243899600111', 'Locataire Confidentiel');
    const tenant2 = await e.person('+243899600112', 'Autre Locataire Confidentiel');
    const o = await e.claimTo(owner, { role: 'OWNER', target_type: 'BUILDING', address: addr() });
    await e.verify(o.claimId, owner, 'TITRE_FONCIER');
    const t = await e.claimTo(tenant, { role: 'TENANT', address: addr({ unit_label: '2' }), valid_from: '2026-02-01' });
    // Administrateur technique : aucune décision juridique ou financière.
    const rc = e.reviewCaseOf(t.claimId);
    expect((await e.call('POST', `/v1/dossiers-revue/${rc.id}/decision`, { user: 'u-superadmin', body: { decision: 'VERIFIED', motif: 'Tentative (test)' } })).statusCode).toBe(403);
    // Invitation seule ou candidat seul : preuve insuffisante.
    expect((await e.call('POST', `/v1/dossiers-revue/${rc.id}/decision`, { user: 'u-controleur', body: { decision: 'VERIFIED', motif: 'Sans pièce (test)' } })).json().code).toBe('EVIDENCE_INSUFFICIENT');
    // Agent de terrain : seulement le dossier affecté, dans son territoire, jusqu'à l'échéance.
    expect((await e.call('GET', `/v1/dossiers-revue/${rc.id}`, { user: 'u-agent-terrain' })).statusCode).toBe(403);
    expect((await e.call('POST', `/v1/dossiers-revue/${rc.id}/affectation`, { user: 'u-controleur', body: { agent_id: 'u-agent-gombe' } })).json().code).toBe('OUT_OF_TERRITORY');
    expect((await e.call('POST', `/v1/dossiers-revue/${rc.id}/affectation`, { user: 'u-controleur', body: { agent_id: 'u-agent-terrain', heures: 24 } })).statusCode).toBe(200);
    expect((await e.call('GET', '/v1/dossiers-revue', { user: 'u-agent-terrain' })).json().items.map((x: { id: string }) => x.id)).toEqual([rc.id]);
    const fieldDetail = (await e.call('GET', `/v1/dossiers-revue/${rc.id}`, { user: 'u-agent-terrain' })).json();
    expect(fieldDetail.revendications[0].compte).toBeNull();
    expect(fieldDetail.revendications[0].pieces).toEqual([]);
    const constat = await e.call('POST', `/v1/dossiers-revue/${rc.id}/constat-terrain`, { user: 'u-agent-terrain', body: { gps: { lat: ADDR.lat, lon: ADDR.lon, accuracy_m: 6 }, photo_sha256: SHA('d'), observations: 'Occupation constatée sur place (test)', confirme: true } });
    expect(constat.statusCode, constat.body).toBe(201);
    expect(e.svc.biens.claim(t.claimId).status).not.toBe('VERIFIED');
    e.clock.advance(25 * 3_600_000);
    for (const x of [owner, tenant, tenant2]) await x.refresh();
    expect((await e.call('GET', '/v1/dossiers-revue', { user: 'u-agent-terrain' })).json().items).toEqual([]);
    // Le réviseur décide sur la base du constat (preuve acceptée).
    expect((await e.call('POST', `/v1/dossiers-revue/${rc.id}/decision`, { user: 'u-controleur', body: { decision: 'VERIFIED', motif: 'Constat de terrain concordant (test)' } })).statusCode).toBe(200);
    const t2 = await e.claimTo(tenant2, { role: 'TENANT', joint_tenancy: true, address: addr({ unit_label: '2' }) });
    await e.verify(t2.claimId, tenant2, 'CONTRAT_DE_LOCATION');
    // Vue du propriétaire : occupation, période ; aucune identité, aucune pièce.
    const ov = await owner.as('GET', `/v1/biens/${c.building}/vue-proprietaire`);
    expect(ov.statusCode, ov.body).toBe(200);
    const u2 = ov.json().unites.find((u: { id: string }) => u.id === c.units['2']);
    expect(u2.occupation).toBe('OCCUPEE');
    expect(u2.occupationsVerifiees).toHaveLength(2);
    for (const s of [tenant.fullName, tenant.phone, tenant.taxpayerId, tenant2.taxpayerId, SHA('d')]) expect(ov.body).not.toContain(s);
    // Locataire : désignation du propriétaire (attestation) seulement ; ni titre ni autre locataire.
    const tv = (await tenant.as('GET', '/v1/moi/relations-biens')).json();
    expect(tv.actuelles[0].designationProprietaire).toBe(owner.fullName);
    const tvRaw = JSON.stringify(tv);
    for (const s of [owner.taxpayerId, owner.phone, tenant2.fullName, tenant2.taxpayerId, 'TITRE_FONCIER']) expect(tvRaw).not.toContain(s);
    // Ni l'un ni l'autre n'accède au compte de l'autre.
    expect((await owner.as('GET', `/v1/taxpayers/${tenant.taxpayerId}`)).statusCode).toBe(403);
    expect((await tenant.as('GET', `/v1/compte-unique/${owner.taxpayerId}`)).statusCode).toBe(403);
    // Lectures sensibles journalisées.
    expect(e.app.ctx.audit.list({ action: 'owner_view.read', limit: 5 }).items.length).toBeGreaterThan(0);
    expect(e.app.ctx.audit.list({ action: 'review_case.read', limit: 5 }).items.length).toBeGreaterThan(0);
  });

  it('§ 8 et § 10 — un bien auto-déclaré non qualifié n’alimente aucune liquidation définitive ; paramètres « par défaut — à confirmer » et mention « non validé juridiquement »', async () => {
    const e = await env();
    const owner = await e.person('+243899600120', 'Propriétaire non qualifié (fictif)');
    const decl = await owner.as('POST', '/v1/biens-declares', { plot: { commune: 'Limete', quartier: 'Kingabwa', avenue: 'Isolée', number: '1', lat: -4.3801, lon: 15.3501 }, target: 'PLOT' });
    expect(decl.statusCode, decl.body).toBe(201);
    expect(decl.json().units).toEqual([{ id: expect.any(String), label: 'MAIN' }]);
    await e.verify(decl.json().claimId, owner, 'TITRE_FONCIER');
    const plot = e.app.ctx.objects.get(decl.json().plotId);
    expect(plot.taxpayerId).toBe(owner.taxpayerId);
    const rule = e.app.ctx.rules.list().find((r) => r.code === 'DEMO-IF-BATI')!;
    expect(() => e.app.ctx.assessment.calculate(e.app.ctx.users.get('u-controleur')!, { ruleId: rule.id, taxpayerId: owner.taxpayerId, objectId: plot.id, inputs: {}, simulate: false })).toThrow(/auto-déclaré non qualifié/);
    const conf = (await e.call('GET', '/v1/biens-relations/configuration', { user: 'u-controleur' })).json();
    expect(Object.values(conf.parametres).every((p) => (p as { statut: string }).statut === 'PAR_DEFAUT_A_CONFIRMER')).toBe(true);
    expect(conf.parametres.validationJuridique.valeur).toBe(false);
    expect(decl.json().mentionJuridique).toMatch(/non validée juridiquement/);
  });

  it('module 7 conservé : les anciens états et routes restent disponibles ; les nouveaux rôles s’ajoutent', async () => {
    const e = await env();
    const ref = (await e.call('GET', '/v1/fiscal/reference', { user: 'u-contribuable' })).json();
    const codes = ref.relationRoles.map((r: { code: string }) => r.code);
    for (const r of ['PROPRIETAIRE', 'COPROPRIETAIRE', 'USUFRUITIER', 'HERITIER_PRESUME', 'GESTIONNAIRE', 'LOCATAIRE', 'SOUS_LOCATAIRE', 'OCCUPANT', 'EXPLOITANT']) expect(codes).toContain(r);
    const c = await e.canonical(ADDR, ['1']);
    const p = await e.person('+243899600130', 'Titulaire module 7 (fictif)');
    const t = await e.claimTo(p, { role: 'TENANT', address: addr({ unit_label: '1' }) });
    const rel = e.svc.relations.get(e.svc.biens.claim(t.claimId).relationId!);
    expect(rel).toMatchObject({ role: 'LOCATAIRE', status: 'PROPOSEE', claimId: t.claimId, objectId: c.units['1'] });
    await e.verify(t.claimId, p, 'CONTRAT_DE_LOCATION');
    expect(e.svc.relations.get(rel.id)).toMatchObject({ status: 'VALIDEE', verificationMethod: 'PREUVE_DOCUMENTAIRE' });
  });
});
