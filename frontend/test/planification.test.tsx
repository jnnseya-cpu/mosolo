import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppProvider } from '../src/context';
import { setDemoUser } from '../src/lib/api';
import { visibleNav } from '../src/components/Shell';
import { certifyGuard } from '../src/modules/pilotage/planif';
import { OriginsTable } from '../src/modules/pilotage/BaseReference';
import { GapView, parseTargets } from '../src/modules/pilotage/Assignations';
import { instructionActions, type InstructionRow } from '../src/modules/pilotage/Instructions';
import { PilotView, type PilotBoard } from '../src/modules/pilotage/Pilote';
import { ScenarioCard, type Scenario } from '../src/modules/pilotage/Scenarios';

const usd = (amount: string) => ({ amount, currency: 'USD' as const });
function mockApi(userId: string, roles: string[]) {
  setDemoUser(userId);
  globalThis.fetch = vi.fn((url: string) => (String(url).includes('/v1/demo/users')
    ? Promise.resolve(new Response(JSON.stringify([{ id: userId, name: 'Test', roles, entity: 'DGIPK' }]), { status: 200, headers: { 'content-type': 'application/json' } }))
    : Promise.reject(new TypeError('Failed to fetch')))) as unknown as typeof fetch;
}
afterEach(() => { setDemoUser(null); localStorage.clear(); });

describe('Planification — gardes d’interface (le serveur reste juge)', () => {
  it('quatre yeux : la personne qui importe ne certifie pas ; rôle non habilité bloqué', () => {
    const set = { status: 'IMPORTEE', importedBy: 'u-a' };
    expect(certifyGuard(set, { id: 'u-a', roles: ['R22'] }, ['R22'])).toMatch(/autre personne/);
    expect(certifyGuard(set, { id: 'u-b', roles: ['R17'] }, ['R22'])).toMatch(/réservée/);
    expect(certifyGuard(set, { id: 'u-b', roles: ['R22'] }, ['R22'])).toBeNull();
    expect(certifyGuard({ ...set, status: 'CERTIFIEE' }, { id: 'u-b', roles: ['R22'] }, ['R22'])).toMatch(/décidé/);
  });

  it('instructions : le destinataire accuse et rend compte ; seule l’autorité (non destinataire) clôt', () => {
    const i = { id: 'I1', status: 'RAPPORT_DEPOSE', assignee: { entity: 'DGIPK', role: 'R06' } } as unknown as InstructionRow;
    expect(instructionActions(i, { id: 'u-dg', roles: ['R06'], entity: 'DGIPK' })).toMatchObject({ report: true, close: false });
    expect(instructionActions(i, { id: 'u-dircab', roles: ['R02'], entity: 'GOUVERNORAT' })).toMatchObject({ close: true, report: false });
    expect(instructionActions({ ...i, status: 'EMISE' }, { id: 'u-dg', roles: ['R06'], entity: 'DGIPK' }).acknowledge).toBe(true);
  });

  it('assignations : lignes « commune;catégorie;montant;devise »', () => {
    expect(parseTargets('commune;categorie;montant;devise\nLimete;IMPOT_PROVINCIAL;600,50;usd')).toEqual([{ commune: 'Limete', category: 'IMPOT_PROVINCIAL', amount: { amount: '600.50', currency: 'USD' } }]);
  });

  it('navigation : écrans de planification pour la direction ; registre IA ; avis pour le contribuable', () => {
    const has = (roles: string[], to: string) => visibleNav(roles).some((n) => n.to === to);
    for (const to of ['/pilotage/base-reference', '/pilotage/pilote', '/pilotage/scenarios', '/pilotage/assignations', '/pilotage/instructions', '/pilotage/projets', '/pilotage/partage-legal']) {
      expect(has(['R01'], to)).toBe(true);
      expect(has(['R10'], to)).toBe(false);
    }
    expect(has(['R29'], '/ia/modeles')).toBe(true);
    expect(has(['R30'], '/satisfaction')).toBe(true);
  });
});

describe('Planification — écrans', () => {
  it('écart non mesuré sans assignation certifiée ; carte des écarts sinon', () => {
    mockApi('u-g', ['R01']);
    const { rerender } = render(<AppProvider initialLang="fr"><GapView g={{ year: '2026', certified: false, note: 'Aucune assignation certifiée.', rows: [], byCommune: [] }} /></AppProvider>);
    expect(screen.getByText(/Écart non mesuré/)).toBeTruthy();
    rerender(<AppProvider initialLang="fr"><GapView g={{ year: '2026', certified: true, rule: 'r', rows: [{ commune: 'Limete', category: '*', target: usd('600.00'), realised: usd('150.00'), gap: usd('450.00'), ratePct: '25.0' }], byCommune: [{ commune: 'Limete', target: [usd('600.00')], realised: [usd('150.00')], ratePctCdf: '25.0' }], totals: { targetCdf: { amount: '1.00', currency: 'CDF' }, realisedCdf: { amount: '1.00', currency: 'CDF' }, ratePct: '25.0' } }} /></AppProvider>);
    expect(screen.getAllByText(/25 %/).length).toBeGreaterThan(0);
  });

  it('ventilation par origine (§ 8.7) : nouvelles, arriérés, rapprochement, reclassement', () => {
    mockApi('u-g', ['R01']);
    const rows = ['RECLASSEMENT', 'RAPPROCHEMENT', 'ARRIERES', 'NOUVELLE', 'COURANTE'].map((o, i) => ({ origin: o, label: `Libellé ${o}`, definition: 'd', count: i, amounts: [] }));
    render(<AppProvider initialLang="fr"><OriginsTable origins={{ basis: 'b', rule: 'Les tableaux séparent toujours…', reference: { date: null, source: 'AUCUNE', note: '' }, rows, total: { count: 10, amounts: [usd('150.00')] } }} /></AppProvider>);
    expect(screen.getAllByText(/Libellé NOUVELLE|Libellé ARRIERES|Libellé RECLASSEMENT/).length).toBeGreaterThanOrEqual(3);
  });

  it('scénario : équivalence du Cahier, sensibilité, hypothèses sourcées', () => {
    mockApi('u-g', ['R01']);
    const s: Scenario = {
      code: 'TRANSFORMATIONNEL', label: 'Transformationnel', equivalent: 'Ambitieux', compliance: 'c', cost: 'x', reading: 'Changement d’échelle', exchangeRate: '2800', exchangeRateSource: 'HYPOTHESE',
      protocolDelayMonths: 3, protocolDelaySource: 'HYPOTHESE', lines: [], additionalNetCdf: { amount: '1000.00', currency: 'CDF' }, complete: true, missing: [],
      hypotheses: [{ id: 'H1', scenario: 'TRANSFORMATIONNEL', variable: 'TAUX_CHANGE', revenue: '*', value: '2800', source: 'Banque centrale (test)', sourceDate: '2026-09-01', recordedBy: 'u', status: 'EN_VIGUEUR' }],
      sensitivity: { note: 'n', compliancePlusOnePointCdf: { amount: '10.00', currency: 'CDF' }, exchangeRatePlusOnePctCdf: null, protocolDelayPlusOneMonthCdf: { amount: '-5.00', currency: 'CDF' } },
    };
    render(<AppProvider initialLang="fr"><ScenarioCard s={s} /></AppProvider>);
    expect(screen.getByText(/équivaut à « ambitieux »/)).toBeTruthy();
    expect(screen.getByText(/Banque centrale \(test\), 2026-09-01/)).toBeTruthy();
    expect(screen.getByText('+1 point de conformité')).toBeTruthy();
  });

  it('pilote : critères pilotes vs témoins et jalons', () => {
    mockApi('u-aud', ['R22']);
    const b: PilotBoard = {
      day: 31, period: { from: '2026-09-01', to: '2026-10-02' }, protocol: 'Protocole',
      config: { startDate: '2026-09-01', communes: ['Gombe', 'Limete', 'Kalamu', 'Ngaliema'], controls: ['Masina'], setBy: 'u', motif: 'm' },
      milestones: [{ milestone: 'J30', days: 30, dueDate: '2026-10-01', reached: true, signed: null }, { milestone: 'J60', days: 60, dueDate: '2026-10-31', reached: false, signed: null }],
      criteria: [{ code: 'PART_ELECTRONIQUE', label: 'Part électronique des encaissements', threshold: '> 90 %', pilot: { value: '100.0', unit: '%', met: true }, controls: { value: null, unit: '%' }, gapPoints: null, status: 'ATTEINT', note: '' }],
      baseline: null, snapshots: [],
    };
    render(<AppProvider initialLang="fr"><PilotView b={b} onDone={() => undefined} /></AppProvider>);
    expect(screen.getByText('Part électronique des encaissements')).toBeTruthy();
    expect(screen.getByText(/Base de référence auditée absente/)).toBeTruthy();
    expect(screen.getByText('Jalon non atteint')).toBeTruthy();
  });
});
