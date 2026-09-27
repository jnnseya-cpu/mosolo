import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ORDRE_FAMILLES, ROLES } from '@mosolo/shared';
import { AppProvider } from '../src/context';
import TypesDeComptes, { familyStatusRows, type AccountType, type AccountTypesRef } from '../src/modules/acces/TypesDeComptes';
import Departements, { orderDepts, type DeptNode } from '../src/modules/acces/Departements';
import { groupByFamily } from '../src/components/Selectors';
import { sansMasques } from '../src/hooks/useMenuRattachements';
import { MODULE_ROUTES } from '../src/modules/registry';

// jsdom n'a pas ResizeObserver (Recharts et trousse de visualisation) : bouchon inerte.
if (typeof globalThis.ResizeObserver === 'undefined') {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
}

function mockApi(routes: Record<string, unknown>) {
  globalThis.fetch = vi.fn((url: string) => {
    const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
    if (!hit) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve(new Response(JSON.stringify(hit[1]), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
}

function renderAt(path: string, el: JSX.Element) {
  return render(
    <AppProvider initialLang="fr">
      <MemoryRouter initialEntries={[path]}><Routes><Route path={path} element={el} /></Routes></MemoryRouter>
    </AppProvider>,
  );
}

const TYPES: AccountTypesRef = {
  total: 3, scope: 'TOUT', note: 'Décomptes vivants',
  families: ORDRE_FAMILLES.map((f) => ({ code: f, label: f === 'TRESOR' ? 'Trésor' : f === 'PUBLIC' ? 'Public' : f, count: f === 'TRESOR' ? 2 : f === 'PUBLIC' ? 1 : 0 })),
  types: Object.entries(ROLES).map(([code, label]): AccountType => ({
    code, label, family: code === 'R17' ? 'TRESOR' : code === 'R30' ? 'PUBLIC' : 'AUTORITE', familyLabel: code === 'R17' ? 'Trésor' : code === 'R30' ? 'Public' : 'Autorité',
    creationPath: code === 'R30' ? 'INSCRIPTION_PUBLIQUE' : 'INVITATION', creationPathLabel: code === 'R30' ? 'Inscription publique (téléphone vérifié)' : 'Invitation en cascade',
    invitableBy: code === 'R30' ? [] : [{ code: 'R26', label: 'Super-administrateur' }], inviteNote: 'Note', level: null, levelLabel: 'Opérateur', sensitive: code === 'R17',
    secondValidation: code === 'R17' ? { code: 'SECURITE', label: 'Seconde validation sécurité' } : null, mfa: { code: 'TOTP_OU_SMS', label: 'Second facteur' },
    entityKinds: [{ code: 'TRESOR', label: 'Trésor provincial' }], entityKindsStatus: 'Indicatif', count: code === 'R17' ? 2 : code === 'R30' ? 1 : 0,
    byStatus: code === 'R17' ? { ACTIF: 1, ATTENTE_VALIDATION: 1 } : code === 'R30' ? { ACTIF: 1 } : {},
    exemples: code === 'R17' ? [{ id: 'u-tresor', name: 'Comptable public (démo)', tag: '[EXEMPLE]' }] : [],
  })),
};

const TREE: DeptNode[] = [
  { id: 'GOUVERNORAT', name: 'Gouvernorat', shortName: 'Gouvernorat', kind: 'EXECUTIF', kindLabel: 'Exécutif provincial', parentId: null, status: 'ACTIVE', demo: true, modules: 0, accounts: 3, pendingLinks: 0 },
  { id: 'COMMUNE-LIMETE', name: 'Commune de Limete (démo)', shortName: 'Limete', kind: 'COMMUNE', kindLabel: 'Commune / ETD', parentId: 'GOUVERNORAT', status: 'ACTIVE', demo: true, modules: 1, accounts: 2, pendingLinks: 1 },
];

const VIEW = {
  entity: { id: 'GOUVERNORAT', name: 'Gouvernorat de la Ville-Province', shortName: 'Gouvernorat', kind: 'EXECUTIF', kindLabel: 'Exécutif provincial', parentId: null, status: 'ACTIVE', lineage: ['GOUVERNORAT'] },
  modules: [
    { code: 'M38', label: 'Gestion documentaire', kind: 'MODULE', revenue: false, revenueScope: null, linkable: true, screens: ['/documents'], attached: true, inheritedFrom: [], source: 'LIEN', sharedRead: false, pending: [] },
    { code: 'M14', label: 'Stationnement public', kind: 'MODULE', revenue: true, revenueScope: 'STATIONNEMENT', linkable: true, screens: ['/stationnement'], attached: false, inheritedFrom: [], source: null, sharedRead: false, pending: [] },
    { code: 'M74', label: 'Invitations et gestion des accès', kind: 'MODULE', revenue: false, revenueScope: null, linkable: false, screens: [], attached: false, inheritedFrom: [], source: null, sharedRead: false, pending: [] },
  ],
  history: [{ id: 'LNK-1', moduleCode: 'M38', moduleLabel: 'Gestion documentaire', entity: 'GOUVERNORAT', revenue: false, action: 'RATTACHEMENT', status: 'ACTIF', from: '2026-09-26', motif: 'Test', createdBy: 'u-superadmin', createdAt: '2026-09-26T09:00:00Z', history: [{ at: '2026-09-26T09:00:00Z', by: 'u-superadmin', action: 'RATTACHE' }], effectiveNow: true }],
  accountsByType: [{ role: 'R01', label: 'Gouverneur', family: 'AUTORITE', familyLabel: 'Autorité', byStatus: { ACTIF: 1 }, total: 1 }],
  users: [{ id: 'u-gouverneur', fullName: 'Gouverneur (démo)', roles: ['R01'], status: 'ACTIF' }],
  contracts: [],
};

const EFF = {
  entity: 'GOUVERNORAT', lineage: ['GOUVERNORAT'], resolution: 'entité → entité parente → valeur globale du registre', modulableStatus: 'PAR_DEFAUT — à confirmer', note: 'Barèmes : quatre visas.',
  items: [{
    id: 'postes.notifications.plafond_defaut', label: 'Notifications par jour', category: 'Postes', unit: 'notifications', owner: 'REGISTRE', globalValue: 5, value: 3,
    provenance: 'ENTITE', sourceEntity: 'GOUVERNORAT', modulable: true, modulableStatus: 'PAR_DEFAUT', consumer: 'postes/service.ts', min: 1, max: 100,
    override: { value: 3, effectiveFrom: '2026-09-26' }, programmed: [], pending: [],
  }],
};

describe('Types de comptes', () => {
  it('affiche les 37 rôles, le parcours de création, la seconde validation et les comptes [EXEMPLE]', async () => {
    mockApi({ '/v1/acces/types-de-comptes': TYPES });
    renderAt('/acces/types-de-comptes', <TypesDeComptes />);
    expect(await screen.findByRole('heading', { name: 'Types de comptes' })).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Types de comptes' });
    expect(within(list).getAllByRole('listitem').filter((li) => li.className.includes('dp-type'))).toHaveLength(37);
    expect(screen.getAllByText('Seconde validation sécurité').length).toBeGreaterThan(0);
    expect(screen.getByText(/\[EXEMPLE\] Comptable public/)).toBeTruthy();
    expect(screen.getByText('Personne (inscription publique)')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Rechercher'), { target: { value: 'R17' } });
    expect(within(list).getAllByRole('listitem').filter((li) => li.className.includes('dp-type'))).toHaveLength(1);
  });

  it('agrégation famille × état : décomptes exacts, jamais inventés', () => {
    const rows = familyStatusRows(TYPES);
    expect(rows.find((r) => r.key === 'TRESOR')!.values).toMatchObject({ ACTIF: 1, ATTENTE_VALIDATION: 1, REVOQUE: 0 });
    expect(rows.find((r) => r.key === 'PUBLIC')!.values.ACTIF).toBe(1);
  });
});

describe('Départements, modules et variables', () => {
  it('arborescence, modules à interrupteurs (transverse désactivé), recettes signalées, variables avec provenance', async () => {
    mockApi({
      '/v1/acces/departements/GOUVERNORAT': VIEW, '/v1/acces/departements': { items: TREE }, '/v1/parametres/effectifs': EFF,
    });
    renderAt('/acces/departements', <Departements />);
    expect(await screen.findByRole('heading', { name: 'Départements, modules et variables' })).toBeTruthy();
    expect(await screen.findByRole('switch', { name: /Détacher M38/ })).toBeTruthy();
    expect((screen.getByRole('switch', { name: /Rattacher M74/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Recettes : STATIONNEMENT')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: /Rattacher M14/ }));
    expect(await screen.findByLabelText('Référence de l’acte (arrêté, décision)')).toBeTruthy();
    expect(screen.getByText(/seconde validation par une personne distincte/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Variables/ }));
    expect(await screen.findByText('Valeur propre à l’entité')).toBeTruthy();
    expect(screen.getByText('Globale : 5')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Historique/ }));
    expect(await screen.findByText(/rattache — u-superadmin/)).toBeTruthy();
  });

  it('ordre de l’arborescence : parent avant enfant', () => {
    expect(orderDepts([...TREE].reverse()).map((e) => e.id)).toEqual(['GOUVERNORAT', 'COMMUNE-LIMETE']);
  });
});

describe('Menu, sélecteur de démonstration et registre', () => {
  it('sélecteur : comptes regroupés par famille dans l’ordre des familles ; sans rôle en dernier', () => {
    const groups = groupByFamily([
      { id: 'a', name: 'A', roles: ['R30'] }, { id: 'b', name: 'B', roles: ['R01'] }, { id: 'c', name: 'C', roles: ['R17'] }, { id: 'd', name: 'D', roles: [] },
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Autorité', 'Trésor', 'Public', 'Sans rôle (en attente)']);
  });

  it('menu : les écrans masqués par les rattachements sont retirés, jamais l’accueil', () => {
    const items = [{ to: '/' }, { to: '/documents' }, { to: '/tresor' }];
    expect(sansMasques(items, new Set(['/documents', '/'])).map((i) => i.to)).toEqual(['/', '/tresor']);
    expect(sansMasques(items, new Set())).toBe(items);
  });

  it('registre : deux nouveaux écrans, noms français, visibles de R26 et R08', () => {
    const t = MODULE_ROUTES.find((m) => m.path === '/acces/types-de-comptes')!;
    const d = MODULE_ROUTES.find((m) => m.path === '/acces/departements')!;
    expect(t.nav!.label).toBe('Types de comptes');
    expect(d.nav!.roles).toEqual(['R26', 'R08']);
  });
});
