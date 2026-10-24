/**
 * Écrans des fiches sectorielles 13 à 25, du module 18 (plastique), du module 14 (exemptions, USSD/SMS, titres actifs
 * d'une plaque) et de la veille du registre des règles (module 26).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import { setDemoUser } from '../src/lib/api';
import Fiches from '../src/modules/verticales/Fiches';
import Plastique from '../src/modules/verticales/Plastique';
import { ActiveTitles, ExemptionsPanel, TextChannelPanel } from '../src/modules/parking/Stationnement14';
import { VeilleRegles } from '../src/modules/juridique/VeilleRegles';
import { MODULE_ROUTES } from '../src/modules/registry';

type Handler = unknown | ((init?: RequestInit) => unknown);
function mockApi(routes: Record<string, Handler>, users: unknown[] = []) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/v1/demo/users')) return Promise.resolve(new Response(JSON.stringify(users), { status: 200, headers: { 'content-type': 'application/json' } }));
    const path = Object.keys(routes).sort((a, b) => b.length - a.length).find((p) => url.split('?')[0]!.endsWith(p));
    if (!path) return Promise.resolve(new Response(JSON.stringify({ title: 'Introuvable', status: 404 }), { status: 404, headers: { 'content-type': 'application/json' } }));
    const h = routes[path];
    const body = typeof h === 'function' ? (h as (i?: RequestInit) => unknown)(init) : h;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
  return calls;
}
const wrap = (ui: JSX.Element) => render(<AppProvider initialLang="fr"><MemoryRouter>{ui}</MemoryRouter></AppProvider>);
const bodyOf = (calls: { url: string; init?: RequestInit }[], path: string) => JSON.parse(String(calls.filter((c) => c.url.includes(path) && c.init?.method === 'POST').at(-1)!.init!.body));

afterEach(() => { setDemoUser(null); localStorage.clear(); vi.restoreAllMocks(); });

const INSTRUCTOR = [{ id: 'vx-instructeur-dgtk', name: 'Instructeur DGTK', roles: ['R11'], entity: 'DGTK' }];
const INDICATORS = {
  generatedAt: '2026-09-26T09:00:00.000Z',
  modules: [
    { module: '13', rule: { ruleCode: null, status: 'ACTE_REQUIS', version: null, demo: false }, indicators: [{ key: 'departsTraces', label: 'Départs tracés', value: 3, measured: true }, { key: 'ecartManifesteTitres', label: 'Écart manifeste / titres', value: null, measured: false, reason: 'Aucun manifeste déposé.' }] },
    { module: '16', rule: { ruleCode: 'TEST-ANTENNES', status: 'ACTIVE', version: 1, demo: true }, indicators: [{ key: 'recouvrement', label: 'Recouvrement', value: [{ amount: '250000.00', currency: 'CDF' }], measured: true }] },
  ],
};

describe('Fiches sectorielles — écran', () => {
  it('est inscrit au menu et affiche les indicateurs mesurés ou « non mesuré » avec la raison', async () => {
    expect(MODULE_ROUTES.some((r) => r.path === '/verticales/fiches' && r.nav?.label.startsWith('Fiches sectorielles'))).toBe(true);
    setDemoUser('vx-instructeur-dgtk');
    mockApi({ '/v1/verticales/fiches/indicateurs': INDICATORS }, INSTRUCTOR);
    wrap(<Fiches />);
    expect(await screen.findByText(/Départs tracés/)).toBeTruthy();
    expect(await screen.findByText(/Non mesuré — Aucun manifeste déposé/)).toBeTruthy();
    expect(await screen.findByText(/Règle TEST-ANTENNES v1 ACTIVE \[EXEMPLE\]/)).toBeTruthy();
  });

  it('liquidations : doctrine automatique sur règle ACTIVE, statut, règlement, lancement du passage par l’instructeur', async () => {
    setDemoUser('vx-instructeur-dgtk');
    const calls = mockApi({
      '/v1/verticales/fiches/indicateurs': INDICATORS,
      '/v1/verticales/fiches/liquidations/automatique': (init?: RequestInit) => init?.method === 'POST'
        ? { exercice: '2026', modules: [{ module: '16', executed: 2 }] }
        : { modules: [{ module: '16', mode: 'AUTOMATIQUE', rule: { ruleCode: 'TEST-ANTENNES', status: 'ACTIVE' } }, { module: '22', mode: 'PROPOSITION', rule: { ruleCode: null, status: 'ACTE_REQUIS' } }], schedulerNote: 'Passage planifié toutes les 60 minutes par défaut (paramètre technique à confirmer par le maître d’ouvrage).', lastRun: null, doctrine: 'Sur règle ACTIVE : liquidation automatique.' },
      '/v1/verticales/fiches/liquidations': { items: [{ id: 'LIQ-16-000001', module: '16', objectId: 'OBJ-1', taxpayerId: 'TP', period: '2026', basis: { sites: '1' }, mode: 'AUTOMATIQUE', ruleCode: 'TEST-ANTENNES', ruleVersion: 1, status: 'EXECUTEE', simulated: { amount: '250000.00', currency: 'CDF' }, note: '', obligationId: 'OBL-1', noticeId: 'AI-1', payment: { state: 'PAYE' }, proposedBy: 'x' }] },
    }, INSTRUCTOR);
    wrap(<Fiches />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Liquidations' }));
    expect(await screen.findByText(/automatique — règle TEST-ANTENNES ACTIVE/)).toBeTruthy();
    expect(screen.getByText(/proposition seulement \(acte requis\)/)).toBeTruthy();
    expect(await screen.findByText(/Exécutée \(auto\)/)).toBeTruthy();
    expect(screen.getByText('PAYE')).toBeTruthy();
    fireEvent.click(screen.getByText('Lancer le passage maintenant'));
    expect(await screen.findByText(/Passage exécuté : 16 → 2/)).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/liquidations/automatique') && c.init?.method === 'POST')).toBe(true);
  });

  it('13 : l’agent scanne un titre d’embarquement ; « DÉJÀ UTILISÉ » au second scan', async () => {
    setDemoUser('vx-agent-terrain-dgtk');
    let scans = 0;
    const calls = mockApi({
      '/v1/verticales/fiches/indicateurs': INDICATORS,
      '/v1/verticales/fiches/references': { items: [{ id: 'EMB-EX-01', module: '13', kind: 'POINT_EMBARQUEMENT', label: 'Point d’embarquement [EXEMPLE] — Kinkole', commune: 'Nsele', lat: -4.341, lon: 15.492, demo: true }] },
      '/v1/verticales/fiches/departs': { items: [{ id: 'DEP-000001', pointId: 'EMB-EX-01', point: 'Kinkole', commune: 'Nsele', destination: 'Maluku', scheduledAt: '2026-09-26T12:00:00.000Z', titleMode: 'PAR_PASSAGER', status: 'PREVU', manifest: { passengers: 3 }, titles: 3 }] },
      '/v1/verticales/fiches/departs/DEP-000001/embarquements': () => {
        scans += 1;
        return scans === 1 ? { control: { result: 'VALIDE', text: 'VALIDE' }, notice: 'Embarquement validé : titre consommé.' } : { control: { result: 'INVALIDE', text: 'DÉJÀ UTILISÉ', alreadyUsed: { at: 'x' }, constat: { id: 'CST-1', notice: 'Constat sans montant.' } }, notice: 'DÉJÀ UTILISÉ : titre déjà consommé (constat sans montant).' };
      },
    }, [{ id: 'vx-agent-terrain-dgtk', name: 'Agent DGTK', roles: ['R10'], entity: 'DGTK', territory: ['Nsele'] }]);
    wrap(<Fiches />);
    fireEvent.click(await screen.findByRole('tab', { name: '13 · Embarquement' }));
    const input = await screen.findByLabelText('Scanner un titre d’embarquement — QR ou code court');
    fireEvent.change(input, { target: { value: 'EMB-ABCD-1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scanner un titre d’embarquement' }));
    expect(await screen.findByText('Embarquement validé : titre consommé.')).toBeTruthy();
    expect(bodyOf(calls, '/embarquements')).toEqual({ code: 'EMB-ABCD-1234' });
    fireEvent.change(input, { target: { value: 'EMB-ABCD-1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scanner un titre d’embarquement' }));
    expect(await screen.findByText('DÉJÀ UTILISÉ')).toBeTruthy();
    expect(screen.getByText(/Constat CST-1/)).toBeTruthy();
    expect(screen.getByText(/jamais à l’agent de quai/)).toBeTruthy();
  });

  it('25 : achat d’un passage [EXEMPLE] lié à la plaque par l’usager (canal numérique) ; solde du carnet', async () => {
    setDemoUser('u-contribuable');
    const calls = mockApi({
      '/v1/verticales/fiches/indicateurs': INDICATORS,
      '/v1/verticales/fiches/references': { items: [{ id: 'AXE-EX-02', module: '25', kind: 'AXE', label: 'Axe de péage [EXEMPLE] — sortie est', commune: 'Nsele', lat: -4.37, lon: 15.52, demo: true }] },
      '/v1/verticales/fiches/25/types-titres': { items: [{ code: 'PEA-PASSAGE', label: 'Péage — passage', activable: false, reason: 'Acte requis' }, { code: 'PEA-PASSAGE-EX', label: 'Péage — passage unique — DÉMONSTRATION [EXEMPLE]', activable: true, demo: true, reason: null }] },
      '/v1/verticales/fiches/peage/titres': { issuance: { id: 'CMD-1', status: 'EN_ATTENTE_PAIEMENT', payments: [{ paymentReference: 'MOS-REF-1', amount: { amount: '2000.00', currency: 'CDF' } }] } },
      '/v1/verticales/fiches/peage/carnets/KN-8888-HH': { plate: 'KN8888HH', titles: [{ number: 'PEA-1', typeCode: 'PEA-CARNET-EX', usesTotal: 10, usesLeft: 9, text: 'VALIDE' }] },
    }, [{ id: 'u-contribuable', name: 'Mbuyi Kalala', roles: ['R30'], entity: 'PUBLIC', taxpayerId: 'TP-DEMO-0001' }]);
    wrap(<Fiches />);
    fireEvent.click(await screen.findByRole('tab', { name: '25 · Péage' }));
    fireEvent.change(await screen.findByLabelText('Plaque du véhicule (péage)'), { target: { value: 'KN-8888-HH' } });
    await screen.findByRole('option', { name: /DÉMONSTRATION \[EXEMPLE\]/ });
    fireEvent.click(screen.getByRole('button', { name: 'Acheter' }));
    expect(await screen.findByText(/payez la référence MOS-REF-1/)).toBeTruthy();
    expect(bodyOf(calls, '/peage/titres')).toMatchObject({ typeCode: 'PEA-PASSAGE-EX', plate: 'KN-8888-HH', pointId: 'AXE-EX-02', channel: 'MOBILE_MONEY' });
    fireEvent.click(screen.getByRole('button', { name: 'Solde du carnet' }));
    expect(await screen.findByText(/9 passage\(s\) restant\(s\) sur 10/)).toBeTruthy();
  });

  it('configuration : réservée au directeur de la régie ; choix d’un type [EXEMPLE] avec la référence de l’acte', async () => {
    setDemoUser('vx-chef-service-dgtk');
    mockApi({ '/v1/verticales/fiches/indicateurs': INDICATORS }, [{ id: 'vx-chef-service-dgtk', name: 'Cheffe DGTK', roles: ['R07'], entity: 'DGTK' }]);
    const { unmount } = wrap(<Fiches />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    expect(await screen.findByText('Configuration réservée à la direction de la régie')).toBeTruthy();
    unmount();
    setDemoUser('vx-directeur-dgtk');
    const calls = mockApi({
      '/v1/verticales/fiches/indicateurs': INDICATORS,
      '/configuration': { ruleCode: null, credentialTypeCode: null, objectCategories: [], actReference: '', rule: 'ACTE_REQUIS' },
      '/types-titres': { items: [], available: [{ code: 'CAR-BON', label: 'Bon de sortie', activable: false, reason: 'Acte requis' }, { code: 'CAR-BON-EX', label: 'Bon de sortie (camion) — DÉMONSTRATION', activable: true, demo: true, reason: null }] },
    }, [{ id: 'vx-directeur-dgtk', name: 'Directeur DGTK', roles: ['R06'], entity: 'DGTK' }]);
    vi.spyOn(window, 'prompt').mockReturnValue('Configuration de démonstration');
    wrap(<Fiches />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    const select = await screen.findByLabelText('Type de titre du module 22');
    await screen.findAllByRole('option', { name: /DÉMONSTRATION \[EXEMPLE\]/ });
    fireEvent.change(select, { target: { value: 'CAR-BON-EX' } });
    fireEvent.change(screen.getByLabelText('Acte du module 22'), { target: { value: 'Acte FICTIF [EXEMPLE]' } });
    fireEvent.submit(select.closest('form')!);
    await waitFor(() => expect(calls.some((c) => c.url.includes('/22/configuration') && c.init?.method === 'POST')).toBe(true));
    expect(bodyOf(calls, '/22/configuration')).toMatchObject({ ruleCode: null, credentialTypeCode: 'CAR-BON-EX', actReference: 'Acte FICTIF [EXEMPLE]', motif: 'Configuration de démonstration' });
  });

  it('17 : données commerciales sensibles refusées au terrain ; transmission des points non autorisés au module 10 par la régie', async () => {
    setDemoUser('vx-agent-terrain-dgtk');
    mockApi({ '/v1/verticales/fiches/indicateurs': INDICATORS }, [{ id: 'vx-agent-terrain-dgtk', name: 'Agent', roles: ['R10'], entity: 'DGTK' }]);
    const first = wrap(<Fiches />);
    fireEvent.click(await screen.findByRole('tab', { name: '17 · Boissons' }));
    expect(await screen.findByText('Données commerciales sensibles')).toBeTruthy();
    first.unmount();
    setDemoUser('vx-chef-service-dgtk');
    const calls = mockApi({
      '/v1/verticales/fiches/indicateurs': INDICATORS,
      '/v1/verticales/fiches/boissons/points-livraison': { items: [{ id: 'PLV-1', label: 'Terrasse Victoire', commune: 'Kalamu', status: 'A_IDENTIFIER', deliveries: 1, volumeLitres: '900', transmitted: false }] },
      '/v1/verticales/fiches/boissons/coherence': { items: [] },
      '/v1/verticales/fiches/boissons/suivi': { items: [] },
      '/v1/verticales/fiches/boissons/transmissions': { id: 'TRM-10-1' },
    }, [{ id: 'vx-chef-service-dgtk', name: 'Cheffe DGTK', roles: ['R07'], entity: 'DGTK' }]);
    vi.spyOn(window, 'prompt').mockReturnValue('Points livrés sans autorisation');
    wrap(<Fiches />);
    fireEvent.click(await screen.findByRole('tab', { name: '17 · Boissons' }));
    fireEvent.click(await screen.findByText(/Transmettre 1 point\(s\) non autorisé\(s\) au module 10/));
    expect(await screen.findByText(/transmis au registre des activités/)).toBeTruthy();
    expect(bodyOf(calls, '/boissons/transmissions')).toEqual({ pointIds: ['PLV-1'], motif: 'Points livrés sans autorisation' });
  });
});

describe('Module 18 — contribution plastique', () => {
  it('affiche « module désactivé » et bloque la déclaration tant que la règle n’est pas ACTIVE', async () => {
    setDemoUser('u-contribuable');
    mockApi({
      '/v1/verticales/plastique': { active: false, ruleCode: null, ruleStatus: 'ACTE_REQUIS', notice: 'Module désactivé : aucune règle publiée et ACTIVE (acte requis — J15, J16).', roles: ['PRODUCTEUR'], categories: { emballages_kg: 'Emballages plastiques (kg)' }, liable: [], study: [], simulations: [], declarations: [], rules: [], indicators: { assujettis: 2, simulations: 1, declarations: 0 } },
    }, [{ id: 'u-contribuable', name: 'Mbuyi Kalala', roles: ['R30'], entity: 'PUBLIC', taxpayerId: 'TP-DEMO-0001' }]);
    wrap(<Plastique />);
    expect(await screen.findByText('Module désactivé')).toBeTruthy();
    expect(screen.getByText(/Assujettis identifiés : 2 · simulations réalisées : 1/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Déclarer' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Module 14 — exemptions, USSD/SMS, titres actifs', () => {
  it('la régie demande une exemption de véhicule officiel avec une pièce ; la décision est réservée à une autre personne', async () => {
    setDemoUser('pk-regie');
    const calls = mockApi({
      '/v1/parking/exemptions': (init?: RequestInit) => init?.method === 'POST' ? { id: 'EXS-1' } : { items: [{ id: 'EXS-0', plate: 'KN-0900-GV', category: 'VEHICULE_OFFICIEL', holder: 'Gouvernorat', ruleCode: null, exemptionBasis: null, zoneIds: [], validFrom: '2026-09-01', validUntil: '2026-12-31', motif: 'Service', status: 'DEMANDEE', inForce: false, requestedBy: 'pk-regie' }] },
    }, [{ id: 'pk-regie', name: 'Régie', roles: ['R07'], entity: 'DGTK' }]);
    wrap(<ExemptionsPanel tick={0} />);
    expect(await screen.findByText(/Décision par une autre personne/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Plaque exemptée'), { target: { value: 'KN-0901-GV' } });
    fireEvent.change(screen.getByLabelText('Bénéficiaire'), { target: { value: 'Ministère (démonstration)' } });
    fireEvent.change(screen.getByLabelText('Début de validité'), { target: { value: '2026-09-26' } });
    fireEvent.change(screen.getByLabelText('Fin de validité'), { target: { value: '2026-12-31' } });
    fireEvent.change(screen.getByLabelText('Pièce justificative'), { target: { value: 'a'.repeat(64) } });
    fireEvent.change(screen.getByLabelText('Motif de la demande'), { target: { value: 'Véhicule de service' } });
    fireEvent.click(screen.getByRole('button', { name: 'Demander' }));
    expect(await screen.findByText(/décision d’une autre personne requise/)).toBeTruthy();
    expect(bodyOf(calls, '/v1/parking/exemptions')).toMatchObject({ plate: 'KN-0901-GV', category: 'VEHICULE_OFFICIEL', documents: ['a'.repeat(64)], validFrom: '2026-09-26' });
  });

  it('l’usager stationne par SMS : réponse du canal texte et accès « À RACCORDER — convention requise »', async () => {
    setDemoUser('u-contribuable');
    const calls = mockApi({
      '/v1/parking/canal-texte/simulateur': { outcome: 'OK', reply: 'Session PK-ABC DEMO-GOMBE-CENTRE KN-0001-DM 60 min : 2000.00 CDF. Payez la référence MOS-1 par Mobile Money.', access: { ussd: '*[code court À CONFIGURER]#', sms: 'SMS au [numéro court À CONFIGURER]', status: 'À RACCORDER — convention requise' } },
    }, [{ id: 'u-contribuable', name: 'Mbuyi Kalala', roles: ['R30'], entity: 'PUBLIC', taxpayerId: 'TP-DEMO-0001' }]);
    wrap(<TextChannelPanel />);
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'STAT DEMO-GOMBE-CENTRE KN-0001-DM 60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer' }));
    expect(await screen.findByText(/Payez la référence MOS-1/)).toBeTruthy();
    expect(screen.getByText(/À RACCORDER — convention requise/)).toBeTruthy();
    expect(bodyOf(calls, '/canal-texte/simulateur')).toEqual({ channel: 'SMS', text: 'STAT DEMO-GOMBE-CENTRE KN-0001-DM 60' });
  });

  it('le contrôleur voit tous les titres actifs de la plaque', async () => {
    mockApi({});
    wrap(<ActiveTitles items={[
      { kind: 'SESSION', zone: 'DEMO-LIMETE-LUMUMBA', reference: 'PK-1', validFrom: '2026-09-26T09:00:00Z', validUntil: '2026-09-26T10:00:00Z', light: 'VERT', text: 'Session payée' },
      { kind: 'EXEMPTION', zone: 'Toutes zones', reference: 'EXS-1', validFrom: '2026-09-01', validUntil: '2026-12-31', light: 'VERT', text: 'Exempté — véhicule officiel' },
    ]} />);
    expect(await screen.findByText(/Tous les titres actifs de la plaque \(2\)/)).toBeTruthy();
    expect(screen.getByText(/Exempté — véhicule officiel/)).toBeTruthy();
    expect(screen.getByText(/Session payée/)).toBeTruthy();
  });
});

describe('Module 26 — veille du registre', () => {
  it('règles expirantes, conflits de normes, délai d’approbation, archivage confirmé par une autre personne', async () => {
    setDemoUser('u-juriste-verificateur');
    const calls = mockApi({
      '/v1/legal-rules/veille': {
        horizonDays: 90, horizonNote: 'Horizon de veille par défaut 90 jours — à confirmer par le maître d’ouvrage.',
        expiring: [{ ruleId: 'r1', code: 'TEST-EXP', version: 1, label: 'x', effectiveTo: '2026-10-15', daysLeft: 19, successor: false }],
        conflicts: [{ kind: 'DOUBLON_ADMINISTRATION', ruleIds: ['a', 'b'], detail: 'Même fait générateur revendiqué par DGIPK et DGTK : arbitrage requis.' }],
        indicators: { activeValidated: 4, active: 5, expiring: 1, archived: 0, approvalDelayDays: { measured: true, count: 4, mean: 2.5, median: 2, max: 5 }, pendingApprovals: [] },
        archives: [{ id: 'ARC-1', ruleId: 'r9', ruleCode: 'TEST-ARCH', version: 1, statusBefore: 'BROUILLON', motif: 'Projet abandonné', requestedBy: 'u-juriste-redacteur', status: 'DEMANDEE' }],
      },
      '/v1/legal-rules/archives/ARC-1/decide': { status: 'CONFIRMEE' },
    }, [{ id: 'u-juriste-verificateur', name: 'Juriste vérificateur', roles: ['R14'], entity: 'MINFIN' }]);
    vi.spyOn(window, 'prompt').mockReturnValue('Archivage confirmé');
    wrap(<VeilleRegles />);
    expect(await screen.findByText(/TEST-EXP/)).toBeTruthy();
    expect(screen.getByText('Doublon entre administrations')).toBeTruthy();
    expect(screen.getByText(/2 j \(médiane\)/)).toBeTruthy();
    expect(screen.getByText(/à confirmer par le maître d’ouvrage/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
    expect(await screen.findByText('Archivage confirmé.')).toBeTruthy();
    expect(bodyOf(calls, '/archives/ARC-1/decide')).toEqual({ approve: true, motif: 'Archivage confirmé' });
  });
});
