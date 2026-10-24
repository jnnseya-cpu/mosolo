import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import { AideContextuelle } from '../src/modules/apprentissage/AideContextuelle';
import { EtatCertification } from '../src/modules/apprentissage/EtatCertification';
import Espace from '../src/modules/apprentissage/Espace';
import Certifications from '../src/modules/apprentissage/Certifications';
import MesCertificats from '../src/modules/apprentissage/MesCertificats';

type Call = { url: string; method: string; body: unknown };
type Handler = (url: string, method: string, body: unknown) => { status?: number; body: unknown } | undefined;

function mockBackend(user: { id: string; roles: string[] }, handler: Handler) {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    calls.push({ url, method, body });
    const reply = (status: number, b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } }));
    if (url.includes('/v1/demo/users')) return reply(200, [{ id: user.id, name: `Utilisateur ${user.id} (démo)`, roles: user.roles }]);
    const r = handler(url, method, body);
    if (r) return reply(r.status ?? 200, r.body);
    return Promise.reject(new TypeError('Failed to fetch'));
  }) as unknown as typeof fetch;
  return calls;
}
const renderPage = (ui: ReactElement) => render(<AppProvider initialLang="fr"><MemoryRouter>{ui}</MemoryRouter></AppProvider>);

const CONF = { principe: 'Traçabilité des actes professionnels, pas surveillance permanente des personnes.', enregistre: ['Les épreuves soumises'], jamais: ['Aucun temps d’écran, aucun suivi des clics'] };
const fiche = { id: 'FICHE-0001', type: 'FICHE', cle: 'contribuable.payer', publics: ['CONTRIBUABLE'], version: 1, titre: 'Comment payer', corps: 'Aucun agent ne peut recevoir d’espèces.',
  lingala: { titre: 'Ndenge ya kofuta', corps: 'Mosali moko te azwaka mbongo na lobɔkɔ.', statut: 'BROUILLON' }, lingalaNote: 'Traduction lingala : brouillon à relire par un locuteur — le texte français fait foi.',
  statut: 'PUBLIEE', auteur: 'u-a', creeLe: '2026-09-01T00:00:00.000Z', demo: true };

describe('Aide contextuelle « ? »', () => {
  it('ouvre la fiche publiée, bascule en lingala signalé comme brouillon', async () => {
    mockBackend({ id: 'u-contribuable', roles: ['R30'] }, (url) => (url.includes('/v1/apprentissage/aide/contribuable.payer') ? { body: fiche } : undefined));
    renderPage(<AideContextuelle cle="contribuable.payer" libelle="Aide : payer" />);
    fireEvent.click(screen.getByRole('button', { name: 'Aide : payer' }));
    expect(await screen.findByText('Comment payer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lingala (brouillon)' }));
    expect(screen.getByText('Ndenge ya kofuta')).toBeTruthy();
    expect(screen.getByText(/français fait foi/)).toBeTruthy();
  });

  it('aucune aide publiée : message clair, jamais d’erreur bloquante', async () => {
    mockBackend({ id: 'u-contribuable', roles: ['R30'] }, (url) => (url.includes('/aide/') ? { status: 404, body: { title: 'Introuvable', code: 'AIDE_INTROUVABLE' } } : undefined));
    renderPage(<AideContextuelle cle="x.y" />);
    fireEvent.click(screen.getByRole('button', { name: 'Aide sur cet écran' }));
    expect(await screen.findByText(/Aucune aide publiée/)).toBeTruthy();
  });
});

describe('État de certification (habilitation des agents)', () => {
  it('liste ce qui manque avant affectation', async () => {
    mockBackend({ id: 'terrain-resp-module', roles: ['R07'] }, (url) => (url.includes('/v1/apprentissage/certifications/terrain-st-agent-2') ? { body: {
      applicable: true, valide: false, profil: 'RECENSEUR', certificat: null, exigences: [], manquants: ['Aucun certificat « Agents recenseurs » délivré', 'Vérification pratique sur le terrain — conforme'],
    } } : undefined));
    renderPage(<EtatCertification userId="terrain-st-agent-2" profil="RECENSEUR" />);
    expect(await screen.findByText(/non valide — ce qui manque/)).toBeTruthy();
    expect(screen.getByText(/Vérification pratique sur le terrain/)).toBeTruthy();
  });
});

describe('Espace d’apprentissage', () => {
  it('modules par rôle, épreuve soumise sans bonne réponse côté client, confidentialité affichée', async () => {
    const espace = {
      profils: [{ profil: 'RECENSEUR', nom: 'Agents recenseurs', mode: 'CERTIFICATION_AVANT_AFFECTATION', libelle: 'Certification avant affectation', contenu: 'Protocole de recensement' }],
      fiches: [{ ...fiche, cle: 'terrain.protocole', titre: 'Protocole de recensement' }],
      modules: [{ id: 'MOD-0001', type: 'MODULE', cle: 'RECENSEMENT-BASE', publics: ['RECENSEUR'], version: 1, titre: 'Recensement de base', corps: 'Module', statut: 'PUBLIEE', auteur: 'u-a', creeLe: '2026-09-01T00:00:00.000Z',
        epreuve: [{ id: 'q1', enonce: 'Accepter de l’argent ?', choix: ['Oui', 'Non'] }], derniereEpreuve: null }],
      certifications: [{ applicable: true, valide: true, profil: 'RECENSEUR', certificat: { id: 'CERT-DEMO', valableJusquau: '2027-08-27', demo: true }, manquants: [], exigences: [] }],
      seuilReussitePct: 80, statutSeuil: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage', confidentialite: CONF,
    };
    const calls = mockBackend({ id: 'u-agent-terrain', roles: ['R10'] }, (url, method) => {
      if (url.includes('/v1/apprentissage/espace')) return { body: espace };
      if (url.includes('/epreuve') && method === 'POST') return { body: { epreuve: { id: 'EPR-1', scorePct: 100, reussie: true }, note: 'Épreuve réussie.' } };
      return undefined;
    });
    renderPage(<Espace />);
    expect(await screen.findByText('Recensement de base')).toBeTruthy();
    expect(screen.getByText(/en vigueur jusqu’au 2027-08-27/)).toBeTruthy();
    expect(screen.getByText(/Aucun temps d’écran/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Passer l’épreuve/ }));
    fireEvent.click(screen.getByLabelText('Non'));
    fireEvent.click(screen.getByRole('button', { name: /Soumettre mes réponses/ }));
    expect(await screen.findByText(/Score 100 %/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ reponses: { q1: 1 } });
  });
});

describe('Administration des certifications', () => {
  it('quatre yeux : l’auteur ne voit pas « Publier » ; une autre personne publie avec motif', async () => {
    const contenu = (auteur: string) => [{ id: 'FICHE-0012', type: 'FICHE', cle: 'canaux.enrolement', publics: ['GUICHET'], versions: [{ version: 1, titre: 'Enrôler', corps: 'Texte', statut: 'PROPOSEE', auteur, creeLe: '2026-09-01T00:00:00.000Z', proposition: { par: auteur, le: '2026-09-01T00:00:00.000Z' } }] }];
    const registre = { lignes: [], evaluations: [], today: '2026-09-26', parametres: { statut: 'PAR_DEFAUT', seuilReussiteEpreuvePct: 80, validiteCertificatJours: {}, evaluationContinueIntervalleJours: 90, echantillonTaille: 10, echantillonConformiteMinPct: 90, note: 'Valeurs par défaut' }, liensIndicateurs: [], evaluateurs: {}, evaluationExigee: {} };
    const calls = mockBackend({ id: 'u-dg-dgipk', roles: ['R06'] }, (url, method) => {
      if (url.endsWith('/v1/apprentissage/certifications')) return { body: registre };
      if (url.endsWith('/v1/apprentissage/contenus') && method === 'GET') return { body: contenu('u-admin-entite') };
      if (url.includes('/publication/decision')) return { body: {} };
      return undefined;
    });
    renderPage(<Certifications />);
    fireEvent.click(await screen.findByRole('tab', { name: /Contenus/ }));
    expect(await screen.findByText('Enrôler')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Motif de la décision'), { target: { value: 'Relu et conforme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publier' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/FICHE-0012/publication/decision'))).toBe(true));
    expect(calls.find((c) => c.url.includes('/publication/decision'))?.body).toEqual({ approve: true, motif: 'Relu et conforme' });
  });

  it('indicateurs : « non mesuré » sans dossiers examinés, couverture agrégée', async () => {
    mockBackend({ id: 'u-dg-dgipk', roles: ['R06'] }, (url) => {
      if (url.endsWith('/v1/apprentissage/certifications')) return { body: { lignes: [], evaluations: [], parametres: { note: '' } } };
      if (url.includes('/v1/apprentissage/indicateurs')) return { body: {
        comprehension: { definition: 'Part des dossiers complets du premier coup', statut: 'NON_MESURE', tauxPct: null, libelle: 'non mesuré', examines: 0, completsDuPremierCoup: 0, sources: [], note: 'Agrégé' },
        couverture: [{ profil: 'RECENSEUR', libelle: 'Agents recenseurs', mode: 'Certification avant affectation', enVigueur: 5, expires: 0, retires: 0, echeanceSous30j: 0 }],
        confidentialite: CONF, publics: [],
      } };
      return undefined;
    });
    renderPage(<Certifications />);
    fireEvent.click(await screen.findByRole('tab', { name: /Indicateurs/ }));
    expect(await screen.findByText('non mesuré')).toBeTruthy();
    expect(screen.getByText('Certification avant affectation')).toBeTruthy();
  });

  it('mes certificats : démonstration signalée', async () => {
    mockBackend({ id: 'u-controleur', roles: ['R11'] }, (url) => (url.includes('/mes-certificats') ? { body: [{
      id: 'CERT-DEMO-CONTROLEUR-u-controleur', userId: 'u-controleur', profil: 'CONTROLEUR', libelleProfil: 'Contrôleurs', delivreLe: '2025-10-21T09:00:00.000Z', valableJusquau: '2026-10-21',
      delivrePar: 'u-dg-dgipk', fondement: { epreuves: [], evaluations: [], note: 'Certificat de démonstration [EXEMPLE]' }, statut: 'DELIVRE', enVigueur: true, demo: true,
    }] } : undefined));
    renderPage(<MesCertificats />);
    expect(await screen.findByText('CERT-DEMO-CONTROLEUR-u-controleur')).toBeTruthy();
    expect(screen.getByText(/\[EXEMPLE\]/)).toBeTruthy();
  });
});
