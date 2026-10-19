// Number, unit and time formatting. Same rules as the old UI: unknown values print "-", never 0.

const SI: [number, string][] = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'K']];

export function short(v: number | null | undefined, d = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  const a = Math.abs(v);
  for (const [n, s] of SI) if (a >= n) return `${(v / n).toFixed(d).replace(/\.0+$/, '')}${s}`;
  return Number.isInteger(v) ? String(v) : v.toFixed(a < 10 ? 2 : 1).replace(/\.?0+$/, '');
}

export type Unit = 'none' | 'percent' | 'bytes' | 'bps' | 'Bps' | 's' | 'ms' | 'reqps' | 'iops' | 'short';
export const UNITS: [Unit, string][] = [
  ['none', 'Auto'], ['percent', 'Percent'], ['bytes', 'Bytes'], ['bps', 'bits/s'], ['Bps', 'Bytes/s'],
  ['s', 'Seconds'], ['ms', 'Milliseconds'], ['reqps', 'Requests/s'],
];

export function fmt(value: number | string | null | undefined, unit: Unit | string = 'none', d?: number): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  let v = Number(value);
  switch (unit) {
    case 'percent': return `${v.toFixed(d ?? 1)}%`;
    case 'bytes': {
      const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
      while (Math.abs(v) >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      return `${v.toFixed(i ? d ?? 1 : 0)} ${u[i]}`;
    }
    case 'bps': return `${short(v)}bps`;
    case 'Bps': return `${fmt(v, 'bytes')}/s`;
    case 's':
      if (v >= 86400) return `${Math.floor(v / 86400)}d ${Math.floor((v % 86400) / 3600)}h`;
      if (v >= 3600) return `${Math.floor(v / 3600)}h ${Math.floor((v % 3600) / 60)}m`;
      if (v >= 60) return `${Math.floor(v / 60)}m ${Math.floor(v % 60)}s`; // 772.09s read as a raw number
      if (v >= 1) return `${v.toFixed(d ?? 2)}s`;
      return `${(v * 1000).toFixed(d ?? 1)}ms`;
    case 'ms': return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
    case 'reqps': return `${short(v)}/s`;
    case 'iops': return `${short(v)} io/s`;
    default: return short(v, d ?? 1);
  }
}

const p2 = (n: number) => String(n).padStart(2, '0');

export function timeHM(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
export function dateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
export function tzName(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'; } catch { return 'local time'; }
}
/** "UTC+05:30" for the given moment (offset can change with daylight saving) */
export function tzLabel(ms = Date.now()): string {
  const off = -new Date(ms).getTimezoneOffset();
  return `UTC${off >= 0 ? '+' : '-'}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`;
}
export function ago(iso: string | number): string {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
/** Hover text for a timestamp: local time with zone, the same moment in UTC, and how long ago */
export function timeTitle(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  return `${dateTime(ms)} ${tzLabel(ms)} (${tzName()})\n${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC\n${ago(ms)}`;
}
export function dateTimeZ(ms: number): string {
  return Number.isFinite(ms) ? `${dateTime(ms)} ${tzLabel(ms)}` : '-';
}
export function timeHeader(label = 'Time'): string {
  return `${label} (${tzLabel()})`;
}
export function legendName(metric: Record<string, string>, tpl?: string): string {
  if (tpl) return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => metric[k] ?? '');
  const { __name__, ...rest } = metric;
  const inner = Object.entries(rest).map(([k, v]) => `${k}="${v}"`).join(', ');
  return `${__name__ || ''}${inner ? `{${inner}}` : ''}` || 'value';
}
/** short series label for table columns: just the label values */
export function shortLabel(l: string): string {
  const m = /\{(.*)\}/.exec(l);
  return m ? m[1].split(', ').map((x) => x.split('=')[1]?.replace(/"/g, '')).join(' / ') : l;
}
export function pctChange(now: number | null, before: number | null): number | null {
  if (now === null || before === null || before === undefined || !Number.isFinite(before) || before === 0) return null;
  return ((now - before) / Math.abs(before)) * 100;
}
export function browserName(ua = ''): string {
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : (ua.split(' ')[0] || 'Unknown');
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} on ${os}` : b;
}
/** escape a value for use inside a PromQL/LogQL double-quoted string */
export function escapeLabel(v: string): string {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
