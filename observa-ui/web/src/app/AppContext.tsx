// App-wide state: the signed-in user, permissions + modules, theme, the global time range,
// auto-refresh, per-user preferences, and the top-bar data-source chip.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient, keepPreviousData, type QueryKey } from '@tanstack/react-query';
import type { Me } from '@/lib/api';
import { applyTheme, onSystemThemeChange, storedTheme, type ThemePref } from '@/lib/theme';
import { findRoute } from './routes';

// ---------------- time range ----------------
export const RANGES: [number, string][] = [
  [300, 'Last 5 minutes'], [900, 'Last 15 minutes'], [3600, 'Last 1 hour'], [6 * 3600, 'Last 6 hours'],
  [12 * 3600, 'Last 12 hours'], [24 * 3600, 'Last 24 hours'], [2 * 86400, 'Last 2 days'], [7 * 86400, 'Last 7 days'], [30 * 86400, 'Last 30 days'],
];
export const REFRESH: [number, string][] = [[0, 'Off'], [10_000, '10s'], [30_000, '30s'], [60_000, '1m'], [300_000, '5m']];

/** relative = "last N seconds" (moves with the clock); absolute = a fixed window (from a link or a chart click) */
export type TimeRange = { kind: 'relative'; seconds: number } | { kind: 'absolute'; from: number; to: number };
export type Range = { start: number; end: number };

export function rangeParams(r: TimeRange): Range {
  if (r.kind === 'absolute') return { start: r.from, end: r.to };
  const end = Math.floor(Date.now() / 1000);
  return { start: end - r.seconds, end };
}
export function rangeKey(r: TimeRange): string {
  return r.kind === 'absolute' ? `abs:${r.from}-${r.to}` : `rel:${r.seconds}`;
}
export function rangeSeconds(r: TimeRange): number {
  return r.kind === 'absolute' ? r.to - r.from : r.seconds;
}
/** query-string for a link to another page around a moment (seconds) */
export function windowQuery(centerSec: number, halfWidthSec = 300): string {
  return `from=${Math.floor(centerSec - halfWidthSec)}&to=${Math.ceil(centerSec + halfWidthSec)}`;
}

// ---------------- permissions ----------------
const LEGACY: Record<string, string> = { viewer: 'view', operator: 'dashboards.edit', admin: 'users.manage' };
export function hasPerm(me: Me | null, p: string): boolean {
  const perms = me?.user?.permissions || [];
  const need = LEGACY[p] || p;
  return perms.includes('*') || perms.includes(need);
}

export type DsChip = { label: string; tone: 'ok' | 'crit' | 'warn' } | null;

interface AppCtx {
  me: Me;
  reloadMe: () => Promise<Me>;
  logout: () => Promise<void>;
  theme: 'dark' | 'light';
  themePref: ThemePref;
  setThemePref: (t: ThemePref) => void;
  range: TimeRange;
  setRange: (r: TimeRange) => void;
  refreshMs: number;
  setRefreshMs: (ms: number) => void;
  refreshAll: () => void;
  can: (perm: string) => boolean;
  moduleOn: (id?: string | null) => boolean;
  /** may the user open this path? (module on + permission) - every page-to-page link checks this */
  canOpen: (path: string) => boolean;
  pref: <T = any>(key: string) => T | undefined;
  savePref: (key: string, value: unknown) => void;
  dsChip: DsChip;
  setDsChip: (c: DsChip) => void;
}

const Ctx = createContext<AppCtx | null>(null);
export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside AppProvider');
  return c;
}
/** Theme state at the root - also used by the sign-in page, before there is a user */
type ThemeState = { theme: 'dark' | 'light'; pref: ThemePref; setPref: (p: ThemePref) => void };
const ThemeCtx = createContext<ThemeState>({ theme: 'dark', pref: 'dark', setPref: () => {} });
export const useTheme = () => useContext(ThemeCtx);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPref] = useState<ThemePref>(storedTheme);
  const [theme, setTheme] = useState(() => applyTheme(pref));
  useEffect(() => { setTheme(applyTheme(pref)); }, [pref]);
  useEffect(() => onSystemThemeChange(() => { if (pref === 'system') setTheme(applyTheme('system')); }), [pref]);
  const v = useMemo(() => ({ theme, pref, setPref }), [theme, pref]);
  return <ThemeCtx.Provider value={v}>{children}</ThemeCtx.Provider>;
}

// ---------------- preferences (saved per user, fire and forget) ----------------
const pending: Record<string, unknown> = {};
let prefTimer: ReturnType<typeof setTimeout> | undefined;
function flushPrefs() {
  clearTimeout(prefTimer);
  if (!Object.keys(pending).length) return;
  const body = JSON.stringify(pending);
  Object.keys(pending).forEach((k) => delete pending[k]);
  // keepalive lets the request finish even while the page is closing
  fetch('/api/me/prefs', { method: 'PUT', keepalive: true, credentials: 'same-origin', body, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'observa' } }).catch(() => {});
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPrefs);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushPrefs());
}

export function AppProvider({ initialMe, onLogout, children }: { initialMe: Me; onLogout: () => Promise<void>; children: ReactNode }) {
  const qc = useQueryClient();
  const [me, setMe] = useState(initialMe);
  const prefsRef = useRef<Record<string, any>>(initialMe.prefs || {});
  const { theme, pref: themePref, setPref: setThemePrefState } = useTheme();
  // the user's saved theme wins over this browser's last choice
  useEffect(() => {
    const t = initialMe.prefs?.theme;
    if (t === 'dark' || t === 'light' || t === 'system') setThemePrefState(t);
  }, [initialMe, setThemePrefState]);
  const initialRange = Number(initialMe.prefs?.timeRange);
  const [range, setRangeState] = useState<TimeRange>({ kind: 'relative', seconds: RANGES.some(([s]) => s === initialRange) ? initialRange : Number(sessionStorage.getItem('oo.range')) || 3600 });
  const [refreshMs, setRefreshMsState] = useState<number>(() => {
    const p = Number(initialMe.prefs?.refreshMs);
    return REFRESH.some(([ms]) => ms === p) ? p : 30_000;
  });
  const [dsChip, setDsChip] = useState<DsChip>(null);

  const savePref = useCallback((key: string, value: unknown) => {
    prefsRef.current = { ...prefsRef.current, [key]: value };
    pending[key] = value;
    clearTimeout(prefTimer);
    prefTimer = setTimeout(flushPrefs, 800);
  }, []);

  const value = useMemo<AppCtx>(() => {
    const can = (p: string) => hasPerm(me, p);
    const moduleOn = (id?: string | null) => !id || (me.modules || []).includes(id);
    return {
      me,
      reloadMe: async () => {
        const r = await fetch('/api/me', { credentials: 'same-origin' }).then((x) => x.json());
        setMe(r);
        return r;
      },
      logout: onLogout,
      theme,
      themePref,
      setThemePref: (t) => { setThemePrefState(t); savePref('theme', t); },
      range,
      setRange: (r) => {
        setRangeState(r);
        if (r.kind === 'relative') {
          sessionStorage.setItem('oo.range', String(r.seconds));
          savePref('timeRange', r.seconds);
          flushPrefs();
        }
      },
      refreshMs,
      setRefreshMs: (ms) => { setRefreshMsState(ms); savePref('refreshMs', ms); },
      refreshAll: () => { qc.invalidateQueries({ refetchType: 'active' }); },
      can,
      moduleOn,
      canOpen: (path: string) => {
        const r = findRoute(path.split('?')[0]);
        return !!r && moduleOn(r.module) && (!r.perm || can(r.perm));
      },
      pref: (key) => prefsRef.current[key],
      savePref,
      dsChip,
      setDsChip,
    };
  }, [me, theme, themePref, setThemePrefState, range, refreshMs, dsChip, onLogout, qc, savePref]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Data hook for page panels. The query re-runs when the global time range changes, refetches on the
 * auto-refresh interval (unless the range is fixed), and keeps the previous data on screen while it reloads
 * (no flashing skeletons on every refresh).
 */
export function useRangeQuery<T>(key: QueryKey, fn: (r: Range) => Promise<T>, opts: { enabled?: boolean; autoRefresh?: boolean } = {}) {
  const { range, refreshMs } = useApp();
  const auto = opts.autoRefresh !== false && range.kind === 'relative' && refreshMs > 0;
  return useQuery({
    queryKey: [...key, rangeKey(range)],
    queryFn: () => fn(rangeParams(range)),
    enabled: opts.enabled,
    refetchInterval: auto ? refreshMs : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}
/** Same, for data that does not depend on the time range (lists, settings) */
export function usePlainQuery<T>(key: QueryKey, fn: () => Promise<T>, opts: { enabled?: boolean; autoRefresh?: boolean } = {}) {
  const { refreshMs } = useApp();
  const auto = opts.autoRefresh !== false && refreshMs > 0;
  return useQuery({
    queryKey: key,
    queryFn: fn,
    enabled: opts.enabled,
    refetchInterval: auto ? refreshMs : false,
    placeholderData: keepPreviousData,
  });
}
