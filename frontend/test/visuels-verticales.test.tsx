/**
 * Visuels des verticales, du stationnement, de la publicité et de la chaîne véhicule (27/09/2026) : graphiques rendus
 * avec des données, état vide, vue tableau, devises jamais additionnées, [EXEMPLE] pour la démonstration.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import { countItems, moneyBarsByCurrency, monthlyCounts, statusItems, toNum, MoneyBars } from '../src/verticals/visuels';
import { CtVisuels, FourriereVisuels, MesVehiculesVisuels } from '../src/modules/vehicules-controle/visuels';
import { AdvertiserVisuels, ContratsVisuels } from '../src/modules/publicite/visuels';
import { ParkingDashboardVisuels, ViolationsVisuels } from '../src/modules/parking/visuels';
import { CalcuVisuels, EspaceVerticaleVisuels, TelecomViz } from '../src/modules/verticales/visuels';
import type { VerticalSpaceData } from '../src/verticals/catalogue';

function wrap(ui: ReactElement) {
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
  return render(<AppProvider initialLang="fr"><MemoryRouter>{ui}</MemoryRouter></AppProvider>);
}
afterEach(() => { localStorage.clear(); });
if (typeof globalThis.ResizeObserver === 'undefined') {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
}

describe('adaptateurs (verticals/visuels)', () => {
  it('toNum lit les décimales françaises et refuse le vide', () => {
    expect(toNum('64,2')).toBe(64.2); expect(toNum('12.5')).toBe(12.5); expect(toNum(null)).toBeNull(); expect(toNum('')).toBeNull(); expect(toNum('abc')).toBeNull();
  });
  it('statusItems suit l’ordre du référentiel et garde les états inconnus', () => {
    const items = statusItems([{ s: 'B' }, { s: 'A' }, { s: 'B' }, { s: 'Z' }], (x) => x.s, { A: { label: 'État A', tone: 'good' }, B: { label: 'État B', tone: 'warning' } });
    expect(items.map((i) => [i.key, i.label, i.count])).toEqual([['A', 'État A', 1], ['B', 'État B', 2], ['Z', 'Z', 1]]);
    expect(countItems([['X', 'X', 'good', null]])[0]!.count).toBe(0);
  });
  it('moneyBarsByCurrency : une série par devise, jamais additionnées entre devises', () => {
    const parts = moneyBarsByCurrency([
      { label: 'Gombe', money: [{ amount: '100.00', currency: 'CDF' }, { amount: '5.00', currency: 'USD' }] },
      { label: 'Gombe', money: [{ amount: '50.00', currency: 'CDF' }] },
      { label: 'Limete', money: { amount: '7.00', currency: 'USD' } },
    ]);
    expect(parts.map((p) => p.currency)).toEqual(['CDF', 'USD']);
    expect(parts[0]!.rows).toEqual([{ key: 'Gombe', label: 'Gombe', values: { v: 150 } }]);
    expect(parts[1]!.rows.map((r) => [r.label, r.values.v])).toEqual([['Limete', 7], ['Gombe', 5]]);
  });
  it('monthlyCounts comble les mois vides jusqu’au mois courant (Kinshasa)', () => {
    const pts = monthlyCounts([{ d: '2026-07-10T10:00:00Z' }, { d: '2026-09-01T00:30:00Z' }, { d: null }], (x) => x.d, new Date('2026-09-27T12:00:00Z'));
    expect(pts[pts.length - 1]).toEqual({ date: '2026-09', values: { n: 1 } });
    expect(pts.find((p) => p.date === '2026-08')!.values.n).toBe(0);
    expect(pts.find((p) => p.date === '2026-07')!.values.n).toBe(1);
    expect(pts.map((p) => p.date)).toEqual(['2026-07', '2026-08', '2026-09']);
  });
  it('MoneyBars : un graphique par devise ; vide sans montant', () => {
    const { rerender } = wrap(<MoneyBars title="Recettes" rows={[{ label: 'A', money: [{ amount: '1', currency: 'CDF' }, { amount: '2', currency: 'USD' }] }]} />);
    expect(screen.getByText('Recettes — CDF')).toBeTruthy();
    expect(screen.getByText('Recettes — USD')).toBeTruthy();
    rerender(<AppProvider initialLang="fr"><MemoryRouter><MoneyBars title="Recettes" rows={[]} emptyText="Aucune recette." /></MemoryRouter></AppProvider>);
    expect(screen.getByText('Aucune recette.')).toBeTruthy();
  });
});

describe('chaîne véhicule', () => {
  const ct = { vehiculesConnus: 10, ctAJour: 6, ctAJourPct: 60, ctBientotEchus: 2, ctEchus: 2, defavorables: 1, procesVerbaux: 3, vignettesEnStock: 5, vignettesEmises: 4, vignettesAnnulees: 1, courtoisieEnCours: 0, prochainesEcheances30j: 2 };
  it('parc par état (états disjoints), vignettes, vue tableau', () => {
    wrap(<CtVisuels i={ct} pvs={[{ result: 'FAVORABLE', endedAt: '2026-09-20T10:00:00Z', centreId: 'C1', demo: true }]} stickers={[{ status: 'EN_STOCK' }, { status: 'ATTRIBUEE' }]} />);
    const parc = screen.getByRole('group', { name: /Parc connu par état du contrôle technique/ });
    expect(parc.getAttribute('aria-label')).toMatch(/À jour 4/);
    expect(parc.getAttribute('aria-label')).toMatch(/Aucun contrôle 1/);
    expect(screen.getAllByText(/EXEMPLE/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: /Vue tableau|Tableau/ })[0]!);
    expect(screen.getAllByRole('table').length).toBeGreaterThan(0);
  });
  it('fourrières sans dossier : états vides, jamais un zéro dessiné', () => {
    wrap(<FourriereVisuels f={undefined} dossiers={[]} sites={[]} recon={[]} />);
    expect(screen.getAllByText(/Aucune donnée pour cette période|Aucune recette liquidée/).length).toBeGreaterThan(0);
  });
  it('mes véhicules : répartition par titre', () => {
    wrap(<MesVehiculesVisuels vehicles={[{ plate: 'KN-1', controleTechnique: { state: 'ECHU' }, vignetteFiscale: { state: 'PAYEE' }, quitus: { state: 'BLOQUE' }, fourriere: [], appointments: [] }]} />);
    expect(screen.getByText('Véhicules rattachés')).toBeTruthy();
    expect(screen.getByRole('group', { name: /^Contrôle technique : Échu 1/ })).toBeTruthy();
  });
});

describe('publicité et stationnement', () => {
  it('espace de l’exploitant : supports par état et droits', () => {
    wrap(<AdvertiserVisuels devices={[
      { status: 'AUTORISE', rights: 'A_JOUR', type: 'PANNEAU', expiringSoon: true, demo: true },
      { status: 'NON_DECLARE', rights: 'IMPAYE', type: 'ENSEIGNE', expiringSoon: false, demo: true },
    ] as never} />);
    expect(screen.getByRole('group', { name: /Mes supports par état : Autorisé 1/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: /Droits de mes supports/ })).toBeTruthy();
  });
  it('échéances : frise et répartition', () => {
    wrap(<ContratsVisuels noticeDays={30} items={[{ kind: 'CONTRAT', id: '1', reference: 'C-1', until: '2026-10-10', daysLeft: 13, expiringSoon: true, expired: false }]} />);
    expect(screen.getByText('Frise des échéances')).toBeTruthy();
    expect(screen.getByRole('group', { name: /Échéances par état : Échu 0 \(0 %\), Dans le préavis \(30 j\) 1/ })).toBeTruthy();
  });
  it('constats : vide sans constat, carte des 24 communes', () => {
    wrap(<ViolationsVisuels violations={[]} />);
    expect(screen.getAllByText('Aucune donnée pour cette période').length).toBeGreaterThan(0);
  });
  it('tableau de bord : zones par position vs cible servie (15 à 25 % libres)', () => {
    wrap(<ParkingDashboardVisuels d={{ totals: { occupancyRate: '80.0', complianceRate: null, checks: 0 }, byCommune: [{ commune: 'Gombe', revenue: [{ amount: '1000', currency: 'CDF' }] }],
      zones: [{ zoneId: 'z', code: 'Z', name: 'Zone Z', legalStatus: 'OUVERTE', freeTarget: 'DANS_LA_CIBLE', capacity: 10, occupancyRate: '80.0', complianceRate: null, paidSessionsToday: 3, demo: true }] }} />);
    expect(screen.getByRole('group', { name: /Zones ouvertes par rapport à la cible : Dans la cible \(15 à 25 % libres\) 1/ })).toBeTruthy();
    expect(screen.getByText(/Aucun contrôle enregistré : conformité non mesurée/)).toBeTruthy();
  });
});

describe('verticales', () => {
  it('CALCU : scores vert / ambre / rouge et paiements bloqués toujours zéro', () => {
    wrap(<CalcuVisuels o={{ totals: { transactions: 4, vert: 2, ambre: 1, rouge: 1, blocked: 0 }, complianceRate: '50.0', accounts: { declared: 2, validated: 1 } }} />);
    expect(screen.getByRole('group', { name: /Opérations par score de correspondance : Vert — conforme 2/ })).toBeTruthy();
    expect(screen.getByText('Toujours zéro')).toBeTruthy();
  });
  it('télécom : concordants, observés non déclarés, déclarés non relevés', () => {
    wrap(<TelecomViz matched={3} observedNotDeclared={1} declaredNotObserved={0} />);
    const g = screen.getByRole('group', { name: /Rapprochement des sites d’antennes/ });
    expect(within(g).getByText('Observés non déclarés')).toBeTruthy();
  });
  it('espace /services/:slug : obligations, éléments, démarches ; montants par devise', () => {
    const s = {
      objects: [{ id: 'o', probativeStatus: 'VERIFIE' }], receipts: [], certificates: [],
      obligations: [{ id: 'ob', status: 'EMISE', amount: { amount: '150.00', currency: 'USD' }, demo: true }],
      cases: [{ id: 'c', status: 'DEPOSE', statusLabel: 'Déposée', createdAt: '2026-09-20T10:00:00Z' }],
    } as unknown as VerticalSpaceData;
    wrap(<EspaceVerticaleVisuels s={s} example />);
    expect(screen.getByRole('group', { name: /Mes obligations par état : À payer 1/ })).toBeTruthy();
    expect(screen.getByText('Montant en USD (une devise par graphique)')).toBeTruthy();
    expect(screen.getByText('Aucune quittance pour ce service.')).toBeTruthy();
  });
});
