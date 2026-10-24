/**
 * Écrans du lot « fiscalité, parcours d'identité, campagnes » : anomalies locatives, conditions des services, campagnes,
 * profils d'enrôlement, contestation sans écrit au guichet, reprise e-DGRK.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ENROLMENT_PROFILES } from '@mosolo/shared';
import { AppProvider } from '../src/context';
import Anomalies from '../src/modules/fiscal/Anomalies';
import Dependances from '../src/modules/fiscal/Dependances';
import Reprise from '../src/modules/fiscal/Reprise';
import Campagnes from '../src/modules/recouvrement/Campagnes';
import Profils from '../src/modules/socle/Profils';
import ContestationAssistee from '../src/modules/canaux/ContestationAssistee';

type Call = { url: string; method: string; body: unknown };
type Handler = (url: string, method: string, body: unknown) => { status?: number; body: unknown } | undefined;

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
const protocol = (active: boolean) => ({ active, reference: active ? 'P-1' : null, origin: 'LOCAL', notice: active ? 'actif' : 'Protocole requis (J13)' });

describe('Anomalies locatives (§ 16.4)', () => {
  it('signaux avec protocole requis ou actif ; liste de travail ; vérification avant confirmation', async () => {
    const calls = mockBackend({ id: 'u-controleur', roles: ['R11'] }, (url, method) => {
      if (url.includes('/anomalies/catalogue')) return { body: { signals: [
        { code: 'COMPTEURS_MULTIPLES', label: 'Plusieurs compteurs', rule: 'Aucune déclaration locative', output: 'Visite', sourceLabel: 'Compteurs', protocol: protocol(true), open: 1 },
        { code: 'INDEMNITES_SANS_RETENUE', label: 'Indemnités de logement', rule: 'Aucune retenue', output: 'Notification', sourceLabel: 'Paie', protocol: protocol(false), open: 0 },
      ], sources: [] } };
      if (url.endsWith('/v1/fiscal/anomalies') && method === 'GET') return { body: [{ id: 'ANO-000001', signal: 'COMPTEURS_MULTIPLES', signalLabel: 'Plusieurs compteurs', rule: 'r', output: 'Visite', summary: '4 compteurs sans déclaration locative', status: 'A_EXAMINER', priority: 1, detectedAt: '2026-09-26T09:00:00Z', followUp: null, reviews: [], commune: 'Limete' }] };
      if (url.includes('/review')) return { body: {} };
      return undefined;
    });
    renderPage(<Anomalies />);
    expect(await screen.findByText('4 compteurs sans déclaration locative')).toBeTruthy();
    expect(screen.getByText('Protocole requis')).toBeTruthy();
    expect(screen.getByText('Protocole actif')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirmer' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Lancer la vérification' }));
    fireEvent.change(screen.getByLabelText(/Motif/), { target: { value: 'Visite programmée' } });
    fireEvent.click(screen.getByRole('button', { name: 'Programmer la vérification' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && (c.body as { decision?: string })?.decision === 'EN_VERIFICATION')).toBe(true));
  });
});

describe('Conditions des services (§ 10A.3)', () => {
  it('visible de tous : mode informatif affiché avec l’acte requis', async () => {
    mockBackend({ id: 'u-contribuable', roles: ['R30'] }, (url) => {
      if (url.includes('/public/fiscal/dependances')) return { body: { notice: 'Conditions visibles de tous', services: [{ service: 'PERMIS_DE_BATIR', label: 'Permis de bâtir', history: [{ code: 'DEP-PERMIS-QUITUS', version: 1, mode: 'INFORMATIF', status: 'EN_VIGUEUR', effectiveFrom: '2026-09-26' }], conditions: [{ code: 'DEP-PERMIS-QUITUS', version: 1, condition: 'QUITUS_VALIDE', label: 'Quitus fiscal valide', citizenText: 'Quitus demandé, informatif tant que l’acte J6 n’est pas publié.', mode: 'INFORMATIF', legal: { jPoint: 'J6' }, effectiveFrom: '2026-09-26' }] }] } };
      return undefined;
    });
    renderPage(<Dependances />);
    expect(await screen.findByText(/Quitus fiscal valide — Informatif/)).toBeTruthy();
    expect(screen.getByText(/acte J6 non publié/)).toBeTruthy();
  });
});

describe('Campagnes (§ 8, § 45)', () => {
  it('simulation lisible (données réelles, aucun taux supposé) ; le proposant ne voit pas l’approbation', async () => {
    const camp = {
      id: 'CAMP-000001', code: 'CAMP-IF-IRL-2026-FEV2027', label: 'Campagne de février 2027', entity: 'DGIPK', kinds: ['IF', 'IRL'], period: '2026', communes: ['Limete'],
      dueDate: '2027-02-01', dueDateStatus: 'A_VERIFIER', dueDateSource: 'Fiche de règle', reminders: [{ offsetDays: 15, label: 'Rappel J-15' }], remindersStatus: 'PAR DÉFAUT', stopCriteria: ['Coût'],
      status: 'LANCEMENT_PROPOSE', createdBy: 'u-dg-dgipk', remindersSent: [], launch: { proposedBy: 'u-dg-dgipk' }, prefill: { items: [{}], errors: [] },
      simulation: { at: '', targets: 3, taxpayers: 2, expectedNotices: 3, totalMessages: 8, unreachable: 0, excluded: { withoutHolder: 5, alreadyFiled: 0, notApplicable: 1 }, channels: { sms: 2, 'in-app': 2 }, reminders: [{ offsetDays: 15, date: '2027-01-17', expectedMessages: 4 }], warnings: ['Échéance À VÉRIFIER'], rules: [], observedFilingRate: null },
    };
    mockBackend({ id: 'u-dg-dgipk', roles: ['R06'] }, (url) => {
      if (url.includes('/v1/campagnes/calendrier')) return { body: [{ entity: 'DGIPK', campaigns: [{ code: camp.code, label: camp.label, status: camp.status, dueDate: camp.dueDate, dueDateStatus: 'A_VERIFIER', reminders: [{ label: 'Rappel J-15', date: '2027-01-17' }] }] }] };
      if (url.endsWith('/v1/campagnes')) return { body: [camp] };
      if (url.endsWith('/v1/prorogations')) return { body: [] };
      return undefined;
    });
    renderPage(<Campagnes />);
    expect(await screen.findByText(/données insuffisantes — aucun taux supposé/)).toBeTruthy();
    expect(screen.getByText('Échéance À VÉRIFIER')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approuver le lancement' })).toBeNull();
  });
});

describe('Profils d’enrôlement (§ 9.3)', () => {
  it('19 profils et plus ; un parcours court par profil ; déclaration = instruction', async () => {
    const calls = mockBackend({ id: 'u-contribuable', roles: ['R30'] }, (url, method) => {
      if (url.includes('/public/enrolement/profils')) return { body: { profiles: ENROLMENT_PROFILES, notice: 'Déclarer un rôle n’établit ni la propriété ni une dette' } };
      if (url.includes('/v1/enrolement/espaces')) return { body: { personal: { taxpayerId: 'TP-DEMO-0001', iuc: 'KIN-X', name: 'Mbuyi', kind: 'PERSONNE_PHYSIQUE', type: 'PERSONNEL' }, spaces: [{ taxpayerId: 'TP-ORG-1', iuc: 'KIN-Y', name: 'Société fictive', kind: 'PERSONNE_MORALE', type: 'ORGANISATION' }], notice: 'aucun droit ajouté' } };
      if (url.includes('/v1/enrolement/roles') && method === 'GET') return { body: { items: [], nif: [] } };
      if (url.includes('/v1/enrolement/roles') && method === 'POST') return { status: 201, body: { id: 'ROLE-000001', notice: 'ouvre une instruction', nifRequestId: 'DNIF-000001' } };
      return undefined;
    });
    renderPage(<Profils />);
    expect(ENROLMENT_PROFILES.length).toBeGreaterThanOrEqual(19);
    expect(await screen.findByText('Exploitant de carrière')).toBeTruthy();
    expect(screen.getByLabelText('Espace actif')).toBeTruthy();
    const buttons = await screen.findAllByRole('button', { name: 'C’est moi' });
    fireEvent.click(buttons[ENROLMENT_PROFILES.findIndex((p) => p.code === 'BAILLEUR')]!);
    fireEvent.change(screen.getByLabelText('Commune'), { target: { value: 'Limete' } });
    fireEvent.change(screen.getByLabelText('Nombre d’unités louées'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /Déclarer ce rôle/ }));
    expect(await screen.findByText(/identifiant provisoire/)).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/v1/enrolement/roles'));
    expect(post?.body).toEqual({ taxpayerId: 'TP-DEMO-0001', profile: 'BAILLEUR', answers: { commune: 'Limete', unites: '2' } });
  });
});

describe('Contestation sans écrit au guichet (§ 13A.6)', () => {
  it('le résumé doit être lu avant l’enregistrement ; consentement devant témoin transmis', async () => {
    const calls = mockBackend({ id: 'u-guichet', roles: ['R12'] }, (url, method) => {
      if (url.includes('/v1/taxpayers/')) return { body: { obligations: [{ id: 'OBL-1', label: 'Impôt foncier', amount: { amount: '150.00', currency: 'USD' }, status: 'EMISE', dueDate: '2026-10-26' }] } };
      if (url.includes('/contestations-assistees') && method === 'POST') return { status: 201, body: { id: 'REC-000001', acknowledgement: { number: 'AR-REC-000001' } } };
      return undefined;
    });
    renderPage(<ContestationAssistee />);
    fireEvent.change(screen.getByLabelText('Identifiant du contribuable'), { target: { value: 'TP-DEMO-0001' } });
    fireEvent.click(screen.getByRole('button', { name: /Rechercher/ }));
    fireEvent.change(await screen.findByLabelText('Obligation contestée'), { target: { value: 'OBL-1' } });
    fireEvent.change(screen.getByLabelText(/Ce que dit la personne/), { target: { value: 'Le bien a été vendu en 2025' } });
    fireEvent.change(screen.getByLabelText('Consentement'), { target: { value: 'TEMOIN' } });
    fireEvent.change(screen.getByLabelText('Nom du témoin'), { target: { value: 'Témoin fictif' } });
    const submit = screen.getByRole('button', { name: 'Enregistrer la contestation' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/J’ai lu le résumé/));
    fireEvent.click(submit);
    expect(await screen.findByText(/AR-REC-000001/)).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({ obligationId: 'OBL-1', consent: { method: 'TEMOIN', summaryReadBack: true, witnessName: 'Témoin fictif' } });
  });
});

describe('Reprise e-DGRK (§ 7.5)', () => {
  it('rapport ligne par ligne ; l’auteur du dépôt ne voit pas « Intégrer le lot »', async () => {
    mockBackend({ id: 'u-guichet', roles: ['R12'] }, (url) => {
      if (url.endsWith('/v1/fiscal/imports')) return { body: [{ id: 'IMP-000001', sourceLabel: 'e-DGRK', format: 'CSV', uploadedBy: 'u-guichet', uploadedAt: '2026-09-26T09:00:00Z', status: 'VALIDE_A_BLANC', notice: 'provenance e-DGRK',
        report: { total: 2, valid: 1, invalid: 1, byType: { COMPTE: 2 }, lines: [{ line: 2, type: 'COMPTE', ref: 'E-1', ok: true, errors: [] }, { line: 3, type: 'COMPTE', ref: 'E-2', ok: false, errors: ['nom manquant'] }] },
        dedup: [], history: [] }] };
      return undefined;
    });
    renderPage(<Reprise />);
    expect(await screen.findByText(/Rejetée : nom manquant/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Intégrer le lot' })).toBeNull();
  });
});
