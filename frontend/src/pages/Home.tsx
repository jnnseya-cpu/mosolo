import { useEffect, useRef } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useApp } from '../context';
import { CityNight } from '../components/CityNight';
import { Icon } from '../components/Icon';
import { accueilDuRole, AUTORITES_POSTE, InstallButton, visibleNav } from '../components/Shell';
import { MakerMark, Tricolour } from '../components/Brand';
import { hasKey, type UIKey } from '../lib/i18n';

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

/**
 * Accueil persuasif (01/10/2026, maître d'ouvrage : « une plateforme nouvelle a besoin d'informations percutantes et
 * convaincantes pour gagner la confiance et l'adhésion de la population et de la classe politique »). Uniquement des
 * garanties que la plateforme applique réellement (principes P2, P5, P6, P9, preuves QR, « Où va votre argent »,
 * doléances) — aucun chiffre de recette ni taux inventé.
 */
const AVANT_APRES: readonly { avant: string; apres: string }[] = [
  { avant: 'Des reçus papier faciles à falsifier.', apres: 'Une quittance avec code QR, vérifiable par n’importe qui, sans compte.' },
  { avant: 'De l’argent liquide remis de la main à la main.', apres: 'Zéro espèce entre les mains des agents : paiement par téléphone ou au guichet agréé, directement au compte public.' },
  { avant: 'Personne ne savait où allait l’argent.', apres: '« Où va votre argent » : chaque Kinois voit ce que la Ville encaisse et comment c’est réparti.' },
  { avant: 'Des montants discutés au cas par cas.', apres: 'Un montant calculé par une règle publiée et approuvée : le même pour tous, expliqué ligne par ligne.' },
  { avant: 'Des contrôles qui font peur.', apres: 'Vos preuves en un clic sur votre téléphone ; un agent n’agit que sur invitation de la plateforme ; vos doléances sans représailles.' },
];
const ENGAGEMENTS: readonly { num: string; unit?: string; label: string; text: string }[] = [
  { num: '0', label: 'espèce entre les mains des agents', text: 'L’agent constate et notifie ; il ne touche jamais l’argent. Vous payez par monnaie mobile (Orange, M-Pesa, Airtel, Africell), QR, USSD, carte ou guichet agréé.' },
  { num: '100', unit: '%', label: 'des paiements vers le compte public', text: 'Aucune recette ne transite par un compte privé de plateforme ou de prestataire. Chaque franc est rapproché du relevé bancaire.' },
  { num: '1', label: 'code QR par quittance', text: 'Chaque quittance, carte, vignette ou titre porte un code QR que tout le monde peut vérifier. Les copies sont détectées.' },
];
const PUBLICS: readonly { titre: string; icon: string; points: readonly string[] }[] = [
  { titre: 'Pour vous, Kinois', icon: 'user', points: [
    'Payez en quelques minutes depuis votre téléphone, sans file d’attente ni intermédiaire.',
    'Tout ce qui vous concerne au même endroit : ce qu’il faut faire, ce qui est en cours, ce qui est à jour.',
    'Le montant exact de votre obligation, rien de plus : les frais de paiement sont à la charge de la Ville.',
    'Votre voix compte : déposez une doléance depuis votre espace, sans crainte de représailles.',
  ] },
  { titre: 'Pour les autorités', icon: 'chart', points: [
    'La recette du jour, commune par commune, rapprochée du relevé bancaire.',
    'Les fuites rendues visibles : écart entre ce qui est dû et ce qui est réellement encaissé, par commune.',
    'Des décisions éclairées : l’IA propose, une personne décide, et chaque décision est tracée.',
    'Plus de recettes sans créer d’impôt : la plateforme collecte mieux ce qui est déjà dû.',
  ] },
  { titre: 'Pour les entreprises et commerçants', icon: 'store', points: [
    'Les mêmes règles pour tous : les grands redevables d’abord, l’accompagnement avant la sanction.',
    'Fini les demandes informelles : chaque montant renvoie à une règle publiée et à sa base légale.',
    'Des quittances et un quitus vérifiables, opposables à tout contrôle.',
    'Aucune sanction automatique : toute décision est prise par une personne, et contestable.',
  ] },
];

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
  const { tr, user } = useApp();
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

      {/* 2 bis. La promesse (01/10/2026) : le message politique et citoyen en une phrase */}
      <section className="promesse" aria-labelledby="promesse-title">
        <div className="section-inner">
          <p className="caps">Kinshasa se finance elle-même</p>
          <h2 id="promesse-title" className="display-2">Plus de recettes pour Kinshasa. Pas un impôt de plus.</h2>
          <p className="promesse-lead">KINSHASA MOSOLO ne crée aucune taxe. Il fait entrer dans les caisses publiques ce qui est déjà dû — payé par téléphone, versé directement au compte de la Ville, vérifiable par chacun. Chaque franc collecté devient un franc visible.</p>
        </div>
      </section>

      {/* 2 ter. Avant / avec MOSOLO */}
      <section className="avant-apres" aria-labelledby="aa-title">
        <div className="section-inner">
          <p className="caps">Ce qui change</p>
          <h2 id="aa-title" className="display-2">Hier l’incertitude. Aujourd’hui la preuve.</h2>
          <ul className="aa-list">
            {AVANT_APRES.map((l) => (
              <li key={l.avant} className="aa-row">
                <p className="aa-avant"><span className="caps-sm">Avant</span>{l.avant}</p>
                <p className="aa-apres"><span className="caps-sm">Avec MOSOLO</span>{l.apres}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 3. La chaîne d'exploitation */}
      <ChainTimeline />

      {/* 4. Ce que la Ville voit enfin */}
      <section className="figures" aria-labelledby="fig-title">
        <div className="section-inner">
          <p className="caps">{tr('home.figures.eyebrow')}</p>
          <h2 id="fig-title" className="display-2">{tr('home.figures.title')}</h2>
          <div className="figure-grid">
            {ENGAGEMENTS.map((e) => (
              <figure key={e.label} className="big-figure">
                <p className="big-num">{e.num}{e.unit && <> <span className="big-unit">{e.unit}</span></>}</p>
                <figcaption>
                  <p className="big-label">{e.label}</p>
                  <p className="big-text">{e.text}</p>
                </figcaption>
              </figure>
            ))}
          </div>
          <div className="figure-grid">
            <figure className="big-figure">
              <p className="big-num">24</p>
              <figcaption>
                <p className="big-label">{tr('home.fig1.label')}</p>
                <p className="big-text">{tr('home.fig1.text')}</p>
                <p className="source">{tr('home.fig1.source')}</p>
              </figcaption>
            </figure>
            {/* Chiffre « IRL 22 % » retiré de l'accueil public (01/10/2026, maître d'ouvrage) : la règle reste au registre
                (annexe B, statut À VÉRIFIER) et dans les écrans fiscaux. */}
          </div>
        </div>
      </section>

      {/* 4 bis. Catalogue d'événements : retiré de l'accueil public (01/10/2026, maître d'ouvrage) ; conservé dans
          « Notifications et modèles » (administration) et l'annexe G. */}
      {/* 4 ter. Pour chacun (01/10/2026) : la population, les autorités, les entreprises */}
      <section className="publics" aria-labelledby="publics-title">
        <div className="section-inner">
          <p className="caps">Pour chacun</p>
          <h2 id="publics-title" className="display-2">Une plateforme qui protège celui qui paie et celui qui gouverne.</h2>
          <div className="publics-grid">
            {PUBLICS.map((p) => (
              <article key={p.titre} className="public-card">
                <h3><Icon name={p.icon} size={22} /> {p.titre}</h3>
                <ul>{p.points.map((x) => <li key={x}><Icon name="check" size={16} /> <span>{x}</span></li>)}</ul>
              </article>
            ))}
          </div>
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

      {/* 5 bis. Appel à l'action (01/10/2026) */}
      <section className="appel" aria-labelledby="appel-title">
        <div className="section-inner">
          <h2 id="appel-title" className="display-2">Kinshasa avance quand chacun paie sa juste part — et voit où va son argent.</h2>
          <div className="appel-cta">
            {!user && <Link to="/inscription" className="btn btn-light btn-lg">Créer mon compte <Icon name="arrowRight" size={18} /></Link>}
            <Link to="/ou-va-votre-argent" className="btn btn-outline-light btn-lg">Où va votre argent</Link>
            <Link to="/points-de-paiement" className="btn btn-outline-light btn-lg">Où payer ?</Link>
          </div>
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
