/**
 * Blog public (22/10/2026) — un article par fonctionnalité : articles complets, adresses uniques, liens vers des pages
 * PUBLIQUES seulement (aucun lien vers une page réservée), aucun chiffre retiré de la communication publique, rendu de
 * l'index et d'un article, adresse inconnue → page « introuvable ».
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../src/context';
import { MODULE_ROUTES } from '../src/modules/registry';
import { BlogArticle, BlogIndex } from '../src/pages/Blog';
import { ARTICLES, CATEGORIES } from '../src/pages/blog/articles';

/** Pages publiques déclarées dans App.tsx (hors registre des modules). */
const PUBLIQUES_APP = ['/', '/accueil', '/inscription', '/services', '/verifier', '/ou-va-votre-argent', '/blog'];
const publique = (to: string) => PUBLIQUES_APP.includes(to)
  || MODULE_ROUTES.some((m) => m.path === to && m.nav && m.nav.group === 'public' && m.nav.roles.length === 0);

const wrap = (path: string) => render(
  <AppProvider initialLang="fr">
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/blog" element={<BlogIndex />} />
        <Route path="/blog/:slug" element={<BlogArticle />} />
      </Routes>
    </MemoryRouter>
  </AppProvider>,
);

describe('Blog public MOSOLO', () => {
  it('au moins vingt articles complets, adresses uniques, catégories connues', () => {
    expect(ARTICLES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(ARTICLES.map((a) => a.slug)).size).toBe(ARTICLES.length);
    for (const a of ARTICLES) {
      expect(a.slug).toMatch(/^[a-z0-9-]+$/);
      expect(CATEGORIES[a.categorie]).toBeTruthy();
      for (const champ of [a.titre, a.accroche, a.usp]) expect(champ.trim().length).toBeGreaterThan(10);
      expect(a.probleme.length && a.solution.length && a.atouts.length && a.pourQui.length).toBeTruthy();
    }
  });

  it('chaque article mène à une page publique (jamais à une page réservée)', () => {
    for (const a of ARTICLES) expect(publique(a.lien.to), `${a.slug} → ${a.lien.to}`).toBe(true);
  });

  it('aucun chiffre retiré de la communication publique (IRL) ni de chiffre de lignes non établi', () => {
    const texte = JSON.stringify(ARTICLES);
    expect(texte).not.toMatch(/IRL|22 %/);
    expect(texte).not.toMatch(/17 lignes/);
  });

  it('index : toutes les catégories et tous les articles', () => {
    wrap('/blog');
    expect(screen.getByRole('heading', { name: 'Le blog MOSOLO' })).toBeTruthy();
    for (const a of ARTICLES) expect(screen.getByText(a.titre)).toBeTruthy();
  });

  it('article : atout distinctif, sections, lien d’action ; adresse inconnue → introuvable', () => {
    const a = ARTICLES[0]!;
    const { unmount } = wrap(`/blog/${a.slug}`);
    expect(screen.getByRole('heading', { name: a.titre })).toBeTruthy();
    expect(screen.getByText('Ce qui la rend unique')).toBeTruthy();
    expect(screen.getByText(a.usp)).toBeTruthy();
    expect(screen.getByRole('link', { name: new RegExp(a.lien.label) })).toBeTruthy();
    unmount();
    wrap('/blog/inexistant');
    expect(screen.queryByText('Ce qui la rend unique')).toBeNull();
  });
});
