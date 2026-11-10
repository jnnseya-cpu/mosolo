import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppProvider } from '../src/context';
import { setDemoUser } from '../src/lib/api';
import { bankMatchGuard, CashDayDetail, FOUR_EYES_RULE, type ReviewCashDay, type StatementSummary } from '../src/modules/canaux/CashDayReview';

// Jour de caisse d'un point agréé vu par le Trésor : clôture, versement, constatation au relevé à quatre yeux.
const USERS = [
  { id: 'u-tresor', name: 'Trésor (démo)', roles: ['R17'] },
  { id: 'u-tresor-2', name: 'Trésor bis (démo)', roles: ['R17'] },
  { id: 'u-analyste', name: 'Analyste (démo)', roles: ['R18'] },
];
const usd = (amount: string) => ({ amount, currency: 'USD' as const });
const base: ReviewCashDay = {
  pointId: 'PA-DEMO-01', day: '2026-09-26', status: 'DECLAREE', expected: [usd('150.00')], expectedByAccount: [{ accountAlias: 'KIN-DGTK-RECETTES-01', amount: usd('150.00') }],
  counted: [usd('150.00')], closedAt: '2026-09-26T17:00:00.000Z', depositDeadline: '2026-09-27T23:00:00.000Z',
  deposit: { bankSlipRef: 'BORD-DEMO-1', lines: [{ accountAlias: 'KIN-DGTK-RECETTES-01', amount: usd('150.00') }], depositedAt: '2026-09-26T18:00:00.000Z', declaredBy: 'canaux-op', declaredAt: '2026-09-26T18:05:00.000Z' },
  collections: [{ id: 'C1', paymentReference: 'REF-1', amount: usd('150.00'), receiptStatus: 'PROVISOIRE', orderStatus: 'CONFIRME' }], reconciledCount: 0, exceptions: [],
};
const proposed = (by: string): ReviewCashDay => ({ ...base, deposit: { ...base.deposit!, bankMatch: { statementId: 'REL-1', valueDate: '2026-09-26', lines: base.deposit!.lines, proposedBy: by, proposedAt: '2026-09-27T08:00:00.000Z' } } });

function renderAs(userId: string, cd: ReviewCashDay, handlers = { onPropose: vi.fn(), onApprove: vi.fn() }, statements?: StatementSummary[]) {
  setDemoUser(userId);
  globalThis.fetch = vi.fn(async (url: string) => (String(url).includes('/v1/demo/users')
    ? new Response(JSON.stringify(USERS), { status: 200, headers: { 'content-type': 'application/json' } })
    : Promise.reject(new TypeError('Failed to fetch')))) as unknown as typeof fetch;
  render(<AppProvider initialLang="fr"><CashDayDetail cd={cd} {...handlers} {...(statements ? { statements } : {})} /></AppProvider>);
  return handlers;
}

describe('Jour de caisse d’un point agréé (Trésor)', () => {
  afterEach(() => { setDemoUser(null); localStorage.clear(); });

  it('garde quatre yeux : proposant, déclarant et non-R17 ne peuvent approuver', () => {
    const u = (id: string) => USERS.find((x) => x.id === id)!;
    expect(bankMatchGuard(base, u('u-analyste'))).toMatchObject({ canPropose: true, canApprove: false });
    expect(bankMatchGuard(proposed('u-tresor'), u('u-tresor')).approveBlock).toMatch(/autre personne/);
    expect(bankMatchGuard(proposed('u-analyste'), u('u-analyste')).approveBlock).toMatch(/R17/);
    expect(bankMatchGuard({ ...proposed('u-analyste'), deposit: { ...proposed('u-analyste').deposit!, declaredBy: 'u-tresor' } }, u('u-tresor')).approveBlock).toMatch(/déclaré ce versement/);
    expect(bankMatchGuard(proposed('u-tresor'), u('u-tresor-2'))).toMatchObject({ canPropose: false, canApprove: true, approveBlock: null });
  });

  it('affiche clôture, bordereau et règle ; le proposant voit l’approbation bloquée', async () => {
    const h = renderAs('u-tresor', proposed('u-tresor'));
    expect(await screen.findByText(/Vous avez proposé cette constatation/)).toBeTruthy();
    expect(screen.getByText('BORD-DEMO-1')).toBeTruthy();
    expect(screen.getByText('1. Clôture de caisse', { exact: false })).toBeTruthy();
    expect(screen.getByTestId('four-eyes-rule').textContent).toContain(FOUR_EYES_RULE);
    expect(screen.getByText('En attente d’une seconde personne')).toBeTruthy();
    const btn = screen.getByRole('button', { name: /Approuver/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(h.onApprove).not.toHaveBeenCalled();
  });

  it('une seconde personne R17 approuve', async () => {
    const h = renderAs('u-tresor-2', proposed('u-tresor'));
    const btn = await screen.findByRole('button', { name: /Approuver/ }) as HTMLButtonElement;
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    expect(h.onApprove).toHaveBeenCalledTimes(1);
  });

  it('proposition par un analyste (R18) avec l’identifiant du relevé', async () => {
    const h = renderAs('u-analyste', base);
    const input = await screen.findByLabelText(/Identifiant du relevé/);
    fireEvent.change(input, { target: { value: ' REL-9 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Proposer la constatation' }));
    expect(h.onPropose).toHaveBeenCalledWith('REL-9');
  });

  it('proposition en choisissant le relevé importé dans la liste', async () => {
    const st: StatementSummary[] = [{ statementId: 'REL-LISTE-2', importedAt: '2026-09-27T07:00:00.000Z', importedBy: 'u-tresor', accounts: ['KIN-DGTK-RECETTES-01'], lines: 2, matched: 0, unmatched: 2 }];
    const h = renderAs('u-analyste', base, undefined, st);
    const select = await screen.findByLabelText(/Relevé importé portant le bordereau/);
    expect(screen.getByRole('option', { name: /REL-LISTE-2 .* 2 non appariée/ })).toBeTruthy();
    fireEvent.change(select, { target: { value: 'REL-LISTE-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Proposer la constatation' }));
    expect(h.onPropose).toHaveBeenCalledWith('REL-LISTE-2');
  });

  it('appariement automatique à la déclaration du versement : affiché comme tel', async () => {
    const cd: ReviewCashDay = { ...base, status: 'VERSEE', deposit: { ...base.deposit!, bankMatch: { ...proposed('SYSTEME:RAPPROCHEMENT_AUTOMATIQUE').deposit!.bankMatch!, auto: true, approvedBy: 'SYSTEME:RAPPROCHEMENT_AUTOMATIQUE', approvedAt: '2026-09-27T08:00:00.000Z' } } };
    renderAs('u-tresor', cd);
    expect(await screen.findByText(/Automatique à la déclaration du versement/)).toBeTruthy();
  });

  it('appariement automatique à l’import : affiché comme tel, sans bouton d’approbation', async () => {
    const cd: ReviewCashDay = { ...base, status: 'VERSEE', reconciledCount: 1, deposit: { ...base.deposit!, bankMatch: { ...proposed('u-tresor').deposit!.bankMatch!, auto: true, approvedBy: 'SYSTEME:RAPPROCHEMENT_AUTOMATIQUE', approvedAt: '2026-09-27T08:00:00.000Z' } } };
    renderAs('u-tresor-2', cd);
    expect(await screen.findByText(/Automatique à l’import/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Approuver/ })).toBeNull();
  });
});
