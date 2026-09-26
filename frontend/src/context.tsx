import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isLanguageCode, isCurrencyCode, intlLocale, type CurrencyCode, type LanguageCode } from '@mosolo/shared';
import { api, asList, getDemoUser, safeGet, safeSet, setApiLang, setDemoUser } from './lib/api';
import { tr, type UIKey } from './lib/i18n';
import { EXAMPLE_RATES } from './lib/money';
import type { DemoUser, ExchangeRates } from './lib/types';

export type ThemePref = 'system' | 'light' | 'dark';

interface AppState {
  lang: LanguageCode;
  setLang: (l: LanguageCode) => void;
  currency: CurrencyCode;
  setCurrency: (c: CurrencyCode) => void;
  theme: ThemePref;
  resolvedTheme: 'light' | 'dark';
  setTheme: (t: ThemePref) => void;
  users: DemoUser[];
  usersError: boolean;
  user: DemoUser | null;
  setUserId: (id: string) => void;
  rates: ExchangeRates | null;
  tr: (key: UIKey, vars?: Record<string, string | number>) => string;
  locale: string;
  fmtDate: (iso: string | undefined, withTime?: boolean) => string;
}

const Ctx = createContext<AppState | null>(null);

function readTheme(): ThemePref {
  const v = safeGet('mosolo.theme');
  return v === 'light' || v === 'dark' ? v : 'system';
}
function systemDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function normalizeRates(v: unknown): ExchangeRates | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const rates: ExchangeRates['rates'] = {};
  const raw = o.rates;
  if (Array.isArray(raw)) {
    for (const r of raw as Record<string, unknown>[]) {
      const code = String(r.currency ?? r.code ?? r.from ?? '');
      const rate = r.rate ?? r.cdfPerUnit ?? r.value;
      if (isCurrencyCode(code) && rate !== undefined) rates[code] = String(rate);
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
      if (isCurrencyCode(k)) rates[k] = String(typeof val === 'object' && val ? (val as Record<string, unknown>).rate : val);
    }
  }
  if (Object.keys(rates).length === 0) return null;
  return { date: String(o.date ?? ''), source: o.source ? String(o.source) : undefined, rates, example: Boolean(o.example) };
}

export function AppProvider({ children, initialLang }: { children: ReactNode; initialLang?: LanguageCode }) {
  const [lang, setLangState] = useState<LanguageCode>(() => {
    const s = safeGet('mosolo.lang');
    return initialLang ?? (s && isLanguageCode(s) ? s : 'fr');
  });
  const [currency, setCurrencyState] = useState<CurrencyCode>(() => {
    const s = safeGet('mosolo.currency');
    return s && isCurrencyCode(s) ? s : 'CDF';
  });
  const [theme, setThemeState] = useState<ThemePref>(readTheme);
  const [sysDark, setSysDark] = useState(systemDark);
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [usersError, setUsersError] = useState(false);
  const [userId, setUserIdState] = useState<string | null>(getDemoUser);
  const [rates, setRates] = useState<ExchangeRates | null>(null);

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSysDark(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);

  const resolvedTheme = theme === 'system' ? (sysDark ? 'dark' : 'light') : theme;
  useEffect(() => {
    const el = document.documentElement;
    if (theme === 'system') delete el.dataset.theme; else el.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute('content', resolvedTheme === 'dark' ? '#0E2A27' : '#1BA996');
  }, [theme, resolvedTheme]);

  useEffect(() => {
    document.documentElement.lang = lang;
    setApiLang(lang);
  }, [lang]);

  useEffect(() => {
    let alive = true;
    api<unknown>('/v1/demo/users')
      .then((v) => {
        if (!alive) return;
        const list = asList<DemoUser>(v, 'users');
        setUsers(list);
        if (list.length && !list.some((u) => u.id === getDemoUser())) {
          const first = list[0]!;
          setDemoUser(first.id);
          setUserIdState(first.id);
        }
      })
      .catch(() => alive && setUsersError(true));
    const today = new Date().toISOString().slice(0, 10);
    api<unknown>(`/v1/exchange-rates/${today}`)
      .then((v) => alive && setRates(normalizeRates(v) ?? EXAMPLE_RATES))
      .catch(() => alive && setRates(EXAMPLE_RATES));
    return () => { alive = false; };
  }, []);

  const setLang = useCallback((l: LanguageCode) => { safeSet('mosolo.lang', l); setLangState(l); }, []);
  const setCurrency = useCallback((c: CurrencyCode) => { safeSet('mosolo.currency', c); setCurrencyState(c); }, []);
  const setTheme = useCallback((t: ThemePref) => { safeSet('mosolo.theme', t === 'system' ? null : t); setThemeState(t); }, []);
  const setUserId = useCallback((id: string) => { setDemoUser(id); setUserIdState(id); }, []);

  const value = useMemo<AppState>(() => {
    const locale = intlLocale(lang);
    return {
      lang, setLang, currency, setCurrency, theme, resolvedTheme, setTheme,
      users, usersError, user: users.find((u) => u.id === userId) ?? null, setUserId, rates,
      tr: (key, vars) => tr(lang, key, vars),
      locale,
      fmtDate: (iso, withTime = false) => {
        if (!iso) return '—';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        try {
          return d.toLocaleString(locale, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
        } catch {
          return d.toISOString().slice(0, withTime ? 16 : 10).replace('T', ' ');
        }
      },
    };
  }, [lang, setLang, currency, setCurrency, theme, resolvedTheme, setTheme, users, usersError, userId, setUserId, rates]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp hors AppProvider');
  return v;
}
