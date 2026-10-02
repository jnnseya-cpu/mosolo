/**
 * Visuels du périmètre « pilotage et décision » (27/09/2026) : agrégations locales (états, devises), graphiques rendus
 * avec des données, états vides (« Aucune … »), non mesuré motivé, vue tableau, une devise par graphique, et la
 * chronologie vide qui ne plante plus (correctif de TimelineStrip).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import { TimelineStrip } from '../src/components/viz';
import {
  BarresParDevise, devisesDe, ETATS_INDICATEUR, EtatIndicateurs, etatIndicateur, etatsDe, montantDevise, nombre, TuilesIndicateurs,
} from '../src/modules/pilotage/visuels';
import { VisuelsInstructions, type InstructionRow } from '../src/modules/pilotage/Instructions';
import { VisuelsReductions, type ReductionReport } from '../src/modules/pilotage/Reductions';
import { EtatExecution, VisuelsFile } from '../src/modules/postes/visuels';
import { VisuelChaine } from '../src/modules/chaine/SeptQuestions';
import type { Answer, Maillon } from '../src/modules/chaine/types';

function wrap(ui: ReactElement) {
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
  return render(<AppProvider initialLang="fr"><MemoryRouter>{ui}</MemoryRouter></AppProvider>);
}
const m = (amount: string, currency: 'CDF' | 'USD'): MoneyJSON => ({ amount, currency });

describe('agrégations des visuels', () => {
  it('nombre, états (ordre de la table, inconnus en neutre), devises (CDF d’abord, jamais additionnées)', () => {
    expect(nombre('19.0')).toBe(19); expect(nombre('12,5')).toBe(12.5); expect(nombre(null)).toBeNull(); expect(nombre('abc')).toBeNull();
    const items = etatsDe([{ s: 'A' }, { s: 'A' }, { s: 'X' }], (i) => i.s, { A: { label: 'Alpha', tone: 'good' }, B: { label: 'Bêta', tone: 'warning' } });
    expect(items.map((i) => [i.key, i.count, i.tone])).toEqual([['A', 2, 'good'], ['B', 0, 'warning'], ['X', 1, 'neutral']]);
    expect(montantDevise([m('10', 'USD'), m('5', 'USD'), m('100', 'CDF')], 'USD')).toBe(15);
    expect(montantDevise([m('10', 'USD')], 'CDF')).toBeNull();
    expect(devisesDe([[m('1', 'USD')], m('2', 'CDF'), null])).toEqual(['CDF', 'USD']);
  });
  it('état d’un indicateur : non mesuré, dans la cible, hors cible, suivi sans cible', () => {
    expect(etatIndicateur({ code: 'a', label: 'a', measured: false, value: null })).toBe('NON_MESURE');
    expect(etatIndicateur({ code: 'a', label: 'a', measured: true, value: '1', meetsTarget: true })).toBe('CIBLE');
    expect(etatIndicateur({ code: 'a', label: 'a', measured: true, value: '1', meetsTarget: false })).toBe('HORS_CIBLE');
    expect(etatIndicateur({ code: 'a', label: 'a', measured: true, value: '1' })).toBe('SUIVI');
    expect(Object.keys(ETATS_INDICATEUR)).toHaveLength(4);
  });
});

describe('graphiques du périmètre', () => {
  it('barres par devise : un graphique par devise, vue tableau ; état vide sans montant', () => {
    wrap(<BarresParDevise title="Par recette" series={[{ key: 'a', label: 'Liquidé' }, { key: 'r', label: 'Rapproché' }]}
      rows={[{ label: 'Foncier', values: { a: [m('100', 'USD')], r: [m('80', 'USD')] } }, { label: 'Patente', values: { a: [m('5000', 'CDF')], r: [] } }]} />);
    expect(screen.getByText('Par recette — CDF')).toBeTruthy();
    expect(screen.getByText('Par recette — USD')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Vue tableau/ })[0]!);
    expect(screen.getAllByRole('table').length).toBeGreaterThan(0);
  });
  it('barres par devise sans montant : texte vide explicite', () => {
    wrap(<BarresParDevise title="Vide" series={[{ key: 'a', label: 'Montant' }]} rows={[]} emptyText="Aucune part calculée" />);
    expect(screen.getByText('Aucune part calculée')).toBeTruthy();
  });
  it('tuiles et états des indicateurs : non mesuré avec motif, cible servie dessinée', () => {
    const items = [
      { code: 'A', label: 'Taux de recouvrement', measured: true, value: '42.0', unit: '%', target: 60, meetsTarget: false },
      { code: 'B', label: 'Délai de contentieux', measured: false, value: null, unit: 'jours', reason: 'Aucun recours décidé.' },
    ];
    wrap(<><TuilesIndicateurs items={items} label="Indicateurs" /><EtatIndicateurs items={items} /></>);
    expect(screen.getAllByText('Aucun recours décidé.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Hors cible').length).toBeGreaterThan(0);
    expect(screen.getByText('Indicateurs par état')).toBeTruthy();
    expect(screen.getAllByRole('meter').length).toBeGreaterThan(0);
  });
  it('instructions : état vide, puis répartition par statut et chronologie des échéances', () => {
    const { unmount } = wrap(<VisuelsInstructions items={[]} origins={{}} />);
    expect(screen.getAllByText('Aucune instruction').length).toBeGreaterThan(0);
    unmount();
    const row = (id: string, status: string, overdue: boolean): InstructionRow => ({ id, number: `INS-${id}`, authority: 'Gouverneur', origin: 'COMMUNE', originLabel: 'Par commune', subject: `Objet ${id}`, body: 'x', deadline: '2026-10-10', status, overdue, daysLeft: 3, assignee: { entity: 'DGIPK' }, issuedBy: 'u', reports: [] });
    wrap(<VisuelsInstructions items={[row('1', 'EMISE', true), row('2', 'CLOSE', false)]} origins={{ COMMUNE: 'Par commune — interpeller' }} />);
    expect(screen.getByText('Instructions par statut')).toBeTruthy();
    expect(screen.getByText('Échéances des instructions')).toBeTruthy();
    expect(within(screen.getByText('Instructions par statut').closest('.viz-card') as HTMLElement).getByText('Émise')).toBeTruthy();
  });
  it('réductions : du brut à l’encaissé par devise, réductions par type', () => {
    const blk = (c: 'CDF' | 'USD') => ({ currency: c, chains: 1, grossAssessed: m('100', c), reductions: { total: m('10', c), count: 1, byType: [{ type: 'EXONERATION', count: 1, amount: m('10', c) }] }, netExpected: m('90', c), collected: m('50', c), outstanding: m('40', c), reconciliation: { grossMinusReductions: m('90', c), netExpected: m('90', c), gap: m('0', c), reconciled: true, tolerance: '0.01' } });
    const d = { totals: [blk('USD')], byCommune: [], potentialUnassessed: { note: '', units: 0, byVertical: [], rows: [] }, untracedDeciders: 0, signals: { raised: 0, open: 0, params: {} } } as unknown as ReductionReport;
    wrap(<VisuelsReductions d={d} />);
    expect(screen.getByText('Du brut liquidé à l’encaissé — USD')).toBeTruthy();
    expect(screen.getByText('Réductions par type — USD')).toBeTruthy();
    expect(screen.getByText(/10 % du brut liquidé/)).toBeTruthy();
  });
  it('chronologie sans événement ni bornes : état vide, sans erreur', () => {
    wrap(<TimelineStrip title="Rien" events={[]} emptyText="Aucune échéance" />);
    expect(screen.getByText('Aucune échéance')).toBeTruthy();
  });
});

describe('postes et chaîne', () => {
  it('exécution des actes et file de travail', () => {
    wrap(<>
      <EtatExecution rows={[{ id: 'a', acteLibelle: 'Arrêté', etat: 'EXECUTE', enRetard: false, echeance: '2026-09-20' }, { id: 'b', acteLibelle: 'Note', etat: 'EN_COURS', enRetard: true, echeance: '2026-09-10' }]} />
      <VisuelsFile enAttente={1} file={[{ id: 'w', module: 'Recours', objet: 'Recours n° 1', echeance: '2026-10-01', enRetard: false, depose: '2026-09-20' }]} />
    </>);
    expect(screen.getByText('Actes par état d’exécution')).toBeTruthy();
    expect(screen.getByText('Éléments par module source')).toBeTruthy();
    expect(screen.getByText('Échéances de la file')).toBeTruthy();
  });
  it('chaîne : maillons par état et part accomplie', () => {
    const mk = (rang: number, status: Maillon['status']): Maillon => ({ rang, code: `M${rang}`, label: `Maillon ${rang}`, garde: '', status, at: null, actor: null, auditEventId: null, auditSeq: null, chainHash: null, evidence: [], detail: '' });
    const q: Answer[] = [{ code: 'QUI', question: 'Qui ?', status: 'REPONDU', answer: 'x', sources: {} }];
    wrap(<VisuelChaine maillons={[mk(1, 'FAIT'), mk(2, 'FAIT'), mk(3, 'EN_ATTENTE'), mk(4, 'SANS_OBJET')]} questions={q} />);
    expect(screen.getByText('Maillons par état')).toBeTruthy();
    const meter = screen.getByRole('meter', { name: 'Maillons accomplis (hors sans objet)' });
    expect(meter.getAttribute('aria-valuenow')).toBe('66.7');
  });
});
