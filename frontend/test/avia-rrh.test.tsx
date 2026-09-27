import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppProvider } from '../src/context';
import { AviaCadreSection, AviaIfaControlSection, AviaRrhSection } from '../src/modules/verticales/AviaRrh';

function mockApi(routes: Record<string, unknown>) {
  const calls: { url: string; body?: string }[] = [];
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    const path = Object.keys(routes).find((p) => url.split('?')[0]!.endsWith(p));
    if (!path) return Promise.resolve(new Response(JSON.stringify({ title: 'Introuvable', status: 404 }), { status: 404, headers: { 'content-type': 'application/json' } }));
    return Promise.resolve(new Response(JSON.stringify(routes[path]), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
  return calls;
}

const sourceFigures = {
  tag: '[À VÉRIFIER]', notice: 'Données du dossier source affichées telles quelles : ni calculées, ni vérifiées par MOSOLO.',
  constat: { origin: 'Dossier source — § 11C.1', rows: [{ label: 'Passagers au départ', value: '≈ 420 000 par an' }, { label: 'Fret aérien', value: '≈ 0 USD déclaré' }] },
  scenarioPrudent: { origin: 'Dossier source — § 11C.5', rows: [{ label: 'Recettes annuelles visées', value: '≈ 1,8 M USD par an' }], principles: ['Aucune nouvelle taxe'] },
};
const cadre = {
  availability: { available: false, reasons: ['Arrêté provincial non enregistré (référence de l’acte et double validation requises).'], act: null },
  acts: [], coordination: [{ partner: 'RVA', label: 'Régie des Voies Aériennes (RVA)', entry: null }],
  measuresCatalogue: [{ code: 'PENALITE_ELECTRONIQUE', label: 'Pénalité électronique', computation: 'Passagers sans IFA × pénalité fixée par l’arrêté.' }],
  measures: [], alternativeKey: { label: 'Clé alternative spécifique AVIA — 65 % Ville / 35 % Groupe Nseya (dossier source, § 11C.6)', statusLabel: 'Acte requis — simulation seulement', reference: 'Modèle retenu : clé du § 37A' },
  sourceFigures, notice: 'Le système constate et calcule ; il ne sanctionne pas seul.',
};
const line = {
  airlineTaxpayerId: 'TP-VX-AVIA-02', airlineName: 'Compagnie aérienne fictive B (démo)', ticketingConnected: true, declarationId: null, declarationStatus: null,
  sold: 14, boarded: 14, boardedWithoutIfa: 1, exited: 12, verified: 12, taxOnBoarded: '65.00', bspSettled: '65.00', remitted: '40.00', remittanceGap: '25.00',
  freight: { declaredKg: 500, manifestKg: 1250, gapKg: 750 }, flightLines: [], hasGap: true, gapLabels: ['Fret : +750 kg entre manifestes et déclarations'],
  proposal: { kind: 'CONSTAT_MOIS_NON_DECLARE', label: 'Proposition : ouvrir un constat sur un mois non déclaré, puis procédure contradictoire', status: 'PROPOSEE' },
};

describe('AVIA — pôle de rapprochement des recettes (RRH)', () => {
  it('indicateurs connus / comptés / vérifiés / compensés, proposition soumise par un humain, chiffres source [À VÉRIFIER]', async () => {
    const calls = mockApi({
      '/v1/demo/users': [],
      '/v1/verticales/avia/rrh/overview': {
        notice: 'Constats et propositions seulement. Aucune facturation ni compensation automatique.',
        kpis: [{ period: '2026-08', known: 14, counted: 14, verified: 12, compensated: 0, rates: { verified: '85.7', compensated: '0.0' } }],
        agencies: [{ id: 'AVIA-AGC-1', name: 'Agence de voyages fictive (démo)', kind: 'AGENCE_VOYAGES', status: 'CERTIFIEE', statusLabel: 'Compte certifié' }],
        connectors: [{ code: 'BSP-BAC-A-SABLE', label: 'Bac à sable BSP / GDS / TTBS [EXEMPLE]', state: 'RACCORDE', example: true }, { code: 'IATA-BSP', label: 'Plan de facturation et de règlement de l’IATA (Billing and Settlement Plan, BSP)', state: 'ACCORD_REQUIS', example: false }],
        reconciliations: [],
      },
      '/v1/verticales/avia/rrh/reconciliations': [{ id: 'AVIA-RRH-2026-08-1', period: '2026-08', trigger: 'AUTOMATIQUE_MENSUEL', at: '2026-09-26T09:00:00Z', lines: [line] }],
      '/v1/verticales/avia/cadre': cadre,
      '/submit': { declaration: { id: 'AVIA-DEC-2026-08-3', status: 'ECART_CONSTATE' } },
    });
    render(<AppProvider initialLang="fr"><AviaRrhSection /></AppProvider>);
    expect(await screen.findByText(/Départs connus \(billets avec IFA\)/)).toBeTruthy();
    expect(screen.getByText(/Départs compensés/)).toBeTruthy();
    expect(screen.getByText('Accord d’accès requis')).toBeTruthy();
    expect(await screen.findByText(/Automatique \(calendrier mensuel\)/)).toBeTruthy();
    expect(screen.getByText(/Proposition : ouvrir un constat/)).toBeTruthy();
    expect(await screen.findByText(/Chiffres du dossier source \[À VÉRIFIER\]/)).toBeTruthy();
    expect(screen.getAllByText('[À VÉRIFIER]').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Soumettre à la procédure contradictoire' }));
    expect(await screen.findByText('Écart soumis à la procédure contradictoire.')).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/lines/TP-VX-AVIA-02/submit'))).toBe(true);
  });
});

describe('AVIA — contrôle IFA et cadre des mesures', () => {
  it('contrôle sans IFA : constat, mesure indisponible sans arrêté', async () => {
    const calls = mockApi({
      '/v1/demo/users': [],
      '/v1/verticales/avia/ifa/controls': { result: 'SANS_IFA', resultLabel: 'Passager sans IFA (billet non transmis)', ifa: null, flight: null, boarded: false, exited: false, measure: { available: false, notice: 'Constat enregistré. Mesure « billet sans IFA non validable » non applicable : Arrêté provincial non enregistré.' } },
    });
    render(<AppProvider initialLang="fr"><AviaIfaControlSection /></AppProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Contrôler' }));
    expect(await screen.findByText('Passager sans IFA (billet non transmis)')).toBeTruthy();
    expect(screen.getByText(/non applicable : Arrêté provincial non enregistré/)).toBeTruthy();
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/ifa/controls'))!.body!)).not.toHaveProperty('qr');
  });

  it('cadre : mesures indisponibles (acte requis), clé alternative 65/35 en simulation à côté de la clé du § 37A', async () => {
    mockApi({ '/v1/demo/users': [], '/v1/verticales/avia/cadre': cadre });
    render(<AppProvider initialLang="fr"><AviaCadreSection /></AppProvider>);
    expect(await screen.findByText('Indisponibles — acte requis')).toBeTruthy();
    expect(screen.getByText(/65 % Ville \/ 35 % Groupe Nseya/)).toBeTruthy();
    expect(screen.getByText(/clé du § 37A/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Proposer' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
