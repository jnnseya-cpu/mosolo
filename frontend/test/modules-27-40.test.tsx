/**
 * Écrans des modules 27 à 40 (spécification fonctionnelle) : relevés à double validation (29), campagnes de
 * recouvrement (33), inspection hors ligne (35), gestion documentaire (38), notifications (39), renseignement
 * anti-fraude (40), indicateurs des modules 27 à 40.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppProvider } from '../src/context';
import { ImportsRelevesView, type StatementImport } from '../src/modules/tresor/ImportsReleves';
import CampagnesRecouvrement, { type RecoveryCampaignView } from '../src/modules/recouvrement/CampagnesRecouvrement';
import Inspection, { readPackage, type OfflinePackage } from '../src/modules/terrain/Inspection';
import Documents, { type DocView } from '../src/modules/documents/Documents';
import { IndicatorsView, type CommIndicators } from '../src/modules/communication/Notifications';
import Renseignement, { ScoreCard, type ScoreItem } from '../src/modules/integrite/Renseignement';
import { ModulesTable, type ModulesResponse } from '../src/modules/pilotage/IndicateursModules2740';

const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } }));
function mockApi(user: { id: string; roles: string[] }, routes: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    if (String(url).includes('/v1/demo/users')) return json([{ ...user, name: `${user.id} (démo)`, entity: 'TEST' }]);
    const hit = Object.entries(routes).sort((a, b) => b[0].length - a[0].length).find(([k]) => String(url).includes(k));
    if (!hit) return Promise.reject(new TypeError('Failed to fetch'));
    return json(hit[1]);
  }) as unknown as typeof fetch;
  localStorage.removeItem('mosolo.demoUser');
  return calls;
}
const renderApp = (el: JSX.Element) => render(<AppProvider initialLang="fr">{el}</AppProvider>);
const USD = (amount: string) => ({ amount, currency: 'USD' as const });

describe('Modules 27 à 40 — écrans', () => {
  it('module 29 : import proposé, intégrité affichée, le proposant ne valide pas ; fonds en attente', async () => {
    mockApi({ id: 'u-tresor', roles: ['R17'] }, {});
    const imp: StatementImport = {
      id: 'IMP-REL-000001', statementId: 'REL-1', fingerprint: 'a'.repeat(64), lines: 2, status: 'EN_ATTENTE_VALIDATION',
      integrity: { ok: true, checks: [{ code: 'TOTAUX_CONTROLE', ok: true, blocking: true, detail: 'Totaux égaux.' }], totals: [USD('300.00')] },
      proposedBy: 'u-analyste-rappro', proposedAt: '2026-09-26T09:00:00.000Z',
    };
    renderApp(<ImportsRelevesView imports={[imp, { ...imp, id: 'IMP-2', statementId: 'REL-2', proposedBy: 'u-tresor' }]} indicators={{ delaiReglement: { statut: 'NON_MESURE', motif: 'Aucun paiement réglé.' }, imports: { enAttente: 2, valides: 0, rejetes: 0, integriteKo: 0 } }}
      suspense={{ open: 1, totals: [USD('40.00')] }} userId="u-tresor" canPropose canValidate onChanged={() => undefined} />);
    expect(screen.getByText('40.00 USD')).toBeTruthy();
    expect(screen.getAllByText(/Totaux égaux/)).toHaveLength(2);
    expect(screen.getByText(/Vous avez proposé cet import/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Valider et appliquer' })).toHaveLength(1);
  });

  it('module 33 : campagne en test, mesure (régularisation, coût par franc), arrêt proposé soumis à décision humaine', async () => {
    const c: RecoveryCampaignView = {
      id: 'CREC-000001', code: 'CREC-LEMBA-01', label: 'Relances Lemba', entity: 'DGIPK', communes: ['Lemba'], segments: ['RETARD', 'CONFORME'], channels: ['SMS', 'APPEL'], status: 'EN_TEST', createdBy: 'u-dg-dgipk',
      sequence: [{ code: 'J-15', offsetDays: -15, action: 'RAPPEL_AMIABLE', channels: ['SMS'], segments: ['CONFORME'], label: 'Rappel J-15' }], sequenceStatus: 'PAR DÉFAUT — à confirmer',
      testSharePct: 50, controlSharePct: 20, targets: [], excluded: [], contacts: [{ id: 'CCT-1', ref: 'OBL-1', step: 'J-15', channel: 'SMS', outcome: 'ENVOYE', at: '2026-09-26T09:00:00.000Z' }], visits: [],
      measures: [{ at: '2026-09-27T09:00:00.000Z', test: { targets: 4, regularised: 2, regularisationRate: '50 %', paying: 2, gross: { USD: '100.00' } }, control: { targets: 2, regularised: 0, regularisationRate: '0 %', paying: 0, gross: {} },
        cost: { USD: '150.00' }, costMeasured: true, gross: { USD: '100.00' }, net: { USD: '-50.00' }, costPerFranc: { byCurrency: { USD: '1.5000' }, cdfEquivalent: '1.5000', statut: 'MESURE', detail: 'Coût total / récupération brute.' }, stopSignals: [{ code: 'COUT_DISPROPORTIONNE', detail: 'Coût ≥ récupération : arrêt à examiner.' }] }],
      stopProposal: { reasons: ['Coût ≥ récupération : arrêt à examiner.'] },
      summary: { targets: 6, bySegment: { RETARD: 6 }, byGroup: { TEST: 4, TEMOIN: 2, RESERVE: 0 }, excluded: 1, contacts: 1, visitsToDo: 0 },
    };
    mockApi({ id: 'u-ministre-finances', roles: ['R05'] }, { '/v1/campagnes-recouvrement': [c] });
    renderApp(<CampagnesRecouvrement />);
    expect(await screen.findByText('Relances Lemba')).toBeTruthy();
    expect(screen.getByText('50 %')).toBeTruthy();
    expect(screen.getAllByText('1.5000').length).toBeGreaterThan(0);
    expect(screen.getByText(/Arrêt proposé par le système/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Arrêter la campagne' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Poursuivre (motivé)' })).toBeTruthy();
  });

  it('module 35 : paquet hors ligne conservé sur le terminal et consultable sans réseau', async () => {
    const pkg: OfflinePackage = {
      mission: { id: 'MIS-LIM-014', title: 'Recensement', commune: 'Limete', dueDate: '2026-10-10', toleranceM: 50 },
      dossiers: [{ id: 'DINS-000001', objectId: 'OBJ-DEMO-UNITE-01', version: 1, contentHash: 'c'.repeat(64), content: { object: { id: 'OBJ-DEMO-UNITE-01', category: 'UNITE_LOCATIVE', commune: 'Limete', quartier: 'Kingabwa', lat: -4.37, lon: 15.34 }, holder: { nameMasked: 'N**** M******' }, situation: { label: 'Obligation(s) à venir', openAppeal: false }, lastFindings: [], checklist: ['Présenter le badge vérifiable ; ne jamais demander ni recevoir d’argent.'] } }],
      itinerary: [{ order: 1, objectId: 'OBJ-DEMO-UNITE-01', legM: 120, cumulativeM: 120 }],
      templates: [], powers: ['CONSTAT_OBJET'], issuedAt: '2026-09-26T09:00:00.000Z', validUntil: '2026-10-10T23:59:59.000+01:00', packageHash: 'd'.repeat(64), signature: 'e'.repeat(64),
    };
    localStorage.setItem('mosolo.inspection.paquet.MIS-LIM-014', JSON.stringify(pkg));
    expect(readPackage('MIS-LIM-014')?.dossiers).toHaveLength(1);
    mockApi({ id: 'u-agent-terrain', roles: ['R10'] }, { '/v1/terrain/missions': { items: [{ id: 'MIS-LIM-014', title: 'Recensement', commune: 'Limete', status: 'EN_COURS' }] }, '/v1/terrain/proces-verbaux': [], '/v1/terrain/inspection/indicateurs': { constats: { total: 1, soumis: 1, valides: 0, rejetes: 0, horsZone: 0 }, tauxValidation: { statut: 'NON_MESURE', motif: 'Aucun constat revu.' }, procesVerbaux: { total: 0, transmis: 0, valides: 0, rejetes: 0, tauxValidation: null, refusDeSigner: 0 }, contestations: { total: 0, traitees: 0 } } });
    renderApp(<Inspection />);
    const select = await screen.findByLabelText('Mission');
    await screen.findByRole('option', { name: /MIS-LIM-014/ });
    fireEvent.change(select, { target: { value: 'MIS-LIM-014' } });
    expect(await screen.findByText(/ne jamais demander ni recevoir d’argent/)).toBeTruthy();
    expect(screen.getByText(/Itinéraire : 1\. OBJ-DEMO-UNITE-01/)).toBeTruthy();
    expect(screen.getByText(/N\*\*\*\* M\*\*\*\*\*\*/)).toBeTruthy();
  });

  it('module 38 : volume stocké, intégrité vérifiée, classification proposée à confirmer', async () => {
    const doc: DocView = {
      id: 'DOC-00000001', title: 'Bail de l’unité 01', category: 'BAIL', categoryLabel: 'Contrat de bail', status: 'ACTIF', auditProof: false, currentVersion: 1, createdBy: 'u-guichet',
      classification: { status: 'PROPOSEE', proposal: { category: 'BAIL', confidence: 'ELEVEE', matched: ['bail', 'bailleur', 'loyer'], method: 'Mots-clés par catégorie.' } },
      retention: { status: 'DUREE_NON_FIXEE', detail: 'Durée de conservation non fixée (registre des seuils) : aucune purge.', until: null },
      versions: [{ id: 'DOCV-1', version: 1, fileName: 'bail.txt', contentType: 'text/plain', size: 90, sha256: 'f'.repeat(64), seal: '9'.repeat(64), encrypted: true, ocr: { source: 'TEXTE_NATIF', chars: 90, excerpt: 'Contrat de bail' }, uploadedAt: '2026-09-26T09:00:00.000Z' }],
    };
    mockApi({ id: 'u-controleur', roles: ['R11'] }, {
      '/v1/documents/indicateurs': { volume: { documents: 1, actifs: 1, purges: 0, versions: 1, octets: 90, byCategory: {} }, classification: { proposees: 1, confirmees: 0 }, integrite: { statut: 'MESURE', derniereVerification: '2026-09-26T09:00:00.000Z', verifiees: 1, conformes: 1, ecarts: 0 }, chiffrement: { algorithme: 'AES-256-GCM', raccordement: '[À RACCORDER — convention requise] HSM' } },
      '/v1/documents/categories': [{ code: 'BAIL', label: 'Contrat de bail', auditProof: false }],
      '/v1/documents': [doc],
    });
    renderApp(<Documents />);
    expect(await screen.findByText('Bail de l’unité 01')).toBeTruthy();
    expect(screen.getByText('1/1')).toBeTruthy();
    expect(screen.getByText(/mots reconnus : bail, bailleur, loyer/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirmer la classification' })).toBeTruthy();
    expect(screen.getByText(/À RACCORDER/)).toBeTruthy();
  });

  it('module 39 : indicateurs de délivrance, délai, ouverture ; module 40 : score explicable ; indicateurs 27–40', async () => {
    mockApi({ id: 'u-dg-dgipk', roles: ['R06'] }, {});
    const ind: CommIndicators = {
      delivrance: { statut: 'MESURE', taux: '75 %', delivres: 3, mesurables: 4 }, delai: { statut: 'MESURE', medianeMinutes: 2 },
      ouverture: { messages: { statut: 'MESURE', taux: '33.3 %' }, avisLegaux: { statut: 'NON_MESURE', motif: 'Aucun avis légal émis.' } },
      bacASable: 5, avisPlaque: { aApposer: 1, apposes: 0 }, modeles: { actifs: 1, brouillons: 0 }, raccordement: '[À RACCORDER — convention requise] agrégateur SMS',
    };
    renderApp(<IndicatorsView d={ind} />);
    expect(screen.getByText('75 %')).toBeTruthy();
    expect(screen.getByText('2 min')).toBeTruthy();
    expect(screen.getByText(/non mesuré — Aucun avis légal émis/)).toBeTruthy();
    const s: ScoreItem = {
      id: 'ALR-1', alertId: 'ALR-1', ruleLabel: 'Réutilisation d’un appareil entre comptes', status: 'A_EXAMINER', raisedAt: '2026-09-26T09:00:00.000Z', score: 56, band: 'MOYEN', confidence: 'MOYENNE',
      factors: [{ factor: 'Gravité', value: 'ELEVEE', contribution: '75 points', source: 'règle' }, { factor: 'Confiance', value: 'MOYENNE', contribution: '× 0.75', source: 'règle' }],
      variables: [{ name: 'Terminal', value: 'dev-partage-01', source: 'terminaux enrôlés' }], method: 'Score = gravité × confiance. Il ordonne l’examen ; il ne vaut ni preuve ni décision.',
    };
    renderApp(<ul><ScoreCard s={s} /></ul>);
    expect(screen.getByText('Score 56/100')).toBeTruthy();
    expect(screen.getByText(/source : terminaux enrôlés/)).toBeTruthy();
    const data: ModulesResponse = { asOf: '2026-09-26', mesures: 1, nonMesures: 1, modules: [{ module: 27, titre: 'Déclaration et liquidation', indicateurs: [
      { code: 'M27_OBLIGATIONS_EMISES', libelle: 'Obligations émises', statut: 'MESURE', valeur: '12', detail: '12 obligations.', source: 'registre' },
      { code: 'M27_DELAI_LIQUIDATION', libelle: 'Délai de liquidation', statut: 'NON_MESURE', valeur: null, detail: 'Aucune déclaration liquidée.', source: 'déclarations' },
    ] }] };
    renderApp(<ModulesTable data={data} />);
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getAllByText('Non mesuré').length).toBeGreaterThan(0);
  });

  it('module 40 : suspension proposée visible au responsable sécurité, exécution motivée', async () => {
    const calls = mockApi({ id: 'u-rssi', roles: ['R28'] }, {
      '/v1/integrite/scores': { items: [] },
      '/v1/integrite/suspensions-conservatoires': [{ id: 'SUSP-000001', caseId: 'DOS-1', userId: 'u-agent-terrain-2', reason: 'Mesure conservatoire pendant l’instruction du dossier', days: 5, status: 'PROPOSEE', proposedBy: 'u-enqueteur' }],
      '/v1/integrite/renseignement/indicateurs': { alertes: { ouvertes: 2, resolues: 1 }, delaiInstruction: { statut: 'NON_MESURE', motif: 'Aucun dossier décidé.' }, deperditionEvitee: { statut: 'NON_MESURE', motif: 'Aucune déperdition évitée constatée.' }, suspensions: { enVigueur: 0, proposees: 1 }, transmissions: { total: 0, accusees: 0 }, signalementsCitoyens: 3 },
    });
    renderApp(<Renseignement />);
    expect(await screen.findByText(/u-agent-terrain-2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Exécuter' }));
    fireEvent.change(screen.getByLabelText(/Motif/), { target: { value: 'Mesure conservatoire exécutée' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suspendre l’accès (conservatoire)' }));
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('/v1/integrite/suspensions-conservatoires/SUSP-000001/decision') && c.init?.method === 'POST')).toBe(true));
  });
});
