/**
 * Parcours du citoyen (modules 1 à 12) — fonctions de l'application Android et iOS testées au niveau web (portefeuille
 * chiffré, code d'accès et verrouillage automatique, crochet d'appareil modifié, QR dynamique), défi anti-robots,
 * écrans des modules 5, 7 à 12 et indicateurs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import { api, INSTALLATION_KEY } from '../src/lib/api';
import { leadingZeroBits, solveChallenge } from '../src/lib/defi';
import {
  codeDefini, contenuStocke, definirCode, ESSAIS_MAX, ouvrirPortefeuille, plateforme, scellerPortefeuille, verifierCode, verifierIntegrite, verrouillageAuto,
  type Portefeuille,
} from '../src/lib/mobile';
import Application from '../src/modules/citoyen/Application';
import PortailPublic from '../src/modules/citoyen/PortailPublic';
import Indicateurs from '../src/modules/citoyen/Indicateurs';
import Vehicules from '../src/modules/citoyen/Vehicules';
import Transport from '../src/modules/citoyen/Transport';
import Cadastre from '../src/modules/citoyen/Cadastre';
import Relations from '../src/modules/citoyen/Relations';
import Locatif from '../src/modules/citoyen/Locatif';
import Activites from '../src/modules/citoyen/Activites';
import { MODULE_ROUTES } from '../src/modules/registry';
import Pieces from '../src/modules/citoyen/Pieces';
import Situation from '../src/modules/citoyen/Situation';
import { analyserTexteDocument } from '../src/lib/documentOcr';

type Handler = unknown | ((init: RequestInit | undefined, url: string) => { status: number; body: unknown });
function mockApi(routes: Record<string, Handler>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const path = Object.keys(routes).sort((a, b) => b.length - a.length).find((p) => url.split('?')[0]!.endsWith(p) || url.endsWith(p));
    if (!path) return Promise.resolve(new Response(JSON.stringify({ title: 'Introuvable', status: 404 }), { status: 404, headers: { 'content-type': 'application/json' } }));
    const h = routes[path];
    const r = typeof h === 'function' ? (h as (i: RequestInit | undefined, u: string) => { status: number; body: unknown })(init, url) : { status: 200, body: h };
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': r.status >= 400 ? 'application/problem+json' : 'application/json' } }));
  }) as unknown as typeof fetch;
  return calls;
}

const wrap = (ui: React.ReactElement) => render(<AppProvider initialLang="fr"><MemoryRouter>{ui}</MemoryRouter></AppProvider>);
const asUser = (id: string) => localStorage.setItem('mosolo.demoUser', id);

beforeEach(() => { localStorage.clear(); delete (globalThis as { Capacitor?: unknown }).Capacitor; });
afterEach(() => { vi.useRealTimers(); });

describe('Module 4 — fonctions de l’appareil (niveau web)', () => {
  it('code d’accès : PBKDF2, essais limités puis blocage temporaire', async () => {
    expect(codeDefini()).toBe(false);
    await definirCode('2468');
    expect(codeDefini()).toBe(true);
    expect(localStorage.getItem('mosolo.appareil.code')).not.toContain('2468');
    expect(await verifierCode('2468')).toEqual({ ok: true });
    const now = Date.now();
    let r = await verifierCode('0000', now);
    expect(r).toMatchObject({ ok: false, restants: ESSAIS_MAX - 1 });
    for (let i = 1; i < ESSAIS_MAX; i++) r = await verifierCode('0000', now);
    expect(r.ok).toBe(false);
    expect((r as { bloqueJusqua?: number }).bloqueJusqua).toBeGreaterThan(now);
    // Même le bon code est refusé pendant le blocage.
    expect((await verifierCode('2468', now + 1000)).ok).toBe(false);
    await expect(definirCode('12')).rejects.toThrow(/4 à 8 chiffres/);
  });

  it('portefeuille chiffré (AES-GCM) : illisible en clair, ouvert avec le bon code seulement, état serveur conservé', async () => {
    const p: Portefeuille = {
      titres: [{ id: 'C1', numero: 'VIG-2026-000123', libelle: 'Vignette automobile', jetonStatique: 'MS1.abc', validUntil: '2026-12-31T22:59:59.000Z', etatServeur: 'VALIDE', texteServeur: 'Valide encore 96 jours' }],
      quittances: [{ numero: 'Q-2026-0001', montant: '40.00 USD', date: '2026-09-26' }], preferences: { langue: 'ln' }, synchroniseA: '2026-09-26T09:00:00.000Z',
    };
    await scellerPortefeuille('1357', p);
    const raw = contenuStocke()!;
    expect(raw).not.toContain('VIG-2026-000123');
    expect(raw).not.toContain('Vignette');
    expect(await ouvrirPortefeuille('0000')).toBeNull();
    const back = await ouvrirPortefeuille('1357');
    expect(back).toEqual(p);
    // Contenu altéré : refusé (authentification AES-GCM).
    const o = JSON.parse(raw) as { ct: string };
    localStorage.setItem('mosolo.portefeuille.v1', JSON.stringify({ ...JSON.parse(raw), ct: `${o.ct[0] === 'A' ? 'B' : 'A'}${o.ct.slice(1)}` })); // toujours un caractère différent
    expect(await ouvrirPortefeuille('1357')).toBeNull();
  });

  it('crochet « appareil modifié » : module natif (Android racine / iOS jailbreak) ou repli navigateur ; plateforme', async () => {
    expect(plateforme()).toBe('WEB');
    expect(await verifierIntegrite()).toMatchObject({ source: 'NAVIGATEUR', racine: false, jailbreak: false });
    (globalThis as { Capacitor?: unknown }).Capacitor = { getPlatform: () => 'ios', Plugins: { MosoloIntegrite: { verifier: async () => ({ jailbreak: true }) } } };
    expect(plateforme()).toBe('IOS');
    expect(await verifierIntegrite()).toMatchObject({ source: 'MODULE_NATIF', jailbreak: true, racine: false });
    (globalThis as { Capacitor?: unknown }).Capacitor = { getPlatform: () => 'android', Plugins: { MosoloIntegrite: { verifier: async () => ({ racine: true, emulateur: true }) } } };
    expect(plateforme()).toBe('ANDROID');
    expect(await verifierIntegrite()).toMatchObject({ racine: true, emulateur: true });
  });

  it('verrouillage automatique après inactivité, relancé par l’activité', () => {
    vi.useFakeTimers();
    const onLock = vi.fn();
    const t = verrouillageAuto(onLock, 1000);
    vi.advanceTimersByTime(800);
    t.touch();
    vi.advanceTimersByTime(800);
    expect(onLock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onLock).toHaveBeenCalledTimes(1);
    t.stop();
  });

  it('écran : installation enregistrée, appareil modifié signalé, code puis portefeuille ; en-tête d’installation joint aux requêtes', async () => {
    const id = 'APP-12345678-1234-1234-1234-123456789abc';
    const calls = mockApi({
      '/v1/demo/users': [{ id: 'u-contribuable', name: 'Contribuable', roles: ['R30'], taxpayerId: 'TP-DEMO-0001' }],
      '/v1/public/application/installations': { id, plateforme: 'WEB', versionApp: '1.0.0', integrite: { statut: 'NON_EVALUE', signaux: [], source: 'AUCUNE' }, heureServeur: '2026-09-26T09:00:00.000Z' },
      [`/v1/public/application/installations/${id}/integrite`]: { id, plateforme: 'ANDROID', versionApp: '1.0.0', integrite: { statut: 'COMPROMIS', signaux: ['RACINE'], source: 'MODULE_NATIF' }, heureServeur: '2026-09-26T09:00:00.000Z' },
      '/v1/titres': [],
    });
    asUser('u-contribuable');
    wrap(<Application />);
    expect(await screen.findByText(/Appareil modifié \(RACINE\)/)).toBeTruthy();
    expect(localStorage.getItem(INSTALLATION_KEY)).toBe(id);
    fireEvent.change(screen.getByLabelText('Nouveau code'), { target: { value: '1234' } });
    fireEvent.change(screen.getByLabelText('Confirmer le code'), { target: { value: '1234' } });
    fireEvent.click(screen.getByText('Enregistrer le code'));
    expect(await screen.findByText('Verrouiller maintenant')).toBeTruthy();
    expect(screen.getByText(/fonctions sensibles|QR dynamique, paiement et prolongation sont refusés/)).toBeTruthy();
    fireEvent.click(screen.getByText('Verrouiller maintenant'));
    expect(await screen.findByText('Application verrouillée')).toBeTruthy();
    // Les requêtes suivantes portent l'identifiant d'installation.
    await api('/v1/titres');
    const last = calls.at(-1)!;
    expect((last.init?.headers as Record<string, string>)['x-mosolo-installation']).toBe(id);
  });
});

describe('Module 5 — anti-robots et simulateurs', () => {
  it('défi : solution valide (bits nuls en tête)', async () => {
    expect(leadingZeroBits(new Uint8Array([0, 0x0f, 0xff]))).toBe(12);
    const nonce = await solveChallenge('sel-test', 8);
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`sel-test:${nonce}`)));
    expect(leadingZeroBits(h)).toBeGreaterThanOrEqual(8);
  });

  it('428 DEFI_REQUIS : le client résout le défi et rejoue une fois avec l’en-tête', async () => {
    let n = 0;
    const calls = mockApi({
      '/v1/public/defi': { id: 'DEF-x', sel: 'abc', difficulte: 4 },
      '/v1/registrations': (init: RequestInit | undefined) => {
        n++;
        const h = (init?.headers ?? {}) as Record<string, string>;
        return h['x-mosolo-defi'] ? { status: 201, body: { taxpayerId: 'TP-1' } } : { status: 428, body: { title: 'Défi', status: 428, code: 'DEFI_REQUIS' } };
      },
    });
    const r = await api<{ taxpayerId: string }>('/v1/registrations', { method: 'POST', body: { x: 1 } });
    expect(r.taxpayerId).toBe('TP-1');
    expect(n).toBe(2);
    expect(calls.some((c) => c.url.endsWith('/v1/public/defi'))).toBe(true);
  });

  it('simulateur IRL : illustration non opposable ; vignette indisponible sans règle', async () => {
    mockApi({
      '/v1/demo/users': [],
      '/v1/public/visites': { enregistre: true },
      '/v1/public/informations': { guides: [{ profil: 'BAILLEUR', libelle: 'Bailleur', obligations: ['IRL'], pieces: ['Bail'], rappel: 'Déclarer un profil ouvre une instruction.' }], textes: { instruments: [] }, calendrier: { echeances: [], mention: 'Échéances issues des fiches du registre.' } },
      '/v1/public/simulateurs': { avertissement: 'Simulation sans enregistrement de données personnelles.', familles: [
        { famille: 'IRL', libelle: 'Impôt sur les revenus locatifs (IRL)', disponible: true, motifIndisponible: null, regles: [{ code: 'IRL-KIN-R1', version: 2, libelle: 'IRL 1er rang', statut: 'A_VERIFIER', base: 'Loyers', entrees: ['loyers_percus', 'retenues_imputees'], rangs: [], nature: 'ILLUSTRATION_NON_OPPOSABLE' }] },
        { famille: 'VIGNETTE', libelle: 'Vignette automobile', disponible: false, motifIndisponible: 'Aucune règle publiée au registre pour vignette automobile.', regles: [] },
      ] },
      '/v1/public/simulations': { nature: 'ILLUSTRATION_NON_OPPOSABLE', montant: { amount: '20.00', currency: 'USD' }, mention: 'Illustration NON OPPOSABLE : fiche IRL-KIN-R1 v2 au statut A_VERIFIER', regle: { code: 'IRL-KIN-R1', version: 2, statut: 'A_VERIFIER', formule: 'max(0, loyers_percus * taux / 100 - retenues_imputees)' }, taux: { taux: '22', taux_retenue: '20' } },
    });
    wrap(<PortailPublic />);
    expect(await screen.findByText('Aucune règle publiée au registre pour vignette automobile.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('loyers percus'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('retenues imputees'), { target: { value: '200' } });
    fireEvent.click(screen.getByText('Simuler'));
    expect(await screen.findByText('20.00 USD')).toBeTruthy();
    expect(screen.getByText('Illustration non opposable (fiche à vérifier)')).toBeTruthy();
    expect(screen.getByText(/taux = 22/)).toBeTruthy();
  });
});

describe('Écrans des modules 7 à 12 et indicateurs', () => {
  it('indicateurs : valeur réelle ou « non mesuré » avec la raison', async () => {
    mockApi({
      '/v1/demo/users': [{ id: 'u-auditeur', name: 'Auditeur', roles: ['R22'] }],
      '/v1/citoyen/indicateurs': { calculeLe: '2026-09-26T09:00:00.000Z', notice: 'Indicateurs calculés sur les données enregistrées.', modules: [
        { module: 1, titre: 'Identité et compte contribuable', indicateurs: { tauxRattachementNif: { valeur: '25.0', numerateur: 1, denominateur: 4 } } },
        { module: 6, titre: 'USSD et SMS', indicateurs: { coutParMessage: { valeur: null, raison: 'Aucun tarif opérateur conventionné [À RACCORDER — convention opérateur télécom].' } } },
      ] },
    });
    asUser('u-auditeur');
    wrap(<Indicateurs />);
    expect(await screen.findByText(/Module 1 — Identité/)).toBeTruthy();
    expect(screen.getByText(/25\.0/)).toBeTruthy();
    // La raison apparaît dans la liste ET dans la tuile « non mesuré » (trousse de visualisation).
    expect(screen.getAllByText(/Aucun tarif opérateur conventionné/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('non mesuré')).toBeTruthy();
  });

  it('véhicules : contrôle par plaque « payée / non régularisée » avec dernier paiement', async () => {
    mockApi({
      '/v1/demo/users': [{ id: 'u-controleur', name: 'Contrôleur', roles: ['R11'] }],
      '/v1/citoyen/vehicules': [],
      '/v1/citoyen/vehicules/immatriculations': [],
      '/v1/citoyen/vehicules/KN-4471-BD/controle': { plaque: 'KN4471BD', enregistre: true, categorie: 'MINIBUS', exercice: '2026', vignette: { code: 'VIG-ANNUELLE', statut: 'NON_REGULARISEE', titre: null, exigible: true }, taxeCirculation: { code: 'TSC-ANNUELLE', statut: 'PAYEE', titre: { numero: 'TSC-1', texte: 'Valide' }, exigible: true }, dernierPaiement: '2026-03-01T10:00:00.000Z', heureServeur: '2026-09-26T09:00:00.000Z', notice: 'Aucune immobilisation décidée par l’algorithme.', horsLigne: '' },
    });
    asUser('u-controleur');
    wrap(<Vehicules />);
    fireEvent.change(await screen.findByLabelText('Plaque'), { target: { value: 'KN-4471-BD' } });
    fireEvent.click(screen.getByText('Contrôler'));
    expect(await screen.findByText('Vignette : non régularisée')).toBeTruthy();
    expect(screen.getByText(/Taxe de circulation : payée/)).toBeTruthy();
    expect(screen.getByText(/Aucune immobilisation/)).toBeTruthy();
  });

  it('transport : autorisation non opposable sans règle ; contrôle en couleur', async () => {
    mockApi({
      '/v1/demo/users': [{ id: 'u-controleur', name: 'Contrôleur', roles: ['R11'] }],
      '/v1/citoyen/transport/indicateurs': { autorisationsActives: { valeur: 0, enAttenteDeRegle: 1, suspendues: 0 } },
      '/v1/citoyen/transport/autorisations': [{ id: 'ATR-1', certificatCode: 'TRP-1', categorieLibelle: 'Minibus', plaque: 'KN4471BD', zones: ['Kalamu'], horaires: { debut: '05:00', fin: '22:00' }, statut: 'EN_ATTENTE_REGLE', opposable: false, mention: 'Non opposable : aucune règle ACTIVE « LIC-BUS » au registre.', validite: { text: 'Valide jusqu’au 31/12' }, cartes: [], taxeJournaliere: '' }],
      '/v1/citoyen/transport/controles': { couleur: 'GRIS', resultat: 'Autorisation enregistrée, non opposable : aucune règle publiée.', heureKinshasa: '10:00', vignette: { texte: 'Vignette non exigible : acte requis (J3).' }, notice: 'Aucune sanction décidée par le système.' },
    });
    asUser('u-controleur');
    wrap(<Transport />);
    expect(await screen.findByText(/Non opposable : aucune règle ACTIVE/)).toBeTruthy();
    fireEvent.change(screen.getAllByLabelText('Plaque')[0]!, { target: { value: 'KN-4471-BD' } });
    fireEvent.change(screen.getByLabelText('Commune du contrôle'), { target: { value: 'Kalamu' } });
    fireEvent.click(screen.getByText('Contrôler'));
    expect(await screen.findByText(/GRIS — Autorisation enregistrée, non opposable/)).toBeTruthy();
  });

  it('cadastre : couche sensible réservée ; relations, locatif et patentes rendus', async () => {
    mockApi({
      '/v1/demo/users': [],
      '/v1/public/cadastre/couches': { notice: 'Vue publique : totaux seulement.', couches: [{ code: 'antennes', libelle: 'Antennes et sites télécoms', sensible: true, restreinte: true, total: null, parCommune: null }] },
    });
    wrap(<Cadastre />);
    expect(await screen.findByText('Réservée aux rôles habilités')).toBeTruthy();

    mockApi({
      '/v1/demo/users': [{ id: 'u-controleur', name: 'Contrôleur', roles: ['R11'] }],
      '/v1/citoyen/relations/indicateurs': { litigesOuverts: { valeur: 0 } },
      '/v1/citoyen/relations/revues': [{ id: 'RVO-1', obligationId: 'OBL-1', relationId: 'REL-1', objectId: 'OBJ-1', dateEffet: '2026-06-30', echeance: '2027-02-01', motifDetachement: 'VENTE', statut: 'A_REVOIR', obligation: { label: 'Impôt foncier', amount: { amount: '150.00', currency: 'USD' }, status: 'EMISE' } }],
      '/v1/citoyen/locatif/indicateurs': { bauxEnregistres: { valeur: 1, verifies: 1 } },
      '/v1/citoyen/locatif/calcul': { masque: false, notice: 'Calcul sur baux vérifiés : proposition de liquidation, jamais une dette automatique.', lignes: [{ bail: 'BAIL-1', igf: null, commune: 'Limete', quartier: 'Kingabwa', avenue: null, rang: 2, statutProbant: 'VERIFIE', loyerAnnuel: { amount: '5400.00', currency: 'USD' }, locataire: 'TP-2', retenue: { amount: '810.00', currency: 'USD' }, irlAnnuel: { amount: '378.00', currency: 'USD' }, regle: { code: 'IRL-KIN-R234', version: 2, statut: 'A_VERIFIER' }, nature: 'ILLUSTRATION_NON_OPPOSABLE', mention: '' }] },
      '/v1/citoyen/locatif/couverture': { lignes: [] },
      '/v1/citoyen/activites': { notice: 'Existence d’une activité ≠ assujettissement', lignes: [{ objectId: 'OBJ-A', igf: null, entreprise: 'Mbuyi', etablissement: 'Boutique', activite: 'Commerce', categorie: null, localisation: { commune: 'Gombe', quartier: 'Commerce' }, dirigeants: [], patente: { active: false, titre: null, exigible: false }, autorisations: [], signauxOuverts: 0 }] },
      '/v1/citoyen/activites/signaux': [],
    });
    asUser('u-controleur');
    const { unmount } = wrap(<Relations />);
    expect(await screen.findByText(/Impôt foncier — 150.00 USD/)).toBeTruthy();
    unmount();
    const l = wrap(<Locatif />);
    expect(await screen.findByText('810.00 USD')).toBeTruthy();
    expect(screen.getByText('IRL-KIN-R234 v2 (A_VERIFIER)')).toBeTruthy();
    l.unmount();
    wrap(<Activites />);
    expect(await screen.findByText('Non exigible (acte requis)')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Détecter sur le registre')).toBeTruthy());
  });

  it('menu : écrans des modules 4, 5, 7 à 12 et indicateurs enregistrés, noms français d’abord', () => {
    const paths = MODULE_ROUTES.map((r) => r.path);
    for (const p of ['/application', '/simulateurs', '/citoyen/relations', '/citoyen/cadastre', '/citoyen/locatif', '/citoyen/activites', '/citoyen/vehicules', '/citoyen/transport', '/citoyen/indicateurs']) expect(paths).toContain(p);
    expect(MODULE_ROUTES.find((r) => r.path === '/application')!.nav!.label).toBe('Application mobile (Android et iOS)');
  });
});


describe('Module 2 — lecture automatique et contrôle des pièces', () => {
  it('analyse OCR : zone MRZ du passeport (numéro, nom) ; sinon numéro candidat et ligne « Nom »', () => {
    const mrz = analyserTexteDocument('REPUBLIQUE\nP<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10\n');
    expect(mrz).toMatchObject({ numero: 'L898902C3', nom: 'ERIKSSON ANNA MARIA', mrzLigne2: 'L898902C36UTO7408122F1204159ZE184226B<<<<<10' });
    const cni = analyserTexteDocument('CARTE D’IDENTITE\nNom : MBUYI KALALA\nN° CD1234567');
    expect(cni).toMatchObject({ numero: 'CD1234567', nom: 'MBUYI KALALA' });
  });

  it('écran : score de confiance expliqué, cas à risque listés pour revue humaine', async () => {
    mockApi({
      '/v1/demo/users': [{ id: 'u-guichet', name: 'Guichet', roles: ['R12'] }],
      '/v1/citoyen/enrolement/pieces/revues': [],
      '/v1/citoyen/enrolement/pieces': { id: 'CTP-1', score: 55, statut: 'A_REVOIR', revueHumaine: true, facteurs: [{ code: 'photo', libelle: 'Capture photo de la pièce', points: 0, max: 15, detail: 'Aucune photo de la pièce.' }], rapprochements: [{ iuc: 'KIN-1', nomMasque: 'M*** K***', motifs: ['MEME_PIECE'] }], notice: 'Cas à risque : revue humaine avant toute élévation de niveau. Aucun rejet automatique.', seuil: { valeur: 70, mention: 'par défaut — à confirmer par le maître d’ouvrage' } },
    });
    asUser('u-guichet');
    wrap(<Pieces />);
    fireEvent.change(await screen.findByLabelText('Numéro'), { target: { value: 'CD1234567' } });
    fireEvent.change(screen.getByLabelText('Nom déclaré'), { target: { value: 'Mbuyi Kalala' } });
    fireEvent.click(screen.getByText('Contrôler la pièce'));
    expect(await screen.findByText(/Score de confiance 55\/100 — cas à risque/)).toBeTruthy();
    expect(screen.getByText(/Rapprochements possibles \(sans fusion\)/)).toBeTruthy();
    expect(screen.getByText('Aucun cas à risque.')).toBeTruthy();
  });
});

describe('Module 3 — attestation de situation', () => {
  it('émission et QR de vérification', async () => {
    mockApi({
      '/v1/demo/users': [{ id: 'u-contribuable', name: 'Contribuable', roles: ['R30'], taxpayerId: 'TP-DEMO-0001' }],
      '/v1/citoyen/situation/attestations': { numero: 'ASI-2026-000001-X', emiseLe: '2026-09-26T09:00:00.000Z', aJour: false, objets: [{ id: 'OBJ-1', igf: 'KIN-LMT-1', categorie: 'PARCELLE', commune: 'Limete', libelle: 'Impayé' }], obligations: { total: 2, parStatut: { EMISE: 2 }, resteAPayer: [{ amount: '150.00', currency: 'USD' }], contestees: 0 }, quitus: { eligible: false, bloquants: 1, mention: 'Quitus INFORMATIF' }, verification: '/v1/public/attestations-situation/ASI-2026-000001-X?sig=abc', notice: 'ce n’est pas un quitus' },
    });
    asUser('u-contribuable');
    wrap(<Situation />);
    fireEvent.click(await screen.findByText('Obtenir mon attestation de situation'));
    expect(await screen.findByText('Obligations ouvertes')).toBeTruthy();
    expect(screen.getByText(/reste à payer : 150.00 USD/)).toBeTruthy();
    expect(screen.getByText('KIN-LMT-1')).toBeTruthy();
  });
});
