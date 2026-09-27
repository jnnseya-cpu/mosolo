/**
 * Écrans des modules 59 à 74 (compléments) : grand livre (59), coffre (60), moteur de découverte (61), répartition
 * automatique et contrôles (73), réserve des agents par points (67), suspension conservatoire des points (66).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '../src/context';
import { setDemoUser } from '../src/lib/api';
import { GrandLivrePanel, type GrandLivreIndicators } from '../src/modules/tresor/GrandLivrePanel';
import { VaultRegistryPanel, type VaultView } from '../src/modules/tresor/VaultRegistry';
import { OppIndicatorsPanel, PilotResultsSection } from '../src/modules/opportunites/Pilotes';
import { AutomationPanel, ControlsPanel, ConventionForm, ReserveModulesPanel, TableauPanel, type AutomationView } from '../src/modules/pilotage/RepartitionComplements';
import { ReserveBody, ReserveShareCard, type ReserveView } from '../src/modules/terrain/ReserveAgents';
import { EarningsBody, type MyEarnings } from '../src/modules/parking/AgentEarnings';

const USERS = [
  { id: 'u-tresor', name: 'Trésor (démo)', roles: ['R17'] },
  { id: 'u-auditeur', name: 'Auditeur (démo)', roles: ['R22'] },
  { id: 'u-autorite-publication', name: 'Autorité de publication (démo)', roles: ['R16'] },
  { id: 'u-ministre-finances', name: 'Ministre des Finances (démo)', roles: ['R05'] },
  { id: 'u-superviseur', name: 'Superviseur (démo)', roles: ['R09'] },
  { id: 'u-dg-dgipk', name: 'DG (démo)', roles: ['R06'] },
  { id: 'u-agent-terrain', name: 'Agent (démo)', roles: ['R10'] },
];
const usd = (amount: string) => ({ amount, currency: 'USD' as const });
const json = (v: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } }));

function mockApi(userId: string, routes: Record<string, unknown> = {}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  setDemoUser(userId);
  globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (String(url).includes('/v1/demo/users')) return json(USERS);
    const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
    return hit ? json(hit[1]) : Promise.reject(new TypeError('Failed to fetch'));
  }) as unknown as typeof fetch;
  return calls;
}
const renderApp = (el: JSX.Element) => render(<AppProvider initialLang="fr">{el}</AppProvider>);
afterEach(() => { setDemoUser(null); localStorage.clear(); });

describe('Module 59 — grand livre : scellement, écart aux relevés, délai de clôture', () => {
  const ind: GrandLivreIndicators = {
    generatedAt: '2026-09-27T09:00:00.000Z', entries: 12, balanced: true, reversals: 1,
    chain: { valid: true, entries: 12, headHash: 'a'.repeat(64) },
    ecartReleves: { byCurrency: [{ currency: 'USD', statements: usd('170.00'), ledger: usd('150.00'), gap: usd('20.00'), zero: false, pendingStatementLines: 1, pendingAmount: usd('20.00') }], statementsWithoutTotals: 0, method: 'Relevés − entrées de fonds.' },
    delaiCloture: { daily: [{ id: 'CLJ-2026-09-26', date: '2026-09-26', closedAt: '2026-09-27T09:00:00.000Z', entries: 5, delayHours: 10 }], monthly: [], medianDelayHours: 10, averageDelayHours: 10, lastDelayHours: 10, backlog: { oldestUnclosedDate: null, hoursSinceEnd: null } },
    suspense: { open: 2, oldestDays: 4 },
  };
  it('affiche les indicateurs et vérifie le scellement à la demande (rupture signalée)', async () => {
    const calls = mockApi('u-tresor', { '/v1/tresor/grand-livre/indicateurs': ind, '/v1/tresor/grand-livre/verification': { valid: false, entries: 12, headHash: 'b', brokenAt: 'GL-00000003', reason: 'EMPREINTE_INVALIDE', closures: { valid: true }, verifiedAt: '2026-09-27T09:05:00.000Z' } });
    renderApp(<GrandLivrePanel />);
    expect(await screen.findByText('Intègre')).toBeTruthy();
    expect(screen.getAllByText('10 h').length).toBeGreaterThan(0);
    expect(screen.getByText('20.00')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Vérifier le scellement/ }));
    expect(await screen.findByText(/rompue à GL-00000003/)).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/v1/tresor/grand-livre/verification'))).toBe(true);
  });
});

describe('Module 60 — coffre : registre verrouillé, indicateurs, veto motivé', () => {
  const view: VaultView = {
    accounts: [
      { alias: 'KIN-DGIPK-RECETTES-01', entity: 'DGIPK', kind: 'BANCAIRE', bankName: 'Banque A', accountNumber: '•••• 2345', holderName: 'DGIPK', currency: 'USD', version: 1, effectiveSince: '2026-09-01T00:00:00.000Z' },
      { alias: 'KIN-DGRK-MM-01', entity: 'DGRK', kind: 'MOBILE_MONEY', bankName: 'Opérateur A', accountNumber: '•••• 0001', holderName: 'DGRK', currency: 'CDF', version: 1, effectiveSince: '2026-09-01T00:00:00.000Z' },
    ],
    changeRequests: [{ id: 'CHG-000001', alias: 'KIN-DGRK-MM-01', status: 'EN_REFROIDISSEMENT', requestedBy: 'u-tresor', requestedAt: '2026-09-26T09:00:00.000Z', coolingEndsAt: '2026-09-29T09:00:00.000Z', proposed: { bankName: 'B', accountNumber: '•••• 0002', holderName: 'DGRK' } }],
    indicators: { requested: 1, approved: 1, effective: 0, refused: 0, pending: 0, coolingOff: 1, accounts: { total: 2, bank: 1, mobileMoney: 1 } },
  };
  it('comptes bancaires et Mobile Money ; veto motivé par l’audit', async () => {
    const calls = mockApi('u-auditeur', { '/v1/beneficiary-accounts/change-requests/CHG-000001/veto': { id: 'CHG-000001', status: 'ANNULEE' }, '/v1/beneficiary-accounts': view });
    renderApp(<VaultRegistryPanel />);
    expect(await screen.findByText('Mobile Money public')).toBeTruthy();
    expect(screen.getByText('1 bancaire(s) · 1 Mobile Money')).toBeTruthy();
    const input = await screen.findByLabelText('Motif du veto CHG-000001');
    fireEvent.change(input, { target: { value: 'Changement non annoncé au comité.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Opposer un veto' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/veto') && c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.url.includes('/veto'))!.body).toEqual({ motif: 'Changement non annoncé au comité.' });
  });
});

describe('Module 61 — indicateurs et résultats de pilote', () => {
  it('opportunités instruites et gain net ; constat d’un résultat par le comité de pilotage', async () => {
    const calls = mockApi('u-ministre-finances', {
      '/v1/opportunites-indicateurs': { generatedAt: 'x', opportunites: { total: 20, instruites: 7, enInstruction: 5, signauxNonInstruits: 3, decidees: { total: 2, ACTIVATION: 1, REPORT: 1, ABANDON: 0 }, parEtape: [] }, pilotes: { resultats: 1, opportunitesPilotees: 1, gainNet: [{ currency: 'CDF', netGain: { amount: '1500000.00', currency: 'CDF' }, netGainWithComparison: { amount: '1500000.00', currency: 'CDF' }, pilots: 1 }] }, methode: 'Gain net = pilote − témoin − coût.' },
      '/resultats-pilote': { items: [] },
    });
    renderApp(<><OppIndicatorsPanel /><PilotResultsSection opportunityId="OPP-1" pilotDefined roles={['R05']} /></>);
    expect(await screen.findByText('Opportunités instruites')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Début'), { target: { value: '2026-07-01' } });
    fireEvent.change(screen.getByLabelText('Fin'), { target: { value: '2026-09-30' } });
    fireEvent.change(screen.getByLabelText('Périmètre pilote'), { target: { value: 'Limete' } });
    fireEvent.change(screen.getByLabelText('Recettes observées (pilote)'), { target: { value: '12000000,00' } });
    fireEvent.change(screen.getByLabelText('Coût d’implémentation'), { target: { value: '1500000.00' } });
    fireEvent.change(screen.getByLabelText('Source des chiffres'), { target: { value: 'Relevés rapprochés' } });
    fireEvent.click(screen.getByRole('button', { name: 'Constater le résultat' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.includes('/v1/opportunites/OPP-1/resultats-pilote'))).toBe(true));
    const body = calls.find((c) => c.method === 'POST')!.body as { observedRevenue: { amount: string }; comparisonRevenue?: unknown };
    expect(body.observedRevenue.amount).toBe('12000000.00');
    expect(body.comparisonRevenue).toBeUndefined();
  });
});

describe('Module 73 — exécution automatique, tableau, contrôles à 100 %, convention', () => {
  const automation: AutomationView = {
    mode: 'EXECUTION_AUTOMATIQUE', periodicite: 'QUOTIDIENNE', missing: [], rule: 'Exécution AUTOMATIQUE des deux flux.',
    convention: { reference: 'CONV-1', bank: 'Banque de règlement', signedOn: '2026-09-21', documentSha256: 'a'.repeat(64), periodicite: 'QUOTIDIENNE', beneficiaries: [{ flow: 'FLUX_1', currency: 'USD', alias: 'NSEYA-FLUX1-USD' }, { flow: 'FLUX_2', currency: 'USD', alias: 'GVT-PROV-FLUX2-USD' }], recordedBy: 'u-autorite-publication', recordedAt: '2026-09-26T10:00:00.000Z' },
    lastRun: { id: 'RUN-000001', at: '2026-09-27T08:00:00.000Z', trigger: 'planificateur', mode: 'EXECUTION', created: ['REP-000001'], skipped: [] },
    simulations: [],
  };
  it('mode et convention affichés ; le Trésor déclenche le traitement idempotent', async () => {
    const calls = mockApi('u-tresor', { '/v1/pilotage/repartition/automatisation/executer': { run: {} } });
    const onDone = vi.fn();
    renderApp(<AutomationPanel automation={automation} onDone={onDone} />);
    expect(screen.getByTestId('repartition-automation').textContent).toContain('Exécution automatique des deux flux');
    expect(screen.getByText(/NSEYA-FLUX1-USD/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Exécuter le traitement maintenant' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/automatisation/executer'))).toBe(true);
  });
  it('tableau, contrôle à 100 %, régularisations en attente et indicateurs', () => {
    mockApi('u-auditeur');
    renderApp(<>
      <TableauPanel tableau={{ rows: [{ period: '2026-09', currency: 'USD', rapproche: usd('150.00'), calcule: usd('150.00'), verse: usd('150.00'), resteAVerser: usd('0.00'), resteAArreter: usd('0.00'), simule: usd('0.00'), distributionId: 'REP-000001', etat: 'VERSE' }], note: 'Versé = instruction émise.' }} />
      <ControlsPanel report={{
        check100: { keySlicesSumTo100: false, partsEqualBase: true, flowsEqualBase: true },
        regularisationsPending: [{ orderId: 'PO-1', paymentReference: 'PR-AAAA-BBBB', distributionId: 'REP-000001', period: '2026-09-26', currency: 'USD', amount: usd('150.00'), status: 'REMBOURSE' }],
        indicateurs: { ecartRepartition: { distributionsWithPartsGap: 0, instructedVsLedger: [{ currency: 'USD', instructed: usd('150.00'), ledger: usd('150.00'), gap: usd('0.00'), zero: true }] }, delaiVersement: { flowsInstructed: 2, averageDays: 0, maxDays: 0 }, grandLivre: { arretees: [{ currency: 'USD', repartitions: usd('150.00'), grandLivre: usd('150.00'), gap: usd('0.00'), zero: true }], simulees: [], simulations: 0 } },
      }} />
      <ReserveModulesPanel report={{ agentsByModule: [{ module: 'DEMO-IF-BATI', tutelle: 'Finances', currency: 'USD', base: usd('150.00'), reserve: usd('15.00'), payments: 1 }], pointsShares: [{ period: '2026-09', currency: 'USD', computed: true, reserve: usd('15.00'), distributed: usd('14.99'), payable: usd('10.00'), undistributed: usd('0.01'), agents: 2, withinReserve: true }] }} />
    </>);
    expect(screen.getAllByText('Versé').length).toBeGreaterThan(0);
    expect(screen.getByTestId('repartition-check100').textContent).toMatch(/Écart à 100 %/);
    expect(screen.getByText('PR-AAAA-BBBB')).toBeTruthy();
    expect(screen.getByTestId('repartition-indicators').textContent).toMatch(/écart nul/);
    expect(screen.getByText('Dans la réserve')).toBeTruthy();
  });
  it('convention : deux flux, alias du coffre par devise (jamais un numéro de compte)', async () => {
    const calls = mockApi('u-autorite-publication', { '/convention': { id: 'CLE-37A-v1' } });
    renderApp(<ConventionForm keyId="CLE-37A-v1" current={null} onDone={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Référence'), { target: { value: 'CONV-1' } });
    fireEvent.change(screen.getByLabelText('Banque de règlement'), { target: { value: 'Banque de règlement' } });
    fireEvent.change(screen.getByLabelText('Signée le'), { target: { value: '2026-09-21' } });
    fireEvent.change(screen.getByLabelText('Empreinte SHA-256 de la convention'), { target: { value: 'a'.repeat(64) } });
    fireEvent.change(screen.getByLabelText('Flux 1 (Groupe Nseya) — USD'), { target: { value: 'NSEYA-FLUX1-USD' } });
    fireEvent.change(screen.getByLabelText('Flux 2 (Gouvernement provincial) — USD'), { target: { value: 'GVT-PROV-FLUX2-USD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer la convention' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.includes('/v1/pilotage/repartition/cles/CLE-37A-v1/convention'))).toBe(true));
    expect((calls.find((c) => c.method === 'POST')!.body as { beneficiaries: unknown[] }).beneficiaries).toEqual([
      { flow: 'FLUX_1', currency: 'USD', alias: 'NSEYA-FLUX1-USD' }, { flow: 'FLUX_2', currency: 'USD', alias: 'GVT-PROV-FLUX2-USD' },
    ]);
  });
});

describe('Module 67 — réserve des agents : points vérifiés × note de qualité', () => {
  const reserve: ReserveView = {
    period: '2026-11', generatedAt: 'x', mode: 'SIMULATION', notice: 'Simulation : clé du § 37A non active.', reservePct: '10',
    weights: { objetConfirme: 1, enrolementValide: 1, regularisationConfirmee: 1, noteSansJugement: 1, status: 'par défaut — à confirmer par le maître d’ouvrage' },
    modules: [{ module: 'DEMO-IF-BATI', currency: 'USD', reserve: usd('15.00'), base: usd('150.00'), weightedPoints: 3.5, points: 4, distributed: usd('14.99'), undistributed: usd('0.01'), status: 'REPARTIE', holders: [{ agentId: 'u-agent-terrain', name: 'Agent (démo)', team: 'Équipe de la régie DGIPK', points: 3, weightedPoints: 3, sharePct: '85.7', share: usd('12.85'), payable: usd('8.56') }] }],
    agents: [{ agentId: 'u-agent-terrain', name: 'Agent (démo)', team: 'REGIE:DGIPK', teamLabel: 'Équipe de la régie DGIPK', subcontractorId: null, points: 3, byKind: { OBJET_CONFIRME: 2, ENROLEMENT_VALIDE: 0, REGULARISATION_CONFIRMEE: 1 }, weightedPoints: 3, quality: { score: 1, confirmed: 2, judged: 2, byDefault: false }, modules: ['DEMO-IF-BATI'], share: [usd('12.85')], payable: [usd('8.56')], toRecover: [], netPayable: [usd('8.56')] }],
    teams: [{ key: 'REGIE:DGIPK', label: 'Équipe de la régie DGIPK', agents: 1, points: 3, share: [usd('12.85')], payable: [usd('8.56')] }], subcontractors: [],
    points: { verified: 3, pending: 1, reclaimed: 0, suspected: 0, unattached: 0 },
    items: [{ key: 'OBJ:CST-1', kind: 'OBJET_CONFIRME', kindLabel: 'Objet confirmé après contrôle qualité', agentId: 'u-agent-terrain', subcontractorId: null, team: 'REGIE:DGIPK', month: '2026-11', at: '2026-11-10T10:00:00.000Z', modules: ['DEMO-IF-BATI'], points: 1, reference: 'Constat CST-1', status: 'VERIFIE', validation: 'VALIDE' }],
    clawbacks: [{ id: 'RPT-000001', pointKeys: ['OBJ:CST-2'], agentId: 'u-agent-terrain', grounds: 'POINT_FICTIF', motif: 'Objet inexistant.', proposedBy: 'u-superviseur', proposedAt: 'x', status: 'PROPOSEE' }],
    rules: ['Réserve de 10 % par module : jamais selon le montant.'], cashHandled: false,
  };
  it('carte « ma quote-part » dans l’écran « Mes gains » harmonisé', () => {
    mockApi('u-agent-terrain');
    const d: MyEarnings = { agentId: 'u-agent-terrain', ratePct: 10, rules: [], counts: { penalites: 0, paiements: 1 }, totals: { acquise: [], confirmee: [], enAttente: [], annulee: [], base: [], ceMois: [], payable: [] }, lines: [], reserve };
    renderApp(<EarningsBody d={d} fmtDate={(iso) => iso ?? ''} />);
    expect(screen.getByTestId('reserve-share-card').textContent).toContain('Ma quote-part de la réserve');
    expect(screen.getByText('Quote-part payable')).toBeTruthy();
    expect(screen.getByText('100 %')).toBeTruthy();
    renderApp(<ReserveShareCard reserve={{ ...reserve, agents: [] }} />);
    expect(screen.getByText('Aucun point de résultat vérifié ce mois-ci')).toBeTruthy();
  });
  it('contrôle qualité : propose la reprise d’un point ; la régie décide (pas le proposant)', async () => {
    let calls = mockApi('u-superviseur', { '/v1/agents/reserve/reprises': { id: 'RPT-000002' } });
    const { unmount } = renderApp(<ReserveBody d={reserve} onDone={() => undefined} />);
    expect(screen.getByTestId('reserve-notice').textContent).toContain('Simulation');
    const why = await screen.findByLabelText('Justification OBJ:CST-1');
    fireEvent.change(why, { target: { value: 'Objet introuvable à la contre-visite.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Proposer la reprise' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/v1/agents/reserve/reprises'))).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ pointKeys: ['OBJ:CST-1'], grounds: 'POINT_FICTIF' });
    unmount();
    calls = mockApi('u-dg-dgipk', { '/v1/agents/reserve/reprises/RPT-000001/decision': { id: 'RPT-000001', status: 'DECIDEE' } });
    renderApp(<ReserveBody d={reserve} onDone={() => undefined} />);
    const motif = await screen.findByLabelText('Motif de décision RPT-000001');
    fireEvent.change(motif, { target: { value: 'Contre-visite probante (décision).' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reprendre les points' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.includes('/RPT-000001/decision'))).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ approve: true, motif: 'Contre-visite probante (décision).' });
  });
});
