// Theme: "dark" (default), "light" or "system". Colours always come from CSS variables in base.css,
// so charts and status marks follow the theme. Charts read colours when they are drawn and are
// redrawn when the theme changes (the theme value is part of every chart's dependencies).

export type ThemePref = 'dark' | 'light' | 'system';
export const THEMES: [ThemePref, string][] = [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']];

const lightQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

export function resolveTheme(pref: ThemePref): 'dark' | 'light' {
  return pref === 'system' ? (lightQuery?.matches ? 'light' : 'dark') : pref;
}
export function storedTheme(): ThemePref {
  try {
    const v = localStorage.getItem('oo.theme');
    return v === 'light' || v === 'system' ? v : 'dark';
  } catch { return 'dark'; }
}
export function applyTheme(pref: ThemePref): 'dark' | 'light' {
  const t = resolveTheme(pref);
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('oo.theme', pref); } catch { /* storage blocked */ }
  return t;
}
export function onSystemThemeChange(cb: () => void): () => void {
  lightQuery?.addEventListener?.('change', cb);
  return () => lightQuery?.removeEventListener?.('change', cb);
}

export function color(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim() || '#888888';
}
export function palette(): string[] {
  return Array.from({ length: 10 }, (_, i) => color(`chart-${i + 1}`));
}
/** Dark or white text, whichever reads better on this background (WCAG contrast) */
export function readableOn(bg: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(bg).trim());
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const L = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? '#0b1324' : '#ffffff';
}
export function statusColor(kind: 'ok' | 'warn' | 'crit' | 'unknown'): string {
  return color(kind);
}
/** value -> status colour, for "higher is worse" (CPU) or "lower is worse" (free disk) */
export function thresholdColor(v: number | null | undefined, { warn, crit, lowerIsWorse = false, base = 'chart-1' }: { warn: number; crit: number; lowerIsWorse?: boolean; base?: string }): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return statusColor('unknown');
  const bad = (t: number) => (lowerIsWorse ? v < t : v >= t);
  return bad(crit) ? statusColor('crit') : bad(warn) ? statusColor('warn') : color(base);
}
export function hexA(hex: string, a: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
/** CSS class for a "higher is worse" percentage (CPU, memory), or "lower is worse" (free disk) */
export function toneClass(v: number | null | undefined, higherIsWorse = true): string {
  if (v === null || v === undefined) return 'dim';
  if (higherIsWorse) return v >= 90 ? 'c-red' : v >= 80 ? 'c-orange' : '';
  return v < 10 ? 'c-red' : v < 20 ? 'c-orange' : 'c-green';
}
