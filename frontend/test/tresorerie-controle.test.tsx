import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppProvider } from '../src/context';
import Appariements, { type MatchingBoard } from '../src/modules/tresor/Appariements';
import PointsAgrees, { type PointsBoard } from '../src/modules/tresor/PointsAgrees';
import Rendement, { type Priorities, type YieldBoard } from '../src/modules/recouvrement/Rendement';
import Qualite, { type QualityBoard } from '../src/modules/terrain/Qualite';
import Detecteurs, { type DetectorsOverview } from '../src/modules/integrite/Detecteurs';
import CalcuOrgane, { type OrganeDashboard } from '../src/modules/verticales/CalcuOrgane';
import { visibleNav } from '../src/components/Shell';

const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } }));
function mockApi(user: { id: string; roles: string[] }, routes: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    if (String(url).includes('/v1/demo/users')) return json([{ ...user, name: `${user.id} (démo)`, entity: 'TEST' }]);
    const hit = Object.entries(routes).sort((a, b) => b[0].length - a[0].length).find(([k]) => String(url).includes(k));
    if (!hit) return Promise.reject(new TypeError('Failed to fetch'));
    return json(hit[1]);
  }) as unknown as typeof fetch;
  localStorage.removeItem('mosolo.demoUser');
  return calls;
}
const renderApp = (el: JSX.Element) => render(<AppProvider initialLang="fr">{el}</AppProvider>);

const matching: MatchingBoard = {
  policy: { threshold: 70, fxTolerancePct: 0.5, statut: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage', note: 'Appariement automatique uniquement sur correspondance exacte.' },
  items: [{
    exceptionId: 'EXC-000001', type: 'ORPHAN_CREDIT', statementId: 'REL-1', detail: 'Crédit sans référence connue',
    line: { accountAlias: 'DGIPK-RECETTES', amount: { amount: '150.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: 'PR-ABCD-EFHG' },
    candidates: [{ exceptionId: 'EXC-000001', paymentReference: 'PR-ABCD-EFGH', orderAmount: { amount: '150.00', currency: 'USD' }, lineAmount: { amount: '150.00', currency: 'USD' }, score: 85, proposable: true,
      factors: [{ code: 'REFERENCE', points: 25, max: 40, detail: 'Référence à une erreur de saisie près.' }] }],
  }],
  proposals: [{ id: 'APP-000001', exceptionId: 'EXC-000002', paymentReference: 'PR-ZZZZ-YYYY', score: 90, motif: 'Inversion constatée (test).', status: 'PROPOSEE', proposedBy: 'u-analyste-rappro', proposedAt: '2026-09-26T09:00:00.000Z' }],
};

describe('Trésorerie, recouvrement, sous-traitance, détecteurs, CALCU (écrans)', () => {
  it('rapprochement proposé : facteurs visibles, proposition motivée, confirmation par le Trésor', async () => {
    const calls = mockApi({ id: 'u-tresor', roles: ['R17'] }, { '/v1/tresor/appariements': matching });
    renderApp(<Appariements />);
    expect(await screen.findByText(/Référence à une erreur de saisie près/)).toBeTruthy();
    expect(screen.getByText(/Seuil de proposition : 70\/100/)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Confirmer' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Motif de la décision APP-000001'), { target: { value: 'Bordereau et relevé concordent.' } });
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('/v1/tresor/appariements/propositions/APP-000001/decision') && c.init?.method === 'POST')).toBe(true));
  });

  it('points agréés : acte requis sans contrat, pénalité calculée à proposer', async () => {
    const board: PointsBoard = {
      notice: 'Commission et pénalités selon le contrat signé de chaque point.',
      points: [{ pointId: 'PA-1', name: 'Agent monnaie mobile — Kingabwa', operator: 'Opérateur A', commune: 'Limete', status: 'ACTIF', contractStatus: 'ACTE_REQUIS', contract: null, pending: null }],
      late: [{ key: 'PA-1:2026-09-20', pointId: 'PA-1', pointName: 'Agent monnaie mobile — Kingabwa', day: '2026-09-20', daysLate: 3, status: 'CALCULEE', amounts: [{ amount: '3.00', currency: 'USD' }], computation: '0.1 % × 3 jour(s)', penaltyId: null, penaltyStatus: null }],
      penalties: [],
    };
    mockApi({ id: 'u-analyste-rappro', roles: ['R18'] }, { '/v1/tresor/points': board });
    renderApp(<PointsAgrees />);
    expect(await screen.findByText('Acte requis')).toBeTruthy();
    expect(screen.getByText(/Pénalité calculée : 3.00 USD/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Proposer la pénalité' })).toBeTruthy();
    expect(screen.queryByText('Enregistrer un contrat de point')).toBeNull();
  });

  it('rendement du recouvrement : net non mesuré sans coût, file priorisée, garanties', async () => {
    const board: YieldBoard = {
      summary: { status: 'NON_MESURE', detail: 'Coût des actions de recouvrement non encore saisi : récupération nette non calculable.', gross: { USD: '150.00' }, reconciled: {}, cost: {}, net: 'NON_MESURE', costedCases: 0, cases: 1, campaigns: [] },
      cases: [{ caseId: 'RC-1', obligationId: 'O-1', status: 'OUVERT', gross: { USD: '150.00' }, cost: {}, net: 'NON_MESURE' }], costs: [], largeDebtors: [], guarantees: [],
      costKinds: ['SMS', 'VISITE'], guaranteeNatures: ['CAUTION_BANCAIRE'],
    };
    const prio: Priorities = { method: 'Rendement net estimé = restant dû × taux observé − coût moyen observé.', items: [{ rank: 1, obligationId: 'O-1', label: 'Impôt foncier (test)', commune: 'Lemba', segment: { label: 'Oubli' }, outstanding: { amount: '150.00', currency: 'USD' }, observedRecoveryRate: 'NON_MESURE', observedCostPerCase: 'NON_MESURE', expectedNetYield: 'NON_MESURE' }] };
    mockApi({ id: 'u-contentieux', roles: ['R20'] }, { '/v1/recouvrement/rendement': board, '/v1/recouvrement/priorites': prio });
    renderApp(<Rendement />);
    expect(await screen.findByText(/récupération nette non calculable/)).toBeTruthy();
    expect(await screen.findByText('Impôt foncier (test)')).toBeTruthy();
    expect(screen.getAllByText('Non mesuré').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Enregistrer le coût' })).toBeTruthy();
  });

  it('qualité de la sous-traitance : présomptions, rotation, récupération décidée par la régie', async () => {
    const board: QualityBoard = {
      suspicions: [{ code: 'PHOTO_EN_DOUBLE', kind: 'DOUBLON', label: 'Même photo (empreinte) pour plusieurs constats', findingIds: ['F-1', 'F-2'], subcontractorId: 'ST-0001', agentIds: ['a'], detail: 'Empreinte présente sur 2 constats.', fingerprint: 'TQ:1' }],
      rotation: { maxDays: 90, blocking: false, statut: 'PAR_DEFAUT', items: [{ kind: 'AGENT', id: 'a', name: 'Agent Limete', commune: 'Limete', since: '2026-06-01', days: 117, overdue: true }] },
      clawbacks: [{ id: 'RECUP-000001', subcontractorId: 'ST-0001', findingIds: ['F-1'], grounds: 'OBJET_FICTIF', motif: 'Locaux inexistants (test).', amount: { amount: '2500.00', currency: 'CDF' }, status: 'PROPOSEE', proposedBy: 'u-controleur' }],
      params: { duplicateDistanceM: 15, rotationMaxDays: 90, statut: 'PAR_DEFAUT' }, note: 'Présomptions à contre-visiter : aucune sanction ni retenue automatique.',
    };
    mockApi({ id: 'u-dg-dgipk', roles: ['R06'] }, { '/v1/terrain/qualite': board });
    renderApp(<Qualite />);
    expect(await screen.findByText('Même photo (empreinte) pour plusieurs constats')).toBeTruthy();
    expect(screen.getByText('À organiser')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Décider la récupération' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Proposer une récupération' })).toBeNull();
  });

  it('détecteurs : signaux, exécution planifiée avec ruptures de chaîne, bouton pour l’audit', async () => {
    const o: DetectorsOverview = {
      detectors: [{ code: 'ECART_CONSTATS_PAIEMENTS', label: 'Écart entre constats et paiements dans une zone', vecteur: 'Encaissement en espèces non déclaré', source: 'Constats ↔ paiements' }],
      params: { ecartPartMinPct: 60 }, statut: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage',
      schedule: { intervalHours: 24, active: true, lastRunAt: null, lastTrigger: null, includesChainRuptures: true },
      signals: [{ code: 'ECART_CONSTATS_PAIEMENTS', label: 'Écart entre constats et paiements dans une zone', subject: 'Limete', detail: 'Limete : 6 constats validés sur 8 sans paiement.', fingerprint: 'DET:1' }],
      note: 'Signaux à examiner par un humain.',
    };
    mockApi({ id: 'u-auditeur', roles: ['R22'] }, { '/v1/integrite/detecteurs': o });
    renderApp(<Detecteurs />);
    expect(await screen.findByText(/6 constats validés sur 8/)).toBeTruthy();
    expect(screen.getByText('Toutes les 24 h')).toBeTruthy();
    expect(screen.getByText('Contrôlées à chaque exécution')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Exécuter maintenant/ })).toBeTruthy();
  });

  it('CALCU organe : montants contrôlés et récupérés, taux d’exécution, PDF, transmission à la justice', async () => {
    const d: OrganeDashboard = {
      controlled: { transactions: 3, amounts: [{ amount: '900.00', currency: 'CDF' }] }, recovered: { count: 1, amounts: [{ amount: '300.00', currency: 'CDF' }] },
      recommendations: { issued: 1, executed: 1, due: 1, executionRate: '100 %' }, notice: 'CALCU ne bloque aucun paiement.',
      institutionsAtRisk: [{ entityName: 'Entité pilote', rouge: 1, ambre: 0, vert: 2, amounts: [{ amount: '300.00', currency: 'CDF' }] }], exposedZones: [{ commune: 'Gombe', anomalies: 1, amounts: [] }],
      suppliers: [], budgetLines: [], missions: [], recommendationsList: [],
      referrals: [{ id: 'CALCU-JUS-000001', status: 'PROPOSEE', reportId: 'CALCU-RPT-2026-000001', authority: 'Parquet (fictif)', motif: 'Aucune pièce.', proposedBy: 'u-auditeur-2' }],
    };
    mockApi({ id: 'u-auditeur', roles: ['R22'] }, { '/v1/verticales/calcu/organe': d, '/v1/verticales/calcu/overview': { reports: [{ id: 'CALCU-RPT-2026-000001', score: 'ROUGE', status: 'OUVERT', createdAt: '2026-09-26T09:00:00.000Z' }] } });
    renderApp(<CalcuOrgane />);
    expect(await screen.findByText('100 %')).toBeTruthy();
    expect(screen.getAllByText('300.00 CDF').length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByRole('button', { name: /PDF/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Transmettre' })).toBeTruthy();
  });

  it('navigation : les nouveaux écrans apparaissent selon le rôle', () => {
    const to = (roles: string[]) => visibleNav(roles).map((n) => n.to);
    expect(to(['R17'])).toEqual(expect.arrayContaining(['/tresor/appariements', '/tresor/points-agrees', '/terrain/qualite']));
    expect(to(['R22'])).toEqual(expect.arrayContaining(['/integrite/detecteurs', '/controle/calcu/organe', '/recouvrement/rendement']));
    expect(to(['R30'])).not.toContain('/tresor/appariements');
  });
});
