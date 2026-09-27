import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useApp } from '../context';
import { useOnline } from '../hooks/useOnline';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import type { UIKey } from '../lib/i18n';
import { CityLogo, MakerMark, Tricolour } from './Brand';
import { Icon } from './Icon';
import { CurrencySelector, DemoUserSelector, LanguageSelector } from './Selectors';
import { MODULE_ROUTES } from '../modules/registry';
import { menuMasque } from '@mosolo/shared';
import { focusables, useFocusTrap } from '../hooks/useFocusTrap';
import { ID_ANNONCES } from '../lib/annonce';
import { sansMasques, useMenuRattachements } from '../hooks/useMenuRattachements';

export interface NavItem { to: string; key: UIKey; icon: string; group: 'public' | 'pilotage' | 'operations'; label?: string; short?: string; roles?: string[] }

export const NAV: NavItem[] = [
  { to: '/', key: 'nav.home', icon: 'home', group: 'public' },
  { to: '/inscription', key: 'nav.register', icon: 'user', group: 'public' },
  { to: '/espace', key: 'nav.taxpayer', icon: 'file', group: 'public' },
  { to: '/services', key: 'nav.services', icon: 'grid', group: 'public' },
  { to: '/verifier', key: 'nav.verify', icon: 'shieldCheck', group: 'public' },
  { to: '/gouverneur', key: 'nav.governor', icon: 'gauge', group: 'pilotage' },
  { to: '/communications', key: 'nav.communications', icon: 'message', group: 'pilotage' },
  { to: '/ia', key: 'nav.ai', icon: 'analysis', group: 'pilotage' },
  { to: '/registre', key: 'nav.rules', icon: 'scale', group: 'operations' },
  { to: '/tresor', key: 'nav.treasury', icon: 'bank', group: 'operations' },
  { to: '/terrain', key: 'nav.field', icon: 'pin', group: 'operations' },
  { to: '/audit', key: 'nav.audit', icon: 'ledger', group: 'operations' },
];
const GROUPS: { id: NavItem['group']; key: UIKey }[] = [
  { id: 'public', key: 'nav.group.public' }, { id: 'pilotage', key: 'nav.group.pilotage' }, { id: 'operations', key: 'nav.group.operations' },
];
const SHORT: Record<string, UIKey> = {
  '/gouverneur': 'nav.governorShort', '/verifier': 'nav.verifyShort', '/registre': 'nav.rulesShort', '/tresor': 'nav.treasuryShort',
  '/communications': 'nav.commsShort', '/services': 'nav.servicesShort', '/ia': 'nav.aiShort', '/inscription': 'nav.register',
};

/** Sections visibles selon les rôles (les routes restent accessibles par URL). */
const ROLE_ROUTES: [string[], string[]][] = [
  [['R30', 'R31'], ['/inscription', '/espace', '/services', '/verifier']],
  // Gouverneur, directeur de cabinet, secrétaire exécutif, ministre et autres autorités : pas de « Vérification publique »
  // dans leur compte (décision du maître d'ouvrage, 27/09/2026) ; la page reste publique pour les usagers.
  [['R01', 'R02', 'R03', 'R04', 'R05'], ['/gouverneur', '/ia']],
  [['R06', 'R07', 'R08'], ['/communications', '/registre', '/ia']],
  [['R13', 'R14', 'R15', 'R16'], ['/registre']],
  [['R17', 'R18', 'R19'], ['/tresor']],
  [['R09', 'R10', 'R11'], ['/terrain']],
  [['R22', 'R23', 'R24', 'R28'], ['/audit', '/tresor']],
  [['R26'], ['/communications', '/audit']],
  [['R09', 'R17', 'R20', 'R24', 'R29'], ['/ia']],
];

/** Profils « usagers » (contribuable, mandataire, partenaires) qui voient les entrées publiques des modules. */
const PUBLIC_USER_ROLES = ['R30', 'R31', 'R32', 'R33', 'R34', 'R36', 'R37'];

/** Entrées de menu des modules d'extension (modules/registry.tsx). */
const MODULE_NAV: NavItem[] = MODULE_ROUTES.filter((m) => m.nav).map((m) => ({
  to: m.path, key: 'nav.more' as UIKey, icon: m.nav!.icon, group: m.nav!.group, label: m.nav!.label, short: m.nav!.short ?? m.nav!.label, roles: m.nav!.roles,
}));

export function visibleNav(roles: string[] | undefined): NavItem[] {
  if (!roles) return [...NAV, ...MODULE_NAV]; // utilisateurs inconnus (hors ligne) : tout afficher
  const allowed = new Set<string>(['/']);
  for (const [rs, routes] of ROLE_ROUTES) if (roles.some((r) => rs.includes(r))) routes.forEach((x) => allowed.add(x));
  if (allowed.size === 1) allowed.add('/verifier');
  const core = NAV.filter((n) => allowed.has(n.to));
  // Entrées publiques (roles: []) : pour le public et les usagers, pas dans les menus de travail des agents.
  const isPublicUser = roles.length === 0 || roles.some((r) => PUBLIC_USER_ROLES.includes(r));
  const extra = MODULE_NAV.filter((n) => (n.roles!.length === 0 ? isPublicUser : n.roles!.some((r) => roles.includes(r))));
  // Présentation seulement (27/09/2026) : pas d'entrée de menu dont la lecture principale est refusée au rôle ; la route
  // et la page restent accessibles par leur adresse (voir shared/src/menu.ts).
  return [...core, ...extra].filter((n) => !menuMasque(n.to, roles));
}

/**
 * Menu du Gouverneur (Cahier nouvelle version, § 27.5) : cinq entrées, pas davantage. Tout le reste de la plateforme
 * demeure accessible au Gouverneur au titre de ses habilitations, par la recherche ou par un lien depuis un écran
 * (les routes restent ouvertes par URL ; `visibleNav` conserve la liste complète des écrans accessibles).
 */
export const MENU_GOUVERNEUR: NavItem[] = [
  { to: '/poste-de-decision/decisions', key: 'nav.more' as UIKey, icon: 'check', group: 'pilotage', label: 'Décisions', short: 'Décisions' },
  { to: '/poste-de-decision/recettes', key: 'nav.more' as UIKey, icon: 'chart', group: 'pilotage', label: 'Recettes', short: 'Recettes' },
  { to: '/poste-de-decision/alertes', key: 'nav.more' as UIKey, icon: 'alert', group: 'pilotage', label: 'Alertes', short: 'Alertes' },
  { to: '/poste-de-decision/communes', key: 'nav.more' as UIKey, icon: 'pin', group: 'pilotage', label: 'Communes', short: 'Communes' },
  { to: '/poste-de-decision/rechercher', key: 'nav.more' as UIKey, icon: 'sort', group: 'pilotage', label: 'Rechercher', short: 'Rechercher' },
];

/** Menu affiché : cinq entrées pour le Gouverneur ; ailleurs, les écrans visibles selon les rôles. */
export function menuDe(roles: string[] | undefined): NavItem[] {
  return roles?.includes('R01') ? MENU_GOUVERNEUR : visibleNav(roles);
}

/** Autorités dont l'écran d'accueil est le poste de décision (§ 27.2 : « il s'ouvre là, toujours »). */
export const AUTORITES_POSTE = ['R01', 'R02', 'R03', 'R04', 'R05'];

/** Libellé d'une entrée (clé traduite, ou libellé fourni par un module). */
function navLabel(n: NavItem, tr: (k: UIKey) => string, short = false): string {
  if (n.label) return short ? n.short ?? n.label : n.label;
  return tr(short ? SHORT[n.to] ?? n.key : n.key);
}

export function OfflineBanner() {
  const online = useOnline();
  const { tr } = useApp();
  if (online) return null;
  return (
    <div className="offline-banner" role="status" aria-live="polite">
      <Icon name="offline" size={18} /> <span>{tr('offline.banner')}</span>
    </div>
  );
}

export function InstallButton({ variant = 'ghost' }: { variant?: 'ghost' | 'secondary' | 'link' }) {
  const { canInstall, install, installed } = useInstallPrompt();
  const { tr } = useApp();
  if (installed || !canInstall) return null;
  return (
    <button type="button" className={variant === 'link' ? 'btn-link' : `btn btn-${variant} btn-sm`} onClick={() => void install()}>
      <Icon name="download" size={16} /> {tr('install.cta')}
    </button>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme, tr } = useApp();
  const dark = resolvedTheme === 'dark';
  return (
    <button type="button" className="hdr-btn" aria-pressed={dark} onClick={() => setTheme(dark ? 'light' : 'dark')}
      aria-label={dark ? tr('theme.toLight') : tr('theme.toDark')} title={dark ? tr('theme.toLight') : tr('theme.toDark')}>
      <Icon name={dark ? 'sun' : 'moon'} size={20} />
    </button>
  );
}

function Header() {
  const { tr } = useApp();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  return (
    <header className="app-header">
      <div className="hdr-inner">
        <NavLink to="/" className="hdr-brand" aria-label={tr('header.homeLink')}>
          <CityLogo height={44} />
          <span className="hdr-divider" aria-hidden="true" />
          <span className="hdr-name">
            <span className="hdr-app">KINSHASA MOSOLO</span>
            <span className="hdr-sub">{tr('header.subtitle')}</span>
          </span>
        </NavLink>
        <div className={`hdr-controls ${open ? 'open' : ''}`} id="hdr-controls">
          <LanguageSelector />
          <CurrencySelector />
          <DemoUserSelector />
        </div>
        <div className="hdr-actions">
          <ThemeToggle />
          <button type="button" className="hdr-btn hdr-settings" aria-expanded={open} aria-controls="hdr-controls" onClick={() => setOpen((v) => !v)}
            aria-label={tr('header.settings')} title={tr('header.settings')}>
            <Icon name={open ? 'close' : 'globe'} size={20} />
          </button>
        </div>
      </div>
      <Tricolour />
    </header>
  );
}

function Sidebar() {
  const { tr, user } = useApp();
  // Rattachements de modules aux entités (27/09/2026) : présentation seulement, les droits restent ceux du serveur.
  const items = sansMasques(menuDe(user?.roles), useMenuRattachements(user?.id));
  return (
    <nav className="sidebar" aria-label={tr('nav.main')}>
      {GROUPS.filter((g) => items.some((n) => n.group === g.id)).map((g) => (
        <div className="side-group" key={g.id}>
          <p className="side-label">{tr(g.key)}</p>
          <ul>
            {items.filter((n) => n.group === g.id).map((n) => (
              <li key={n.to}>
                <NavLink to={n.to} end={n.to === '/'} className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}>
                  <Icon name={n.icon} size={18} /> <span>{navLabel(n, tr)}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="side-foot"><InstallButton variant="link" /></div>
    </nav>
  );
}

function BottomNav() {
  const { tr, user } = useApp();
  const items = sansMasques(menuDe(user?.roles), useMenuRattachements(user?.id));
  const hasMore = items.length > 5;
  const bottom = hasMore ? items.slice(0, 4) : items;
  const [more, setMore] = useState(false);
  const loc = useLocation();
  const sheet = useRef<HTMLDivElement>(null);
  useFocusTrap(sheet, more);
  useEffect(() => setMore(false), [loc.pathname]);
  // Ouverture de la feuille « Plus » : focus dans la feuille ; Échap la ferme (clavier seul).
  useEffect(() => {
    if (!more) return;
    focusables(sheet.current ?? document.body)[0]?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMore(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [more]);
  return (
    <>
      <nav className="bottom-nav" aria-label={tr('nav.main')} style={{ gridTemplateColumns: `repeat(${bottom.length + (hasMore ? 1 : 0)}, 1fr)` }}>
        {bottom.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `bn-link ${isActive ? 'active' : ''}`}>
            <Icon name={n.icon} size={22} />
            <span>{navLabel(n, tr, true)}</span>
          </NavLink>
        ))}
        {hasMore && (
          <button type="button" className={`bn-link ${more ? 'active' : ''}`} aria-expanded={more} aria-controls="more-sheet" onClick={() => setMore((v) => !v)}>
            <Icon name="menu" size={22} /><span>{tr('nav.more')}</span>
          </button>
        )}
      </nav>
      {more && (
        <div className="sheet-backdrop" onClick={() => setMore(false)}>
          <div ref={sheet} className="sheet" id="more-sheet" role="dialog" aria-modal="true" aria-label={tr('nav.more')} onClick={(e) => e.stopPropagation()}>
            {GROUPS.filter((g) => items.some((n) => n.group === g.id)).map((g) => (
              <div key={g.id} className="sheet-group">
                <p className="side-label">{tr(g.key)}</p>
                <ul>
                  {items.filter((n) => n.group === g.id).map((n) => (
                    <li key={n.to}>
                      <NavLink to={n.to} end={n.to === '/'} className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}>
                        <Icon name={n.icon} size={18} /> <span>{navLabel(n, tr)}</span>
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <InstallButton variant="secondary" />
          </div>
        </div>
      )}
    </>
  );
}

export function Footer() {
  const { tr } = useApp();
  return (
    <footer className="app-footer">
      <div className="footer-inner">
        <p className="footer-inst">{tr('footer.institutions')}</p>
        {/* Mention « Document de travail… » retirée de l'affichage à la demande du maître d'ouvrage (27/09/2026) ; texte conservé dans i18n. */}
        <MakerMark />
      </div>
    </footer>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const { tr } = useApp();
  const immersive = loc.pathname === '/';
  useEffect(() => { window.scrollTo?.(0, 0); }, [loc.pathname]);
  return (
    <div className={`app ${immersive ? 'app-immersive' : ''}`}>
      <a href="#main" className="skip-link">{tr('a11y.skip')}</a>
      <div id={ID_ANNONCES} className="sr-only" role="status" aria-live="polite" aria-atomic="true" />
      <Header />
      <OfflineBanner />
      <div className="app-body">
        {!immersive && <Sidebar />}
        <main id="main" className="app-main" tabIndex={-1}>
          {children}
          {!immersive && <Footer />}
        </main>
      </div>
      <BottomNav />
    </div>
  );
}

export function PageHead({ eyebrow, title, lead, children }: { eyebrow?: string; title: string; lead?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {lead && <p className="lead">{lead}</p>}
      </div>
      {children && <div className="page-head-tools">{children}</div>}
    </div>
  );
}
