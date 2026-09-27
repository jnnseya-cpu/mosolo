/**
 * Visuels du périmètre « trésor » (Trésor, recouvrement, canaux, RakaPay, titres) — trousse de visualisation :
 * les graphiques se rendent avec des données réelles de forme serveur, affichent l'état vide, offrent la vue tableau,
 * ne mélangent jamais les devises et ne dessinent jamais une valeur absente comme un zéro.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import { lignesParJour, soldesParDevise, TresorSynthese, ExceptionsVisuel, PointsAgreesVisuel, repartition } from '../src/modules/tresor/visuels';
import { EXC_STATUS } from '../src/modules/tresor/shared';
import { balanceAgeeParDevise, RecouvrementVisuel, NonValeursVisuel } from '../src/modules/recouvrement/visuels';
import { caisseParDevise, CaisseVisuel, heureKinshasa, OuPayerVisuel, EnrolementVisuel } from '../src/modules/canaux/visuels';
import { ciblePct, tauxPct, PilotageVisuel } from '../src/modules/rakapay/visuels';
import { CatalogueVisuel, ConstatsVisuel, constatLabel } from '../src/modules/titres/visuels';
import { MesArrieresVisuel } from '../src/modules/recouvrement/visuels';
import { TimelineStrip } from '../src/components/viz';

function wrap(ui: ReactElement) {
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
  return render(<AppProvider initialLang="fr"><MemoryRouter>{ui}</MemoryRouter></AppProvider>);
}
afterEach(() => { localStorage.clear(); });
if (typeof globalThis.ResizeObserver === 'undefined') {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
}
const usd = (amount: string) => ({ amount, currency: 'USD' as const });
const cdf = (amount: string) => ({ amount, currency: 'CDF' as const });

describe('agrégations pures', () => {
  it('soldes par devise : un graphique par devise, valeur absolue, nature nommée, soldes nuls écartés', () => {
    const s = soldesParDevise([
      { account: 'RECETTES_CONSTATEES', label: 'Recettes constatées', currency: 'USD', balance: usd('-7725.00') },
      { account: 'CREANCES', label: 'Créances', currency: 'USD', balance: usd('1665.00') },
      { account: 'VIDE', currency: 'USD', balance: usd('0.00') },
      { account: 'RECETTES_CONSTATEES', label: 'Recettes constatées', currency: 'CDF', balance: cdf('-3600000.00') },
    ]);
    expect(Object.keys(s).sort()).toEqual(['CDF', 'USD']);
    expect(s.USD).toEqual([{ label: 'Recettes constatées (créditeur)', values: { solde: 7725 } }, { label: 'Créances (débiteur)', values: { solde: 1665 } }]);
  });
  it('lignes de relevés par jour : nombre de lignes par devise, jamais une somme de montants', () => {
    const r = lignesParJour([{ lines: [{ valueDate: '2026-09-26', amount: usd('450.00') }, { valueDate: '2026-09-27', amount: cdf('9000.00') }, { valueDate: '2026-09-27', amount: usd('1.00') }] }, { lines: 3 }]);
    expect(r.currencies).toEqual(['CDF', 'USD']);
    expect(r.rows.map((x) => [x.key, x.values])).toEqual([['2026-09-26', { CDF: 0, USD: 1 }], ['2026-09-27', { CDF: 1, USD: 1 }]]);
  });
  it('répartition par état : ordre du dictionnaire, états absents à zéro', () => {
    expect(repartition(['OUVERTE', 'OUVERTE', 'RESOLUE'] as const, EXC_STATUS).map((i) => [i.key, i.count])).toEqual([['OUVERTE', 2], ['EN_COURS', 0], ['RESOLUE', 1], ['CLASSEE', 0]]);
  });
  it('balance âgée par devise et caisse du jour : valeur non saisie = non mesurée (null), jamais zéro', () => {
    const b = balanceAgeeParDevise({ count: 1, total: { USD: '50.00' }, byBand: { B1: { USD: '50.00' } }, byCategory: {}, byCommune: {}, bySegment: {}, bands: [{ code: 'B1', label: '0 à 30 j' }, { code: 'B2', label: '31 à 90 j' }] });
    expect(b).toEqual({ USD: [{ key: 'B1', label: '0 à 30 j', values: { m: 50 } }, { key: 'B2', label: '31 à 90 j', values: { m: 0 } }] });
    const c = caisseParDevise({ status: 'OUVERTE', expected: [cdf('9000.00')], counted: null, reconciledCount: 0, exceptions: [], deposit: null, collections: [] });
    expect(c).toEqual({ CDF: { attendu: 9000, compte: null, verse: null } });
    expect(heureKinshasa('2026-09-27T08:30:00Z')).toBe(9);
  });
  it('taux et cible RakaPay : cible lue telle que servie, jamais inventée', () => {
    expect(tauxPct('0.85')).toBe(85);
    expect(tauxPct(null)).toBeNull();
    expect(ciblePct('100 %')).toBe(100);
    expect(ciblePct('1.0000')).toBe(100);
    expect(ciblePct('')).toBeNull();
    expect(constatLabel('OUVERT')).toBe('À instruire');
  });
});

describe('rendu des visuels', () => {
  it('synthèse du Trésor : tuiles, un graphique de soldes par devise, vue tableau', () => {
    wrap(<TresorSynthese
      balance={{ balanced: true, entries: 107, accounts: [{ account: 'A', label: 'Compte public', currency: 'USD', balance: usd('5975.00') }, { account: 'B', label: 'Recettes', currency: 'CDF', balance: cdf('-3600000.00') }] }}
      overview={{ exceptions: { open: 2, overdue: 1, unassigned: 0 }, suspense: { open: 1, totals: [usd('75.00')], oldestDays: 4 }, operations: { pending: 0 }, closures: { lastClosedDate: null, lastHash: null, chainValid: true }, accounting: { imputed: 5, unimputed: 15 } }}
      suspense={{ items: [], open: 1, totals: [], buckets: [{ bucket: '0-2 j', count: 0, amounts: [] }, { bucket: '3-5 j', count: 1, amounts: [usd('75.00')] }], slaDays: 5, maxDays: 30 }}
      imports={[{ status: 'VALIDE', lines: [{ valueDate: '2026-09-27', amount: usd('450.00') }] }]} />);
    expect(screen.getByText('Écritures du grand livre')).toBeTruthy();
    expect(screen.getByText('107')).toBeTruthy();
    expect(screen.getByText('1 au-delà de 48 h')).toBeTruthy();
    expect(screen.getByText('Soldes des comptes — USD')).toBeTruthy();
    expect(screen.getByText('Soldes des comptes — CDF')).toBeTruthy();
    expect(screen.getByText('Suspens par ancienneté')).toBeTruthy();
    const card = screen.getByText('Soldes des comptes — USD').closest('section')!;
    fireEvent.click(within(card).getByRole('button', { name: /Tableau|Vue tableau/ }));
    expect(within(card).getByRole('table')).toBeTruthy();
  });
  it('rôle sans accès au grand livre : tuile « non mesurée » avec motif, pas de faux zéro', () => {
    wrap(<TresorSynthese balance={null} overview={null} suspense={null} imports={null} />);
    expect(screen.getAllByText('Non mesuré').length).toBeGreaterThan(0);
    expect(screen.getByText('Grand livre non lisible pour ce rôle.')).toBeTruthy();
  });
  it('files d’exception vides : état « Aucune donnée »', () => {
    wrap(<ExceptionsVisuel list={{ items: [], queues: [{ queue: 'ECART_MONTANT', open: 0, inProgress: 0, closed: 0, overdue: 0 }], slaHours: 48 }} />);
    expect(screen.getByText('Exceptions par file')).toBeTruthy();
    expect(screen.getAllByText(/Aucune (exception|donnée)/).length).toBeGreaterThan(0);
  });
  it('points agréés : carte des 24 communes et contrats par état', () => {
    wrap(<PointsAgreesVisuel board={{ points: [{ pointId: 'P1', name: 'Guichet Limete', commune: 'Limete', contractStatus: 'ACTE_REQUIS' }], late: [], penalties: [] }} />);
    expect(screen.getByText('Points agréés par commune')).toBeTruthy();
    expect(screen.getByText('Contrats des points')).toBeTruthy();
    expect(screen.getAllByText('Contrat : acte requis').length).toBeGreaterThan(0);
  });
  it('file de recouvrement : balance âgée par devise, profil de risque, jauges sans cible', () => {
    wrap(<RecouvrementVisuel
      items={[{ obligationId: 'O1', commune: 'Lemba', amount: usd('50.00'), segment: { code: 'OUBLI', label: 'Oubli', approach: '', reasons: [] }, risk: { level: 'FAIBLE', score: 1, factors: [] } } as never]}
      balance={{ count: 1, total: { USD: '50.00' }, byBand: { B1: { USD: '50.00' } }, byCategory: {}, byCommune: {}, bySegment: { OUBLI: 1 }, bands: [{ code: 'B1', label: '0 à 30 j' }] }}
      indicators={{ cases: { open: 1, regularised: 0, classed: 0 }, proposals: { pending: 0, approved: 0, rejected: 0 }, notices: { issued: 0, read: 0, undelivered: 0 }, plans: { requested: 0, active: 0, defaulted: 0 }, regularisationRate: '0 %' }}
      plans={[]} />);
    expect(screen.getByText('Balance âgée — USD')).toBeTruthy();
    expect(screen.getByText('Faible')).toBeTruthy();
    expect(screen.getByText('Taux de régularisation des dossiers')).toBeTruthy();
    expect(screen.getAllByText(/aucun avis notifié/).length).toBeGreaterThan(0);
  });
  it('non-valeurs vides : état vide sans graphique de montants', () => {
    wrap(<NonValeursVisuel writeOffs={[]} />);
    expect(screen.getByText('Admissions en non-valeur par état')).toBeTruthy();
    expect(screen.queryByText(/Montants proposés et admis/)).toBeNull();
  });
  it('jour de caisse : attendu / compté / versé par devise, ruban EXEMPLE', () => {
    wrap(<CaisseVisuel cd={{ status: 'CLOTUREE', expected: [cdf('9000.00')], counted: [cdf('9000.00')], reconciledCount: 1, exceptions: [], deposit: null, collections: [{ id: 'C1', amount: cdf('9000.00'), collectedAt: '2026-09-27T08:00:00Z', receiptStatus: 'DEFINITIVE' }] }} />);
    expect(screen.getByText('Attendu, compté, versé — CDF')).toBeTruthy();
    expect(screen.getByText('Encaissements par heure (Kinshasa)')).toBeTruthy();
    expect(screen.getAllByText(/EXEMPLE/).length).toBeGreaterThan(0);
  });
  it('où payer et enrôlement : chiffres du réseau et dossiers par état', () => {
    wrap(<>
      <OuPayerVisuel points={[{ id: 'P1', type: 'GUICHET_BANCAIRE_MOSOLO', commune: 'Gombe', status: 'ACTIF', demo: true }, { id: 'P2', type: 'AGENT_MONNAIE_MOBILE', commune: 'Limete', status: 'SUSPENDU', demo: true }]} guichets={[{ commune: 'Gombe' }]} />
      <EnrolementVisuel list={[{ id: 'E1', status: 'A_REVOIR', commune: 'Limete', channel: 'DOMICILE', receivedAt: '2026-09-27T08:00:00Z', person: { language: 'ln' } }]} queued={2} />
    </>);
    expect(screen.getByText('Points ouverts par commune')).toBeTruthy();
    expect(screen.getByText('1 suspendu(s)')).toBeTruthy();
    expect(screen.getByText('Dossiers par état')).toBeTruthy();
    expect(screen.getByText('En file locale')).toBeTruthy();
  });
  it('pilotage RakaPay : jauge du paiement numérique avec la cible servie, estimations marquées EXEMPLE', () => {
    wrap(<PilotageVisuel d={{
      coverage: { byStation: [{ stationId: 'S1', name: 'Station Victoire', registered: 2, estimated: 180, green: 1 }], byCommune: [{ commune: 'Kalamu', registered: 2, estimated: 180, green: 1 }] },
      compliance: { controlled: 2, green: 1, rate: '0.5', constats: { total: 1, open: 1, classified: 0, transmitted: 0 } },
      digitalPayment: { passesIssued: 2, paidDigitally: 2, rate: '1', target: '100 %', byChannel: { USSD: 1, MOBILE_MONEY: 1 } },
      complaints: { total: 0, open: 0, closed: 0, byCommune: [] }, tickets: { sold: 1, active: 1, controls: 0, reuseAttempts: 0 },
      revenueByCommune: [{ commune: 'Kalamu', amounts: [cdf('13000.00')] }],
    }} />);
    expect(screen.getByText('Paiement numérique des pass')).toBeTruthy();
    expect(screen.getByText('Cible atteinte')).toBeTruthy();
    expect(screen.getByText('Recette confirmée par commune — CDF')).toBeTruthy();
    expect(screen.getAllByText(/EXEMPLE/).length).toBeGreaterThan(0);
  });
  it('titres : catalogue par statut d’acte et constats par état', () => {
    wrap(<>
      <CatalogueVisuel types={[{ code: 'A', module: '81', moduleLabel: 'Wewa', activable: true, legalAct: { status: 'DEMONSTRATION' }, supports: ['TELEPHONE'] }, { code: 'B', module: '70', moduleLabel: 'Vignette', activable: false, legalAct: { status: 'ACTE_REQUIS' }, supports: ['PAPIER'] }]} />
      <ConstatsVisuel constats={[{ id: 'K1', status: 'OUVERT', reason: 'Pass expiré', at: '2026-09-27T08:00:00Z' }]} />
    </>);
    expect(screen.getByText('Types de titres par statut de l’acte')).toBeTruthy();
    expect(screen.getByText('Constats par état')).toBeTruthy();
    expect(screen.getAllByText('À instruire').length).toBeGreaterThan(0);
  });
  it('frise vide : état « Aucune donnée », sans plantage (correctif TimelineStrip)', () => {
    wrap(<>
      <TimelineStrip title="Échéances" categories={['Échéance']} events={[]} />
      <MesArrieresVisuel mine={{ arrears: [], upcoming: [], notices: [], plans: [] }} appeals={0} />
    </>);
    expect(screen.getAllByText('Aucune donnée pour cette période').length).toBeGreaterThan(0);
    expect(screen.getByText('Aucune échéance à venir.')).toBeTruthy();
  });
});
