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
  const routes = (roles: string[]) => visibleNav(roles).map((n) => n.to);
  it('contribuable : accueil, inscription, espace, services, vérification', () => {
    expect(routes(['R30'])).toEqual(['/', '/inscription', '/espace', '/services', '/verifier']);
  });
  it('gouverneur : pilotage uniquement', () => {
    expect(routes(['R01'])).toEqual(['/', '/verifier', '/gouverneur', '/ia']);
  });
  it('trésor, terrain, audit', () => {
    expect(routes(['R17'])).toEqual(['/', '/tresor']);
    expect(routes(['R10'])).toEqual(['/', '/terrain']);
    expect(routes(['R22'])).toEqual(['/', '/tresor', '/audit']);
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
