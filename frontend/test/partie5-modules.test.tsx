/**
 * Écrans des modules 75 à 81 et des parcours de la Partie V : tarification ParkSmart automatique dans les fourchettes de
 * l'acte, facturation AVIA automatique après arrêté (et contradictoire de la compagnie), situation NFIU complète pour
 * l'agent habilité, limites et commissions RakaPay, période de grâce, constats et pénalités contestables, patrimoine
 * provincial, environnement, détermination des obligations, parcours de bout en bout.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { AppProvider } from '../src/context';
import { setDemoUser } from '../src/lib/api';
import { TarificationDynamiqueTab } from '../src/modules/parking/TarificationDynamique';
import { AviaAutoAirline, AviaAutoSection } from '../src/modules/verticales/AviaAuto';
import { NfiuHabilitations, NfiuRapports, NfiuSituation } from '../src/modules/verticales/Nfiu';
import { ConstatsPanel, GracePanel, MesPenalites, OperatorTools } from '../src/modules/rakapay/Billetterie';
import { ParcoursPanel } from '../src/modules/verticales/Parcours';
import Patrimoine from '../src/modules/verticales/Patrimoine';
import Environnement from '../src/modules/verticales/Environnement';
import { EtablissementObligations } from '../src/modules/verticales/Determination';

function mockApi(routes: Record<string, unknown>) {
  const calls: { url: string; method: string; body?: string }[] = [];
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined });
    const path = Object.keys(routes).sort((a, b) => b.length - a.length).find((p) => url.split('?')[0]!.endsWith(p));
    if (!path) return Promise.resolve(new Response(JSON.stringify({ title: 'Introuvable', status: 404 }), { status: 404, headers: { 'content-type': 'application/json' } }));
    return Promise.resolve(new Response(JSON.stringify(routes[path]), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
  return calls;
}
const renderApp = (ui: ReactElement) => render(<MemoryRouter><AppProvider initialLang="fr">{ui}</AppProvider></MemoryRouter>);
const usd = (amount: string) => ({ amount, currency: 'USD' as const });

describe('Module 75 — tarification automatique dans les fourchettes de l’acte', () => {
  it('zone automatique : fourchettes et tarif appliqué par heure, historique ; zone sans acte : recommandation seulement', async () => {
    mockApi({
      '/v1/demo/users': [],
      '/v1/parking/tarification-dynamique': {
        target: { minPct: 15, maxPct: 25 }, scheduler: { active: false, frequency: 'Chaque heure écoulée (heure de Kinshasa)' }, notice: 'Tarification automatique à l’intérieur des fourchettes fixées par l’acte.',
        runs: [],
        zones: [
          { zoneId: 'Z1', code: 'EX-DYN-01', name: 'Zone d’exemple', commune: 'Gombe', demo: true, mode: 'AUTOMATIQUE', reason: 'Fourchettes fixées par la règle EX-PARK-DYN v1.', rule: { code: 'EX-PARK-DYN', version: 1, demo: true, currency: 'CDF' }, currentHour: 9, currentRate: '750',
            hours: [{ hour: 9, band: { min: '500', max: '1000', step: '250' }, rate: '750', lastEvaluated: '2026-09-26|09' }], history: [{ at: '2026-09-26T09:00:00Z', hour: 9, from: '500', to: '750', freeRate: '0.0', reason: 'hausse d’un pas', trigger: 'MANUELLE' }] },
          { zoneId: 'Z2', code: 'GOMBE-REEL', name: 'Gombe intégrale', commune: 'Gombe', demo: false, mode: 'RECOMMANDATION_SEULEMENT', reason: 'Sans acte : zone au statut ACTE_REQUIS.', rule: null, currentHour: 9, currentRate: null, hours: [], history: [] },
        ],
      },
    });
    renderApp(<TarificationDynamiqueTab />);
    expect(await screen.findByText('Tarif automatique (fourchettes de l’acte)')).toBeTruthy();
    expect(screen.getByText('Recommandation seulement')).toBeTruthy();
    expect(screen.getByText(/Sans acte/)).toBeTruthy();
    expect(screen.getAllByText('750').length).toBeGreaterThan(0);
    expect(screen.getByText(/500 → 750/)).toBeTruthy();
  });
});

describe('Modules 62 et 78 — facturation automatique des écarts après arrêté', () => {
  const exec = {
    id: 'AVIA-AUTO-2026-08-TP-B', period: '2026-08', airlineTaxpayerId: 'TP-B', airlineName: 'Compagnie B', kind: 'FACTURATION', trigger: 'PLANIFIEE', actReference: 'Arrêté EX',
    remittanceGap: '25.00', boardedWithoutIfa: 1, gapLabels: [],
    billings: [{ ruleCode: 'AVIA-ECART-REVERSEMENT', ruleVersion: 1, obligationId: 'OBL-1', amount: usd('25.00'), label: 'Taxe non créditée à la Ville (2026-08)', status: 'EMISE', dueDate: '2026-10-26', appeal: null }],
    creditsApplied: [], compensation: null, notExecuted: [{ label: 'Fret : 750 kg d’écart', reason: 'Décision humaine.' }],
    contradictory: { deadline: '2026-10-11', observations: [] }, contradictoryOpen: true, total: usd('25.00'), notice: 'Avis émis automatiquement après l’arrêté.', at: '2026-09-26T09:00:00Z',
  };
  it('console : mode, règles, passages ; exécution manuelle du passage mensuel', async () => {
    const calls = mockApi({
      '/v1/demo/users': [],
      '/v1/verticales/avia/auto': {
        currentMode: { period: '2026-08', mode: 'EXECUTION', reason: 'Arrêté EX enregistré.', act: { reference: 'Arrêté EX', signedOn: '2026-08-01' } },
        scheduler: { active: true, frequency: 'Mensuelle', lastRun: null },
        rules: [{ code: 'AVIA-ECART-REVERSEMENT', label: 'Écart de reversement', status: 'ACTIVE', version: 1, demo: true }],
        totals: { executions: 1, billed: [usd('25.00')], compensated: '0.00', creditsRemaining: '0.00', observations: 0 },
        runs: [{ id: 'R1', period: '2026-08', mode: 'EXECUTION', trigger: 'PLANIFIEE', at: '2026-09-01T00:00:00Z', reason: 'x', executions: ['X'], skipped: [] }],
        executions: [exec], notice: 'Avant l’arrêté : proposition seulement.',
      },
      '/v1/verticales/avia/auto/run': { run: { mode: 'EXECUTION' }, executions: [] },
    });
    renderApp(<AviaAutoSection />);
    expect(await screen.findByText('Exécution automatique (après arrêté)')).toBeTruthy();
    expect(screen.getByText('Avis émis')).toBeTruthy();
    expect(screen.getByText(/Fret : 750 kg/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Exécuter le passage mensuel' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/v1/verticales/avia/auto/run') && c.method === 'POST')).toBe(true));
  });
  it('compagnie : observations dans le délai après l’avis', async () => {
    const calls = mockApi({ '/v1/demo/users': [], '/v1/verticales/avia/auto/executions': { items: [exec] }, '/observations': exec });
    renderApp(<AviaAutoAirline />);
    const box = await screen.findByLabelText('Vos observations sur cet avis');
    fireEvent.change(box, { target: { value: 'Billet émis hors BSP, pièces jointes.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Présenter mes observations' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/observations') && c.method === 'POST')).toBe(true));
  });
});

describe('Module 79 — NFIU : situation complète, habilitations, rapports journaliers', () => {
  it('situation complète en lecture seule : propriétaire, loyers, IF et IRL, payé / impayé, pénalités', () => {
    mockApi({ '/v1/demo/users': [] });
    renderApp(<NfiuSituation s={{
      owner: { taxpayerId: 'TP-1', name: 'Propriétaire fictif', kind: 'PP' },
      occupation: { status: 'LOUE', label: 'Loué (bail déclaré)', leases: [{ id: 'B1', rent: usd('300.00'), periodicity: 'MENSUELLE', start: '2026-01-01', probativeStatus: 'DECLARE' }] },
      obligations: [
        { id: 'O1', kind: 'IF', label: 'Impôt foncier', amount: usd('150.00'), dueDate: '2026-10-26', payment: 'IMPAYE', paymentLabel: 'Impayé à l’échéance', remaining: usd('150.00'), penalties: { overdueDays: 12, items: [{ id: 'P1', status: 'PROPOSEE', amount: usd('10.00') }] } },
        { id: 'O2', kind: 'IRL', label: 'IRL', amount: usd('264.00'), dueDate: '2026-10-26', payment: 'PAYE', paymentLabel: 'Payé', remaining: usd('0.00'), penalties: { overdueDays: 0, items: [] } },
      ],
      totals: { IF: { due: [usd('150.00')], paid: [], remaining: [usd('150.00')], unpaid: 1 }, IRL: { due: [usd('264.00')], paid: [usd('264.00')], remaining: [], unpaid: 0 } },
      history: { payments: [], plates: [], scans: [], visits: [] }, editable: false, notice: 'Situation complète en lecture seule.',
    }} />);
    expect(screen.getByText(/Propriétaire fictif/)).toBeTruthy();
    expect(screen.getByText('Loué (bail déclaré)')).toBeTruthy();
    expect(screen.getByText('Impayé à l’échéance')).toBeTruthy();
    expect(screen.getByText('Payé')).toBeTruthy();
    expect(screen.getByText(/Pénalité proposee/)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('habilitations et rapport journalier', async () => {
    mockApi({
      '/v1/demo/users': [],
      '/v1/verticales/nfiu/habilitations': { items: [{ userId: 'u-agent-terrain', agentName: 'Agent de terrain Limete', communes: ['Limete'], motif: 'Campagne de recouvrement', validUntil: '2026-12-31', active: true }] },
      '/v1/verticales/nfiu/rapports': { date: '2026-09-26', generatedAt: '2026-09-26T20:00:00Z', trigger: 'PLANIFIEE', agents: [{ agentId: 'u-agent-terrain', agentName: 'Agent de terrain Limete', platesIssued: 1, platesReplaced: 0, scans: 3, fullSituations: 1, bySituation: { red: 1, amber: 1, green: 1, grey: 0 }, presenceVerified: 2, communes: ['Limete'] }] },
    });
    renderApp(<><NfiuHabilitations /><NfiuRapports /></>);
    expect(await screen.findByText('Active')).toBeTruthy();
    expect(await screen.findByText(/Production automatique/)).toBeTruthy();
    expect(screen.getAllByText('Agent de terrain Limete').length).toBeGreaterThan(1);
  });
});

describe('Modules 76 et 81 — limites, commissions, grâce, pénalités contestables', () => {
  it('analyse quotidienne et ajustement par l’opérateur dans les limites approuvées', async () => {
    const calls = mockApi({
      '/v1/demo/users': [],
      '/analyse-quotidienne': {
        date: '2026-09-26', viewer: 'EXPLOITANT', sales: 3, amounts: [{ amount: '5400', currency: 'CDF' }], cancellations: 0, previous7DaysAverage: 1.2, trend: 'HAUSSE',
        commissions: { count: 3, amounts: [{ amount: '432', currency: 'CDF' }], payer: 'Opérateur (contrat opérateur-agent) — jamais le compte public' }, byHour: [], byOffer: [], byAgent: [],
        limits: { commissionMaxPct: '10', priceBands: [{ offerId: 'OFR-1', min: { amount: '1000', currency: 'CDF' }, max: { amount: '2000', currency: 'CDF' } }], motif: 'x', approvedAt: '2026-09-26' }, grid: { rates: [{ offerId: '*', pct: '8' }], updatedAt: '2026-09-26' },
      },
      '/prix': {},
    });
    renderApp(<OperatorTools operatorId="OPR-1" viewer="EXPLOITANT" offers={[{ id: 'OFR-1', commercialName: 'Parking 3 h', publicRevenue: false, status: 'APPROUVEE' }]} agents={[]} />);
    expect(await screen.findByText(/jamais le compte public/)).toBeTruthy();
    expect(screen.getByText(/commission ≤ 10 %/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Nouveau prix'), { target: { value: '1800' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ajuster dans les limites' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/v1/rakapay/offres/OFR-1/prix'))).toBe(true));
  });
  it('période de grâce, constats (pénalité retenue) et contestation par le redevable', async () => {
    mockApi({
      '/v1/demo/users': [],
      '/v1/rakapay/periode-grace': { modules: [{ module: '81', until: '2026-10-31', active: true, pending: null }, { module: '76', until: null, active: false, pending: null }], notice: 'Pendant la période de grâce, les constats sont pédagogiques.' },
      '/v1/titres/constats': [{ id: 'CST-1', module: '81', at: '2026-10-06', status: 'OUVERT', reason: 'Aucun titre valide présenté', duringGrace: false, presented: 'KNM20418' }],
    });
    renderApp(<><GracePanel /><ConstatsPanel module="81" /></>);
    expect(await screen.findByText(/jusqu’au 2026-10-31/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Retenir la pénalité' })).toBeTruthy();
  });
  it('le redevable voit sa pénalité et peut la contester', async () => {
    const calls = mockApi({
      '/v1/demo/users': [{ id: 'rk-conducteur-2', name: 'Conducteur', roles: ['R30'], entity: 'PUBLIC', taxpayerId: 'TP-RK-WEWA-0002' }],
      '/v1/titres/constats/mine': [{ id: 'CST-2', module: '81', at: '2026-10-06', status: 'RETENU', reason: 'Aucun pass', penalty: { amount: { amount: '250', currency: 'CDF' }, percentage: '50', obligationId: 'OBL-P' }, contests: [] }],
      '/contestation': { id: 'CST-2' },
    });
    vi.spyOn(window, 'prompt').mockReturnValue('Pass payé la veille par la coopérative.');
    setDemoUser('rk-conducteur-2');
    renderApp(<MesPenalites />);
    expect(await screen.findByText(/50 % du ticket de référence/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Contester' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/v1/titres/constats/CST-2/contestation') && c.method === 'POST')).toBe(true));
    setDemoUser(null);
  });
});

describe('Partie V — écrans des parcours, patrimoine, environnement, détermination', () => {
  it('parcours de bout en bout : étapes, écrans et règles propres', () => {
    renderApp(<ParcoursPanel parcours={{ nomPartieV: 'MOSOLO Assets', finalite: 'Valoriser le patrimoine provincial.', modules: [48, 61], reglesPropres: ['Aucune attribution de gré à gré sans procédure.'], etapes: [{ rang: 1, label: 'Inventaire des actifs', modules: [48], ecran: '/verticales/actifs', route: 'POST /v1/verticales/actifs/inventaire' }] }} />);
    expect(screen.getByText('1. Inventaire des actifs')).toBeTruthy();
    expect(screen.getByText(/gré à gré/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ouvrir l’écran' }).getAttribute('href')).toBe('/verticales/actifs');
  });
  it('patrimoine provincial : inventaire, appels, revenus domaniaux', async () => {
    mockApi({
      '/v1/demo/users': [],
      '/v1/verticales/actifs': { assets: [{ id: 'ACT-1', reference: 'PAT-1', nature: 'LOCAL_COMMERCIAL', designation: 'Local d’exemple', commune: 'Gombe', status: 'ATTRIBUE', demo: true, evaluation: { annualRevenueEstimate: usd('6000.00'), marketValue: usd('90000.00') } }], calls: [{ id: 'APL-1', reference: 'APL-2026-1', assetId: 'ACT-1', procedure: 'APPEL_PUBLIC', deadline: '2026-09-28T09:00:00Z', status: 'ATTRIBUE', reservePrice: usd('6000.00'), candidatures: 1, award: { caseId: 'C1', motif: 'Offre la mieux-disante' } }] },
      '/v1/verticales/actifs/revenus': { rule: { code: 'VX-ACT-REDEVANCE', status: 'ACTIVE', demo: true }, items: [{ assetId: 'ACT-1', reference: 'PAT-1', designation: 'Local d’exemple', status: 'ATTRIBUE', obligations: 1, liquidated: [usd('6500.00')], paid: [usd('6500.00')], reconciled: [] }], notice: 'Aucune attribution de gré à gré.' },
    });
    renderApp(<Patrimoine />);
    expect(await screen.findByText(/Offre la mieux-disante/)).toBeTruthy();
    expect(await screen.findByText(/Règle VX-ACT-REDEVANCE : ACTIVE \[EXEMPLE\]/)).toBeTruthy();
  });
  it('environnement : registre désactivé sans édit, simulation sans effet', async () => {
    const calls = mockApi({
      '/v1/demo/users': [],
      '/v1/verticales/environnement/registre': { rule: { code: 'VX-ENV-PLASTIQUE', status: 'ACTE_REQUIS' }, activated: false, notice: 'Désactivé tant qu’aucun édit n’est publié.', items: [{ objectId: 'O1', raisonSociale: 'Emballages d’exemple', categorie: 'PRODUCTEUR', commune: 'Limete', tonnage: { tonnes: '40', periode: null }, obligations: 0 }] },
      '/v1/verticales/environnement/simulations': { id: 'S1', estimate: usd('2000.00'), declaredTonnes: '40', registrants: 1, effect: 'AUCUN' },
    });
    renderApp(<Environnement />);
    expect(await screen.findByText('Désactivé : aucun édit publié')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Hypothèse'), { target: { value: 'Hypothèse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simuler' }));
    expect(await screen.findByText(/aucun effet/)).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/simulations') && c.method === 'POST')).toBe(true);
  });
  it('entreprises : la règle décide (aucune obligation créée par la détermination)', async () => {
    mockApi({
      '/v1/demo/users': [],
      '/obligations': { objectId: 'O1', activite: 'Débit de boissons', commune: 'Gombe', localityRank: 1, categorie: 'PERSONNE_PHYSIQUE', notice: 'L’existence d’une activité n’emporte pas assujettissement : la règle décide.', items: [{ code: 'PATENTE', label: 'Patente', ruleCode: 'VX-ENT-PATENTE', ruleStatus: 'ACTE_REQUIS', demo: false, applicable: false, action: 'Aucune règle ACTIVE : aucun montant (la règle décide).', criteres: { activite: 'Débit de boissons', lieu: 'Gombe', categorie: 'PP' } }] },
    });
    renderApp(<EtablissementObligations objectId="O1" label="Bar d’exemple" />);
    expect(await screen.findByText(/la règle décide\)/)).toBeTruthy();
    expect(screen.getByText('ACTE_REQUIS')).toBeTruthy();
  });
});
