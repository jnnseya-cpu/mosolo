import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppProvider } from '../src/context';
import { setDemoUser } from '../src/lib/api';
import { repartitionGuard, RepartitionView, type KeyView, type RepartitionReport } from '../src/modules/pilotage/Repartition';
import { OP_LABEL } from '../src/modules/tresor/shared';
import { visibleNav } from '../src/components/Shell';

const usd = (amount: string) => ({ amount, currency: 'USD' as const });
const SLICES = [
  { code: 'GROUPE_NSEYA', label: 'Groupe Nseya (investisseur et opérateur)', pct: '10', flow: 'FLUX_1' as const, remainder: false, calcul: 'De toute recette' },
  { code: 'TUTELLE', label: 'Ministère de tutelle du module', pct: '10', flow: 'FLUX_2' as const, remainder: false, calcul: 'Modules' },
  { code: 'AGENTS_SOUS_TRAITANTS', label: 'Agents de terrain et sous-traitants', pct: '10', flow: 'FLUX_2' as const, remainder: false, calcul: 'Réserve' },
  { code: 'GOUVERNEMENT_PROVINCIAL', label: 'Gouvernement provincial', pct: '70', flow: 'FLUX_2' as const, remainder: true, calcul: 'Solde' },
];
const agg = (base: string, parts: string[]) => ({
  currency: 'USD', base: usd(base), payments: 1,
  slices: SLICES.map((s, i) => ({ slice: s.code, label: s.label, pct: s.pct, flow: s.flow, amount: usd(parts[i]!) })),
  flows: [{ flow: 'FLUX_1', label: 'Flux 1 — compte de Groupe Nseya', amount: usd(parts[0]!) }, { flow: 'FLUX_2', label: 'Flux 2 — compte du Gouvernement provincial au Trésor', amount: usd((Number(base) - Number(parts[0])).toFixed(2)) }],
  check: { sumOfSlices: usd(base), equalsBase: true, flowsEqualBase: true },
});

const keyView = (over: Partial<KeyView['key']> = {}): KeyView => ({
  key: { id: 'CLE-37A-v1', status: 'ACTE_REQUIS', slices: SLICES, durationYears: 30, source: 'Cahier des exigences v2.9, § 37A', history: [], ...over },
  flows: { FLUX_1: { label: 'Flux 1 — compte de Groupe Nseya', beneficiary: 'Groupe Nseya', note: '10 %' }, FLUX_2: { label: 'Flux 2 — compte du Gouvernement provincial au Trésor', beneficiary: 'Gouvernement provincial', note: '90 %' } },
  baseDefinition: 'Recettes rapprochées', conditions: { contratPpp: 'Contrat PPP', conformiteLofip: 'LOFIP', conventionTripartite: 'Convention tripartite', traitementFiscal: 'Traitement fiscal' },
  notice: 'Simulation — aucun décaissement.', activationPath: ['Enregistrer l’acte', 'Publier la règle', 'Deux personnes'],
  registry: [{ id: 'rule-cle-repartition-37a-v1', version: 1, status: 'A_VERIFIER', executable: false, sourceReference: 'Cahier v2.9' }],
});

const report = (over: Partial<RepartitionReport> = {}): RepartitionReport => ({
  generatedAt: '2026-09-27T09:00:00.000Z', mode: 'SIMULATION', disbursement: 'AUCUN',
  notice: 'Simulation — aucun décaissement. Clé du § 37A non active : acte juridique provincial requis.',
  baseDefinition: 'Recettes rapprochées (états 8 et 9).', tutelleNote: 'Indicatif',
  key: { id: 'CLE-37A-v1', status: 'ACTE_REQUIS', version: 1, slices: SLICES, durationYears: 30, source: 'Cahier v2.9' },
  totals: [{ ...agg('1234.57', ['123.45', '123.45', '123.45', '864.22']), regularisations: { count: 0, amount: usd('0.00') } }],
  byPeriod: [{ ...agg('1234.57', ['123.45', '123.45', '123.45', '864.22']), period: '2026-09' }],
  byTutelle: [{ ...agg('1234.57', ['123.45', '123.45', '123.45', '864.22']), tutelle: 'Finances' }],
  agents: {
    commissionModuleLoaded: true, rows: [],
    totals: [{ currency: 'USD', reserve: usd('123.45'), commissionsValidated: usd('150.00'), commissionsRequested: usd('0.00'), commissionsAcquired: usd('150.00'), remaining: usd('-26.55'), consumptionPct: '121.5', status: 'DEPASSEMENT' }],
    rules: ['Les commissions des agents sont prélevées sur la réserve « agents et sous-traitants ».'],
  },
  distributions: [],
  ...over,
});

const USERS = [
  { id: 'u-gouverneur', name: 'Gouverneur (démo)', roles: ['R01'] },
  { id: 'u-ministre-finances', name: 'Ministre des Finances (démo)', roles: ['R05'] },
  { id: 'u-autorite-publication', name: 'Autorité de publication (démo)', roles: ['R16'] },
  { id: 'u-analyste-rappro', name: 'Analyste (démo)', roles: ['R18'] },
  { id: 'u-auditeur', name: 'Auditeur (démo)', roles: ['R22'] },
];
function mockApi(userId: string) {
  setDemoUser(userId);
  globalThis.fetch = vi.fn((url: string) => (String(url).includes('/v1/demo/users')
    ? Promise.resolve(new Response(JSON.stringify(USERS), { status: 200, headers: { 'content-type': 'application/json' } }))
    : Promise.reject(new TypeError('Failed to fetch')))) as unknown as typeof fetch;
}
afterEach(() => { setDemoUser(null); localStorage.clear(); });

describe('Répartition § 37A — garde des actions (acte + deux personnes)', () => {
  const u = (id: string) => USERS.find((x) => x.id === id)!;
  const act = { instrumentId: 'demo-instrument-001', reference: 'ARR', title: 'Arrêté', nature: 'ARRETE', signedOn: '2026-09-20', documentSha256: 'a'.repeat(64), conditions: {}, recordedBy: 'u-autorite-publication', recordedAt: '2026-09-26T09:00:00.000Z' };
  it('acte requis : aucune proposition sans acte, aucune proposition de décaissement', () => {
    const k = keyView().key;
    expect(repartitionGuard(k, u('u-ministre-finances'))).toMatchObject({ canPropose: false, canDecide: false, canProposeDisbursement: false });
    expect(repartitionGuard(k, u('u-autorite-publication')).canRecordAct).toBe(true);
    expect(repartitionGuard(k, u('u-analyste-rappro')).canProposeDisbursement).toBe(false);
    expect(repartitionGuard({ ...k, legalAct: act }, u('u-ministre-finances')).canPropose).toBe(true);
  });
  it('activation proposée : ni le proposant ni celui qui a enregistré l’acte ne décident', () => {
    const k = keyView({ status: 'ACTIVATION_PROPOSEE', legalAct: act, activation: { proposedBy: 'u-ministre-finances', proposedAt: '2026-09-26T10:00:00.000Z', motif: 'm', ruleId: 'r', ruleVersion: 2 } }).key;
    expect(repartitionGuard(k, u('u-ministre-finances')).decideBlock).toMatch(/proposé/);
    expect(repartitionGuard(k, u('u-autorite-publication')).decideBlock).toMatch(/enregistré l’acte/);
    expect(repartitionGuard(k, u('u-auditeur')).canDecide).toBe(false);
    expect(repartitionGuard(k, u('u-gouverneur'))).toMatchObject({ canDecide: true, decideBlock: null });
  });
  it('clé active : seuls le Trésor (R17) et l’analyste (R18) proposent les flux, validés ensuite à quatre yeux', () => {
    const k = keyView({ status: 'ACTIVE' }).key;
    expect(repartitionGuard(k, u('u-analyste-rappro')).canProposeDisbursement).toBe(true);
    expect(repartitionGuard(k, u('u-gouverneur')).canProposeDisbursement).toBe(false);
    expect(OP_LABEL.DECAISSEMENT_REPARTITION).toMatch(/deux flux/);
  });
});

describe('Répartition § 37A — écran', () => {
  it('simulation : bandeau « aucun décaissement », parts exactes, dépassement de la réserve des agents signalé', async () => {
    mockApi('u-auditeur');
    render(<AppProvider initialLang="fr"><RepartitionView report={report()} keyView={keyView()} onDone={() => undefined} /></AppProvider>);
    expect(screen.getByTestId('repartition-notice').textContent).toMatch(/Simulation — aucun décaissement/);
    expect(screen.getByTestId('repartition-notice').textContent).toMatch(/Acte requis/);
    expect(screen.getAllByText(/864,22|864\.22/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('100 % de l’assiette').length).toBe(1);
    expect(screen.getByText('Dépassement — à arbitrer')).toBeTruthy();
    expect(screen.getByText('121.5 %')).toBeTruthy();
    expect(screen.getAllByText('non documenté')).toHaveLength(4);
    expect(screen.getByText(/Clé non active : simulation seulement/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Proposer les deux flux/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Approuver l’activation/ })).toBeNull();
  });

  it('navigation : entrée « Répartition » pour la direction, les finances et l’audit ; jamais pour le contribuable ni l’agent', () => {
    const has = (roles: string[]) => visibleNav(roles).some((n) => n.to === '/pilotage/repartition');
    for (const r of ['R01', 'R05', 'R17', 'R22', 'R23']) expect(has([r])).toBe(true);
    for (const r of ['R30', 'R10']) expect(has([r])).toBe(false);
  });
});
