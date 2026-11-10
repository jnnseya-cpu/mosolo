import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import { setDemoUser } from '../src/lib/api';
import Recettes from '../src/modules/referentiel/Recettes';
import TitresCatalogue from '../src/modules/titres/Catalogue';
import Secteurs from '../src/modules/verticales/Secteurs';
import AdSignaler from '../src/modules/publicite/AdSignaler';
import Operateurs from '../src/modules/rakapay/Operateurs';
import AdCarte from '../src/modules/publicite/AdCarte';

type Handler = unknown | ((init?: RequestInit) => unknown);
function mockApi(routes: Record<string, Handler>, users: unknown[] = []) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/v1/demo/users')) return Promise.resolve(new Response(JSON.stringify(users), { status: 200, headers: { 'content-type': 'application/json' } }));
    const path = Object.keys(routes).find((p) => url.split('?')[0]!.endsWith(p));
    if (!path) return Promise.resolve(new Response(JSON.stringify({ title: 'Introuvable', status: 404 }), { status: 404, headers: { 'content-type': 'application/json' } }));
    const h = routes[path];
    const body = typeof h === 'function' ? (h as (i?: RequestInit) => unknown)(init) : h;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
  return calls;
}
const wrap = (ui: JSX.Element) => render(<AppProvider initialLang="fr"><MemoryRouter>{ui}</MemoryRouter></AppProvider>);

const line = (code: string, section: string, label: string, extra: Record<string, unknown> = {}) => ({
  code, section, label, object: 'Objet', liableWhere: 'non renseigné', capture: 'Capture', yield: 'Élevé', competence: 'PROVINCIALE', competenceLabel: 'Recette exclusivement provinciale',
  revenueCategory: 'IMPOT_PROVINCIAL', status: 'A_VERIFIER', space: 'PROVINCIAL', provincialScope: true, modules: [7], codeStatus: 'ACTIF',
  activation: { activable: false, reasons: ['Ligne au statut A_VERIFIER : base légale à certifier (chapitre 6).'] }, ...extra,
});

afterEach(() => { setDemoUser(null); localStorage.clear(); });

describe('Référentiel des recettes (ch. 7)', () => {
  it('affiche les sections, le statut « à vérifier », l’IPM hors périmètre et les recettes administratives rattachées', async () => {
    mockApi({
      '/v1/public/referentiel/recettes': {
        items: [
          line('R71-IF', '7.1', 'Impôt foncier (bâti et non bâti)'),
          line('R72-TSCR', '7.2', 'Taxe spéciale de circulation routière', { competence: 'INTERET_COMMUN_CLE', competenceLabel: 'Recette d’intérêt commun avec clé de répartition', sharingKey: 'Clé de répartition non renseignée — à certifier (chapitre 6)' }),
          line('ETD-IPM', '6.3', 'Impôt personnel minimum (ancien IPM)', { competence: 'ETD', space: 'COMMUNAL', provincialScope: false }),
        ],
        administrative: [{ code: 'R75-QUITUS-FISCAL', label: 'Délivrance du quitus fiscal numérique', nature: 'ACTE', linkedTo: { kind: 'PRESTATION', ref: 'fiscal:clearances', label: 'Quitus fiscal' }, status: 'A_VERIFIER', linkResolved: true }],
        spaces: [{ id: 'PROVINCIAL', label: 'Espace des recettes provinciales', active: true, note: '' }, { id: 'COMMUNAL', label: 'Espace des recettes communales (distinct)', active: false, note: 'Non activé.' }],
        notice: 'Toutes les lignes sont au statut A_VERIFIER.',
      },
    });
    wrap(<Recettes />);
    expect(await screen.findByText('Impôt foncier (bâti et non bâti)')).toBeTruthy();
    expect(screen.getByText('§ 7.2 — Taxes d’intérêt commun')).toBeTruthy();
    expect(screen.getByText(/Clé de répartition non renseignée/)).toBeTruthy();
    expect(screen.getByText('Espace communal — non activé')).toBeTruthy();
    expect(screen.getByText('Délivrance du quitus fiscal numérique')).toBeTruthy();
    expect(screen.getAllByText('À vérifier').length).toBeGreaterThan(2);
    expect(screen.queryByText(/%/)).toBeNull();
  });
});

describe('Catalogue des titres § 19A.4', () => {
  it('montre les types « acte requis » sans tarif', async () => {
    mockApi({ '/v1/titres/types': [{ code: 'VIG-ANNUELLE', module: '11', moduleLabel: 'Véhicules et circulation', label: 'Vignette automobile (impôt sur les véhicules automoteurs)', prefix: 'VIG', plateBound: true, supports: ['AUTOCOLLANT'], demo: false, validity: { modelLabel: 'Annuel / exercice', modelRule: 'Exercice fiscal' }, legalAct: { ref: 'J3', status: 'ACTE_REQUIS', note: '' }, activable: false, notActivableReason: 'Acte requis (J3) : type non activable.', price: { amount: null, demo: false } }] });
    wrap(<TitresCatalogue />);
    expect(await screen.findByText(/Vignette automobile/)).toBeTruthy();
    expect(screen.getByText('Acte requis (J3)')).toBeTruthy();
  });
});

describe('Modules sectoriels (acte requis)', () => {
  it('affiche les modules sous « acte requis » et leurs titres non activables', async () => {
    mockApi({
      '/v1/verticales/secteurs': {
        notice: 'Modules sous ACTE_REQUIS.',
        items: [{ module: '25', name: 'Péage provincial', function: 'Axes, passages, reçus électroniques', vertical: 'mobilite', verticalName: 'MOSOLO Mobility', legal: 'ACTE_REQUIS', prerequisites: ['J1 — péage (acte)'], revenueCodes: [], credentialTypes: [{ code: 'PEA-PASSAGE', label: 'Péage — passage (usage unique)', activable: false, reason: 'Acte requis' }], declarationKinds: [], observationSources: ['PASSAGE_PEAGE'], routes: [], counts: { references: 2, declarations: 0, observations: 0 } }],
      },
    });
    wrap(<Secteurs />);
    expect(await screen.findByText('25 — Péage provincial')).toBeTruthy();
    expect(screen.getByText(/Péage — passage \(usage unique\) \(non activables\)/)).toBeTruthy();
    expect(screen.getByText('Acte requis avant tout paiement')).toBeTruthy();
  });
});

describe('Portail citoyen de signalement publicitaire', () => {
  it('envoie le signalement sans donnée nominative et affiche le code de suivi de la ligne d’intégrité', async () => {
    const calls = mockApi({ '/v1/public/publicite/signalements': { reference: 'SPUB-000001', status: 'TRANSMIS_INTEGRITE', message: 'Signalement reçu.', integrity: { reference: 'SIG-000001', trackingCode: 'ABCD-EFGH', message: 'Transmis à la ligne d’intégrité.' } } });
    wrap(<AdSignaler />);
    fireEvent.change(screen.getByLabelText('Ce que vous signalez'), { target: { value: 'DEMANDE_ESPECES' } });
    fireEvent.change(screen.getByLabelText('Description (lieu, repère)'), { target: { value: 'Un contrôleur a demandé de l’argent liquide au carrefour' } });
    fireEvent.click(screen.getByText('Envoyer le signalement'));
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
    const post = calls.find((c) => c.url.includes('/v1/public/publicite/signalements'))!;
    const body = JSON.parse(String(post.init?.body));
    expect(body.kind).toBe('DEMANDE_ESPECES');
    expect(Object.keys(body)).not.toContain('contact');
  });
});

describe('Opérateurs de billetterie (RakaPay) — supervision', () => {
  it('affiche les deux circuits séparés et la redevance ARB-08 en acte requis', async () => {
    setDemoUser('rk-responsable');
    mockApi({
      '/v1/rakapay/operateurs/mon-rattachement': { agentOf: null, adminOf: [] },
      '/v1/rakapay/operateurs': [{ id: 'OPR-0001', code: 'OPR-0001', name: 'Parking privé fictif', kind: 'PRIVE', commune: 'Gombe', status: 'CANDIDAT' }],
      '/v1/rakapay/offres': { items: [] },
      '/v1/rakapay/circuits': { public: { label: 'Recettes publiques — compte public', amounts: [] }, private: { label: 'Ventes des opérateurs privés — hors compte public', amounts: [{ amount: '3000.00', currency: 'CDF' }], sales: 1 }, notice: 'Deux circuits comptables séparés : aucun total ne les additionne.', platformFee: { label: 'Redevance d’usage de la plateforme par les opérateurs privés', status: 'ACTE_REQUIS', note: '' } },
      '/v1/rakapay/revues-ventes': { items: [] },
    }, [{ id: 'rk-responsable', name: 'Responsable RakaPay (démo)', roles: ['R07'], entity: 'DGTK' }]);
    wrap(<Operateurs />);
    expect(await screen.findByText('Parking privé fictif')).toBeTruthy();
    expect(await screen.findByText(/aucun total ne les additionne/)).toBeTruthy();
    expect(screen.getByText('Acte requis (ARB-08)')).toBeTruthy();
    expect(screen.getByText('Proposer l’agrément')).toBeTruthy();
  });
});

describe('Carte et pilote publicité', () => {
  it('affiche les zones à contrôler, le pilote en sept étapes et les propositions à vérifier', async () => {
    setDemoUser('pb-autorite');
    mockApi({
      '/v1/publicite/carte/couches': { supports: [], density: [{ commune: 'Gombe', activeSupports: 3 }], saturatedZones: [], zonesToControl: { designated: [], computed: [{ commune: 'Gombe', undeclared: 1, expired: 0, openCases: 0, citizenReports: 1, aiConfirmed: 0, total: 2 }] }, availableSpaces: [], interventions: [], citizenReports: [], aiProposals: [], notice: 'Zones saturées : décisions motivées.' },
      '/v1/publicite/pilote': { steps: Array.from({ length: 7 }, (_, i) => ({ id: `P${i + 1}`, rank: i + 1, label: `Étape ${i + 1}`, status: 'A_FAIRE', measure: null, notes: [] })) },
      '/v1/publicite/ia/propositions': { items: [{ id: 'IA1', photoId: 'PH1', kind: 'SUPPORT_NON_ENREGISTRE_PROBABLE', explanation: 'Proposition à vérifier par une personne : ni dossier, ni sanction.', status: 'A_VERIFIER', candidates: [] }] },
      '/v1/publicite/signalements': { items: [] },
    }, [{ id: 'pb-autorite', name: 'Autorité publicité (démo)', roles: ['R06'], entity: 'DGTK' }]);
    wrap(<AdCarte />);
    expect(await screen.findByText(/1 non déclaré\(s\)/)).toBeTruthy();
    expect(await screen.findByText('7. Étape 7')).toBeTruthy();
    expect(await screen.findByText('Support non enregistré probable')).toBeTruthy();
    expect(screen.getByText('Confirmer')).toBeTruthy();
  });
});
