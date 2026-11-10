/**
 * Blog public « Le blog MOSOLO » (22/10/2026) : un article par fonctionnalité, rédigé pour convaincre (atout distinctif,
 * problème résolu, preuve à voir dans la démonstration). Pages publiques, sans connexion ; contenu statique
 * (`blog/articles.ts`), uniquement des garanties réellement appliquées par la plateforme (annexe I, § I.65).
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../components/Icon';
import { PageHead } from '../components/Shell';
import { ARTICLES, CATEGORIES, type Article } from './blog/articles';
import NotFound from './NotFound';

function Carte({ a }: { a: Article }) {
  return (
    <li className="blog-carte">
      <Link to={`/blog/${a.slug}`} className="blog-carte-lien">
        <span className="blog-carte-titre">{a.titre}</span>
        <span className="blog-carte-accroche">{a.accroche}</span>
        <span className="blog-carte-lire">Lire l’article <Icon name="arrowRight" size={16} /></span>
      </Link>
    </li>
  );
}

export function BlogIndex() {
  return (
    <div className="page page-wide blog">
      <PageHead eyebrow="Ville de Kinshasa · KINSHASA MOSOLO" title="Le blog MOSOLO"
        lead="Chaque fonctionnalité de la plateforme, expliquée simplement : le problème qu’elle règle, ce qui la rend unique, et où la voir fonctionner." />
      {(Object.keys(CATEGORIES) as Article['categorie'][]).map((c) => {
        const liste = ARTICLES.filter((a) => a.categorie === c);
        if (!liste.length) return null;
        return (
          <section key={c} className="blog-section" aria-labelledby={`blog-${c}`}>
            <h2 className="blog-section-titre" id={`blog-${c}`}>{CATEGORIES[c]}</h2>
            <ul className="blog-grille">{liste.map((a) => <Carte key={a.slug} a={a} />)}</ul>
          </section>
        );
      })}
      <p className="small muted">Données de la démonstration fictives et non contractuelles. Les valeurs marquées « à confirmer » attendent la décision du Gouvernorat.</p>
    </div>
  );
}

/** Révision approuvée d'un article par la Veille des tendances (§ I.70) : titre, accroche et appel ; sinon le texte d'origine. */
interface Revision { slug: string; surface: string; revision: number; titre: string; description: string; accroche: string; ctaLibelle: string; ctaCible: string }
function evenement(slug: string, evenementType: 'VISITE' | 'CTA', revision?: number) {
  void api(`/v1/public/tendances/pages/${encodeURIComponent(slug)}/evenements`, { method: 'POST', body: { evenement: evenementType, ...(revision ? { revision } : {}) } }).catch(() => undefined);
}

export function BlogArticle() {
  const { slug } = useParams();
  const [rev, setRev] = useState<Revision | null>(null);
  useEffect(() => {
    let actif = true;
    setRev(null);
    if (!slug || !ARTICLES.some((x) => x.slug === slug)) return;
    // Sans serveur, sans page liée ou hors ligne : l'article d'origine s'affiche, rien ne bloque la lecture.
    api<Revision>(`/v1/public/tendances/pages/${encodeURIComponent(slug)}`).then((r) => {
      if (!actif || r.surface !== 'BLOG') return;
      setRev(r);
      evenement(slug, 'VISITE', r.revision);
    }).catch(() => undefined);
    return () => { actif = false; };
  }, [slug]);
  const i = ARTICLES.findIndex((x) => x.slug === slug);
  const a = ARTICLES[i];
  if (!a) return <NotFound />;
  const suivant = ARTICLES[(i + 1) % ARTICLES.length]!;
  return (
    <article className="page blog blog-article">
      <p className="small"><Link to="/blog">← Le blog MOSOLO</Link></p>
      <PageHead eyebrow={CATEGORIES[a.categorie]} title={rev?.titre ?? a.titre} lead={rev?.accroche ?? a.accroche} />

      <section className="blog-usp" aria-label="Ce qui la rend unique">
        <p className="caps caps-sm">Ce qui la rend unique</p>
        <p className="blog-usp-texte">{a.usp}</p>
      </section>

      <h2>Le problème</h2>
      {a.probleme.map((p) => <p key={p}>{p}</p>)}

      <h2>La réponse de MOSOLO</h2>
      {a.solution.map((p) => <p key={p}>{p}</p>)}

      <h2>Les atouts</h2>
      <ul className="blog-atouts">{a.atouts.map((x) => <li key={x}><Icon name="check" size={16} /> <span>{x}</span></li>)}</ul>

      <h2>Pour qui</h2>
      <ul>{a.pourQui.map((x) => <li key={x}>{x}</li>)}</ul>

      {a.aConfirmer && <p className="notice" role="note"><Icon name="info" size={16} /> {a.aConfirmer}</p>}

      <div className="blog-cta">
        <Link to={rev?.ctaCible ?? a.lien.to} className="btn btn-primary" onClick={() => { if (rev) evenement(rev.slug, 'CTA', rev.revision); }}>{rev?.ctaLibelle ?? a.lien.label} <Icon name="arrowRight" size={16} /></Link>
        <Link to={`/blog/${suivant.slug}`} className="btn btn-ghost">Article suivant : {suivant.titre}</Link>
      </div>
    </article>
  );
}

export default BlogIndex;
