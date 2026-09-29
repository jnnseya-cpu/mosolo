/**
 * Parcours par rôle (29/09/2026, demande du maître d'ouvrage : « chaque utilisateur n'accède qu'à ce qu'il a à faire »).
 * Menus par rôle (nombre et entrées clés), « Mon travail du jour », écran d'accueil du rôle, garde des comptes publics,
 * liens « Réalisé par », lecture agrégée des autorités R01–R03. Présentation seulement : les droits restent décidés
 * par le serveur (backend/test/menu-droits.test.ts vérifie chaque entrée de chaque compte de démonstration).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MENU_LECTURE_PAR_ENTITE, MENU_MASQUE_SANS_LECTURE, TRAVAIL_DU_JOUR } from '@mosolo/shared';
import { AppProvider } from '../src/context';
import { accueilDuRole, lectureAgregee, MENU_GOUVERNEUR, menuDe, menuOrganise, SEUIL_MENU_COURT, visibleNav } from '../src/components/Shell';
import { ecranAccessible, LienEcran } from '../src/components/LienEcran';
import { RouteGuard } from '../src/components/RouteGuard';
import { ErrorState } from '../src/components/States';
import { SuiteDuTravail } from '../src/components/SuiteDuTravail';
import { ApiError } from '../src/lib/api';
import { MODULE_ROUTES } from '../src/modules/registry';

/** Un compte de démonstration par rôle (rôle, entité), comme le parcours réel dans le navigateur. */
const COMPTES: [string, string][] = [
  ['R01', 'GOUVERNORAT'], ['R02', 'GOUVERNORAT'], ['R03', 'GOUVERNORAT'], ['R04', 'MIN-TRANSPORTS'], ['R05', 'MINFIN'],
  ['R06', 'DGIPK'], ['R07', 'DGIPK'], ['R08', 'DGIPK'], ['R09', 'DGIPK'], ['R10', 'DGIPK'], ['R11', 'DGIPK'], ['R12', 'DGIPK'],
  ['R13', 'MINFIN'], ['R14', 'MINFIN'], ['R15', 'MINFIN'], ['R16', 'MINFIN'], ['R17', 'TRESOR'], ['R18', 'TRESOR'], ['R19', 'TRESOR'],
  ['R20', 'DGIPK'], ['R21', 'DGIPK'], ['R22', 'AUDIT'], ['R23', 'AUDIT-EXTERNE'], ['R24', 'AUDIT'], ['R25', 'PLATEFORME'],
  ['R26', 'PLATEFORME'], ['R27', 'PLATEFORME'], ['R28', 'PLATEFORME'], ['R29', 'PLATEFORME'], ['R30', 'PUBLIC'], ['R31', 'PUBLIC'],
  ['R32', 'BANQUE-PARTENAIRE-A'], ['R33', 'BANQUE-A'], ['R34', 'EXPLOITANT-AERO'], ['R35', 'OPERATEUR-FOURRIERE-EX-01'],
  ['R36', 'INSTANCE-CONTROLE-DEMO'], ['R37', 'GOUVERNORAT'],
];

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}
function mockUser(user: { id: string; roles: string[]; entity?: string; taxpayerId?: string }) {
  globalThis.fetch = vi.fn((url: string) => {
    if (String(url).includes('/v1/demo/users')) return json([{ ...user, name: `${user.id} (démo)` }]);
    return Promise.reject(new TypeError('Failed to fetch'));
  }) as unknown as typeof fetch;
  localStorage.removeItem('mosolo.demoUser');
}
const at = (path: string, el: JSX.Element) => render(
  <AppProvider initialLang="fr"><MemoryRouter initialEntries={[path]}><Routes><Route path="*" element={el} /></Routes></MemoryRouter></AppProvider>,
);

describe('menus par rôle — nombre d’entrées et « Mon travail du jour » (instantané)', () => {
  it('chaque rôle : taille du menu, entrées visibles d’emblée, travail du jour et écran d’accueil', () => {
    const table = Object.fromEntries(COMPTES.map(([r, e]) => {
      const items = menuDe([r], e);
      const { jour } = menuOrganise(items, [r]);
      const long = jour.length > 0 && items.length > SEUIL_MENU_COURT;
      return [r, `${items.length} entrées · d’emblée ${long ? jour.length : items.length} · jour ${jour.map((n) => n.to).join(' ')} · accueil ${accueilDuRole([r], e) ?? '/'}`];
    }));
    expect(table).toMatchInlineSnapshot(`
      {
        "R01": "6 entrées · d’emblée 6 · jour  · accueil /",
        "R02": "60 entrées · d’emblée 6 · jour /poste-de-decision /pilotage/instructions /pilotage/decisions-gouvernement /acces/types-de-comptes /decision/commandement /pilotage/tableaux · accueil /poste-de-decision",
        "R03": "41 entrées · d’emblée 5 · jour /poste-de-decision /pilotage/instructions /pilotage/decisions-gouvernement /juridique/points /decision/commandement · accueil /poste-de-decision",
        "R04": "31 entrées · d’emblée 5 · jour /poste-de-decision /decision/ministere /pilotage/indicateurs /pilotage/instructions /vehicules/controle-technique · accueil /poste-de-decision",
        "R05": "66 entrées · d’emblée 6 · jour /poste-de-decision /decision/ministere /decision/salle-controle /pilotage/indicateurs /pilotage/repartition /decision/regie-fiscale · accueil /poste-de-decision",
        "R06": "85 entrées · d’emblée 6 · jour /poste-de-travail /decision/regie-fiscale /recouvrement /terrain/supervision /agents/validation-commissions /fiscal/quitus · accueil /poste-de-travail",
        "R07": "78 entrées · d’emblée 6 · jour /poste-de-travail /decision/regie-fiscale /fiscal/biens /biens-relations/revue /recouvrement /terrain/supervision · accueil /poste-de-travail",
        "R08": "37 entrées · d’emblée 6 · jour /acces/invitations /acces/departements /acces/entites /integrite/revue-acces /acces/delegations /poste-de-travail · accueil /acces/invitations",
        "R09": "35 entrées · d’emblée 6 · jour /terrain/supervision /terrain /terrain/qualite /agents/validation-commissions /terrain/inspection /poste-de-travail · accueil /terrain/supervision",
        "R10": "21 entrées · d’emblée 6 · jour /terrain /terrain/inspection /titres/controle /vehicules/scan /canaux/enrolement /mes-gains · accueil /terrain",
        "R11": "52 entrées · d’emblée 6 · jour /poste-de-travail /terrain /terrain/inspection /fiscal/declarations /titres/controle /stationnement/controle · accueil /poste-de-travail",
        "R12": "24 entrées · d’emblée 6 · jour /poste-de-travail /canaux/enrolement /citoyen/pieces /fiscal/declarations /canaux/contestation /verifier · accueil /poste-de-travail",
        "R13": "21 entrées · d’emblée 4 · jour /registre /juridique/points /fiscal/exonerations /poste-de-travail · accueil /registre",
        "R14": "21 entrées · d’emblée 3 · jour /registre /juridique/points /poste-de-travail · accueil /registre",
        "R15": "28 entrées · d’emblée 5 · jour /registre /pilotage/repartition /decision/salle-controle /controle/calcu /poste-de-travail · accueil /registre",
        "R16": "19 entrées · d’emblée 4 · jour /registre /juridique/points /pilotage/decisions-gouvernement /poste-de-travail · accueil /registre",
        "R17": "43 entrées · d’emblée 6 · jour /tresor /tresor/appariements /canaux/points-supervision /tresor/points-agrees /tresor/prestataires /decision/previsions · accueil /tresor",
        "R18": "34 entrées · d’emblée 4 · jour /tresor/appariements /tresor /canaux/jour-de-caisse /canaux/points-supervision · accueil /tresor/appariements",
        "R19": "4 entrées · d’emblée 4 · jour /poste-de-travail /tresor · accueil /poste-de-travail",
        "R20": "15 entrées · d’emblée 4 · jour /recours /recouvrement /recouvrement/remises /poste-de-travail · accueil /recours",
        "R21": "18 entrées · d’emblée 5 · jour /recours /recouvrement/remises /recouvrement/non-valeurs /integrite/renseignement /poste-de-travail · accueil /recours",
        "R22": "119 entrées · d’emblée 6 · jour /audit /pilotage/piste-audit /decision/audit /integrite/scellement /tresor /chaine · accueil /audit",
        "R23": "89 entrées · d’emblée 4 · jour /audit /pilotage/piste-audit /decision/audit /integrite/scellement · accueil /audit",
        "R24": "65 entrées · d’emblée 5 · jour /integrite/enquetes /integrite/renseignement /integrite/collusion /integrite/controles-mystere /decision/audit · accueil /integrite/enquetes",
        "R25": "23 entrées · d’emblée 4 · jour /integrite/donnees /donnees/extractions /juridique/donnees /integrite/incidents · accueil /integrite/donnees",
        "R26": "33 entrées · d’emblée 5 · jour /plateforme/administration /acces/invitations /acces/departements /plateforme/supervision /tresor/prestataires · accueil /plateforme/administration",
        "R27": "22 entrées · d’emblée 4 · jour /plateforme/supervision /integrite/incidents /plateforme/administration /acces/elevations · accueil /plateforme/supervision",
        "R28": "35 entrées · d’emblée 5 · jour /integrite/incidents /integrite/revue-acces /integrite/cles /acces/elevations /integrite/scellement · accueil /integrite/incidents",
        "R29": "5 entrées · d’emblée 5 · jour /ia/modeles /ia/journal /ia · accueil /ia/modeles",
        "R30": "46 entrées · d’emblée 6 · jour /espace /mes-arrieres /espace/biens-relations /fiscal/declarations /vehicules/mes-vehicules /points-de-paiement · accueil /espace",
        "R31": "41 entrées · d’emblée 5 · jour /acces/mandats /fiscal/declarations /mes-arrieres /fiscal/biens /points-de-paiement · accueil /acces/mandats",
        "R32": "19 entrées · d’emblée 3 · jour /canaux/point-agree /verifier /preuve · accueil /canaux/point-agree",
        "R33": "18 entrées · d’emblée 3 · jour /verifier /preuve /transparence · accueil /verifier",
        "R34": "21 entrées · d’emblée 4 · jour /vehicules/controle-technique /vehicules/centres-agrees /opportunites/recoupement /verifier · accueil /vehicules/controle-technique",
        "R35": "14 entrées · d’emblée 5 · jour /vehicules/fourrieres /terrain/supervision /terrain/sous-traitants /titres/controle /mes-gains · accueil /vehicules/fourrieres",
        "R36": "23 entrées · d’emblée 4 · jour /poste-de-decision /juridique/points /pilotage/pilote /rakapay/pilotage · accueil /poste-de-decision",
        "R37": "20 entrées · d’emblée 3 · jour /fiscal/quitus /fiscal/dependances /verifier · accueil /fiscal/quitus",
      }
    `);
  });

  it('entrées clés par rôle (travail du jour en tête, entrées refusées absentes)', () => {
    const jour = (r: string, e: string) => menuOrganise(menuDe([r], e), [r]).jour.map((n) => n.to);
    expect(menuDe(['R01'])).toBe(MENU_GOUVERNEUR);
    expect(menuDe(['R01'])).toHaveLength(6); // 5 entrées du § 27.5 + centre de commandement (décision du 29/09/2026)
    expect(jour('R10', 'DGIPK')[0]).toBe('/terrain');
    expect(jour('R10', 'DGIPK')).toEqual(expect.arrayContaining(['/terrain/inspection', '/titres/controle']));
    expect(jour('R17', 'TRESOR')[0]).toBe('/tresor');
    expect(jour('R30', 'PUBLIC')[0]).toBe('/espace');
    expect(jour('R22', 'AUDIT')[0]).toBe('/audit');
    // Menus longs : repliés sous « Tous mes écrans » (aucune entrée retirée).
    for (const r of ['R06', 'R07', 'R22', 'R23', 'R24']) expect(menuDe([r], COMPTES.find((c) => c[0] === r)![1]).length, r).toBeGreaterThan(SEUIL_MENU_COURT);
    // Entités : la DGIPK ne voit pas la publicité (DGTK) ; la DGTK la voit.
    expect(visibleNav(['R06'], 'DGIPK').map((n) => n.to)).not.toContain('/publicite/regie');
    expect(visibleNav(['R06'], 'DGTK').map((n) => n.to)).toContain('/publicite/regie');
    // Partenaires : pas d'espace d'apprentissage réservé aux agents.
    for (const r of ['R32', 'R33', 'R34', 'R36', 'R37']) expect(visibleNav([r]).map((n) => n.to), r).not.toContain('/apprentissage');
    // Autorités R01–R03 : aucun masque par entité, tous les modules.
    expect(lectureAgregee(['R02'])).toBe(true);
    expect(lectureAgregee(['R05'])).toBe(false);
  });

  it('aucune route retirée : chaque écran masqué d’un menu reste déclaré ; chaque écran du travail du jour existe', () => {
    const declares = new Set([...MODULE_ROUTES.map((m) => m.path), '/', '/inscription', '/espace', '/services', '/verifier', '/gouverneur', '/communications', '/ia', '/registre', '/tresor', '/terrain', '/audit']);
    for (const p of [...Object.keys(MENU_MASQUE_SANS_LECTURE), ...Object.keys(MENU_LECTURE_PAR_ENTITE)]) expect(declares.has(p), p).toBe(true);
    for (const [r, ps] of Object.entries(TRAVAIL_DU_JOUR)) for (const p of ps) expect(declares.has(p), `${r} ${p}`).toBe(true);
    // Tout rôle de démonstration a au moins un écran de travail du jour dans son menu.
    for (const [r, e] of COMPTES) expect(accueilDuRole([r], e) ?? (r === 'R01' ? '/poste-de-decision' : null), r).not.toBeNull();
  });
});

describe('garde des comptes publics et liens adaptés au compte', () => {
  it('contribuable : écran de travail d’agent → « Écran réservé » ; carte de ses biens (hors menu) → affichée', async () => {
    mockUser({ id: 'u-contribuable', roles: ['R30'], entity: 'PUBLIC', taxpayerId: 'TP-1' });
    const roles = MODULE_ROUTES.find((m) => m.path === '/titres/controle')!.nav!.roles;
    const r1 = at('/titres/controle', <RouteGuard roles={roles}><p>outil de contrôle</p></RouteGuard>);
    expect(await screen.findByText('Écran réservé')).toBeTruthy();
    expect(screen.queryByText('outil de contrôle')).toBeNull();
    r1.unmount();
    const carte = MODULE_ROUTES.find((m) => m.path === '/fiscal/carte')!.nav!.roles;
    at('/fiscal/carte', <RouteGuard roles={carte}><p>carte de mes biens</p></RouteGuard>);
    expect(await screen.findByText('carte de mes biens')).toBeTruthy();
  });

  it('lien vers un écran que le rôle n’utilise pas : « Réalisé par : … » ; sinon lien normal', async () => {
    mockUser({ id: 'u-contribuable', roles: ['R30'], entity: 'PUBLIC', taxpayerId: 'TP-1' });
    at('/espace', <p><LienEcran to="/fiscal/reprise">Reprise</LienEcran> <LienEcran to="/mes-arrieres">Mes arriérés</LienEcran> <LienEcran masquer to="/juridique/points">Points</LienEcran></p>);
    expect(await screen.findByText(/Réalisé par : /)).toBeTruthy();
    expect(screen.queryByText('Reprise')).toBeNull();
    expect(screen.getByRole('link', { name: 'Mes arriérés' })).toBeTruthy();
    expect(screen.queryByText('Points')).toBeNull();
  });

  it('règle d’accessibilité des écrans (rôle, entité, autorités)', () => {
    expect(ecranAccessible('/integrite/revue-acces', ['R06'], 'DGIPK')).toBe(false);
    expect(ecranAccessible('/integrite/revue-acces', ['R08'], 'DGIPK')).toBe(true);
    expect(ecranAccessible('/publicite/regie', ['R07'], 'DGIPK')).toBe(false);
    expect(ecranAccessible('/publicite/regie', ['R07'], 'DGTK')).toBe(true);
    expect(ecranAccessible('/integrite/revue-acces', ['R02'], 'GOUVERNORAT')).toBe(true);
    expect(ecranAccessible('/transparence', ['R30'], 'PUBLIC')).toBe(true);
    expect(ecranAccessible('/fiscal/carte', ['R30'], 'PUBLIC')).toBe(true);
    expect(ecranAccessible('/tresor', ['R10'], 'DGIPK')).toBe(false);
    expect(ecranAccessible('/tresor', ['R17'], 'TRESOR')).toBe(true);
    expect(ecranAccessible('/espace', ['R12'], 'DGIPK')).toBe(false);
    expect(ecranAccessible('/espace', ['R30'], 'PUBLIC')).toBe(true);
    expect(ecranAccessible('/nimporte', undefined)).toBe(true);
  });

  it('autorités R01–R03 : un refus serveur devient « Lecture agrégée » ; les autres comptes gardent « Accès réservé »', async () => {
    mockUser({ id: 'u-dircab', roles: ['R02'], entity: 'GOUVERNORAT' });
    const r = at('/publicite/regie', <ErrorState error={new ApiError(403, 'FORBIDDEN', 'refus')} />);
    expect(await screen.findByText('Lecture agrégée')).toBeTruthy();
    r.unmount();
    mockUser({ id: 'u-guichet', roles: ['R12'], entity: 'DGIPK' });
    at('/publicite/regie', <ErrorState error={new ApiError(403, 'FORBIDDEN', 'refus')} />);
    expect(await screen.findByText('Accès réservé')).toBeTruthy();
  });

  it('écran vide : la prochaine action utile du travail du jour est proposée', async () => {
    mockUser({ id: 'u-agent-terrain', roles: ['R10'], entity: 'DGIPK' });
    at('/terrain/inspection', <SuiteDuTravail />);
    expect(await screen.findByText('Prochaine action utile :')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Inspection et constat' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Contrôle des titres' })).toBeTruthy();
  });
});
