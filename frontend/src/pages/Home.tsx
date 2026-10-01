import { useEffect, useRef } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { EVENTS, EVENT_CATEGORIES } from '@mosolo/shared';
import { useApp } from '../context';
import { CityNight } from '../components/CityNight';
import { Icon } from '../components/Icon';
import { accueilDuRole, AUTORITES_POSTE, InstallButton, visibleNav } from '../components/Shell';
import { MakerMark, Tricolour } from '../components/Brand';
import { hasKey, type UIKey } from '../lib/i18n';
import { ChartGrid } from '../components/viz';
import { CatalogueEvenementsVisuel } from './visuels';

const CHAIN = [
  'recenser', 'identifier', 'geolocaliser', 'qualifier', 'calculer', 'notifier', 'payer',
  'rapprocher', 'quittancer', 'controler', 'recouvrer', 'auditer', 'planifier',
] as const;
/**
 * Emplacement photographique : lorsque de vraies photographies seront fournies
 * (public/media/hero.avif|webp|jpg, voir README « Direction artistique »), renseigner
 * { base: '/media/hero' }. Par défaut : vue aérienne nocturne procédurale.
 */
const HERO_PHOTO = null as { base: string } | null;
const PRINCIPLES = ['P1', 'P2', 'P5', 'P6', 'P9', 'P10'] as const;

/** Frise horizontale pilotée par le défilement (desktop) ; liste verticale numérotée (mobile). */
function ChainTimeline() {
  const { tr } = useApp();
  const wrap = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const w = wrap.current, t = track.current;
    if (!w || !t) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const mq = window.matchMedia?.('(min-width: 1024px)');
    let raf = 0;
    const update = () => {
      raf = 0;
      if (reduce || !mq?.matches) { t.style.transform = ''; w.style.removeProperty('--progress'); return; }
      const rect = w.getBoundingClientRect();
      const total = w.offsetHeight - window.innerHeight;
      const p = Math.min(1, Math.max(0, -rect.top / Math.max(total, 1)));
      const max = Math.max(0, t.scrollWidth - t.clientWidth);
      const first = t.firstElementChild as HTMLElement | null;
      const step = first?.offsetWidth || 300;
      // Pas discret : aucune carte n'est coupée au repos
      const x = Math.min(max, Math.round((p * max) / step) * step);
      t.style.transform = `translate3d(${-x}px,0,0)`;
      w.style.setProperty('--progress', String(p));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); cancelAnimationFrame(raf); };
  }, []);
  return (
    <section className="chain-section" ref={wrap} aria-labelledby="chain-title">
      <div className="chain-sticky">
        <div className="chain-head">
          <p className="caps">{tr('home.chain.eyebrow')}</p>
          <h2 id="chain-title" className="display-2">{tr('home.chain.title')}</h2>
          <p className="chain-lead">{tr('home.chain.lead')}</p>
        </div>
        <div className="chain-progress" aria-hidden="true"><span /></div>
        <ol className="chain-track" ref={track}>
          {CHAIN.map((c, i) => (
            <li key={c} className="chain-step">
              <span className="chain-num">{String(i + 1).padStart(2, '0')}</span>
              <h3 className="chain-name">{tr(`chain.${c}.title` as UIKey)}</h3>
              <p className="chain-what">{tr(`chain.${c}.what` as UIKey)}</p>
              <p className="chain-guard"><span className="caps-sm">{tr('home.chain.guard')}</span>{tr(`chain.${c}.guard` as UIKey)}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export default function Home() {
  const { tr, lang, user } = useApp();
  const mandatory = EVENTS.filter((e) => e.obligatoire).length;
  const nf = (n: number) => n.toLocaleString(lang === 'en' ? 'en-GB' : 'fr-FR');
  // Visiteur sans compte : seulement les espaces publics ; compte connecté : ses propres écrans.
  const areas = visibleNav(user?.roles, user?.entity).filter((n) => n.to !== '/' && (user ? true : n.group === 'public'));
  // Page d'accueil (30/09/2026, consigne du maître d'ouvrage : « rester sur la page d'accueil, ne pas être emmené
  // automatiquement dans le compte ») : « / » et « /accueil » affichent TOUJOURS la présentation ; chaque compte y trouve
  // le bouton « Ouvrir mon espace de travail » (poste de décision, centre de commandement ou travail du jour). Le
  // parcours par rôle du 29/09/2026 reste disponible : « /?travail » ouvre directement l'espace de travail.
  const espaceTravail = !user ? null
    : user.roles.some((r) => AUTORITES_POSTE.includes(r)) ? '/poste-de-decision'
      : user.roles.includes('R38') ? '/groupe-nseya/command-centre'
        : (() => { const a = accueilDuRole(user.roles, user.entity); return a && a !== '/' ? a : '/espace'; })();
  const directTravail = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('travail');
  if (directTravail && espaceTravail) return <Navigate to={espaceTravail} replace />;
  return (
    <div className="landing">
      {/* 1. Ouverture institutionnelle : visuel officiel, non modifié, logo jamais recadré */}
      <section className="cover" aria-label={tr('home.coverLabel')}>
        <picture>
          <img src="/media/couverture-ville-de-kinshasa.webp" alt={tr('home.coverAlt')} className="cover-img" width={1536} height={1024} fetchPriority="high" />
        </picture>
      </section>

      {/* 2. Plan cinématographique : la ville la nuit */}
      <section className="hero-night" aria-labelledby="hero-title">
        {HERO_PHOTO ? (
          <picture className="hero-photo">
            <source srcSet={`${HERO_PHOTO.base}.avif`} type="image/avif" />
            <source srcSet={`${HERO_PHOTO.base}.webp`} type="image/webp" />
            <img src={`${HERO_PHOTO.base}.jpg`} alt="" width={2400} height={1350} />
          </picture>
        ) : (
          <CityNight />
        )}
        <div className="hero-inner">
          <p className="caps hero-kicker">{tr('home.kicker')}</p>
          <h1 id="hero-title" className="display-1">{tr('app.motto')}</h1>
          <p className="hero-lead">{tr('app.tagline')}</p>
          <div className="hero-cta">
            {espaceTravail && espaceTravail !== '/espace'
              ? <Link to={espaceTravail} className="btn btn-light btn-lg" data-testid="home-espace-travail">Ouvrir mon espace de travail <Icon name="arrowRight" size={18} /></Link>
              : <Link to="/espace" className="btn btn-light btn-lg">{tr('home.cta.space')} <Icon name="arrowRight" size={18} /></Link>}
            <Link to="/verifier" className="btn btn-outline-light btn-lg"><Icon name="shieldCheck" size={18} /> {tr('home.cta.verify')}</Link>
          </div>
          <div className="hero-install"><InstallButton variant="link" /> · <Link to="/ou-va-votre-argent" style={{ color: "inherit" }}>Où va votre argent</Link></div>
        </div>
        <p className="hero-caption">{tr('home.heroCaption')}</p>
      </section>

      {/* 3. La chaîne d'exploitation */}
      <ChainTimeline />

      {/* 4. Ce que la Ville voit enfin */}
      <section className="figures" aria-labelledby="fig-title">
        <div className="section-inner">
          <p className="caps">{tr('home.figures.eyebrow')}</p>
          <h2 id="fig-title" className="display-2">{tr('home.figures.title')}</h2>
          <div className="figure-grid">
            <figure className="big-figure">
              <p className="big-num">24</p>
              <figcaption>
                <p className="big-label">{tr('home.fig1.label')}</p>
                <p className="big-text">{tr('home.fig1.text')}</p>
                <p className="source">{tr('home.fig1.source')}</p>
              </figcaption>
            </figure>
            <figure className="big-figure">
              <p className="big-num">22 <span className="big-unit">%</span></p>
              <figcaption>
                <p className="big-label">{tr('home.fig2.label')}</p>
                <p className="big-text">{tr('home.fig2.text')}</p>
                <p className="source">{tr('home.fig2.source')}</p>
              </figcaption>
            </figure>
            <figure className="big-figure">
              <p className="big-num">{nf(EVENTS.length)}</p>
              <figcaption>
                <p className="big-label">{tr('home.fig3.label')}</p>
                <p className="big-text">{tr('home.fig3.text', { categories: EVENT_CATEGORIES.length, mandatory })}</p>
                <p className="source">{tr('home.fig3.source')}</p>
              </figcaption>
            </figure>
          </div>
        </div>
      </section>

      {/* 4 bis. Le catalogue d'événements en graphique (données réelles du paquet partagé) */}
      <section className="home-viz" aria-label="Catalogue d’événements en graphique">
        <div className="section-inner">
          <ChartGrid min={320}><CatalogueEvenementsVisuel events={EVENTS} categories={EVENT_CATEGORIES} /></ChartGrid>
        </div>
      </section>

      {/* 5. Principes */}
      <section className="principles" aria-labelledby="pr-title">
        <div className="section-inner principles-grid">
          <div className="principles-intro">
            <p className="caps">{tr('home.principles.eyebrow')}</p>
            <h2 id="pr-title" className="display-2">{tr('home.principles.title')}</h2>
            <p className="muted">{tr('home.principles.lead')}</p>
          </div>
          <ol className="principles-list">
            {PRINCIPLES.map((p) => (
              <li key={p}>
                <span className="pr-code">{p}</span>
                <div>
                  <h3>{tr(`principle.${p}.title` as UIKey)}</h3>
                  <p>{tr(`principle.${p}.text` as UIKey)}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Index des espaces */}
      <section className="access" aria-labelledby="acc-title">
        <div className="section-inner">
          <p className="caps">{tr('home.access.eyebrow')}</p>
          <h2 id="acc-title" className="display-2">{tr('home.access.title')}</h2>
          <ul className="access-list">
            {areas.map((n, i) => (
              <li key={n.to}>
                <Link to={n.to} className="access-link">
                  <span className="access-num">{String(i + 1).padStart(2, '0')}</span>
                  {/* Nom réel de l'écran (30/09/2026 : des dizaines de cartes « Plus » avec des clés techniques affichées). */}
                  <span className="access-name">{n.label ?? tr(n.key)}</span>
                  {hasKey(`home.area.${n.to.slice(1)}`) && <span className="access-desc">{tr(`home.area.${n.to.slice(1)}` as UIKey)}</span>}
                  <Icon name="arrowRight" size={18} className="access-arrow" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 6. Pied de page institutionnel */}
      <footer className="inst-footer">
        <Tricolour />
        <div className="section-inner inst-grid">
          <div>
            <p className="inst-title">{tr('footer.city')}</p>
            <p className="muted-light">{tr('footer.cityLine')}</p>
          </div>
          <div>
            <p className="caps-sm">{tr('footer.entities')}</p>
            <ul className="inst-list">
              <li>{tr('entity.DGIPK')}</li>
              <li>{tr('entity.DGTK')}</li>
              <li>{tr('entity.MINFIN')}</li>
              <li>{tr('entity.TRESOR')}</li>
            </ul>
          </div>
          <div>
            <p className="caps-sm">{tr('footer.legalTitle')}</p>
            <p className="muted-light small">{tr('footer.langNote')}</p>
          </div>
        </div>
        <div className="section-inner inst-bottom">
          <span className="muted-light small">© {new Date().getFullYear()} Ville Province de Kinshasa</span>
          <MakerMark />
        </div>
      </footer>
    </div>
  );
}
