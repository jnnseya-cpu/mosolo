import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppProvider } from '../src/context';
import { setDemoUser } from '../src/lib/api';
import { pointDecisionGuard } from '../src/modules/canaux/shared';
import { FourEyesActions } from '../src/modules/canaux/PointsSupervision';
import { EarningsBody, type MyEarnings } from '../src/modules/parking/AgentEarnings';
import { canDecideCommission, ValidationQueueView, type ValidationQueue, type ValidationRequest } from '../src/modules/parking/CommissionValidations';

const USERS = [
  { id: 'u-tresor', name: 'Trésor (démo)', roles: ['R17'] },
  { id: 'canaux-tresor-2', name: 'Trésor bis (démo)', roles: ['R17'] },
  { id: 'u-analyste', name: 'Analyste (démo)', roles: ['R18'] },
  { id: 'pk-regie', name: 'Cheffe de service (démo)', roles: ['R07'] },
  { id: 'pk-controleur', name: 'Contrôleuse (démo)', roles: ['R11'] },
];
const json = (v: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } }));

function mockApi(userId: string, routes: Record<string, unknown> = {}) {
  const calls: { url: string; body?: unknown }[] = [];
  setDemoUser(userId);
  globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (String(url).includes('/v1/demo/users')) return json(USERS);
    const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
    return hit ? json(hit[1]) : Promise.reject(new TypeError('Failed to fetch'));
  }) as unknown as typeof fetch;
  return calls;
}
const renderApp = (el: JSX.Element) => render(<AppProvider initialLang="fr">{el}</AppProvider>);
afterEach(() => { setDemoUser(null); localStorage.clear(); });

describe('Points agréés : rétablissement et écartement en deux actes (quatre yeux)', () => {
  const req = { by: 'u-analyste', at: '2026-09-27T08:00:00.000Z', motif: 'Écart régularisé, pièces reçues.' };
  it('garde : R17/R18 demandent ; seul un R17 distinct du demandeur et de celui qui a suspendu décide', () => {
    const u = (id: string) => USERS.find((x) => x.id === id)!;
    expect(pointDecisionGuard(undefined, u('u-analyste'))).toMatchObject({ canRequest: true, canDecide: false });
    expect(pointDecisionGuard(undefined, u('pk-regie'))).toMatchObject({ canRequest: false });
    expect(pointDecisionGuard(req, u('u-analyste')).block).toMatch(/R17/);
    expect(pointDecisionGuard({ ...req, by: 'u-tresor' }, u('u-tresor')).block).toMatch(/autre personne/);
    expect(pointDecisionGuard(req, u('u-tresor'), ['u-tresor']).block).toMatch(/suspendu ce point/);
    expect(pointDecisionGuard(req, u('canaux-tresor-2'), ['u-tresor'])).toMatchObject({ canDecide: true, block: null });
  });

  it('écran : la seconde personne approuve ou refuse sur la route de décision, avec motif', async () => {
    mockApi('canaux-tresor-2');
    const act = vi.fn(async () => undefined);
    const withMotif = (_l: string, f: (m: string) => void) => f('Contrôle en seconde lecture effectué.');
    renderApp(<FourEyesActions what="le rétablissement" request={req} user={USERS[1]} excluded={['u-tresor']} base="/v1/payment-points/PA-1/reinstatement-request" requestLabel="Demander le rétablissement" withMotif={withMotif} act={act} />);
    expect(screen.getByTestId('four-eyes-request').textContent).toContain('Demande de u-analyste');
    fireEvent.click(screen.getByRole('button', { name: 'Refuser' }));
    expect(act).toHaveBeenCalledWith('/v1/payment-points/PA-1/reinstatement-request/decision', { approve: false, motif: 'Contrôle en seconde lecture effectué.' }, expect.any(String));
    fireEvent.click(screen.getByRole('button', { name: 'Approuver' }));
    expect(act).toHaveBeenLastCalledWith('/v1/payment-points/PA-1/reinstatement-request/decision', { approve: true, motif: 'Contrôle en seconde lecture effectué.' });
  });

  it('écran : le demandeur ne voit aucun bouton de décision ; sans demande, un R18 peut demander', () => {
    const act = vi.fn(async () => undefined);
    const withMotif = (_l: string, f: (m: string) => void) => f('Pièces justificatives reçues.');
    const { unmount } = renderApp(<FourEyesActions what="l’écartement" request={req} user={USERS[2]} base="/v1/payment-point-proposals/P1/dismissal-request" requestLabel="Demander l’écartement" withMotif={withMotif} act={act} />);
    expect(screen.queryByRole('button', { name: 'Approuver' })).toBeNull();
    unmount();
    renderApp(<FourEyesActions what="l’écartement" request={undefined} user={USERS[2]} base="/v1/payment-point-proposals/P1/dismissal-request" requestLabel="Demander l’écartement" withMotif={withMotif} act={act} />);
    fireEvent.click(screen.getByRole('button', { name: 'Demander l’écartement' }));
    expect(act).toHaveBeenCalledWith('/v1/payment-point-proposals/P1/dismissal-request', { motif: 'Pièces justificatives reçues.' }, expect.stringContaining('seconde personne'));
  });
});

const cdf = (amount: string) => ({ amount, currency: 'CDF' as const });
const request = (over: Partial<ValidationRequest> = {}): ValidationRequest => ({
  id: 'COMV-000001', agentId: 'pk-controleur', agentName: 'Contrôleuse (démo)', status: 'DEMANDEE', requestedAt: '2026-09-29T09:00:00.000Z',
  total: [cdf('2000.00')], excluded: ['pk-controleur', 'pk-superviseur', 'pk-autorite'], blockReason: null,
  lines: [{ key: 'PENALITE:ORD-1', module: 'STATIONNEMENT', source: 'PENALITE', reference: 'PV-2026-0001', commission: cdf('2000.00'), verifierIds: ['pk-superviseur', 'pk-autorite'] }],
  ...over,
});

describe('Commissions : file de validation (superviseur distinct) et demande par l’agent', () => {
  it('un superviseur non intervenu valide avec motif ; le vérificateur voit la raison du blocage', async () => {
    const calls = mockApi('pk-regie', { '/decision': { status: 'VALIDEE' } });
    const onDone = vi.fn();
    const queue: ValidationQueue = { pending: 2, rule: 'Payable seulement après validation par un superviseur distinct.', items: [request(), request({ id: 'COMV-000002', blockReason: 'Vous avez vérifié ou décidé un constat à l’origine de cette commission.' })] };
    expect(canDecideCommission(queue.items[0]!)).toBe(true);
    expect(canDecideCommission(queue.items[1]!)).toBe(false);
    renderApp(<ValidationQueueView queue={queue} onDone={onDone} />);
    expect(screen.getByTestId('commission-block').textContent).toMatch(/vérifié ou décidé/);
    expect(screen.getAllByRole('button', { name: 'Valider (payable)' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Valider (payable)' }));
    expect(await screen.findByRole('alert')).toBeTruthy(); // motif manquant
    fireEvent.change(screen.getByLabelText(/Motif de la décision/), { target: { value: 'Pièces et rapprochement contrôlés.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Valider (payable)' }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    const call = calls.find((c) => c.url.includes('/v1/agents/commission-validations/COMV-000001/decision'))!;
    expect(call.body).toEqual({ approve: true, motif: 'Pièces et rapprochement contrôlés.' });
  });

  it('« Mes gains » : montant payable, état de validation par ligne, demande de validation', async () => {
    const calls = mockApi('pk-controleur', { '/v1/agents/me/commission-validations': { id: 'COMV-000003', lines: [{}] } });
    const d: MyEarnings = {
      agentId: 'pk-controleur', ratePct: 10, rules: [], counts: { penalites: 2, paiements: 0 },
      totals: { acquise: [cdf('4000.00')], confirmee: [], enAttente: [], annulee: [], base: [cdf('40000.00')], ceMois: [], payable: [cdf('2000.00')] },
      validation: { aDemander: 1, demandees: 0, validees: 1 },
      lines: [
        { source: 'PENALITE', reference: 'PV-1', plate: 'KN-1', zone: 'Gombe', at: '2026-09-28T09:00:00.000Z', base: cdf('20000.00'), commission: cdf('2000.00'), state: 'ACQUISE', stateLabel: 'Acquise', validation: 'VALIDEE', validationKey: 'PENALITE:O1' },
        { source: 'PENALITE', reference: 'PV-2', plate: 'KN-2', zone: 'Gombe', at: '2026-09-28T10:00:00.000Z', base: cdf('20000.00'), commission: cdf('2000.00'), state: 'ACQUISE', stateLabel: 'Acquise', validation: 'A_DEMANDER', validationKey: 'PENALITE:O2' },
      ],
    };
    const onChanged = vi.fn();
    renderApp(<EarningsBody d={d} fmtDate={(iso) => iso ?? ''} onChanged={onChanged} />);
    expect(screen.getAllByText('Validée — payable').length).toBeGreaterThan(0);
    expect(screen.getAllByText('À faire valider').length).toBeGreaterThan(0);
    expect(screen.getByText('Payable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Demander la validation (1)' }));
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.some((c) => c.url.includes('/v1/agents/me/commission-validations'))).toBe(true);
    expect(await screen.findByText(/COMV-000003 enregistrée/)).toBeTruthy();
  });
});
