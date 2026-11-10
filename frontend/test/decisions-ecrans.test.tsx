import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import Remises from '../src/modules/recouvrement/Remises';
import NonValeurs from '../src/modules/recouvrement/NonValeurs';
import Corrections from '../src/modules/fiscal/Corrections';
import Derogations from '../src/modules/socle/Derogations';
import Reductions from '../src/modules/pilotage/Reductions';
import MyArrears from '../src/modules/recouvrement/MyArrears';

const USD = (amount: string) => ({ amount, currency: 'USD' });
type Call = { url: string; method: string; body: unknown };
type Handler = (url: string, method: string, body: unknown) => { status?: number; body: unknown } | undefined;

/** Backend simulé : utilisateur de démo unique, puis réponses par route ; toute autre route est « hors ligne ». */
function mockBackend(user: { id: string; roles: string[] }, handler: Handler) {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    calls.push({ url, method, body });
    const reply = (status: number, b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } }));
    if (url.includes('/v1/demo/users')) return reply(200, [{ id: user.id, name: `Utilisateur ${user.id} (démo)`, roles: user.roles }]);
    const r = handler(url, method, body);
    if (r) return reply(r.status ?? 200, r.body);
    return Promise.reject(new TypeError('Failed to fetch'));
  }) as unknown as typeof fetch;
  return calls;
}

const renderPage = (ui: ReactElement) => render(<AppProvider initialLang="fr"><MemoryRouter>{ui}</MemoryRouter></AppProvider>);

const computation = {
  rate: '25', declaredBy: ['DEMO-IF-BATI v1'], originalAmount: USD('200.00'), maxReduction: USD('50.00'), alreadyRemitted: USD('0.00'),
  available: USD('50.00'), currentAmount: USD('200.00'), computedAmount: USD('150.00'), chain: ['OBL-1'],
};

describe('Écrans de décision — quatre yeux', () => {
  it('remises : calcul serveur affiché (taux, plafond), décision sans montant saisi, erreur backend en clair', async () => {
    const calls = mockBackend({ id: 'u-decideur', roles: ['R21'] }, (url, method) => {
      if (url.endsWith('/v1/recouvrement/remises') && method === 'GET') return { body: [{
        id: 'REM-000001', obligationId: 'OBL-1', taxpayerId: 'TP-DEMO-0002', basisRuleId: 'rule-demo', requestedAmount: USD('100.00'), motivation: 'Difficultés passagères attestées',
        requestedBy: 'u-agent', requestedAt: '2026-09-20T09:00:00.000Z', status: 'INSTRUITE', computation,
        instruction: { by: 'u-agent', at: '2026-09-20T09:00:00.000Z', favorable: true, analysis: 'Dossier complet et motivé' },
      }] };
      if (url.includes('/decision')) return { status: 422, body: { title: 'Plafond atteint', detail: 'Plafond de remise déclaré par la règle (25 %) déjà atteint.', code: 'REMISSION_CAP_EXHAUSTED' } };
      if (url.includes('/arrieres')) return { body: { items: [] } };
      if (url.includes('/legal-rules')) return { body: [] };
      return undefined;
    });
    renderPage(<Remises />);
    expect(await screen.findByText('REM-000001')).toBeTruthy();
    expect(screen.getByText('25 %')).toBeTruthy();
    expect(screen.getByText(/Aucun plafond en montant déclaré/)).toBeTruthy();
    expect(screen.getByText('Montant après remise calculé')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Demander/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Motivation de la décision'), { target: { value: 'Motif circonstancié de la décision' } });
    fireEvent.click(screen.getByRole('button', { name: /Accorder/ }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('déjà atteint'));
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/remises/REM-000001/decision'));
    expect(post?.body).toEqual({ granted: true, motivation: 'Motif circonstancié de la décision' });
  });

  it('non-valeurs : le proposant ne peut pas décider ; l’autorité distincte admet (statut ADMISE_EN_NON_VALEUR)', async () => {
    const wo = { id: 'ANV-000001', obligationId: 'OBL-9', taxpayerId: 'TP-DEMO-0003', amount: USD('80.00'), motivation: 'Contribuable insolvable, disparition constatée',
      evidence: ['PV de carence n° 12'], proposedBy: 'u-agent', proposedAt: '2026-09-21T09:00:00.000Z', status: 'PROPOSEE' };
    const calls = mockBackend({ id: 'u-decideur', roles: ['R21'] }, (url, method) => {
      if (url.endsWith('/v1/recouvrement/non-valeurs') && method === 'GET') return { body: [wo] };
      if (url.includes('/decision')) return { body: { ...wo, status: 'ADMISE' } };
      if (url.includes('/arrieres')) return { body: { items: [] } };
      return undefined;
    });
    renderPage(<NonValeurs />);
    expect(await screen.findByText('ANV-000001')).toBeTruthy();
    expect(screen.getByText('PV de carence n° 12')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Motivation de la décision'), { target: { value: 'Irrécouvrabilité établie par les pièces' } });
    fireEvent.click(screen.getByRole('button', { name: /Admettre en non-valeur/ }));
    expect(await screen.findByText(/ADMISE_EN_NON_VALEUR \(jamais soldée\)/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && (c.body as { decision?: string })?.decision === 'ADMISE')).toBe(true);
  });

  it('corrections d’objets : ancienne → nouvelle valeur, pas d’approbation par l’auteur de la proposition', async () => {
    const obj = { id: 'OBJ-DEMO-1', category: 'PARCELLE', categoryLabel: 'Parcelle', commune: 'Lemba', quartier: 'Salongo', avenue: null, localityRank: 3, status: 'VALIDE',
      probativeStatus: 'VERIFIE', igf: null, holder: 'TP-1', highValue: false, attributes: { surface_m2: '300' }, situation: { color: 'green', label: 'À jour', reason: '' },
      coverage: { color: 'green', label: '', reason: '' }, occupancy: { code: 'X', label: '' }, tree: { geo: [], objects: [], children: [] }, plate: null, relations: [], leases: [], example: true };
    mockBackend({ id: 'u-controleur', roles: ['R07'] }, (url) => {
      if (url.endsWith('/v1/fiscal/objects')) return { body: [obj] };
      if (url.includes('/v1/fiscal/object-corrections?status=EN_ATTENTE')) return { body: [] };
      if (url.includes('/corrections')) return { body: { corrections: [{
        id: 'CORR-OBJ-000001', objectId: obj.id, proposed: { attributes: { surface_m2: '250' } }, before: { localityRank: 3, attributes: { surface_m2: '300' } },
        reason: 'Mesure contradictoire sur place', proposedBy: 'u-controleur', proposedAt: '2026-09-22T09:00:00.000Z', status: 'PROPOSEE',
      }], history: [] } };
      return undefined;
    });
    renderPage(<Corrections />);
    fireEvent.click(await screen.findByRole('button', { name: /^Corrections/ }));
    expect(await screen.findByText('CORR-OBJ-000001')).toBeTruthy();
    expect(screen.getByText('250')).toBeTruthy();
    expect(screen.getByText(/Quatre yeux : l’approbation revient à une autre personne/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approuver' })).toBeNull();
    expect(screen.getByText(/Une correction est déjà proposée/)).toBeTruthy();
  });

  it('dérogations à la base : champs abaissés et refus motivé par la hiérarchie', async () => {
    const bo = { id: 'DERO-000001', ruleId: 'rule-demo', taxpayerId: 'TP-1', objectId: 'OBJ-1', inputs: { surface_m2: '100' },
      lowered: [{ field: 'surface_m2', reference: '300', referenceSource: 'CONSTAT', declared: '100' }], motive: 'Partie du bâtiment démolie',
      requestedBy: 'u-liquidateur', requestedAt: '2026-09-23T09:00:00.000Z', status: 'DEMANDEE' };
    const calls = mockBackend({ id: 'u-chef', roles: ['R07'] }, (url, method) => {
      if (url.endsWith('/v1/assessments/base-overrides') && method === 'GET') return { body: [bo] };
      if (url.includes('/decision')) return { body: { ...bo, status: 'REFUSEE' } };
      return undefined;
    });
    renderPage(<Derogations />);
    expect(await screen.findByText('DERO-000001')).toBeTruthy();
    expect(screen.getAllByText('surface_m2').length).toBeGreaterThan(0);
    expect(screen.getByText(/constat de terrain/)).toBeTruthy();
    const refuse = screen.getByRole('button', { name: /Refuser/ });
    expect(refuse).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Motif de la décision'), { target: { value: 'Aucune pièce de démolition fournie' } });
    fireEvent.click(refuse);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && (c.body as { approve?: boolean })?.approve === false)).toBe(true));
  });

  it('réductions : totaux par devise, filtre par type, détection des anomalies (sans effet automatique)', async () => {
    const block = {
      currency: 'USD', chains: 2, grossAssessed: USD('500.00'), netExpected: USD('380.00'), collected: USD('100.00'), outstanding: USD('280.00'),
      reductions: { total: USD('120.00'), count: 2, byType: [{ type: 'REMISE', label: 'Remise gracieuse', count: 1, amount: USD('50.00') }, { type: 'EXONERATION', label: 'Exonération appliquée à la liquidation', count: 1, amount: USD('70.00') }] },
      reconciliation: { grossMinusReductions: USD('380.00'), netExpected: USD('380.00'), gap: USD('0.00'), reconciled: true, tolerance: '0.01' },
    };
    const report = {
      generatedAt: '2026-09-27T08:00:00.000Z', scope: { kind: 'PROVINCE', label: 'Province de Kinshasa' }, method: 'Méthode.', formula: 'brut − réductions = net',
      totals: [block], reconciled: true, byCommune: [{ commune: 'Lemba', totals: [block] }], byModule: [],
      byDecider: [{ deciderId: 'u-decideur', traced: true, count: 2, communes: ['Lemba'], totals: [{ currency: 'USD', count: 2, amount: USD('120.00'), byType: [{ type: 'REMISE', count: 1, amount: USD('50.00') }, { type: 'EXONERATION', count: 1, amount: USD('70.00') }] }] }],
      untracedDeciders: 0, unmatchedDeclaredReductions: [], currencyAnomalies: [],
      potentialUnassessed: { note: 'Aucun montant estimé.', units: 0, byVertical: [], rows: [] },
      signals: { raised: 0, open: 1, params: { demo: true, deciderShare: '0.5', minReductionsInGroup: 3, taxpayerThreshold: { USD: '1000' } } },
    };
    const rcalls = mockBackend({ id: 'u-audit', roles: ['R24'] }, (url, method) => {
      if (url.includes('/v1/pilotage/reductions/detection') && method === 'POST') return { body: { raised: 1, automaticEffect: 'AUCUN', params: report.signals.params, signals: [
        { kind: 'DECIDEUR_CONCENTRE', fingerprint: 'RED-DEC:Lemba:2026-09:u-decideur', detail: 'u-decideur a décidé 3 des 4 réductions de recettes de Lemba en 2026-09 : examen humain proposé, aucune mesure automatique.', context: {} },
      ] } };
      if (url.includes('/v1/pilotage/reductions')) return { body: report };
      return undefined;
    });
    renderPage(<Reductions />);
    expect(await screen.findByText('Remise gracieuse')).toBeTruthy();
    expect(screen.getByText('Rapproché')).toBeTruthy();
    expect(screen.getByText(/Seuils de démonstration \[EXEMPLE\]/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Type de réduction'), { target: { value: 'REMISE' } });
    await waitFor(() => expect(rcalls.some((c) => c.url.includes('/v1/pilotage/reductions?type=REMISE'))).toBe(true));
    fireEvent.change(screen.getByLabelText('Décideur'), { target: { value: 'u-decideur' } });
    await waitFor(() => expect(rcalls.some((c) => c.url.includes('type=REMISE') && c.url.includes('decideur=u-decideur'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /Lancer la détection/ }));
    expect(await screen.findByText(/examen humain proposé, aucune mesure automatique/)).toBeTruthy();
    expect(screen.getByText(/effet automatique : aucun/)).toBeTruthy();
  });
  it('corrections d’objets : file des approbations tous objets, pièces justificatives visibles de l’approbateur', async () => {
    const sha = 'b'.repeat(64);
    const calls = mockBackend({ id: 'u-chef', roles: ['R07'] }, (url, method) => {
      if (url.endsWith('/v1/fiscal/objects')) return { body: [] };
      if (url.includes('/v1/fiscal/object-corrections?status=EN_ATTENTE')) return { body: [{
        id: 'CORR-OBJ-000007', objectId: 'OBJ-7', proposed: { localityRank: 2 }, before: { localityRank: 3, attributes: {} }, reason: 'Reclassement du quartier constaté',
        evidence: [{ label: 'PV de constat n° 42', sha256: sha }], proposedBy: 'u-controleur', proposedAt: '2026-09-22T09:00:00.000Z', status: 'PROPOSEE',
        object: { id: 'OBJ-7', category: 'PARCELLE', commune: 'Gombe', quartier: 'Golf', localityRank: 3, createdBy: 'u-agent' },
      }] };
      if (url.includes('/object-corrections/CORR-OBJ-000007/decision') && method === 'POST') return { body: { status: 'APPLIQUEE' } };
      return undefined;
    });
    renderPage(<Corrections />);
    expect(await screen.findByText('CORR-OBJ-000007')).toBeTruthy();
    expect(screen.getByText(/OBJ-7 · Gombe · Golf/)).toBeTruthy();
    expect(screen.getByText(/PV de constat n° 42/)).toBeTruthy();
    expect(screen.getByText(/SHA-256 bbbbbbbbbbbb/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approuver' }));
    fireEvent.change(screen.getByLabelText(/Motif \(obligatoire/), { target: { value: 'Pièces concordantes, reclassement fondé' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approuver et appliquer' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && (c.body as { approve?: boolean })?.approve === true)).toBe(true));
  });

  it('espace contribuable : demande de remise sur sa propre obligation, base de la règle affichée, statut suivi', async () => {
    const arrear = {
      obligationId: 'OBL-1', taxpayerId: 'TP-DEMO-0002', label: 'Impôt foncier (démonstration)', revenueCategory: 'IMPOT_PROVINCIAL', ruleCode: 'DEMO-IF-BATI',
      entity: 'DGIPK', commune: 'Lemba', amount: USD('50.00'), dueDate: '2026-07-15', ageDays: 73, ageBand: '31-90', status: 'EN_RETARD',
      prescription: { limitationYears: 5, startsOn: '2026-07-15', prescribedOn: '2031-07-15', daysRemaining: 1753, state: 'EN_COURS', note: '' },
      legalBasis: [], caseId: null, plan: null, demo: true, steps: [], pendingMeasure: [],
      remissionBasis: { available: true, detail: 'Règle DEMO-IF-BATI v2 : remise au plus 40 %.', ruleId: 'rule-demo-v2', rate: '40', floor: USD('30.00') },
    };
    const mine = {
      asOf: '2026-09-26', arrears: [arrear], upcoming: [], notices: [], plans: [], procedure: { maxInstallments: 12 },
      planBasis: { available: false, detail: 'Acte requis.' },
      remissions: [{ id: 'REM-000009', obligationId: 'OBL-0', status: 'INSTRUITE', requestedAmount: USD('20.00'), requestedAt: '2026-09-01T09:00:00.000Z', motivation: 'x', computedAmount: USD('25.00'), rate: '40', instruction: { at: '2026-09-02T09:00:00.000Z', favorable: true } }],
    };
    const calls = mockBackend({ id: 'u-locataire', roles: ['R30'] }, (url, method) => {
      if (url.includes('/v1/recouvrement/mes-arrieres')) return { body: mine };
      if (url.endsWith('/v1/appeals')) return { body: [] };
      if (url.endsWith('/v1/recouvrement/remises') && method === 'POST') return { status: 201, body: { id: 'REM-000010', status: 'DEMANDEE' } };
      return undefined;
    });
    renderPage(<MyArrears />);
    expect(await screen.findByText(/REM-000009/)).toBeTruthy();
    expect(screen.getByText(/Instruction favorable/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Demander une remise' }));
    expect(screen.getByText(/remise au plus 40 %/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Montant après remise demandé/), { target: { value: '35.00' } });
    fireEvent.change(screen.getByLabelText('Motif de la demande'), { target: { value: 'Perte d’emploi documentée par attestation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/recouvrement/remises'))?.body).toEqual({
      obligationId: 'OBL-1', basisRuleId: 'rule-demo-v2', requestedAmount: USD('35.00'), motivation: 'Perte d’emploi documentée par attestation',
    }));
  });
});
