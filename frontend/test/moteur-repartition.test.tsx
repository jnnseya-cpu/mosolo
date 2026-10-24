/**
 * Écran « Répartition des recettes et droits » (moteur de répartition, 29/09/2026) : centre de commandement exécutif,
 * « Expliquer ce chiffre » puis « Voir les transactions », accès par les menus des rôles concernés.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../src/context';
import MoteurRepartition from '../src/modules/pilotage/MoteurRepartition';
import { visibleNav } from '../src/components/Shell';

if (typeof globalThis.ResizeObserver === 'undefined') {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
}

const m = (amount: string) => ({ amount, currency: 'USD' });
const fig = (d: string) => ({ currency: 'USD', recettesEligibles: m('150.00'), droit: m(d), electronique: m(d), especes: m('0.00'), regle: m('0.00'), approuve: m('0.00'), enAttente: m(d), conteste: m('0.00'), recouvrable: m('0.00'), payable: m('0.00'), enRetard: m('0.00'), resteDu: m(d), contrepasse: m('0.00'), transactions: 1 });
const EXEC = {
  mode: 'SIMULATION', asOf: '2026-09-29', etat: 'SIMULATION — règle non active (acte requis)',
  version: { id: 'KIN-DEFAULT-V1', status: 'ACTE_REQUIS', statusLabel: 'Proposée par défaut — acte requis', poolModeLabel: 'Selon la recette générée' },
  parDevise: [{
    currency: 'USD', cartes: [{ code: 'TOTAL', label: 'Recette éligible rapprochée (100 %)', montant: m('150.00'), expliquer: 'beneficiaire=TOTAL&currency=USD' }],
    groupes: [{ ...fig('15.00'), code: 'GROUPE_NSEYA', label: 'Groupe Nseya', montant: m('15.00'), expliquer: 'beneficiaire=GROUPE_NSEYA&currency=USD' }],
    controle: { egal: true }, parEntite: [], parModule: [], parMethode: [], parMois: [],
    coutsTechnologiques: { modeLabel: 'Aucun traitement des coûts (défaut)', positionNette: m('105.00'), detteServicesNseya: m('0.00') },
  }],
  contradictions: [{ code: 'A', titre: 'Pool des opérations de terrain', harmonisation: 'Deux modes', statut: 'TRANCHE' }],
};
const EXPL = {
  beneficiaire: 'GROUPE_NSEYA', label: 'Groupe Nseya', mode: 'SIMULATION', asOf: '2026-09-29', etat: 'SIMULATION',
  parDevise: [{ currency: 'USD', recetteEligible: m('150.00'), taux: [{ versionId: 'KIN-DEFAULT-V1', pct: ['10'], recetteEligible: m('150.00'), droit: m('15.00') }], droitCalcule: m('15.00'), formule: 'Recette éligible × taux = droit', arrondis: m('0.00'), electronique: m('15.00'), especes: m('0.00'),
    etats: { regle: m('0.00'), approuve: m('0.00'), enAttente: m('15.00'), conteste: m('0.00'), payable: m('0.00'), enRetard: m('0.00'), recouvrable: m('0.00'), contrepasse: m('0.00') },
    transactions: 1, controle: { egalAuDroit: true, electroniquePlusEspeces: true }, par: {}, voirTransactions: '/v1/pilotage/moteur-repartition/transactions?beneficiaire=GROUPE_NSEYA&currency=USD' }],
};

function mock(roles: string[]) {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const reply = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
    if (url.includes('/v1/demo/users')) return reply([{ id: 'u-test', name: 'Test', roles }]);
    if (url.includes('/tableau/executif')) return reply(EXEC);
    if (url.includes('/expliquer')) return reply(EXPL);
    if (url.includes('/transactions')) return reply({ mode: 'SIMULATION', asOf: '2026-09-29', etat: 'SIMULATION', total: 0, donneesPersonnelles: 'PSEUDONYMISEES', items: [], totals: [] });
    return Promise.reject(new TypeError('Failed to fetch'));
  }) as unknown as typeof fetch;
}

describe('Moteur de répartition — écrans', () => {
  it('centre de commandement financier : chaque chiffre s’explique (taux, droit, contrôle) puis mène aux transactions', async () => {
    mock(['R05']);
    render(<AppProvider initialLang="fr"><MemoryRouter initialEntries={['/executive/finance']}><Routes><Route path="/executive/finance" element={<MoteurRepartition />} /></Routes></MemoryRouter></AppProvider>);
    expect(await screen.findByText(/Centre de commandement financier — USD/)).toBeTruthy();
    expect(screen.getByText(/Contradictions à arbitrer/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Expliquer ce chiffre' })[1]!);
    expect(await screen.findByText(/Somme des lignes = droit affiché/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Voir les transactions/ }));
    expect(await screen.findByText(/pseudonymisées/)).toBeTruthy();
  });

  it('les écrans sont atteignables depuis les menus de chaque profil', () => {
    const has = (roles: string[], path: string) => visibleNav(roles).some((n) => n.to === path);
    for (const r of ['R02', 'R03', 'R05']) expect(has([r], '/executive/finance'), r).toBe(true);
    expect(has(['R38'], '/groupe-nseya/command-centre')).toBe(true);
    expect(has(['R26'], '/platform-admin/finance/allocation-rules')).toBe(true);
    expect(has(['R35'], '/subcontractor/finance')).toBe(true);
    for (const r of ['R04', 'R06', 'R10']) expect(has([r], '/pilotage/moteur-repartition'), r).toBe(true);
  });
});
