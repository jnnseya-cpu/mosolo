/**
 * MOSOLO AVIA — pôle de rapprochement des recettes (RRH), IFA, cadre des mesures et clé alternative (§ 11C).
 * Tout reste derrière « acte requis » : constats et propositions, décisions humaines, aucune sanction automatique.
 */
import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DAY_MS, ManualClock } from '../src/core/clock.js';
import { verticalesPlugin, type VerticalesService } from '../src/plugins/verticales/plugin.js';
import { VX_DEMO } from '../src/plugins/verticales/seed.js';
import { PROVIDER_SECRET, type TestEnv } from './helpers.js';

async function setup(): Promise<TestEnv & { svc: VerticalesService }> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
    plugins: [verticalesPlugin],
  });
  await app.ready();
  const req: TestEnv['req'] = (method, url, user, body, headers = {}) =>
    app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  return { app, clock, req, svc: app.ctx.ext.verticales as VerticalesService };
}

const U = VX_DEMO.users;
const B = VX_DEMO.airlineBTaxpayerId;
const HASH = 'b'.repeat(64);
const M1 = '2026-08';

describe('AVIA — pôle de rapprochement des recettes (RRH) : trois flux, reversements, fret', () => {
  it('rapprochement mensuel automatique : vendus ↔ embarqués ↔ sortis ↔ reversés, par compagnie et par vol, sans rien facturer', async () => {
    const env = await setup();
    const list = (await env.req('GET', `/v1/verticales/avia/rrh/reconciliations?period=${M1}`, U.instructor)).json();
    expect(list).toHaveLength(1);
    expect(list[0].trigger).toBe('AUTOMATIQUE_MENSUEL');
    const line = list[0].lines.find((l: { airlineTaxpayerId: string }) => l.airlineTaxpayerId === B);
    expect(line).toMatchObject({ sold: 14, boarded: 14, boardedWithoutIfa: 1, exited: 12, verified: 12, boardedNotExited: 1, taxOnBoarded: '65.00', remitted: '40.00', remittanceGap: '25.00', bspGap: '25.00', hasGap: true });
    expect(line.ticketSources).toEqual(expect.arrayContaining(['BSP', 'PORTAIL_AGENCE']));
    expect(line.freight).toMatchObject({ declaredKg: 500, manifestKg: 1250, gapKg: 750, awbDeclared: 1, awbManifest: 2 });
    expect(line.flightLines.map((f: { flightNumber: string }) => f.flightNumber)).toEqual(['XB101', 'XB103']);
    expect(line.proposal).toMatchObject({ kind: 'CONSTAT_MOIS_NON_DECLARE', status: 'PROPOSEE' });
    // Rien d'automatique : aucune déclaration créée, aucune obligation.
    expect(env.svc.avia.declarations.find((d) => d.taxpayerId === B)).toHaveLength(0);
    expect(env.app.ctx.assessment.byTaxpayer(B)).toHaveLength(0);
    const ov = (await env.req('GET', '/v1/verticales/avia/rrh/overview', U.instructor)).json();
    expect(ov.kpis[0]).toMatchObject({ period: M1, known: 14, counted: 14, verified: 12, compensated: 0 });
    expect(ov.connectors.find((c: { code: string }) => c.code === 'IATA-BSP').state).toBe('ACCORD_REQUIS');
    expect((await env.req('GET', '/v1/verticales/avia/rrh/overview', U.airline)).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/verticales/avia/rrh/connectors/IATA-BSP/pull', U.airport, { airlineTaxpayerId: B, period: M1 })).json().code).toBe('CONNECTOR_AGREEMENT_REQUIRED');
  });

  it('écart soumis à la procédure contradictoire existante → observations → validation distincte → facturation refusée (acte requis) → compensation décidée', async () => {
    const env = await setup();
    const rec = env.svc.aviaRrh.latest(M1)!;
    expect((await env.req('POST', `/v1/verticales/avia/rrh/reconciliations/${rec.id}/lines/${B}/submit`, U.airlineB)).statusCode).toBe(403);
    const sub = await env.req('POST', `/v1/verticales/avia/rrh/reconciliations/${rec.id}/lines/${B}/submit`, U.instructor);
    expect(sub.statusCode).toBe(200);
    const decl = sub.json().declaration;
    expect(decl).toMatchObject({ origin: 'CONSTAT_RRH', status: 'ECART_CONSTATE' });
    expect(decl.reconciliation.rrh).toMatchObject({ boarded: 14, remittanceGap: '25.00', hasGap: true });
    expect((await env.req('POST', `/v1/verticales/avia/rrh/reconciliations/${rec.id}/lines/${B}/submit`, U.instructor)).json().code).toBe('RRH_ALREADY_SUBMITTED');
    // La compagnie répond ; une autre personne valide après le délai ; puis décisions humaines.
    expect((await env.req('POST', `/v1/verticales/avia/declarations/${decl.id}/observations`, U.airlineB, { text: 'Un passager sans IFA : billet émis hors BSP, pièces jointes.', documents: [HASH] })).json().status).toBe('OBSERVATIONS_RECUES');
    env.clock.advance(16 * DAY_MS);
    expect((await env.req('POST', `/v1/verticales/avia/declarations/${decl.id}/gap-decision`, U.chief, { outcome: 'COMPENSATION', reason: 'Avant validation.' })).json().code).toBe('AVIA_NOT_VALIDATED');
    expect((await env.req('POST', `/v1/verticales/avia/declarations/${decl.id}/validate`, U.chief, { reason: 'Écart confirmé après observations.' })).json().status).toBe('VALIDEE');
    const bill = await env.req('POST', `/v1/verticales/avia/declarations/${decl.id}/billing`, U.chief);
    expect(bill.json().code).toBe('ACTE_REQUIS');
    expect((await env.req('POST', `/v1/verticales/avia/declarations/${decl.id}/gap-decision`, U.instructor, { outcome: 'COMPENSATION', reason: 'Par l’analyste.' })).statusCode).toBe(403);
    const comp = await env.req('POST', `/v1/verticales/avia/declarations/${decl.id}/gap-decision`, U.chief, { outcome: 'COMPENSATION', reason: 'Compensation retenue sur le prochain reversement (démonstration).', proposalRef: rec.id });
    expect(comp.json().status).toBe('COMPENSEE');
    expect(env.app.ctx.assessment.byTaxpayer(B)).toHaveLength(0);
    const kpi = env.svc.aviaRrh.departuresKpi(M1)!;
    expect(kpi.compensated).toBe(13);
  });

  it('déclaration reçue puis RRH : le rapprochement d’origine reprend les flux du RRH (sans données agrégées de l’exploitant)', async () => {
    const env = await setup();
    const d = await env.req('POST', '/v1/verticales/avia/declarations', U.airlineB, { period: M1, aircraftObjectIds: [], flights: 2, passengersDeparting: 14, freightKg: 500 });
    expect(d.statusCode).toBe(201);
    const run = await env.req('POST', '/v1/verticales/avia/rrh/reconciliations', U.instructor, { period: M1 });
    expect(run.statusCode).toBe(201);
    expect(run.json().lines[0].proposal.kind).toBe('FACTURATION_ECART');
    const sub = (await env.req('POST', `/v1/verticales/avia/rrh/reconciliations/${run.json().id}/lines/${B}/submit`, U.instructor)).json();
    expect(sub.declaration.status).toBe('ECART_CONSTATE');
    expect(sub.declaration.reconciliation.observed).toMatchObject({ passengersBoarded: 14, passengersExited: 12, freightKg: 1250 });
    expect(sub.declaration.reconciliation.gaps).toMatchObject({ passengers: 0, freightKg: 750 });
    expect((await env.req('POST', '/v1/verticales/avia/rrh/reconciliations', U.instructor, { period: '2026-09' })).json().code).toBe('PERIOD_NOT_CLOSED');
  });

  it('flux : agences certifiées à quatre yeux, sources contrôlées, reversements par la bonne source', async () => {
    const env = await setup();
    const t = { ticketNumber: '9990000009001', flightNumber: 'XB105', flightDate: '2026-08-20', destination: 'NBO', passengerRef: 'PNR-TEST-1', urbanTax: { amount: '5.00', currency: 'USD' } };
    // Une compagnie ne peut pas se faire passer pour le BSP ; elle transmet par son API.
    expect((await env.req('POST', '/v1/verticales/avia/rrh/tickets', U.airlineB, { source: 'BSP', airlineTaxpayerId: B, period: M1, tickets: [t] })).statusCode).toBe(403);
    const api = await env.req('POST', '/v1/verticales/avia/rrh/tickets', U.airlineB, { source: 'API_COMPAGNIE', airlineTaxpayerId: B, period: M1, tickets: [t, { ...t, ticketNumber: '9990000009002' }, { ...t, ticketNumber: '9990000009003', flightDate: '2026-07-02' }] });
    expect(api.statusCode).toBe(201);
    expect(api.json().batch.accepted).toBe(1);
    expect(api.json().batch.rejected.map((r: { reason: string }) => r.reason)).toEqual(['IFA déjà émis pour ce passager sur ce vol', 'Vol hors du mois déclaré']);
    // Agence non certifiée : déclarations refusées ; le contrôleur ne certifie pas (séparation des tâches).
    env.app.ctx.taxpayers.register({ phone: '+243810009990', fullName: 'Agence test', language: 'fr', situation: 'other' }, 'TP-AGV-TEST');
    env.app.ctx.users.add({ id: 'agv-test', name: 'Agence test', roles: ['R30'], entity: 'PUBLIC', taxpayerId: 'TP-AGV-TEST' });
    const ag = (await env.req('POST', '/v1/verticales/avia/rrh/agencies', 'agv-test', { name: 'Agence test', kind: 'AGENCE_VOYAGES', taxpayerId: 'TP-AGV-TEST' })).json();
    expect(ag.status).toBe('EN_ATTENTE');
    expect((await env.req('POST', `/v1/verticales/avia/rrh/agencies/${ag.id}/tickets`, 'agv-test', { airlineTaxpayerId: B, period: M1, tickets: [{ ...t, ticketNumber: '9990000009010', passengerRef: 'PNR-TEST-2' }] })).json().code).toBe('AGENCY_NOT_CERTIFIED');
    expect((await env.req('POST', `/v1/verticales/avia/rrh/agencies/${ag.id}/decision`, U.instructor, { decision: 'CERTIFIEE', reason: 'Tentative du contrôleur.' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/verticales/avia/rrh/agencies/${ag.id}/decision`, U.chief, { decision: 'CERTIFIEE', reason: 'Pièces vérifiées.' })).json().status).toBe('CERTIFIEE');
    expect((await env.req('POST', `/v1/verticales/avia/rrh/agencies/${ag.id}/tickets`, 'agv-test', { airlineTaxpayerId: B, period: M1, tickets: [{ ...t, ticketNumber: '9990000009010', passengerRef: 'PNR-TEST-2' }] })).statusCode).toBe(201);
    // Reversements : BSP par le partenaire de données, relevé bancaire par la banque collectrice.
    expect((await env.req('POST', '/v1/verticales/avia/rrh/remittances', U.bank, { source: 'BSP', airlineTaxpayerId: B, period: M1, amount: { amount: '1.00', currency: 'USD' }, reference: 'X-1' })).json().code).toBe('REMITTANCE_SOURCE_MISMATCH');
    expect((await env.req('POST', '/v1/verticales/avia/rrh/remittances', U.bank, { source: 'BANQUE_COLLECTRICE', airlineTaxpayerId: B, period: M1, amount: { amount: '25.00', currency: 'USD' }, reference: 'BQ-RATTRAPAGE-1', nature: 'RATTRAPAGE' })).statusCode).toBe(201);
    // Fret : la compagnie ne dépose pas de manifeste RVA.
    expect((await env.req('POST', '/v1/verticales/avia/rrh/freight', U.airlineB, { source: 'RVA_MANIFESTE', airlineTaxpayerId: B, flightNumber: 'XB101', flightDate: '2026-08-12', awbNumber: '999-10000003', weightKg: 10 })).statusCode).toBe(403);
  });
});

describe('AVIA — identifiant fiscal aérien (IFA) : QR signé, vérifiable hors ligne, contrôle terrain', () => {
  it('QR de la carte d’embarquement vérifiable hors ligne avec la clé publique ; falsification et doublon détectés', async () => {
    const env = await setup();
    const ticket = env.svc.aviaRrh.tickets.all()[0]!;
    expect(ticket.ifa).toMatch(/^IFA-\d{6}-[0-9A-Z]{8}-[0-9A-Z]$/);
    expect(new Set(env.svc.aviaRrh.tickets.all().map((t) => t.ifa)).size).toBe(env.svc.aviaRrh.tickets.count());
    const pass = (await env.req('GET', `/v1/verticales/avia/ifa/${ticket.ifa}`, U.airlineB)).json();
    expect(pass.qr).toBe(ticket.ifaToken);
    expect(JSON.stringify(pass)).not.toMatch(/PNR-DEMO/);
    expect((await env.req('GET', `/v1/verticales/avia/ifa/${ticket.ifa}`, U.airline)).statusCode).toBe(403);
    // Vérification hors ligne : signature Ed25519 de la charge utile avec la seule clé publique.
    const key = (await env.req('GET', '/v1/public/verticales/avia/ifa/cle-publique')).json();
    const [, body, sig] = pass.qr.split('.');
    expect(verify(null, Buffer.from(body), createPublicKey(key.publicKeyPem), Buffer.from(sig, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(body, 'base64url').toString()).c).toBe(ticket.ifa);
    expect((await env.req('POST', '/v1/public/verticales/avia/ifa/verify', undefined, { qr: pass.qr })).json()).toMatchObject({ authentique: true, connu: true, vol: ticket.flightNumber });
    const forged = `${pass.qr.slice(0, -4)}AAAA`;
    expect((await env.req('POST', '/v1/public/verticales/avia/ifa/verify', undefined, { qr: forged })).json().authentique).toBe(false);
    // Un second scan du même QR n'est pas recompté.
    const again = await env.req('POST', '/v1/verticales/avia/rrh/passenger-events', U.airport, { source: 'RVA_EMBARQUEMENT', airlineTaxpayerId: B, flightNumber: ticket.flightNumber, flightDate: ticket.flightDate, scans: [{ qr: pass.qr }, { qr: forged }] });
    expect(again.json().tally).toEqual({ DOUBLON: 1, FALSIFIE: 1 });
  });

  it('contrôle terrain par lecteur QR : constat journalisé, aucune mesure appliquée sans arrêté', async () => {
    const env = await setup();
    const ticket = env.svc.aviaRrh.tickets.all()[0]!;
    const ok = (await env.req('POST', '/v1/verticales/avia/ifa/controls', U.fieldAgent, { qr: ticket.ifaToken, place: 'Aéroport de N’Djili — porte 3' })).json();
    expect(ok).toMatchObject({ result: 'VALIDE', boarded: true, exited: true, measure: null });
    const none = (await env.req('POST', '/v1/verticales/avia/ifa/controls', U.fieldAgent, { place: 'Aéroport de N’Djili — porte 3', flightNumber: 'XB101' })).json();
    expect(none.result).toBe('SANS_IFA');
    expect(none.measure.available).toBe(false);
    expect(none.measure.notice).toMatch(/Arrêté provincial non enregistré/);
    expect((await env.req('POST', '/v1/verticales/avia/ifa/controls', U.airlineB, { place: 'Porte 3' })).statusCode).toBe(403);
    expect(env.app.ctx.audit.list({ limit: 100000 }).items.filter((e) => e.action === 'avia.ifa.controlled')).toHaveLength(2);
  });
});

describe('AVIA — mesures du dossier source : seulement après arrêté (double validation) et coordination, décidées au cas par cas', () => {
  it('arrêté enregistré à quatre yeux + coordination complète → le système calcule ; l’autorité compétente décide', async () => {
    const env = await setup();
    const propose = () => env.req('POST', '/v1/verticales/avia/cadre/mesures', U.instructor, { measure: 'PENALITE_ELECTRONIQUE', airlineTaxpayerId: B, period: M1 });
    expect((await propose()).json().code).toBe('ACTE_REQUIS');
    const act = (await env.req('POST', '/v1/verticales/avia/cadre/actes', U.instructor, {
      reference: 'Arrêté provincial n° TEST/2026', title: 'Arrêté de test (fictif)', signedOn: '2026-09-01', documentSha256: HASH,
      measuresEnabled: ['BILLET_SANS_IFA_NON_VALIDABLE', 'PENALITE_ELECTRONIQUE'], parameters: { penaltyPerTicketUsd: '10.00', integrationDelayDays: 90 },
    })).json();
    expect(act.status).toBe('EN_ATTENTE_VALIDATION');
    expect((await env.req('POST', `/v1/verticales/avia/cadre/actes/${act.id}/validate`, U.instructor, { approve: true, reason: 'Auto-validation.' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/verticales/avia/cadre/actes/${act.id}/validate`, U.chief, { approve: true, reason: 'Texte conforme au Journal officiel (test).' })).json().status).toBe('ENREGISTRE');
    // Coordination incomplète : toujours indisponible.
    for (const p of ['RVA', 'DGM', 'AAC']) expect((await env.req('POST', `/v1/verticales/avia/cadre/coordination/${p}`, U.instructor, { reference: `PV-${p}-2026` })).statusCode).toBe(200);
    expect((await propose()).json().detail).toMatch(/COMPAGNIES/);
    await env.req('POST', '/v1/verticales/avia/cadre/coordination/COMPAGNIES', U.instructor, { reference: 'PV-COMPAGNIES-2026' });
    const m = (await propose()).json();
    expect(m).toMatchObject({ status: 'PROPOSEE', computation: { penaltyPerTicketUsd: '10.00', amountUsd: '10.00' }, facts: { boardedWithoutIfa: 1 } });
    expect((await env.req('POST', '/v1/verticales/avia/cadre/mesures', U.instructor, { measure: 'RETRAIT_AGREMENT', airlineTaxpayerId: B, period: M1 })).json().code).toBe('MEASURE_NOT_IN_ACT');
    expect((await env.req('POST', `/v1/verticales/avia/cadre/mesures/${m.id}/decide`, U.instructor, { decision: 'RETENUE', authority: 'Contrôleur', reason: 'Tentative.' })).statusCode).toBe(403);
    const dec = (await env.req('POST', `/v1/verticales/avia/cadre/mesures/${m.id}/decide`, 'u-ministre-finances', { decision: 'ECARTEE', authority: 'Ministre provincial des Finances', reason: 'Billet émis hors BSP justifié par la compagnie.' })).json();
    expect(dec.status).toBe('ECARTEE');
    // Le système n'a rien exécuté : aucune obligation ; le contrôle terrain reste un constat.
    expect(env.app.ctx.assessment.byTaxpayer(B)).toHaveLength(0);
    const ctl = (await env.req('POST', '/v1/verticales/avia/ifa/controls', U.fieldAgent, { place: 'Porte 3' })).json();
    expect(ctl.measure).toMatchObject({ available: true });
    expect(ctl.measure.notice).toMatch(/décision de l’autorité compétente/);
  });

  it('clé alternative 65/35 : simulation ACTE_REQUIS à côté de la clé du § 37A ; chiffres source [À VÉRIFIER]', async () => {
    const env = await setup();
    const sim = (await env.req('GET', '/v1/verticales/avia/cadre/remuneration-alternative?amount=1000.01', U.instructor)).json();
    expect(sim).toMatchObject({ simulation: true, opposable: false, baseUsd: '1000.01', villeUsd: '650.01', groupeUsd: '350.00' });
    expect(sim.key.status).toBe('ACTE_REQUIS');
    expect(sim.key.reference).toMatch(/§ 37A/);
    expect((await env.req('GET', '/v1/verticales/avia/cadre/remuneration-alternative', U.airline)).statusCode).toBe(403);
    const cadre = (await env.req('GET', '/v1/verticales/avia/cadre', U.chief)).json();
    expect(cadre.sourceFigures.tag).toBe('[À VÉRIFIER]');
    expect(cadre.sourceFigures.constat.rows.map((r: { label: string }) => r.label)).toContain('Fret aérien');
    expect(cadre.availability.available).toBe(false);
    expect(cadre.coordination).toHaveLength(4);
  });
});
