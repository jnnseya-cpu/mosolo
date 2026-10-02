import { describe, expect, it } from 'vitest';
import { auditActionLabel, categoryLabel, humanize, levelLabel } from '../src/lib/labels';
import { visibleNav } from '../src/components/Shell';
import { shortLabel } from '../src/components/Selectors';

describe('libellés humains', () => {
  it('traduit catégories, niveaux et actions d’audit, avec repli lisible', () => {
    expect(categoryLabel('fr', 'UNITE_LOCATIVE')).toBe('Unité locative');
    expect(categoryLabel('fr', 'KIOSQUE_MOBILE')).toBe('Kiosque mobile');
    expect(levelLabel('fr', 'N1')).toBe('N1 — identifié');
    expect(auditActionLabel('fr', 'rule.approved.verificateur_juridique')).toBe('Visa de règle');
    expect(auditActionLabel('fr', 'payment.confirmed')).toBe('Paiement confirmé');
    expect(auditActionLabel('fr', 'inconnu.x')).toBe('inconnu.x');
    expect(humanize('SUPPORT_PUBLICITAIRE')).toBe('Support publicitaire');
  });
});

describe('navigation par rôle', () => {
  // Écrans du socle (les entrées des modules d'extension s'ajoutent après, selon les rôles).
  const routes = (roles: string[]) => visibleNav(roles).filter((n) => !n.label).map((n) => n.to);
  const modules = (roles: string[]) => visibleNav(roles).filter((n) => n.label).map((n) => n.to);
  it('contribuable : accueil, inscription, espace, services, vérification', () => {
    // 30/09/2026 : l'usager connecté n'a ni « Vérifier », ni inscription, ni doublon de l'accueil dans son menu (tout est
    // dans « Mon espace ») ; les pages restent publiques pour le public non connecté.
    expect(routes(['R30'])).toEqual(['/espace', '/services']);
    expect(routes([])).toEqual(['/', '/verifier']);
  });
  it('gouverneur : pilotage uniquement', () => {
    // Pas de « Vérification publique » dans le compte des autorités (R01 à R05), décision du 27/09/2026.
    for (const r of ['R01', 'R02', 'R05']) expect(routes([r])).toEqual(['/', '/gouverneur', '/ia']);
    // R03, R04 : le tableau du Gouverneur leur est refusé en lecture — entrée masquée du menu (présentation seulement,
    // deuxième passe adverse du 27/09/2026) ; la page /gouverneur reste accessible par son adresse.
    for (const r of ['R03', 'R04']) expect(routes([r])).toEqual(['/', '/ia']);
  });
  it('menu aligné sur les droits de lecture : entrées masquées, pages conservées (shared/src/menu.ts)', () => {
    expect(modules(['R17'])).not.toContain('/terrain/sous-traitants');
    expect(modules(['R06'])).toContain('/terrain/sous-traitants');
    expect(modules(['R17'])).not.toContain('/chaine');
    for (const p of ['/vehicules/fourrieres', '/citoyen/cadastre', '/citoyen/activites', '/citoyen/vehicules', '/citoyen/transport']) expect(modules(['R10'])).not.toContain(p);
    for (const p of ['/documents', '/verticales/fiches', '/rakapay/cooperative']) expect(modules(['R30'])).not.toContain(p);
    expect(modules(['R05'])).not.toContain('/rakapay/pilotage');
    expect(routes(['R05', 'R17'])).toContain('/tresor');
    // Une personne portant aussi un rôle qui lit la donnée garde l'entrée.
    expect(modules(['R10', 'R09'])).toContain('/citoyen/cadastre');
  });
  it('trésor, terrain, audit', () => {
    expect(routes(['R17'])).toEqual(['/', '/ia', '/tresor']);
    expect(routes(['R10'])).toEqual(['/', '/terrain']);
    expect(routes(['R22'])).toEqual(['/', '/tresor', '/audit']);
  });
  it('modules : entrées publiques pour tous, entrées métier selon le rôle', () => {
    expect(modules(['R30'])).toEqual(expect.arrayContaining(['/transparence', '/signaler', '/stationnement', '/mes-arrieres']));
    expect(modules(['R30'])).not.toContain('/recouvrement');
    expect(modules(['R17'])).toEqual(expect.arrayContaining(['/canaux/points-supervision', '/pilotage/indicateurs']));
    expect(modules(['R10'])).toEqual(expect.arrayContaining(['/titres/controle', '/canaux/enrolement']));
  });
  it('libellés courts non tronqués', () => {
    const users = [
      { id: 'a', name: 'Agent de terrain Limete (démo)', roles: ['R10'], territory: ['Limete'] },
      { id: 'b', name: 'Agent de terrain Gombe (démo)', roles: ['R10'], territory: ['Gombe'] },
      { id: 'c', name: 'Directeur général DGIPK (démo)', roles: ['R06'], entity: 'DGIPK' },
    ];
    expect(shortLabel(users[0]!, users)).toBe('Agent de terrain · Limete');
    expect(shortLabel(users[2]!, users)).toBe('DG DGIPK');
  });
});
