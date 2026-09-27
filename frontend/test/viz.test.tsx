/**
 * Trousse de visualisation (components/viz) : chaque composant se rend, affiche ses états (chargement, vide « Aucune
 * donnée pour cette période », erreur, non mesuré avec motif), offre la vue tableau, une légende dès deux séries, des
 * attributs d'accessibilité, un rendu sombre SÉLECTIONNÉ (pas inversé), le repli « Autres » et la séparation des devises.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import { safeSet } from '../src/lib/api';
import {
  BarChartViz, ChartGrid, COMMUNES_KINSHASA, DonutViz, ETATS_PAIEMENT, GaugeMeter, HeatGrid, heatStep, KpiGrid, KpiTile, LadderFunnel, LineAreaViz,
  MatrixHeat, meterState, ProgressMeter, sixEtatsFromLadder, Sparkline, StackedBarViz, StatusDistribution, TimelineStrip, TrendBadge, vizTheme,
} from '../src/components/viz';
import { COMMUNES } from '../src/modules/pilotage/shared';
import { CATEGORICAL_DARK, CATEGORICAL_LIGHT, inkOn, ORDINAL_LADDER_DARK, ORDINAL_LADDER_LIGHT, SEQ_NAVY, SEQ_NAVY_DARK } from '../src/lib/palette';
import { splitByCurrency, sumBy } from '../src/lib/aggregate';

function wrap(ui: ReactElement) {
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
  return render(<AppProvider initialLang="fr"><MemoryRouter>{ui}</MemoryRouter></AppProvider>);
}
afterEach(() => { localStorage.clear(); delete document.documentElement.dataset.theme; });
// jsdom n'a pas ResizeObserver (utilisé par ResponsiveContainer de Recharts et par la trousse) : bouchon inerte.
if (typeof globalThis.ResizeObserver === 'undefined') {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
}

const toggleTable = () => fireEvent.click(screen.getAllByRole('button', { name: /Vue tableau|Tableau/ })[0]!);

describe('palette et thème', () => {
  it('le mode sombre est sélectionné (autres pas), pas une inversion de la rampe claire', () => {
    const light = vizTheme(false); const dark = vizTheme(true);
    expect(light.cat).toEqual(CATEGORICAL_LIGHT); expect(dark.cat).toEqual(CATEGORICAL_DARK);
    expect(light.seq).toEqual(SEQ_NAVY); expect(dark.seq).toEqual(SEQ_NAVY_DARK);
    expect([...SEQ_NAVY_DARK]).not.toEqual([...SEQ_NAVY].reverse());
    expect(light.ordinal).toEqual(ORDINAL_LADDER_LIGHT); expect(dark.ordinal).toEqual(ORDINAL_LADDER_DARK);
    expect(dark.surface).toBe('#141A33');
    expect(inkOn('#20296f')).toBe('#FFFFFF'); expect(inkOn('#E3EAF7')).toBe('#111111');
  });
  it('les 24 communes de la trousse sont celles du référentiel', () => {
    expect([...COMMUNES_KINSHASA]).toEqual(COMMUNES);
  });
});

describe('KpiTile et KpiGrid', () => {
  it('valeur héroïque avec unité, état, tendance (icône + texte), courbe miniature, jauge de cible', () => {
    wrap(<KpiGrid max={4}><KpiTile label="Encaissé" value={1200} unit="CDF" state={{ label: 'Encaissé', tone: 'info' }} delta={{ current: 1200, previous: 1000, versus: 'vs veille' }}
      spark={{ values: [1, 3, 2, 5], labels: ['a', 'b', 'c', 'd'] }} target={{ value: 1500, label: 'cible (exemple)' }} /></KpiGrid>);
    expect(screen.getByRole('group', { name: 'Indicateurs clés' })).toBeTruthy();
    const tile = screen.getByRole('article', { name: /Encaissé : 1\s?200 CDF — Encaissé/ });
    expect(within(tile).getByText('Encaissé', { selector: '.badge span' })).toBeTruthy();
    expect(within(tile).getByLabelText(/Hausse de 20 % vs veille, favorable/)).toBeTruthy();
    expect(within(tile).getByRole('img', { name: /Encaissé : 4 points, dernier \(d\) 5/ })).toBeTruthy();
    expect(within(tile).getByRole('meter')).toBeTruthy();
    expect(within(tile).getByText('Sous la cible')).toBeTruthy();
  });
  it('non mesuré avec motif ; chargement ; erreur', () => {
    wrap(<><KpiTile label="Potentiel" value={null} reason="Modèle non calibré." /><KpiTile label="B" value={1} loading /><KpiTile label="C" value={1} error={new Error('panne')} /></>);
    expect(screen.getByText('Non mesuré')).toBeTruthy();
    expect(screen.getByText('Modèle non calibré.')).toBeTruthy();
    expect(screen.getByText('Chargement…')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/Indisponible : panne/);
  });
  it('TrendBadge : sens favorable, baisse favorable, base nulle, indisponible', () => {
    wrap(<><TrendBadge current={80} previous={100} versus="vs veille" /><TrendBadge current={80} previous={100} better="BAISSE" versus="délai" /><TrendBadge current={5} previous={0} versus="vs N−1" /><TrendBadge current={null} previous={1} versus="vs veille" /></>);
    expect(screen.getByLabelText(/Baisse de 20 % vs veille, défavorable/).className).toContain('viz-trend-bad');
    expect(screen.getByLabelText(/Baisse de 20 % délai, favorable/).className).toContain('viz-trend-good');
    expect(screen.getByText(/\+5 vs N−1 \(base nulle\)/)).toBeTruthy();
    expect(screen.getByText(/Tendance indisponible vs veille/)).toBeTruthy();
  });
  it('Sparkline : trous pour les valeurs manquantes, rien si aucune donnée', () => {
    const { container } = wrap(<><Sparkline values={[1, null, 3, 4]} label="Série" /><Sparkline values={[null]} label="Vide" /></>);
    expect(container.querySelectorAll('.viz-spark path').length).toBe(2);
    expect(screen.getByRole('img', { name: 'Vide : aucune donnée' })).toBeTruthy();
  });
});

describe('graphiques cartésiens', () => {
  const rows = [{ label: 'Gombe', values: { a: 10, b: 5, c: 1, d: 2, e: 3 } }, { label: 'Limete', values: { a: 4, b: 2, c: 0, d: 1, e: 1 } }];
  it('BarChartViz : carte titrée, légende dès 2 séries, repli au-delà de 4 séries dans « Autres », vue tableau', () => {
    wrap(<BarChartViz title="Par commune" series={['a', 'b', 'c', 'd', 'e'].map((k) => ({ key: k, label: k.toUpperCase() }))} rows={rows} />);
    expect(screen.getByRole('heading', { name: 'Par commune' })).toBeTruthy();
    const legend = screen.getByRole('list', { name: 'Légende' });
    expect(within(legend).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['A', 'B', 'C', 'Autres']);
    expect(screen.getByText(/« Autres » regroupe : D, E/)).toBeTruthy();
    expect(screen.getByRole('img', { name: /Par commune\. Vue tableau disponible/ })).toBeTruthy();
    toggleTable();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Autres' })).toBeTruthy();
    expect(within(table).getAllByRole('row')[1]!.textContent).toContain('5'); // D + E pour Gombe
  });
  it('BarChartViz : une série = pas de légende ; vide ; chargement ; erreur ; non mesuré', () => {
    const { rerender } = wrap(<BarChartViz title="Seule" series={[{ key: 'a', label: 'A' }]} rows={rows} reference={{ value: 5, label: 'Cible' }} />);
    expect(screen.queryByRole('list', { name: 'Légende' })).toBeNull();
    const again = (ui: ReactElement) => rerender(<AppProvider initialLang="fr"><MemoryRouter>{ui}</MemoryRouter></AppProvider>);
    again(<BarChartViz title="Vide" series={[{ key: 'a', label: 'A' }]} rows={[]} />);
    expect(screen.getByText('Aucune donnée pour cette période')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Vue tableau/ })).toBeNull();
    again(<BarChartViz title="Charge" series={[{ key: 'a', label: 'A' }]} rows={[]} loading />);
    expect(screen.getByText('Chargement du graphique…')).toBeTruthy();
    again(<BarChartViz title="Err" series={[{ key: 'a', label: 'A' }]} rows={rows} error={new Error('Service en panne')} />);
    expect(screen.getByRole('alert').textContent).toContain('Service en panne');
    again(<BarChartViz title="NM" series={[{ key: 'a', label: 'A' }]} rows={rows} unmeasured="aucune assignation certifiée" />);
    expect(screen.getByText(/aucune assignation certifiée/).closest('.viz-state')?.textContent).toMatch(/Non mesuré — aucune assignation certifiée/);
  });
  it('StackedBarViz : parts à 100 % dans la vue tableau, légende, mention EXEMPLE', () => {
    wrap(<StackedBarViz title="Pile" example series={[{ key: 'a', label: 'Payé' }, { key: 'b', label: 'Impayé' }]} rows={[{ label: 'Gombe', values: { a: 3, b: 1 } }]} />);
    expect(screen.getByText('EXEMPLE — non opposable')).toBeTruthy();
    expect(screen.getAllByRole('listitem').map((l) => l.textContent)).toEqual(['Payé', 'Impayé']);
    toggleTable();
    expect(screen.getByRole('row', { name: /Gombe/ }).textContent).toMatch(/75 %.*25 %/);
  });
  it('LineAreaViz : dates en mois de Kinshasa, cible dans la légende et le tableau', () => {
    wrap(<LineAreaViz title="Série" granularity="month" target={{ value: 10, label: 'Cible déclarée' }} series={[{ key: 'v', label: 'Encaissé' }]}
      points={[{ date: '2026-08', values: { v: 4 } }, { date: '2026-08-31T23:30:00Z', values: { v: 7 } }]} />);
    expect(screen.getAllByRole('listitem').map((l) => l.textContent)).toEqual(['Encaissé', 'Cible déclarée']);
    toggleTable();
    const rowsT = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(rowsT).toEqual(['août 26410', 'sept. 26710']);
  });
});

describe('DonutViz', () => {
  it('au plus 5 parts : la traîne se replie dans « Autres », total au centre, parts dans la légende', () => {
    const slices = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((k, i) => ({ key: k, label: `Cat ${k}`, value: 70 - i * 10 }));
    const { container } = wrap(<DonutViz title="Catégories" slices={slices} centerLabel="dossiers" />);
    const items = within(screen.getByRole('list', { name: 'Légende' })).getAllByRole('listitem').map((l) => l.textContent);
    expect(items).toHaveLength(5);
    expect(items[4]).toMatch(/^Autres · \d+ %$/);
    expect(screen.getByText(/« Autres » regroupe : Cat E, Cat F, Cat G/)).toBeTruthy();
    expect(container.querySelector('.viz-donut-center strong')?.textContent).toBe('280');
    expect(screen.getByRole('img', { name: /Catégories : total 280 dossiers/ })).toBeTruthy();
  });
  it('total nul : état vide', () => {
    wrap(<DonutViz title="Rien" slices={[{ key: 'a', label: 'A', value: 0 }]} />);
    expect(screen.getByText('Aucune donnée pour cette période')).toBeTruthy();
  });
});

describe('jauges', () => {
  it('meterState : état imposé, cible atteinte / sous la cible, sans cible, non mesuré — aucun seuil inventé', () => {
    expect(meterState({ value: 96, target: 95 })).toEqual({ tone: 'good', label: 'Cible atteinte' });
    expect(meterState({ value: 2, target: 1, better: 'BAISSE' })).toEqual({ tone: 'warning', label: 'Sous la cible' });
    expect(meterState({ value: 2 })).toEqual({ tone: 'info', label: 'Suivi (sans cible)' });
    expect(meterState({ value: null })).toEqual({ tone: 'neutral', label: 'Non mesuré' });
    expect(meterState({ value: 50, target: 95, tone: 'critical', toneLabel: 'Sous la cible' }).tone).toBe('critical');
  });
  it('GaugeMeter et ProgressMeter : rôle meter, valeur lue, état avec icône et libellé, non mesuré motivé', () => {
    wrap(<><GaugeMeter title="Rapprochement" value={97} target={95} unit="%" /><ProgressMeter label="Part numérique" value={60} target={80} unit="%" /><ProgressMeter label="NM" value={null} reason="aucun paiement" /></>);
    const meters = screen.getAllByRole('meter');
    expect(meters[0]!.getAttribute('aria-valuetext')).toMatch(/97 % sur une cible de 95 % — Cible atteinte/);
    expect(meters[1]!.getAttribute('aria-valuenow')).toBe('60');
    expect(screen.getByText('Cible atteinte').closest('.badge')?.querySelector('svg')).toBeTruthy();
    expect(screen.getByText(/aucun paiement/)).toBeTruthy();
  });
});

describe('StatusDistribution', () => {
  it('couleurs d’état doublées d’icônes et de libellés, parts, infobulle au clavier, tableau', () => {
    const { container } = wrap(<StatusDistribution title="Paiements" unitLabel="paiements" items={[
      { key: 'PAYE', ...ETATS_PAIEMENT.PAYE!, count: 6 }, { key: 'EN_ATTENTE', ...ETATS_PAIEMENT.EN_ATTENTE!, count: 3 }, { key: 'IMPAYE', ...ETATS_PAIEMENT.IMPAYE!, count: 1 },
    ]} />);
    expect(container.querySelectorAll('.viz-status-list .badge svg')).toHaveLength(3);
    expect(screen.getByText('Payé').closest('li')?.textContent).toMatch(/Payé.*6.*60 %/);
    const seg = screen.getByRole('img', { name: 'Impayé : 1 paiements, 10 %' });
    fireEvent.focus(seg);
    expect(screen.getByRole('tooltip').textContent).toMatch(/1 · 10 %/);
    fireEvent.blur(seg);
    expect(screen.queryByRole('tooltip')).toBeNull();
    toggleTable();
    expect(screen.getByRole('row', { name: /En attente/ }).textContent).toContain('30 %');
  });
});

describe('cartes de chaleur', () => {
  it('HeatGrid : 24 communes, les absentes « non mesurées » avec motif, échelle de légende, tableau', () => {
    const { container } = wrap(<HeatGrid title="Communes" measureLabel="Rapproché" unit="CDF" cells={[{ commune: 'Gombe', value: 100 }, { commune: 'Limete', value: 50 }]} unmeasuredReason="aucun paiement" />);
    expect(container.querySelectorAll('.viz-heat-cell')).toHaveLength(24);
    expect(container.querySelectorAll('.viz-heat-cell.is-unmeasured')).toHaveLength(22);
    expect(screen.getByRole('img', { name: 'Kalamu : non mesuré — aucun paiement' })).toBeTruthy();
    expect(screen.getByLabelText(/Échelle : de 0 CDF \(clair\) à 100 CDF \(foncé\)/)).toBeTruthy();
    expect(screen.getByText('non mesuré', { selector: '.viz-scale-nm' })).toBeTruthy();
    toggleTable();
    expect(screen.getAllByRole('row')).toHaveLength(25);
  });
  it('HeatGrid sombre : rampe sombre sélectionnée ; vignette compacte à abréviations', () => {
    safeSet('mosolo.theme', 'dark');
    const { container } = wrap(<HeatGrid title="Vignette" compact framed={false} measureLabel="Taux" unit="%" domain={[0, 100]} cells={[{ commune: 'Gombe', value: 100 }]} />);
    const gombe = screen.getByRole('img', { name: 'Gombe : 100 %' }) as HTMLElement;
    expect(gombe.textContent).toBe('Gom');
    expect((gombe.parentElement as HTMLElement).style.background).toBe('rgb(202, 222, 255)'); // #cadeff, dernier pas sombre
    expect(container.querySelector('.viz-inline-title')?.textContent).toBe('Vignette');
  });
  it('heatStep : classes 0 → 6, null si non mesuré', () => {
    expect(heatStep(0, [0, 100])).toBe(0); expect(heatStep(100, [0, 100])).toBe(6); expect(heatStep(50, [0, 100])).toBe(3); expect(heatStep(null, [0, 1])).toBeNull();
  });
  it('MatrixHeat : lignes × colonnes, cellules lues au clavier', () => {
    wrap(<MatrixHeat title="Jour × heure" measureLabel="Paiements" rows={['lun.', 'mar.']} cols={['8 h', '9 h']} values={[[1, 2], [null, 4]]} />);
    expect(screen.getByRole('img', { name: 'mar., 8 h : non mesuré' })).toBeTruthy();
    fireEvent.focus(screen.getByRole('img', { name: 'lun., 9 h : 2' }));
    expect(screen.getByRole('tooltip').textContent).toContain('lun. · 9 h');
  });
});

describe('LadderFunnel', () => {
  const lvl = (level: string, measure: 'MONTANT' | 'COMPTE' | 'NON_MESURE', cdf: string | null, amounts: { amount: string; currency: 'CDF' | 'USD' }[] = [], note?: string) =>
    ({ level, measure, amounts, consolidatedCdf: cdf ? { amount: cdf, currency: 'CDF' as const } : null, count: 1, note });
  it('six états depuis l’échelle unifiée ; non mesurés hachurés et motivés ; part du précédent ; devises séparées', () => {
    const steps = sixEtatsFromLadder([
      lvl('potential', 'NON_MESURE', null, [], 'Modèle non calibré'), lvl('assessed', 'MONTANT', '1000', [{ amount: '100.00', currency: 'CDF' }, { amount: '1.00', currency: 'USD' }]),
      lvl('confirmed', 'MONTANT', '500'), lvl('settled', 'MONTANT', '400'), lvl('reconciled', 'MONTANT', '300'),
    ], (a) => a.map((m) => `${m.amount} ${m.currency}`).join(' · '));
    expect(steps.map((s) => s.label)).toEqual(['Potentiel', 'Constaté', 'Encaissé', 'Réglé', 'Rapproché', 'Disponible']);
    expect(steps[1]!.display).toBe('100.00 CDF · 1.00 USD');
    expect(steps[5]!.value).toBeNull();
    const { container } = wrap(<LadderFunnel title="Six états" steps={steps} />);
    expect(container.querySelectorAll('.viz-ladder-row.is-unmeasured .viz-hatch')).toHaveLength(2);
    expect(screen.getByRole('img', { name: /Potentiel : Non mesuré — Modèle non calibré/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Encaissé : .*50 % de « Constaté »/ })).toBeTruthy();
    toggleTable();
    expect(screen.getByRole('row', { name: /^Réglé/ }).textContent).toContain('80 % de « Encaissé »');
  });
});

describe('TimelineStrip et ChartGrid', () => {
  it('points par catégorie, légende, infobulle, tableau chronologique en jours de Kinshasa', () => {
    wrap(<ChartGrid label="Grille"><TimelineStrip title="Frise" events={[
      { id: '1', at: '2026-09-26T23:30:00Z', category: 'Alertes', label: 'Écart' }, { id: '2', at: '2026-09-20T10:00:00Z', category: 'Décisions', label: 'Validée' },
    ]} /></ChartGrid>);
    expect(screen.getByRole('region', { name: 'Grille' })).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Légende' })).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['Alertes', 'Décisions']);
    const dot = screen.getByRole('img', { name: '2026-09-27 — Alertes : Écart' });
    act(() => { fireEvent.focus(dot); });
    expect(screen.getByRole('tooltip').textContent).toContain('Écart');
    toggleTable();
    expect(screen.getAllByRole('row').slice(1).map((r) => r.firstChild?.textContent)).toEqual(['2026-09-20', '2026-09-27']);
  });
});

describe('devises', () => {
  it('une série par devise : jamais une barre qui additionne CDF et USD', () => {
    const rows = sumBy([{ c: 'Gombe', m: { amount: '100.00', currency: 'CDF' as const } }, { c: 'Gombe', m: { amount: '2.00', currency: 'USD' as const } }], 'c', 'm');
    const s = splitByCurrency(rows);
    wrap(<>{(['CDF', 'USD'] as const).map((cur) => <BarChartViz key={cur} title={`Par commune (${cur})`} series={[{ key: 'v', label: cur }]} rows={(s[cur] ?? []).map((r) => ({ label: r.key, values: { v: r.value } }))} />)}</>);
    fireEvent.click(screen.getAllByRole('button', { name: /Vue tableau/ })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: /Vue tableau/ })[0]!);
    const tables = screen.getAllByRole('table');
    expect(tables.map((t) => within(t).getAllByRole('row')[1]!.textContent)).toEqual(['Gombe100', 'Gombe2']);
  });
});

describe('intégrations : poste du Gouverneur et galerie', () => {
  it('bloc 2 : quatre tuiles avec courbes miniatures (données réelles du mois), fiches chiffrées conservées ; vignette en carte de chaleur', async () => {
    const { VilleAujourdhui, VignetteCommunes } = await import('../src/modules/postes/visuels');
    const mois = new Date(Date.now() + 3600_000).toISOString().slice(0, 7);
    globalThis.fetch = vi.fn((url: string) => {
      if (String(url).includes('/v1/pilotage/drill/month')) return Promise.resolve(new Response(JSON.stringify({ rows: [{ key: mois, values: { confirmed: { consolidatedCdf: { amount: '17837000.00', currency: 'CDF' } }, settled: { consolidatedCdf: { amount: '1.00', currency: 'CDF' } }, reconciled: { consolidatedCdf: { amount: '2.00', currency: 'CDF' } } } }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      return Promise.reject(new TypeError('Failed to fetch'));
    }) as unknown as typeof fetch;
    const ch = (code: string, etat: string, valeur: string | null, unite = 'CDF') => ({ code, libelle: code, valeur, unite, etat, etatLabel: etat, estimation: false, date: '2026-09-27T09:00:00Z',
      comparaison: { type: 'PERIODE_PRECEDENTE', libelle: 'Même période 2025', valeur: '0.00', ecart: null, tendance: 'HAUSSE' }, source: { libelle: 's', chemin: ['/poste-de-decision', '/pilotage/indicateurs'], api: '/x' } });
    render(<AppProvider initialLang="fr"><MemoryRouter>
      <VilleAujourdhui chiffres={[ch('ENCAISSE', 'ENCAISSE', '17837000.00'), ch('REGLE', 'REGLE', '1.00'), ch('RAPPROCHE', 'RAPPROCHE', '2.00'), { ...ch('ECART_ASSIGNATION', 'RATIO', null, '%'), comparaison: { type: 'OBJECTIF', libelle: 'Aucune assignation certifiée : écart non mesuré.', valeur: '0', ecart: null, tendance: 'INDISPONIBLE' } }]} />
      <VignetteCommunes com={{ mesure: false, note: 'Aucune assignation certifiée : couleurs non mesurées (gris).', communes: [{ commune: 'Gombe', couleur: 'GRIS', tauxPct: null, lien: '/x' }] }} />
    </MemoryRouter></AppProvider>);
    expect(screen.getAllByRole('article')).toHaveLength(4);
    expect(await screen.findByRole('img', { name: /ENCAISSE — 12 derniers mois.*dernier .* 17,8 M/ })).toBeTruthy();
    expect(screen.getByText('Aucune assignation certifiée : écart non mesuré.', { selector: '.viz-kpi-reason' })).toBeTruthy();
    expect(screen.getByText('État, comparaison, date, taux et source de chaque chiffre')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Gombe : non mesuré — Aucune assignation certifiée : couleurs non mesurées (gris).' })).toBeTruthy();
    expect(document.querySelectorAll('input, select, textarea')).toHaveLength(0);
  });
  it('galerie : route inscrite pour les rôles internes ; hors connexion, chaque bloc est marqué [EXEMPLE] avec le motif', async () => {
    const { MODULE_ROUTES } = await import('../src/modules/registry');
    const r = MODULE_ROUTES.find((x) => x.path === '/visualisation/galerie');
    expect(r?.nav?.label).toBe('Galerie de visualisation');
    expect(r?.nav?.roles).toContain('R01');
    expect(r?.nav?.roles).not.toContain('R30');
    const { default: Galerie } = await import('../src/modules/plateforme/GalerieVisualisation');
    wrap(<Galerie />);
    expect(await screen.findByRole('heading', { name: 'Galerie de visualisation' })).toBeTruthy();
    expect((await screen.findAllByText(/\[EXEMPLE\] données illustratives, non opposables/)).length).toBeGreaterThan(3);
    expect(screen.getByRole('heading', { name: '4. États de chaque composant' })).toBeTruthy();
  });
});
