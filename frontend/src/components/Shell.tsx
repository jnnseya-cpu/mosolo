import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useApp } from '../context';
import { useOnline } from '../hooks/useOnline';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import type { UIKey } from '../lib/i18n';
import { CityLogo, MakerMark, Tricolour } from './Brand';
import { Icon } from './Icon';
import { CurrencySelector, DemoUserSelector, LanguageSelector } from './Selectors';

export interface NavItem { to: string; key: UIKey; icon: string; group: 'public' | 'pilotage' | 'operations' }

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
  [['R01', 'R02', 'R03', 'R04', 'R05'], ['/gouverneur', '/ia', '/verifier']],
  [['R06', 'R07', 'R08'], ['/communications', '/registre', '/ia']],
  [['R13', 'R14', 'R15', 'R16'], ['/registre']],
  [['R17', 'R18', 'R19'], ['/tresor']],
  [['R09', 'R10', 'R11'], ['/terrain']],
  [['R22', 'R23', 'R24', 'R28'], ['/audit', '/tresor']],
  [['R26'], ['/communications', '/audit']],
];

export function visibleNav(roles: string[] | undefined): NavItem[] {
  if (!roles) return NAV; // utilisateurs inconnus (hors ligne) : tout afficher
  const allowed = new Set<string>(['/']);
  for (const [rs, routes] of ROLE_ROUTES) if (roles.some((r) => rs.includes(r))) routes.forEach((x) => allowed.add(x));
  if (allowed.size === 1) allowed.add('/verifier');
  return NAV.filter((n) => allowed.has(n.to));
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
  const items = visibleNav(user?.roles);
  return (
    <nav className="sidebar" aria-label={tr('nav.main')}>
      {GROUPS.filter((g) => items.some((n) => n.group === g.id)).map((g) => (
        <div className="side-group" key={g.id}>
          <p className="side-label">{tr(g.key)}</p>
          <ul>
            {items.filter((n) => n.group === g.id).map((n) => (
              <li key={n.to}>
                <NavLink to={n.to} end={n.to === '/'} className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}>
                  <Icon name={n.icon} size={18} /> <span>{tr(n.key)}</span>
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
  const items = visibleNav(user?.roles);
  const hasMore = items.length > 5;
  const bottom = hasMore ? items.slice(0, 4) : items;
  const [more, setMore] = useState(false);
  const loc = useLocation();
  useEffect(() => setMore(false), [loc.pathname]);
  return (
    <>
      <nav className="bottom-nav" aria-label={tr('nav.main')} style={{ gridTemplateColumns: `repeat(${bottom.length + (hasMore ? 1 : 0)}, 1fr)` }}>
        {bottom.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `bn-link ${isActive ? 'active' : ''}`}>
            <Icon name={n.icon} size={22} />
            <span>{tr(SHORT[n.to] ?? n.key)}</span>
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
          <div className="sheet" id="more-sheet" role="dialog" aria-modal="true" aria-label={tr('nav.more')} onClick={(e) => e.stopPropagation()}>
            {GROUPS.filter((g) => items.some((n) => n.group === g.id)).map((g) => (
              <div key={g.id} className="sheet-group">
                <p className="side-label">{tr(g.key)}</p>
                <ul>
                  {items.filter((n) => n.group === g.id).map((n) => (
                    <li key={n.to}>
                      <NavLink to={n.to} end={n.to === '/'} className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}>
                        <Icon name={n.icon} size={18} /> <span>{tr(n.key)}</span>
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
        <p className="footer-legal">{tr('footer.legal')}</p>
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
