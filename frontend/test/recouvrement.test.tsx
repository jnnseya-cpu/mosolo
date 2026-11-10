import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../src/context';
import MyArrears from '../src/modules/recouvrement/MyArrears';
import NoticeView from '../src/modules/recouvrement/NoticeView';

const USD = (amount: string) => ({ amount, currency: 'USD' });

const notice = {
  id: 'MD-2026-000001', number: 'MD-2026-000001', kind: 'MISE_EN_DEMEURE', taxpayerId: 'TP-DEMO-0002', obligationId: 'OBL-1',
  issuedAt: '2026-10-11T09:00:00.000Z', issuedBy: 'u-decideur', contentHash: 'f'.repeat(64), eventCode: 'recovery.formal_notice',
  deliveryIds: ['DLV-1'], notification: 'NOTIFIE', demo: true,
  content: {
    number: 'MD-2026-000001', kind: 'MISE_EN_DEMEURE', title: 'Mise en demeure', issuedOn: '2026-10-11',
    issuingAuthority: 'Ministère provincial des Finances', administeringEntity: 'DGIPK',
    taxpayer: { id: 'TP-DEMO-0002', name: 'Nzuzi Makiese', iuc: 'KIN-ABCDEFGH-X' },
    obligation: { id: 'OBL-1', label: 'Impôt foncier (démonstration)', ruleCode: 'DEMO-IF-BATI', ruleVersion: 1, objectId: 'OBJ-1', status: 'EN_RETARD' },
    legalBasis: [{ id: 'demo-instrument-001', title: 'Instrument FICTIF de démonstration', status: 'EN_VIGUEUR' }], articles: ['Article 1 (fictif)'],
    amount: USD('50.00'), dueDate: '2026-10-26',
    remedy: { path: 'Réclamation auprès de la DGIPK', delayDays: 30, deadline: '2026-11-10', delayStatus: 'A_VERIFIER' },
    payment: { beneficiaryAccountAlias: 'KIN-DGIPK-RECETTES-01', instructions: 'Paiement uniquement par le circuit officiel.' },
    body: ['Vous êtes mis en demeure de régler l’obligation OBL-1.'],
    decision: { by: 'u-decideur', at: '2026-10-11T09:00:00.000Z', motivation: 'Relances restées sans suite', legalBasis: { instrumentId: 'demo-instrument-001', title: 'Instrument FICTIF', article: 'Art. 4' } },
    mentions: ['DÉMONSTRATION — règle fictive, avis sans valeur juridique.'], demo: true,
  },
};

const mine = {
  asOf: '2026-09-26',
  arrears: [{
    obligationId: 'OBL-1', taxpayerId: 'TP-DEMO-0002', label: 'Impôt foncier (démonstration)', revenueCategory: 'IMPOT_PROVINCIAL', ruleCode: 'DEMO-IF-BATI',
    entity: 'DGIPK', commune: 'Lemba', amount: USD('50.00'), dueDate: '2026-07-15', ageDays: 73, ageBand: '31-90', status: 'EN_RETARD',
    prescription: { limitationYears: 5, startsOn: '2026-07-15', prescribedOn: '2031-07-15', daysRemaining: 1753, state: 'EN_COURS', note: '' },
    legalBasis: [{ id: 'demo-instrument-001', title: 'Instrument FICTIF de démonstration', status: 'EN_VIGUEUR' }],
    caseId: 'DREC-000001', plan: null, demo: true,
    steps: [{ kind: 'AVIS_J_PLUS_1', label: 'Avis d’échéance dépassée J+1', doneOn: '2026-07-16', noticeId: null }],
    pendingMeasure: [],
  }],
  upcoming: [], notices: [{ id: notice.id, number: notice.number, kind: notice.kind, title: 'Mise en demeure', issuedAt: notice.issuedAt, readAt: null, obligationId: 'OBL-1', demo: true }],
  plans: [], planBasis: { available: true, title: 'Instrument FICTIF autorisant les échéanciers', demo: true, detail: '' }, procedure: { maxInstallments: 12 },
};

function mockBackend() {
  const calls: { url: string; method: string }[] = [];
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (url.includes('/v1/demo/users')) return json([{ id: 'u-locataire', name: 'Nzuzi Makiese (locataire fictive)', roles: ['R30'], taxpayerId: 'TP-DEMO-0002' }]);
    if (url.includes('/v1/recouvrement/mes-arrieres')) return json(mine);
    if (url.endsWith('/v1/appeals')) return json([]);
    if (url.includes('/lecture')) return json({ ...notice, readAt: '2026-10-12T08:00:00.000Z' });
    if (url.includes('/preuve')) return json({ notice, deliveries: [{ id: 'DLV-1', at: notice.issuedAt, channel: 'in-app', status: 'delivre', provider: 'in-app', providerMode: 'internal', recipientMasked: 'N*** M***', contentHash: 'x' }], readAcknowledgement: null });
    if (url.includes('/v1/recouvrement/avis/')) return json(notice);
    return Promise.reject(new TypeError('Failed to fetch'));
  }) as unknown as typeof fetch;
  return calls;
}

function renderAt(path: string) {
  return render(
    <AppProvider initialLang="fr">
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/mes-arrieres" element={<MyArrears />} />
          <Route path="/recouvrement/avis/:id" element={<NoticeView />} />
        </Routes>
      </MemoryRouter>
    </AppProvider>,
  );
}

describe('Recouvrement — écrans', () => {
  it('mes arriérés : montant, base légale, étapes notifiées, échéancier possible, aucun profil de risque', async () => {
    mockBackend();
    renderAt('/mes-arrieres');
    expect(await screen.findByText('73 jours de retard')).toBeTruthy();
    expect(screen.getAllByText(/Instrument FICTIF de démonstration/).length).toBeGreaterThan(0);
    expect(screen.getByText('Avis d’échéance dépassée J+1')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Demander un échéancier/ })).toBeTruthy();
    expect(screen.queryByText(/Profil de risque/)).toBeNull();
    expect(screen.getByText('Mise en demeure')).toBeTruthy();
  });

  it('avis imprimable : mentions obligatoires, empreinte, preuve de notification et accusé de lecture automatique', async () => {
    const calls = mockBackend();
    renderAt('/recouvrement/avis/MD-2026-000001');
    expect(await screen.findByRole('heading', { name: 'Mise en demeure' })).toBeTruthy();
    expect(screen.getByText(/DÉMONSTRATION — règle fictive, document sans valeur juridique/)).toBeTruthy();
    expect(screen.getByText('Voie et délai de recours')).toBeTruthy();
    expect(screen.getByText('Réclamation auprès de la DGIPK')).toBeTruthy();
    expect(screen.getByText('f'.repeat(64))).toBeTruthy();
    expect(screen.getByRole('button', { name: /Imprimer/ })).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url.includes('/lecture') && c.method === 'POST')).toBe(true));
    expect(await screen.findByText('Preuve de notification')).toBeTruthy();
  });
});
