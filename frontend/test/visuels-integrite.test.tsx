/**
 * Visuels du périmètre « intégrité, accès, IA, socle, plateforme, documents, communication, preuves » (27/09/2026) :
 * les graphiques se rendent avec des données, affichent l'état vide, offrent la vue tableau, ne dessinent jamais un
 * « non mesuré » à zéro, et les indicateurs de module deviennent des tuiles (le détail d'origine reste consultable).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import { etatsDe, IndicateursVisuels, nombreDe, serieParJour } from '../src/modules/plateforme/visuels';
import { CollusionVisuels, ConsoleVisuels, SeuilsVisuels, SurveillanceVisuels } from '../src/modules/integrite/visuels';
import { ArbitragesVisuels, circuitArbitrage, EtapesInvitation } from '../src/modules/acces/visuels';
import { BoiteVisuels } from '../src/modules/ia/visuels';
import { ExtractionsVisuels } from '../src/modules/socle/visuels';
import { DocumentsVisuels } from '../src/modules/documents/visuels';
import { CommunicationVisuels } from '../src/modules/communication/visuels';
import { SupervisionVisuels } from '../src/modules/plateforme/visuelsPlateforme';
import type { Arbitration } from '../src/modules/acces/common';
import type { IaRec } from '../src/modules/ia/types';

function wrap(ui: ReactElement) {
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
  return render(<AppProvider initialLang="fr"><MemoryRouter>{ui}</MemoryRouter></AppProvider>);
}
afterEach(() => { localStorage.clear(); });
if (typeof globalThis.ResizeObserver === 'undefined') {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
}
const now = new Date().toISOString();

describe('agrégations communes', () => {
  it('etatsDe liste tout le circuit dans l’ordre, y compris les états à zéro', () => {
    const items = etatsDe([{ s: 'B' }, { s: 'B' }, { s: 'X' }], (i) => i.s, { A: ['État A', 'warning'], B: { label: 'État B', tone: 'good' } }, ['A', 'B']);
    expect(items.map((i) => [i.key, i.label, i.count])).toEqual([['A', 'État A', 0], ['B', 'État B', 2], ['X', 'X', 1]]);
  });
  it('serieParJour comble les jours vides et compte les éléments hors fenêtre', () => {
    const s = serieParJour([{ at: now }, { at: now }, { at: '2020-01-01T10:00:00Z' }], (i) => i.at, 14);
    expect(s.values).toHaveLength(14);
    expect(s.values[13]).toBe(2);
    expect(s.dansFenetre).toBe(2);
    expect(s.total).toBe(3);
  });
  it('nombreDe lit les valeurs servies en texte français, sinon null (jamais zéro)', () => {
    expect(nombreDe('97,5 %')).toBe(97.5);
    expect(nombreDe('1 234')).toBe(1234);
    expect(nombreDe(null)).toBeNull();
    expect(nombreDe('non mesuré')).toBeNull();
  });
});

describe('indicateurs de module en tuiles', () => {
  it('valeur, état, jauge si cible servie, non mesuré avec motif ; détail d’origine replié', () => {
    wrap(<IndicateursVisuels items={[
      { code: 'A', label: 'Disponibilité', measured: true, value: '99,95', unit: '%', target: '99.9', meetsTarget: true },
      { code: 'B', label: 'Délai de rétablissement', measured: false, value: null, reason: 'Aucun incident rétabli.' },
    ]} />);
    expect(screen.getByRole('article', { name: /Disponibilité : [0-9,]+ % — Cible atteinte/ })).toBeTruthy();
    expect(screen.getByRole('article', { name: /Délai de rétablissement : Non mesuré/ })).toBeTruthy();
    expect(screen.getAllByText('Aucun incident rétabli.').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('meter').length).toBeGreaterThan(0);
    expect(screen.getByText(/Détail des indicateurs/)).toBeTruthy();
  });
});

describe('intégrité', () => {
  it('console : tuiles, états des files, vue tableau', () => {
    wrap(<ConsoleVisuels
      ind={{ signalements: { total: 3, ouverts: 2, enRetard: 1, delaiMoyenJours: null, partConfirmee: null, parCanal: { WEB: 2, SMS: 1 }, parCategorie: { FAUX_AGENT: 3 } }, alertes: { ouvertes: 4, classees: 0, versDossier: 1 }, dossiers: { ouverts: 1, decides: 0, delaiInstructionMoyenJours: null } }}
      reports={[{ status: 'RECU', receivedAt: now, commune: 'Gombe', category: 'FAUX_AGENT', channel: 'WEB', overdue: false, demo: true }, { status: 'CLOS', receivedAt: now, commune: 'Limete', category: 'FAUX_AGENT', channel: 'SMS', overdue: true, demo: true }]}
      alerts={[{ status: 'A_EXAMINER', severity: 'ELEVEE', raisedAt: now, ruleLabel: 'R' }]} cases={[{ status: 'OUVERT', openedAt: now }]} />);
    expect(screen.getByRole('article', { name: /Signalements ouverts : 2/ })).toBeTruthy();
    expect(screen.getByRole('article', { name: /Délai moyen de traitement : Non mesuré/ })).toBeTruthy();
    const etats = screen.getByRole('group', { name: /Signalements par état : Reçu 1 \(50 %\), Qualifié 0/ });
    expect(etats).toBeTruthy();
    expect(screen.getAllByText('EXEMPLE — non opposable').length).toBeGreaterThan(0);
    fireEvent.click(within(screen.getByRole('heading', { name: 'Alertes par état' }).closest('.chart-card, .viz-card, section, article, div')!.parentElement!).getAllByRole('button', { name: /Vue tableau|Tableau/ })[0]!);
    expect(screen.getAllByRole('table').length).toBeGreaterThan(0);
  });
  it('collusion : seuil du registre en référence, part des refus non mesurée sans décision', () => {
    wrap(<CollusionVisuels r={{ params: { pairShareMinPct: 60, statut: 'PAR_DEFAUT — à confirmer', rotationMaxPerPair: 5, rotationWindowDays: 30 }, circuits: [], totals: { decisions: 0, approvals: 0, refusals: 0, pairs: 0 }, pairs: [], approvers: [], findings: [] }} />);
    expect(screen.getByText('Aucun signal sur la période')).toBeTruthy();
    expect(screen.getAllByText(/Aucune décision à deux personnes sur la période/)[0]).toBeTruthy();
  });
  it('seuils : progression des paramètres confirmés et statuts', () => {
    wrap(<SeuilsVisuels reg={{ entries: [{ category: 'Terrain', status: 'PAR_DEFAUT' }, { category: 'Terrain', status: 'CONFIRME' }], summary: { total: 2, parDefaut: 1, confirmes: 1, modifiesAConfirmer: 0 }, requests: [] }} />);
    expect(screen.getByRole('meter', { name: /Paramètres confirmés par un acte/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: /Paramètres par statut : Par défaut — à confirmer 1/ })).toBeTruthy();
  });
  it('surveillance : plafond non fixé jamais dessiné à zéro', () => {
    wrap(<SurveillanceVisuels devices={{ items: [] }} gps={{ items: [], maxKmh: 150 }} ceilings={{ day: '2026-09-27', channels: [{ channel: 'USSD', today: 3, alertPerDay: 0, maxPerDay: 0 }] }} />);
    expect(screen.getByText('Aucun déplacement implausible')).toBeTruthy();
    expect(screen.getByText(/non fixé » : aucune barre/)).toBeTruthy();
  });
});

describe('accès, IA, socle, documents, communication, plateforme', () => {
  it('arbitrages : comptes par marche du circuit', () => {
    const a = (status: Arbitration['status'], extra: Partial<Arbitration> = {}): Arbitration => ({ id: status, kind: 'FAIT_GENERATEUR', subject: { factCode: 'VEHICULE' }, claimants: [], status, openedAt: now, openedBy: 'x', existingObligationIds: [], ...extra });
    const items = [a('OUVERT'), a('INSTRUIT', { opinion: { by: 'j', at: now, text: 'avis' } }), a('DECIDE', { opinion: { by: 'j', at: now, text: 'avis' }, decision: { by: 'g', at: now, winnerEntity: 'E', motif: 'm', actReference: 'A', rectificationRequired: true } })];
    expect(circuitArbitrage(items)).toEqual({ bloques: 3, avis: 2, decides: 1, rectifications: 1 });
    wrap(<ArbitragesVisuels items={items} />);
    expect(screen.getByRole('group', { name: /Dossiers d’arbitrage par état : Ouvert 1/ })).toBeTruthy();
  });
  it('finalisation d’invitation : progression des étapes remplies', () => {
    wrap(<EtapesInvitation f={{ phone: '+243810000001', code: '123456', docNumber: '', photo: false, mfa: 'PASSKEY' }} />);
    expect(screen.getByRole('meter', { name: /Étapes de finalisation remplies/ }).getAttribute('aria-valuenow')).toBe('3');
  });
  it('IA : répartition par état et par niveau ; état vide', () => {
    const rec = (status: IaRec['status']) => ({ id: status, agentCode: 'A', agent: 'Agent A', autonomy: 'C_RECOMMANDATION', status, createdAt: now, example: true, actions: [] }) as unknown as IaRec;
    wrap(<BoiteVisuels recs={[rec('EMISE'), rec('ACCEPTEE'), rec('REJETEE')]} />);
    expect(screen.getByRole('group', { name: /Recommandations par état : À décider 1/ })).toBeTruthy();
    expect(screen.getByRole('meter', { name: /retenues/ }).getAttribute('aria-valuenow')).toBe('50');
  });
  it('extractions : seuil servi par le registre marqué « par défaut — à confirmer »', () => {
    wrap(<ExtractionsVisuels items={[]} threshold={5000} statuts={{ DEMANDEE: ['Visa attendu', 'warning'] }} />);
    expect(screen.getAllByText('Aucune demande d’extraction massive').length).toBe(2);
  });
  it('documents : intégrité non mesurée avec motif', () => {
    wrap(<DocumentsVisuels labels={{ BAIL: 'Bail' }} docs={[]} ind={{ volume: { documents: 1, actifs: 1, purges: 0, versions: 1, octets: 2048, byCategory: { BAIL: { documents: 1, bytes: 2048 } } }, classification: { proposees: 1, confirmees: 0 }, integrite: { statut: 'NON_MESURE', motif: 'Aucun contrôle exécuté.' } }} />);
    expect(screen.getByRole('article', { name: /Écarts d’intégrité : Non mesuré/ })).toBeTruthy();
    expect(screen.getAllByText('Aucun contrôle exécuté.').length).toBeGreaterThan(0);
  });
  it('communication : taux non mesurés, jamais inventés', () => {
    const nm = { statut: 'NON_MESURE', motif: 'Aucun accusé fournisseur.' };
    wrap(<CommunicationVisuels d={{ delivrance: nm, delai: nm, ouverture: { messages: nm, avisLegaux: nm }, bacASable: 4, avisPlaque: { aApposer: 1, apposes: 0 }, modeles: { actifs: 0, brouillons: 0 }, raccordement: 'bac à sable' }} />);
    expect(screen.getByRole('article', { name: /Taux de délivrance : Non mesuré/ })).toBeTruthy();
    expect(screen.getByText('Aucun modèle : texte par défaut du catalogue')).toBeTruthy();
  });
  it('supervision : disponibilité comparée à la cible servie, latence (baisse favorable)', () => {
    wrap(<SupervisionVisuels d={{ targets: { availabilityPct: '99.9', source: 'Cahier § 28.6' }, thresholds: { latencyP95Ms: 2000, status: 'PAR_DEFAUT' }, window15: { requests: 10, errors5xx: 0, availabilityPct: '100', p95Ms: 12 }, routes: [], incidents: [] }} />);
    expect(screen.getByRole('meter', { name: /Disponibilité/ }).getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getAllByText('Cible atteinte').length).toBe(2);
  });
});
