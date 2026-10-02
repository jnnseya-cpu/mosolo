import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { RULE_TECHNICAL_ATTRIBUTES, SAMPLE_RULES } from '@mosolo/shared';
import { AppProvider } from '../src/context';
import { AttenteBaseLegale } from '../src/modules/juridique/AttenteBaseLegale';
import { RuleTechnicalView } from '../src/modules/juridique/RuleJuridiqueTools';
import PointsJuridiques, { type Registre } from '../src/modules/juridique/PointsJuridiques';
import DonneesConservation from '../src/modules/juridique/DonneesConservation';

const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } }));

function mockApi(user: { id: string; roles: string[] } | null, routes: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    if (user && String(url).includes('/v1/demo/users')) return json([{ ...user, name: `${user.id} (démo)`, entity: 'MINFIN' }]);
    const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
    if (!hit) return Promise.reject(new TypeError('Failed to fetch'));
    return json(hit[1]);
  }) as unknown as typeof fetch;
  localStorage.removeItem('mosolo.demoUser');
  return calls;
}
const renderApp = (el: JSX.Element) => render(<AppProvider initialLang="fr">{el}</AppProvider>);

describe('Mention « en attente de base légale »', () => {
  it('affiche le message du registre, rien quand le point est tranché, l’hypothèse prudente hors ligne', async () => {
    mockApi(null, { '/v1/public/juridique/fonctions/COMMISSIONS_VERSEMENT': { code: 'COMMISSIONS_VERSEMENT', label: 'Versement', enAttente: true, message: 'Paiement en attente de base légale (J10).', points: [] } });
    const a = renderApp(<AttenteBaseLegale fonction="COMMISSIONS_VERSEMENT" />);
    expect((await screen.findByRole('note')).textContent).toContain('Paiement en attente de base légale (J10).');
    a.unmount();
    mockApi(null, { '/v1/public/juridique/fonctions/AGREGATEURS_ACTIVATION': { code: 'AGREGATEURS_ACTIVATION', label: 'Agrégateurs', enAttente: false, message: 'Base légale tranchée.', points: [] } });
    const b = renderApp(<AttenteBaseLegale fonction="AGREGATEURS_ACTIVATION" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('note')).toBeNull();
    b.unmount();
    mockApi(null, {});
    renderApp(<AttenteBaseLegale fonction="QUITTANCE_ELECTRONIQUE" />);
    expect((await screen.findByRole('note')).textContent).toMatch(/J7, J17/);
  });
});

describe('Vue technique d’une fiche (attributs du registre § 6.2)', () => {
  it('présente les 21 attributs snake_case du Cahier avec leur valeur', () => {
    mockApi(null, {});
    renderApp(<RuleTechnicalView rule={SAMPLE_RULES[0]!} />);
    const table = screen.getByRole('table');
    for (const a of RULE_TECHNICAL_ATTRIBUTES) expect(within(table).getAllByText(a.attribut).length).toBeGreaterThan(0);
    expect(within(table).getByText('KIN-DGIPK-RECETTES-01')).toBeTruthy();
  });
});

const registre: Registre = {
  points: [
    { code: 'J10', question: 'Régime des incitations des agents (primes, quotes-parts)', autorite: 'Finances', hypothese: 'Aucune prime calculée par la plateforme', verrou: 'Mode indicateurs', source: 'Document maître § 6.13', statut: 'OUVERT',
      proposition: { acte: { reference: 'ARR-1 (fictif)', titre: 'Arrêté fictif', sha256: 'a'.repeat(64) }, motif: 'Acte publié (test).', proposedBy: 'u-juriste-verificateur', proposedAt: '2026-09-26T09:00:00.000Z' },
      decision: null, annexeB: [8], septQuestions: [6], fonctions: ['COMMISSIONS_VERSEMENT'] },
    { code: 'J14', question: 'Base légale des échéanciers', autorite: 'Finances / Assemblée provinciale', hypothese: 'Modules désactivés', verrou: '—', source: 'Document maître § 6.13', statut: 'TRANCHE', proposition: null,
      decision: { acte: { reference: 'EDIT-2026 (fictif)', titre: 'Édit fictif', sha256: 'b'.repeat(64) }, motif: 'ok', proposedBy: 'x', decidedBy: 'y', at: '2026-09-26T09:00:00.000Z' }, annexeB: [], septQuestions: [4], fonctions: [] },
  ],
  septQuestions: [{ rang: 4, question: 'Base légale des échéanciers de paiement par Mobile Money', autorite: 'Assemblée provinciale ou arrêté', effet: 'Impossible de proposer le paiement fractionné', points: ['J14'], statut: 'TRANCHE' }],
  annexeB: [{ point: 8, objet: 'Régime légal des primes', points: ['J10'], statut: 'OUVERT' }],
  fonctions: [{ code: 'COMMISSIONS_VERSEMENT', label: 'Versement des commissions des agents', enAttente: true, message: 'Paiement en attente de base légale (J10).', points: [{ code: 'J10', statut: 'OUVERT', question: '…' }] }],
  summary: { total: 30, ouverts: 29, tranches: 1 },
  note: 'Trancher un point exige un acte.',
};

describe('Registre des points juridiques', () => {
  it('liste les points, les propositions à décider (autre personne) et les vues § 6.4 / annexe B', async () => {
    const calls = mockApi({ id: 'u-autorite-publication', roles: ['R16'] }, {
      '/v1/juridique/points/J10/decision': { ...registre.points[0], statut: 'TRANCHE' },
      '/v1/juridique/points': registre,
      '/v1/legal-instruments/completude': { complet: true, absents: [], lignes: [{ texte: 'Ordonnance-loi n° 13/001', objet: 'Ancienne nomenclature', usage: 'ABROGÉE', statut: 'ABROGE', complet: true, instruments: [{ id: 'ol-13-001', present: true, status: 'ABROGE' }] }] },
    });
    renderApp(<PointsJuridiques />);
    expect(await screen.findByRole('heading', { name: 'Propositions à décider' })).toBeTruthy();
    expect(screen.getAllByText('Tranché').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Motif de décision J10'), { target: { value: 'Acte vérifié : point tranché.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trancher' }));
    await new Promise((r) => setTimeout(r, 20));
    const post = calls.find((c) => c.url.includes('/v1/juridique/points/J10/decision'));
    expect(JSON.parse(String(post!.init!.body))).toEqual({ approve: true, motif: 'Acte vérifié : point tranché.' });
    fireEvent.click(screen.getByRole('button', { name: /Sept questions/ }));
    expect(screen.getByText('Impossible de proposer le paiement fractionné')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Textes/ }));
    expect(await screen.findByText('Abrogé')).toBeTruthy();
  });
});

describe('Classification et conservation des données', () => {
  it('affiche la classe de chaque dépôt et l’aperçu de purge ; propose seulement si des enregistrements sont échus', async () => {
    const calls = mockApi({ id: 'integrite-u-dpo', roles: ['R25'] }, {
      '/v1/juridique/donnees/classification': {
        classes: { C1: 'Public', C2: 'Interne', C3: 'Personnel', C4: 'Personnel sensible / secret fiscal', C5: 'Secret' }, aClasser: 0, note: 'Classification par dépôt et par champ.',
        depots: [
          { depot: 'payments.orders', enregistrements: 4, classe: 'C4', nature: 'FINANCIER', libelle: 'Ordres de paiement', source: 'PREFIXE', champs: {}, conservation: null, purgeable: false, refusPurge: 'Dépôt protégé' },
          { depot: 'ext.acces.otps', enregistrements: 1, classe: 'C4', nature: 'TECHNIQUE', libelle: 'Codes à usage unique', source: 'EXACT', champs: { codeHash: 'C5' }, conservation: { parametre: 'conservation.codes_otp_jours', champDate: 'createdAt', champsEffaces: ['codeHash'] }, purgeable: true, refusPurge: null },
        ],
      },
      '/v1/juridique/donnees/purges/apercu': { generatedAt: '2026-09-26T09:00:00.000Z', total: 1, lignes: [{ depot: 'ext.acces.otps', parametre: 'conservation.codes_otp_jours', dureeJours: 30, statut: 'ELIGIBLE', ids: ['OTP-1'], champsEffaces: ['codeHash'] }] },
      '/v1/juridique/donnees/purges': { items: [] },
    });
    renderApp(<DonneesConservation />);
    expect(await screen.findByText('Ordres de paiement')).toBeTruthy();
    expect(screen.getByText(/Non — Dépôt protégé/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Aperçu (simulation)' }));
    expect(await screen.findByText('Éligible')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Motif de la proposition de purge'), { target: { value: 'Purge des codes échus.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Proposer la purge' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.url.endsWith('/v1/juridique/donnees/purges') && c.init?.method === 'POST')).toBe(true);
  });
});
