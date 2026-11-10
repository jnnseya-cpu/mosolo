import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppProvider } from '../src/context';
import { setDemoUser } from '../src/lib/api';
import { visibleNav } from '../src/components/Shell';
import { gateDecisionGuard, GovernancePanel, HorizonsPanel, OperatingModelPanel, parseCalendar, PhasesPanel, type Governance, type OperatingModel, type Roadmap } from '../src/modules/pilotage/FeuilleDeRoute';
import { IllustrativeExamplePanel, type IllustrativeExample } from '../src/modules/pilotage/Scenarios';

function mockApi(userId: string, roles: string[]) {
  setDemoUser(userId);
  globalThis.fetch = vi.fn((url: string) => (String(url).includes('/v1/demo/users')
    ? Promise.resolve(new Response(JSON.stringify([{ id: userId, name: 'Test', roles, entity: 'MINFIN' }]), { status: 200, headers: { 'content-type': 'application/json' } }))
    : Promise.reject(new TypeError('Failed to fetch')))) as unknown as typeof fetch;
}
afterEach(() => { setDemoUser(null); localStorage.clear(); });

const staffing = { ok: false, sansBinome: [{ postId: 'P1', roleLabel: 'Architecte' }], jalonsEnRetard: [] };
const roadmap: Roadmap = {
  today: '2026-09-26', programme: { startDate: '2026-08-01', note: null }, staffing, rule: 'Deux personnes, jamais automatique.',
  phases: [
    { code: 'P0', rank: 0, label: 'Phase 0 — Mandat et mobilisation juridique', objectifs: 'Sponsor, gouvernance', livrablesTexte: 'Décision provinciale', porteDeSortie: 'Décision signée et référentiel juridique arrêté', state: 'FRANCHIE', stateLabel: 'Porte franchie', canStart: false,
      livrables: [{ code: 'P0-L1', label: 'Décision provinciale', proofs: [{ id: 'PRV-1', livrable: 'P0-L1', reference: 'DOC', sha256: 'a'.repeat(64), by: 'u', at: '2026-09-01' }] }],
      gates: [{ id: 'G1', phase: 'P0', requestedBy: 'u-a', requestedAt: '2026-09-20', motif: 'm', proofIds: ['PRV-1'], status: 'FRANCHIE', decision: { by: 'u-b', at: '2026-09-21', approve: true, motif: 'Référentiel arrêté', meetingId: 'REUNION-1' } }] },
    { code: 'P1', rank: 1, label: 'Phase 1 — Cadrage et architecture', objectifs: 'Architecture', livrablesTexte: 'Spécifications', porteDeSortie: 'Architecture validée et pilote approuvé', state: 'A_VENIR', stateLabel: 'À venir', canStart: true, livrables: [{ code: 'P1-L1', label: 'Spécifications', proofs: [] }], gates: [] },
  ],
  horizons: [{ code: 'H30J', label: '30 jours', dueDate: '2026-08-31', preuveAttendue: 'Acte de nomination, relevé juridique signé, inventaire remis', overdueCount: 1, doneCount: 0,
    actions: [{ code: 'H30J-A1', label: 'Décision provinciale', owner: null, status: 'A_FAIRE', statusLabel: 'À faire', proof: null, dueDate: '2026-08-31', overdue: true }] }],
  overdueActions: [{ horizon: '30 jours', code: 'H30J-A1', label: 'Décision provinciale', dueDate: '2026-08-31' }],
};

describe('Feuille de route — gardes d’interface (le serveur reste juge)', () => {
  it('porte : comité de pilotage, personne distincte du demandeur, réunion consignée', () => {
    const g = { status: 'DEMANDEE' as const, requestedBy: 'u-a' };
    expect(gateDecisionGuard(g, { id: 'u-a', roles: ['R05'] }, 1)).toMatch(/autre personne/);
    expect(gateDecisionGuard(g, { id: 'u-b', roles: ['R17'] }, 1)).toMatch(/comité de pilotage/);
    expect(gateDecisionGuard(g, { id: 'u-b', roles: ['R01'] }, 0)).toMatch(/Consigner d’abord/);
    expect(gateDecisionGuard(g, { id: 'u-b', roles: ['R01'] }, 1)).toBeNull();
    expect(gateDecisionGuard({ ...g, status: 'FRANCHIE' }, { id: 'u-b', roles: ['R01'] }, 1)).toMatch(/déjà/);
  });

  it('calendrier de transfert écrit ; navigation réservée aux rôles de pilotage', () => {
    expect(parseCalendar('2026-12-01;Reprise du déploiement\n\n2027-03-01;Exploitation autonome')).toEqual([{ dueDate: '2026-12-01', label: 'Reprise du déploiement' }, { dueDate: '2027-03-01', label: 'Exploitation autonome' }]);
    const has = (roles: string[]) => visibleNav(roles).some((n) => n.to === '/pilotage/feuille-de-route');
    expect(has(['R01'])).toBe(true);
    expect(has(['R36'])).toBe(true);
    expect(has(['R10'])).toBe(false);
    expect(has(['R30'])).toBe(false);
  });
});

describe('Feuille de route — écrans', () => {
  it('phases avec état de porte, décision motivée ; blocage du transfert signalé', () => {
    mockApi('u-g', ['R01']);
    render(<AppProvider initialLang="fr"><PhasesPanel r={roadmap} meetings={[]} onDone={() => {}} /></AppProvider>);
    expect(screen.getByText('Porte franchie')).toBeTruthy();
    expect(screen.getByText(/Référentiel arrêté \(réunion REUNION-1\)/)).toBeTruthy();
    expect(screen.getByText(/1 poste\(s\) externe\(s\) sans binôme provincial/)).toBeTruthy();
  });

  it('horizons : actions en retard signalées', () => {
    mockApi('u-g', ['R01']);
    render(<AppProvider initialLang="fr"><HorizonsPanel r={roadmap} onDone={() => {}} /></AppProvider>);
    expect(screen.getByText(/1 action\(s\) en retard/)).toBeTruthy();
    expect(screen.getByText('À faire — en retard')).toBeTruthy();
  });

  it('modèle opérationnel : effectif indicatif, poste sans binôme, autonomie', () => {
    mockApi('u-g', ['R01']);
    const m: OperatingModel = {
      principe: 'Le principe d’exploitation est la montée en autonomie', effectifsNote: 'Effectifs indicatifs', staffing,
      functions: [{ code: 'INGENIERIE', label: 'Ingénierie', effectifIndicatif: '6 à 10 développeurs, 1 architecte, 1 spécialiste données spatiales', rattachement: 'Prestataire avec transfert de compétences', externeParDefaut: true,
        posts: [{ id: 'P1', functionCode: 'INGENIERIE', roleLabel: '[EXEMPLE] Architecte (prestataire)', holderLabel: 'Poste à pourvoir', external: true, example: true, transferComplete: false, overdueMilestones: [], progress: null }] }],
      autonomy: { externalPosts: 1, transferred: 0, sharePct: '0.0', note: 'Part des postes externes transférés' },
    };
    render(<AppProvider initialLang="fr"><OperatingModelPanel m={m} onDone={() => {}} /></AppProvider>);
    expect(screen.getByText('Sans binôme')).toBeTruthy();
    expect(screen.getAllByText(/indicatif au pilote/).length).toBeGreaterThan(0);
    expect(screen.getByText(/0.0 % des postes externes transférés/)).toBeTruthy();
  });

  it('gouvernance : réunion en retard, fréquence par défaut à confirmer, liens vers les circuits existants', () => {
    mockApi('u-g', ['R01']);
    const g: Governance = {
      today: '2026-09-26', delaisNote: 'Délais : PAR_DEFAUT — à confirmer par le maître d’ouvrage.', meetings: [],
      bodies: [{ code: 'COMITE_DONNEES', label: 'Comité des données', composition: ['Responsable des données'], role: 'Protocoles, finalités, conservation, publications', frequence: 'Mensuelle', delaiJours: 31, delaiStatut: 'PAR_DEFAUT', secretariat: ['R25'],
        liens: [{ type: 'CIRCUIT', reference: 'SOCLE_EXTRACTION_MASSIVE', description: 'Extraction massive' }], lastMeetingDate: null, nextDueDate: null, overdue: true, flag: 'Aucune réunion consignée' }],
    };
    render(<AppProvider initialLang="fr"><GovernancePanel g={g} onDone={() => {}} /></AppProvider>);
    expect(screen.getByText('Aucune réunion consignée')).toBeTruthy();
    expect(screen.getByText(/31 jours — par défaut, à confirmer/)).toBeTruthy();
    expect(screen.getByText('SOCLE_EXTRACTION_MASSIVE')).toBeTruthy();
  });

  it('exemple illustratif (§ 39.3) : [EXEMPLE], recalcul concordant, avertissement méthodologique', () => {
    mockApi('u-g', ['R01']);
    const x: IllustrativeExample = {
      titre: 'Exemple illustratif, à remplacer par les données du pilote', source: 'Cahier § 39.3', formula: 'même fonction', concordance: true,
      colonnes: ['Ligne', 'Objets (hypothèse)', 'Montant annuel moyen (hypothèse)', 'Conformité actuelle → cible (hypothèse)', 'Gain illustratif'],
      avertissement: 'Les valeurs du tableau ci-dessus sont des hypothèses de travail destinées à illustrer la mécanique de calcul.',
      lignes: [{ ligne: 'Revenus locatifs', objetsTexte: '2 000 000 unités louées', montantTexte: '158 USD', conformiteTexte: '8 % → 35 %', gainTexte: '≈ 85 M USD', marque: '[EXEMPLE] hypothèse', gainCalcule: { amount: '85320000.00', currency: 'USD' }, gainMillionsCalcule: 85, gainMillionsCahier: 85, concordance: true }],
    };
    render(<AppProvider initialLang="fr"><IllustrativeExamplePanel x={x} /></AppProvider>);
    expect(screen.getByText(/\[EXEMPLE\] Exemple illustratif/)).toBeTruthy();
    expect(screen.getByText('≈ 85 M USD, concordant')).toBeTruthy();
    expect(screen.getByText(/hypothèses de travail destinées à illustrer/)).toBeTruthy();
  });
});
