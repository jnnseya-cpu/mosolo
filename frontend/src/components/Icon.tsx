/**
 * Jeu d'icônes linéaires dessiné à la main (grille 24, trait 1,5 px, currentColor).
 * Aucune icône « magique » (étincelles, robot, baguette) : l'analyse est signalée sobrement.
 */
const P: Record<string, string> = {
  home: 'M3.5 10.5 12 4l8.5 6.5M5.5 9v10.5h13V9M10 19.5v-5h4v5',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5',
  shieldCheck: 'M12 3.5 5 6v5.5c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9V6l-7-2.5ZM8.8 12l2.2 2.2 4.2-4.4',
  gauge: 'M4 17a8 8 0 1 1 16 0M12 17l3.5-5M4 20.5h16',
  message: 'M4 5.5h16v11H9l-5 3.5v-14.5ZM8 9.5h8M8 12.5h5',
  scale: 'M12 4v16M7 20h10M5 7h14M5 7l-2.5 6a3 3 0 0 0 5 0L5 7Zm14 0-2.5 6a3 3 0 0 0 5 0L19 7Z',
  bank: 'M3.5 9 12 4.5 20.5 9M5 9v8M9.7 9v8M14.3 9v8M19 9v8M3.5 20h17',
  pin: 'M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  ledger: 'M6 3.5h10.5L19 6v14.5H6V3.5ZM9 8.5h7M9 12h7M9 15.5h4',
  analysis: 'M4 19.5h16M6.5 16V11M11 16V7M15.5 16v-6M20 4.5l-3.5 3',
  menu: 'M4 7h16M4 12h16M4 17h16',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  moon: 'M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5 10 17.5 19 7',
  x: 'M7 7l10 10M17 7 7 17',
  clock: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 7.5V12l3 2',
  alert: 'M12 4 2.8 19.5h18.4L12 4ZM12 10v4.5M12 17h.01',
  info: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 11v5.5M12 7.8h.01',
  question: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4M12 16.8h.01',
  replace: 'M4.5 9.5h12l-3-3M19.5 14.5h-12l3 3',
  ban: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM6 6l12 12',
  offline: 'M3 3l18 18M8.5 16a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 4-2.3M19 12.5a10 10 0 0 0-3.2-2M2 9a14.5 14.5 0 0 1 4.5-2.8M22 9a14.5 14.5 0 0 0-10-4M12 19.5h.01',
  download: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M4.5 19.5h15',
  upload: 'M12 15V4M7.5 8.5 12 4l4.5 4.5M4.5 19.5h15',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4',
  history: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4M12 8v4.5l3 1.5',
  camera: 'M4 7.5h3.5L9 5h6l1.5 2.5H20v11H4v-11ZM12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  qr: 'M4 4h6v6H4V4ZM14 4h6v6h-6V4ZM4 14h6v6H4v-6ZM14 14h2.5v2.5H14V14ZM17.5 17.5H20V20h-2.5v-2.5ZM14 19.5h1M19.5 14v1',
  arrowRight: 'M4.5 12h15M14 6.5l5.5 5.5-5.5 5.5',
  chevronDown: 'M6 9.5l6 6 6-6',
  chevronRight: 'M9.5 6l6 6-6 6',
  external: 'M13.5 4.5h6v6M19.5 4.5 11 13M17.5 14v5.5h-13v-13H10',
  globe: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5Z',
  lock: 'M6 10.5h12v10H6v-10ZM8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5',
  table: 'M4 5h16v14H4V5ZM4 10h16M4 14.5h16M10 10v9',
  chart: 'M4 4.5v15h15.5M8 15l3.5-4 3 2.5L19.5 8',
  send: 'M20.5 3.5 10 14M20.5 3.5l-6.5 17-4-6.5-6.5-4 17-6.5Z',
  mark: 'M12 3.5 20.5 12 12 20.5 3.5 12 12 3.5Z',
  cash: 'M3.5 7h17v10h-17V7ZM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3.5 20l17-16',
  phone: 'M7.5 3.5h9v17h-9v-17ZM11 17.5h2',
  card: 'M3.5 6h17v12h-17V6ZM3.5 10h17M7 14.5h3',
  store: 'M4 9.5 5.5 4.5h13L20 9.5M5 9.5V20h14V9.5M4 9.5c0 1.4 1.1 2.5 2.5 2.5S9 10.9 9 9.5c0 1.4 1.1 2.5 2.5 2.5h1c1.4 0 2.5-1.1 2.5-2.5 0 1.4 1.1 2.5 2.5 2.5S20 10.9 20 9.5M10 20v-4.5h4V20',
  keypad: 'M6.5 4h11v16h-11V4ZM9 7.5h6M9 11h.01M12 11h.01M15 11h.01M9 14h.01M12 14h.01M15 14h.01M9 17h.01M12 17h.01M15 17h.01',
  gps: 'M12 17.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  sync: 'M4.5 10a7.5 7.5 0 0 1 13.4-3.4M19.5 4v3.5H16M19.5 14a7.5 7.5 0 0 1-13.4 3.4M4.5 20v-3.5H8',
  file: 'M6 3.5h8l4 4v13H6v-17ZM14 3.5v4h4',
  sort: 'M8 5v14M4.5 8.5 8 5l3.5 3.5M16 19V5M12.5 15.5 16 19l3.5-3.5',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 20, className, title }: { name: IconName | string; size?: number; className?: string; title?: string }) {
  const d = P[name] ?? P.mark;
  return (
    <svg
      className={`icon ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  );
}
