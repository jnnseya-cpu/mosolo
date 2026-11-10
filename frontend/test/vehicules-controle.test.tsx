import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../src/context';
import { MODULE_ROUTES } from '../src/modules/registry';
import { ScanResult, type ScanView } from '../src/modules/vehicules-controle/ScanVehicule';
import Fourrieres from '../src/modules/vehicules-controle/Fourrieres';
import RaccordementRfck from '../src/modules/vehicules-controle/RaccordementRfck';
import VerifierVignette from '../src/modules/vehicules-controle/VerifierVignette';
import CentresAgrees from '../src/modules/vehicules-controle/CentresAgrees';
import { ageText } from '../src/modules/vehicules-controle/common';

const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } }));
function mockApi(user: { id: string; roles: string[]; entity?: string } | null, routes: Record<string, unknown>) {
  globalThis.fetch = vi.fn((url: string) => {
    if (user && String(url).includes('/v1/demo/users')) return json([{ ...user, name: `${user.id} (démo)`, entity: user.entity ?? 'RFCK' }]);
    const hit = Object.entries(routes).sort((a, b) => b[0].length - a[0].length).find(([k]) => String(url).includes(k));
    if (!hit) return Promise.reject(new TypeError('Failed to fetch'));
    return json(hit[1]);
  }) as unknown as typeof fetch;
  if (user) localStorage.setItem('mosolo.demoUser', user.id); else localStorage.removeItem('mosolo.demoUser');
}
const renderApp = (el: JSX.Element) => render(<MemoryRouter><AppProvider initialLang="fr">{el}</AppProvider></MemoryRouter>);

const view: ScanView = {
  scanId: 'SCAN-1', method: 'PLAQUE', plate: 'KN1999EC',
  identification: { plate: 'KN1999EC', categoryLabel: 'Véhicule d’entreprise', ownerRef: 'CTB-•••001', accountLink: 'COMPTE_RATTACHE' },
  vignetteFiscale: { state: 'PAYEE', label: 'Payée — valable jusqu’au 2026-12-31', receipt: 'Q-TEST-0001' },
  taxeCirculation: { state: 'AUCUNE', label: 'Aucun titre enregistré pour cette plaque' },
  autorisationTransport: { state: 'NON_APPLICABLE', label: 'Sans objet' },
  controleTechnique: { state: 'DEFAVORABLE', label: 'Contrôle défavorable — contre-visite requise', lastDate: '2026-09-27T08:50:00.000Z', centre: 'Centre [EXEMPLE]', result: 'DEFAVORABLE', echeance: '2026-10-27', stickerNumber: null },
  fourriere: { passages: 0, sortiesRegulieres: 0, enCours: 0, fraisImpayes: 0 },
  quitus: { state: 'BLOQUE', label: 'Quitus non délivrable', reasons: ['IMPAYEE'] },
  courtesy: { id: 'COURT-0001', until: '2026-10-27', decisionRef: 'Décision [EXEMPLE]', notice: 'Mode courtoisie : contrôles de vignette et procès-verbaux suspendus.' },
  notice: 'Affichage seulement.', serverTime: '2026-09-27T09:00:00.000Z',
};

describe('Chaîne véhicule — écrans', () => {
  it('scan unique : vignette fiscale et contrôle technique en deux lignes distinctes, jamais un statut unique ; courtoisie affichée', () => {
    mockApi(null, {});
    renderApp(<ScanResult v={view} />);
    const vf = screen.getByRole('region', { name: 'Vignette fiscale' });
    const ct = screen.getByRole('region', { name: 'Contrôle technique' });
    expect(within(vf).getByText('Payée')).toBeTruthy();
    expect(within(vf).getByText(/Q-TEST-0001/)).toBeTruthy();
    expect(within(ct).getByText('Défavorable — contre-visite')).toBeTruthy();
    expect(within(ct).queryByText('Payée')).toBeNull();
    expect(screen.queryByText(/vignette payée/i)).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/Mode courtoisie/);
    expect(screen.getAllByRole('region')).toHaveLength(7);
  });

  it('fourrières : indicateurs et priorisation sans ordre d’enlèvement', async () => {
    mockApi({ id: 'vc-u-chef-service-rfck', roles: ['R07'] }, {
      '/v1/vehicules/indicateurs': {
        controleTechnique: {}, centres: { actifs: 3, suspendus: 0, enInstruction: 0, alertesAnalytique: 0 }, tauxConformite: null, scan: { scans: 0, decisions: 0, constatsTransmis: 0 }, generatedAt: '2026-09-27T09:00:00.000Z',
        fourriere: { enFourriere: 1, constatsEnAttente: 0, enlevementsDecides: 1, sorties: 2, mainlevees: 1, dureeMoyenneGardeJours: 3.5, destinationsExecutees: 0, gardeLongue: 0, recetteLiquidee: [], recettePayee: [] },
      },
      '/v1/fourrieres/dossiers': { items: [] },
      '/v1/fourrieres/sites': { items: [{ id: 'FRR-EX-01', name: 'Fourrière [EXEMPLE]', commune: 'Limete', capacity: 40, occupancy: 1, demo: true }] },
      '/v1/fourrieres/rapprochement': { sites: [] },
      '/v1/fourrieres/priorisation': { items: [{ plate: 'KN1999EC', score: 30, factors: [{ label: 'Contrôle défavorable' }] }], notice: 'Priorisation indicative : n’ordonne aucun enlèvement.' },
    });
    renderApp(<Fourrieres />);
    expect(await screen.findByText('Aucun (décision humaine requise)')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Durée moyenne de garde' }).textContent).toContain('3.5 j');
    expect(screen.getByRole('group', { name: 'Véhicules en fourrière' }).textContent).toContain('1');
  });

  it('raccordement RFCK : dix flux « À RACCORDER — convention requise », numérotation à arbitrer, chiffres publiés À VÉRIFIER', async () => {
    mockApi({ id: 'vc-u-direction-rfck', roles: ['R06'] }, {
      '/v1/rfck/entite': {
        entity: { name: 'Régie des Fourrières et de Contrôle Technique des Véhicules de Kinshasa', shortName: 'RFCK', nature: 'Établissement public provincial', tutelle: 'Ministère provincial des Transports et de la Mobilité urbaine' },
        arrete: { title: 'Arrêté ministériel du 12 novembre 2025 [texte À VÉRIFIER]', status: 'A_VERIFIER', scope: ['Motos'] }, contacts: { adresse: '', telephone: '', courriel: '' },
        modules: [{ numero: 82, numeroMaitreOuvrage: 59, label: 'Contrôle technique et vignette sécurisée', note: 'n° 59–61 dans le catalogue du maître d’ouvrage du 27/09/2026' }],
        numerotation: { note: 'n° 59–61', aArbitrer: 'À arbitrer : les n° 82 à 84 désignent déjà le quitus fiscal numérique.' },
      },
      '/v1/rfck/flux': { items: Array.from({ length: 10 }, (_, k) => ({ code: `F${k}`, label: `Flux ${k}`, direction: 'BIDIRECTIONNEL', cadence: 'Temps réel', status: 'A_RACCORDER', statusLabel: 'À RACCORDER — convention requise', exchanges: 0, connector: 'bac à sable' })) },
      '/v1/rfck/integration': { steps: [{ rank: 1, code: 'CONVENTION', label: 'Convention RFCK – Ville signée', status: 'CONDITIONS_NON_REMPLIES', conditions: [{ label: 'Convention active', met: false }] }] },
      '/v1/rfck/domaine': { requirements: [{ code: 'D1', label: 'Domaine officiel désigné', status: 'A_FAIRE', detail: 'EXEMPLE' }], domain: { host: 'verification.exemple.cd', status: 'EXEMPLE', ownedBy: 'Ville' }, sampleQr: 'https://verification.exemple.cd/v/ct/VTS-EXEMPLE' },
      '/v1/rfck/chiffres-publies': { items: [{ code: 'VEHICULES_CONTROLES', label: 'Véhicules contrôlés (chiffre publié)', value: '2 500', status: 'A_VERIFIER', usage: 'jamais une base' }] },
    });
    renderApp(<RaccordementRfck />);
    expect((await screen.findAllByText('À RACCORDER — convention requise')).length).toBe(10);
    expect(screen.getByText(/À arbitrer/)).toBeTruthy();
    expect(screen.getAllByText('À vérifier').length).toBeGreaterThan(0);
  });

  it('centres agréés : suspension uniquement par décision motivée (message), tuiles actifs / suspendus', async () => {
    mockApi({ id: 'vc-u-direction-rfck', roles: ['R06'] }, {
      '/v1/centres-agrees/analytique': { rows: [], byPoint: [], alerts: [], notice: 'Alertes seulement.' },
      '/v1/centres-agrees': { items: [{ id: 'C1', publicCode: 'AGR-C1', name: 'Centre [EXEMPLE]', kindLabel: 'Centre de contrôle technique', commune: 'Limete', status: 'SUSPENDU', categories: [], activities: [], quotas: { stockVignettes: 10, inspectionsParJour: 5 }, suspension: { motif: 'Stock non déclaré', at: '2026-09-27' } }], indicators: { actifs: 2, suspendus: 1, enInstruction: 0 } },
    });
    renderApp(<CentresAgrees />);
    expect(await screen.findByText(/jamais automatique/)).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Centres suspendus' }).textContent).toContain('1');
    expect(screen.getByText('Stock non déclaré')).toBeTruthy();
  });

  it('vérification publique : numéro inconnu « non authentique », domaine non officiel signalé', async () => {
    mockApi(null, { '/v1/public/vehicules/vignettes/verifier': { found: false, authentic: false, state: 'DOMAINE_NON_OFFICIEL', message: 'Ce QR ne pointe pas vers le domaine officiel de vérification.', officialDomain: 'verification.exemple.cd' } });
    render(<MemoryRouter initialEntries={['/v/ct/VTS-2026-00000011']}><AppProvider initialLang="fr"><Routes><Route path="/v/ct/:numero" element={<VerifierVignette />} /></Routes></AppProvider></MemoryRouter>);
    expect(await screen.findByText(/ne pointe pas vers le domaine officiel/)).toBeTruthy();
    expect(screen.getByText('Non authentique ou non valable')).toBeTruthy();
    expect(screen.getByText(/Domaine officiel : verification.exemple.cd/)).toBeTruthy();
  });

  it('registre des écrans et fraîcheur du statut hors ligne', () => {
    const paths = MODULE_ROUTES.map((r) => r.path);
    for (const p of ['/vehicules/controle-technique', '/vehicules/scan', '/vehicules/fourrieres', '/vehicules/centres-agrees', '/vehicules/rfck', '/vehicules/mes-vehicules', '/vehicules/verifier', '/v/ct/:numero']) expect(paths).toContain(p);
    expect(MODULE_ROUTES.find((r) => r.path === '/vehicules/fourrieres')!.nav!.label).toBe('Fourrières, enlèvement et gardiennage');
    const now = Date.parse('2026-09-27T10:00:00.000Z');
    expect(ageText('2026-09-27T09:45:00.000Z', now)).toBe('il y a 15 min');
    expect(ageText('2026-09-27T07:00:00.000Z', now)).toBe('il y a 3 h 00');
  });
});
