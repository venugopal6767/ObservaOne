// Shared UI helpers: DOM, formatting, icons, charts, modal, toast, API calls.

// ---------- DOM ----------
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // only used with our own static SVG strings
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

// ---------- API ----------
// status = HTTP status; state = what the server said about the data source
// ('unavailable' = configured but not answering, 'not_configured' = no address set)
export class ApiError extends Error {
  constructor(message, { status, state, source } = {}) {
    super(message);
    this.status = status;
    this.state = state || null;
    this.source = source || null;
  }
}
export async function api(path, { method = 'GET', body, query } = {}) {
  let url = `/api${path}`;
  if (query) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
    url += `?${q}`;
  }
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'observa', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && path !== '/login') {
    window.dispatchEvent(new CustomEvent('oo:unauthorized', { detail: data?.error }));
  }
  if (!res.ok) throw new ApiError(data?.error || `HTTP ${res.status}`, { status: res.status, state: data?.state, source: data?.source });
  return data;
}

// ---------- formatting ----------
const SI = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'K']];
export function short(v, d = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  const a = Math.abs(v);
  for (const [n, s] of SI) if (a >= n) return `${(v / n).toFixed(d).replace(/\.0+$/, '')}${s}`;
  return Number.isInteger(v) ? String(v) : v.toFixed(a < 10 ? 2 : 1).replace(/\.?0+$/, '');
}
export function fmt(v, unit = 'none', d) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '-';
  v = Number(v);
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
      if (v >= 1) return `${v.toFixed(d ?? 2)}s`;
      return `${(v * 1000).toFixed(d ?? 1)}ms`;
    case 'ms': return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
    case 'reqps': return `${short(v)}/s`;
    case 'iops': return `${short(v)} io/s`;
    default: return short(v, d ?? 1);
  }
}
export function timeHM(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
export function dateTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// ---------- time zones ----------
// Every timestamp the UI prints is in the viewer's local time. These make that zone explicit,
// so people in different offices can compare times.
export function tzName() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'; } catch { return 'local time'; }
}
// "UTC+05:30" for the given moment (offset can change with daylight saving)
export function tzLabel(ms = Date.now()) {
  const off = -new Date(ms).getTimezoneOffset();
  const p = (n) => String(n).padStart(2, '0');
  return `UTC${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}
// Hover text for one timestamp: local time with zone name, the same moment in UTC, and how long ago
export function timeTitle(ms) {
  if (!Number.isFinite(ms)) return '';
  return `${dateTime(ms)} ${tzLabel(ms)} (${tzName()})\n${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC\n${ago(new Date(ms).toISOString())}`;
}
// A timestamp element: shown text + full detail on hover. "text" defaults to the full local time.
export function timeEl(ms, text) {
  if (!Number.isFinite(ms)) return '-';
  return h('time', { datetime: new Date(ms).toISOString(), title: timeTitle(ms) }, text ?? dateTime(ms));
}
// Full local time with its zone, for single values outside tables: "2026-10-11 00:44:12 UTC+05:30"
export function dateTimeZ(ms) {
  return Number.isFinite(ms) ? `${dateTime(ms)} ${tzLabel(ms)}` : '-';
}
// Table header for a time column: "Time (UTC+05:30)"
export function timeHeader(label = 'Time') {
  return `${label} (${tzLabel()})`;
}

export function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function legendName(metric, tpl) {
  if (tpl) return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => metric[k] ?? '');
  const { __name__, ...rest } = metric;
  const inner = Object.entries(rest).map(([k, v]) => `${k}="${v}"`).join(', ');
  return `${__name__ || ''}${inner ? `{${inner}}` : ''}` || 'value';
}

// ---------- icons (24x24 stroke icons) ----------
const P = {
  overview: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  dashboards: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  metrics: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  logs: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/>',
  traces: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 6h7M6 8.5V14a4 4 0 0 0 4 4h5.5"/>',
  services: '<path d="M12 2 3 7l9 5 9-5-9-5z"/><path d="m3 17 9 5 9-5M3 12l9 5 9-5"/>',
  infrastructure: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  alerting: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  datasources: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-6.5 0-10-7-10-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 5c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  play: '<path d="m6 4 14 8-14 8z"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  bellOff: '<path d="M13.73 21a2 2 0 0 1-3.46 0M18.63 13A17.89 17.89 0 0 1 18 8M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.33-5M1 1l22 22"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
  down: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
  cube: '<path d="M21 16V8l-9-5-9 5v8l9 5 9-5z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/>',
  github: '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>',
  google: '<path d="M21 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h5.1a4.4 4.4 0 0 1-1.9 2.9v2.4h3.1c1.8-1.7 2.7-4.1 2.7-7z"/><path d="M12 21c2.6 0 4.7-.9 6.3-2.3l-3.1-2.4c-.9.6-2 .9-3.2.9-2.5 0-4.6-1.7-5.3-3.9H3.5v2.5A9.5 9.5 0 0 0 12 21z"/><path d="M6.7 13.3a5.7 5.7 0 0 1 0-3.6V7.2H3.5a9.5 9.5 0 0 0 0 8.6z"/><path d="M12 5.8c1.4 0 2.6.5 3.6 1.4l2.7-2.7A9.5 9.5 0 0 0 3.5 7.2l3.2 2.5C7.4 7.5 9.5 5.8 12 5.8z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  windows: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
  k8s: '<path d="M12 2 4 6v12l8 4 8-4V6z"/><circle cx="12" cy="12" r="3"/><path d="M12 2v7M12 15v7M4 6l5.5 4.5M14.5 13.5 20 18M20 6l-5.5 4.5M9.5 13.5 4 18"/>',
  agent: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
};
export function icon(name, size = 18, extraClass = '') {
  const span = h('span', { class: `ic ${extraClass}`, 'aria-hidden': 'true' });
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  return span;
}
export function logo(size = 30) {
  const span = h('span', { class: 'logo-mark', 'aria-hidden': 'true' });
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 40 40"><defs><linearGradient id="lg1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#60a5fa"/><stop offset="1" stop-color="#2563eb"/></linearGradient></defs><path d="M20 3 4 35h9l7-15 7 15h9z" fill="url(#lg1)"/><circle cx="20" cy="27" r="4.5" fill="#0b1324" stroke="#93c5fd" stroke-width="2"/></svg>`;
  return span;
}

// ---------- small components ----------
export function pill(text, tone = 'muted') { return h('span', { class: `pill pill-${tone}` }, text); }
export function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, icon('activity', 28), h('div', { class: 'empty-title' }, title), text ? h('div', { class: 'muted' }, text) : null, action || null);
}
export function errorBox(msg) { return h('div', { class: 'error-box' }, icon('alert', 16), h('span', {}, msg)); }
export function spinner() { return h('div', { class: 'spinner' }); }

// ---------- data states ----------
// One look and one meaning per state, on every page:
//   loading        waiting for the answer
//   empty          the source answered, there is simply no data for this view
//   not_configured the source has no address yet (an admin must set it)
//   unavailable    the source is configured but did not answer (down, network, timeout)
//   error          the request failed for another reason (bad query, server error)
//   stale          the last data is older than expected (shown with its age)
//   partial        some parts loaded, some did not (use stateBanner)
// Never replace any of these with made-up numbers.
const STATE_META = {
  loading: { icon: null, title: 'Loading...' },
  empty: { icon: 'activity', title: 'No data' },
  not_configured: { icon: 'settings', title: 'Not configured' },
  unavailable: { icon: 'alert', title: 'Data source unavailable' },
  error: { icon: 'alert', title: 'Something went wrong' },
  stale: { icon: 'clock', title: 'Data is out of date' },
  partial: { icon: 'alert', title: 'Some data is missing' },
};
export function stateView(kind, { title, text, action, skeleton: sk } = {}) {
  const m = STATE_META[kind] || STATE_META.error;
  if (kind === 'loading') {
    // a skeleton shaped like what is coming (table / chart / cards); spinner only for small inline waits
    return h('div', { class: 'state-loading', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
      sk ? skeleton(sk) : spinner(), h('span', { class: 'sr-only' }, title || m.title));
  }
  return h('div', { class: `state state-${kind}`, role: kind === 'error' || kind === 'unavailable' ? 'alert' : 'status' },
    icon(m.icon, 26),
    h('div', { class: 'state-title' }, title || m.title),
    text ? h('div', { class: 'state-text' }, text) : null,
    action || null);
}
// Grey placeholder shapes while data loads. They never show numbers or text.
export function skeleton(kind = 'table', n) {
  if (kind === 'cards') return h('div', { class: 'skeleton-cards' }, Array.from({ length: n || 4 }, () => h('div', { class: 'sk sk-card' })));
  if (kind === 'chart') return h('div', { class: 'skeleton' }, h('div', { class: 'sk sk-line', style: { width: '30%' } }), h('div', { class: 'sk sk-chart' }));
  return h('div', { class: 'skeleton' }, Array.from({ length: n || 6 }, () =>
    h('div', { class: 'sk-row' }, h('div', { class: 'sk sk-line' }), h('div', { class: 'sk sk-line' }), h('div', { class: 'sk sk-line' }), h('div', { class: 'sk sk-line' }))));
}

// Row count + paging for a table. Returns the rows to draw and the footer element.
// The count is always the real number of rows we have; "of N" is never estimated.
export function paginate(rows, { page = 0, pageSize = 50, onPage, noun = 'rows', note } = {}) {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(0, page), pages - 1);
  const from = total ? p * pageSize + 1 : 0, to = Math.min(total, (p + 1) * pageSize);
  const foot = h('div', { class: 'table-foot', role: 'status' },
    h('span', {}, total ? `${from}-${to} of ${total} ${noun}` : `0 ${noun}`),
    note ? h('span', { class: 'dim' }, note) : null,
    pages > 1 ? h('div', { class: 'pager' },
      h('button', { class: 'btn', disabled: p === 0, 'aria-label': 'Previous page', onclick: () => onPage(p - 1) }, 'Previous'),
      h('span', {}, `Page ${p + 1} of ${pages}`),
      h('button', { class: 'btn', disabled: p >= pages - 1, 'aria-label': 'Next page', onclick: () => onPage(p + 1) }, 'Next')) : null);
  return { rows: rows.slice(p * pageSize, (p + 1) * pageSize), foot, page: p };
}

// A thin line above content: partial data, truncated results, stale values
export function stateBanner(kind, text) {
  const m = STATE_META[kind] || STATE_META.partial;
  return h('div', { class: `state-banner state-banner-${kind}`, role: 'status' }, icon(m.icon || 'alert', 15), h('span', {}, text));
}
// Turn a failed API call into the right state. "what" names the data, e.g. "Logs".
export function stateFromError(e, what = 'Data') {
  const toSources = h('a', { href: '/datasources', 'data-link': true, class: 'btn btn-sm' }, 'Open Data Sources');
  if (e?.state === 'not_configured') return stateView('not_configured', { title: `${what}: data source not configured`, text: e.message, action: toSources });
  if (e?.state === 'unavailable' || e?.status === 502 || e?.status === 503 || e?.status === 504) {
    return stateView('unavailable', { title: `${what}: data source unavailable`, text: `${e.message}. Nothing is shown until it answers again.`, action: toSources });
  }
  return stateView('error', { title: `${what} could not be loaded`, text: e?.message || 'Unknown error' });
}
// Health of one thing (host, scrape target, service). "unknown"-like states never look green or red.
const HEALTH = {
  up: ['UP', 'solid-green', 'Answering normally'],
  healthy: ['Healthy', 'solid-green', ''],
  degraded: ['Degraded', 'solid-orange', ''],
  down: ['DOWN', 'solid-red', ''],
  not_reporting: ['Not reporting', 'stale', 'No data received recently. The host may be fine; the agent or network may have stopped.'],
  no_traffic: ['No traffic', 'muted', 'No requests in this period, so there is no error rate or latency to judge.'],
  unknown: ['Unknown', 'muted', 'Not checked yet.'],
};
export function healthPill(health, detail) {
  const [label, tone, hint] = HEALTH[health] || HEALTH.unknown;
  return h('span', { class: `pill pill-${tone}`, title: detail || hint || label }, label);
}

export function select(options, value, onchange, attrs = {}) {
  const s = h('select', { class: 'select', ...attrs, onchange: (e) => onchange(e.target.value) },
    options.map((o) => {
      const [v, label] = Array.isArray(o) ? o : [o, o];
      return h('option', { value: v, selected: String(v) === String(value) }, label);
    }));
  return s;
}

export function tabs(items, active, onclick) {
  return h('div', { class: 'tabs' }, items.map(([key, label]) =>
    h('button', { class: `tab ${key === active ? 'active' : ''}`, onclick: () => onclick(key) }, label)));
}

export function toggle(checked, onchange, disabled = false, title = '') {
  const input = h('input', { type: 'checkbox', checked, disabled, onchange: (e) => onchange(e.target.checked, e.target) });
  return h('label', { class: `switch ${disabled ? 'disabled' : ''}`, title }, input, h('span', { class: 'slider' }));
}

// ---------- toast ----------
export function toast(msg, tone = 'ok') {
  let box = $('#toasts');
  if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  const t = h('div', { class: `toast toast-${tone}` }, icon(tone === 'ok' ? 'check' : 'alert', 16), h('span', {}, msg));
  box.append(t);
  setTimeout(() => t.classList.add('hide'), 3500);
  setTimeout(() => t.remove(), 4000);
}

// ---------- modal ----------
export function modal(title, body, actions = [], { wide = false } = {}) {
  // keyboard: focus moves into the dialog, Tab stays inside it, Escape closes it,
  // and focus goes back to whatever opened it
  const opener = document.activeElement;
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); opener?.focus?.(); };
  const focusables = () => [...overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled);
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') {
      const f = focusables(); if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  const overlay = h('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('div', { class: 'modal-head' }, h('h3', { id: titleId }, title), h('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Close' }, icon('x'))),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) =>
        h('button', { class: `btn ${a.primary ? 'btn-primary' : a.danger ? 'btn-danger' : ''}`, onclick: async (e) => {
          const b = e.currentTarget;
          if (a.onclick) {
            b.disabled = true;
            try { const keep = await a.onclick(close); if (keep !== true) close(); }
            catch (err) { toast(err.message, 'err'); }
            finally { b.disabled = false; }
          } else close();
        } }, a.label))) : null));
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  setTimeout(() => (overlay.querySelector('input,select,textarea') || overlay.querySelector('.modal-foot .btn-primary, .modal-foot .btn-danger, .modal-foot .btn') || overlay.querySelector('.modal-head .icon-btn'))?.focus(), 30);
  return close;
}
export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}
export function confirmBox(title, text, okLabel = 'Confirm', danger = true) {
  return new Promise((resolve) => {
    modal(title, h('p', {}, text), [
      { label: 'Cancel', onclick: () => resolve(false) },
      { label: okLabel, danger, primary: !danger, onclick: () => resolve(true) },
    ]);
  });
}

// ---------- theme colours ----------
// Colours come from CSS variables (app.css), so charts and status marks follow the dark/light theme.
// Read them when a chart is drawn; the app redraws the page when the theme changes.
export function color(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim() || '#888888';
}
// Series colours, in order
export function palette() {
  return Array.from({ length: 10 }, (_, i) => color(`chart-${i + 1}`));
}
// Black or white text, whichever reads better on this background colour (WCAG contrast)
export function readableOn(bg) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(bg).trim());
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const L = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? '#0b1324' : '#ffffff';
}
// Status colour by meaning: ok / warn / crit / unknown
export function statusColor(kind) {
  return color({ ok: 'ok', warn: 'warn', crit: 'crit' }[kind] || 'unknown');
}
// value -> status for "higher is worse" (CPU, memory) or "lower is worse" (free disk)
export function thresholdColor(v, { warn, crit, lowerIsWorse = false, base = 'chart-1' } = {}) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return statusColor('unknown');
  const bad = (t) => (lowerIsWorse ? v < t : v >= t);
  return bad(crit) ? statusColor('crit') : bad(warn) ? statusColor('warn') : color(base);
}

// ---------- charts (Chart.js, loaded globally) ----------
function baseOptions(unit, { stacked = false, min, max, showLegend = false } = {}) {
  const GRID = color('chart-grid'), TICK = color('chart-tick');
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: showLegend, position: 'bottom', labels: { color: color('chart-legend'), boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle', font: { size: 11 } } },
      tooltip: {
        backgroundColor: color('tooltip-bg'), borderColor: color('tooltip-border'), borderWidth: 1, titleColor: color('tooltip-title'), bodyColor: color('tooltip-body'), padding: 10,
        callbacks: {
          title: (items) => (items[0] && typeof items[0].parsed.x === 'number' && items[0].parsed.x > 1e11 ? dateTimeZ(items[0].parsed.x) : items[0]?.label),
          label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y ?? c.parsed, unit)}`,
        },
      },
    },
    scales: {
      x: { grid: { color: GRID }, ticks: { color: TICK, maxTicksLimit: 7, font: { size: 10 } }, border: { display: false } },
      y: { stacked, min: min ?? (unit === 'percent' ? 0 : undefined), max, beginAtZero: true, grid: { color: GRID }, ticks: { color: TICK, maxTicksLimit: 5, font: { size: 10 }, callback: (v) => fmt(v, unit, 0) }, border: { display: false } },
    },
  };
}

export function timeChart(canvas, series, { unit = 'none', area = false, stacked = false, legend = false, min, max } = {}) {
  const pal = palette();
  const datasets = series.map((s, i) => {
    const c = s.color || pal[i % pal.length];
    return {
      label: s.label,
      data: s.points.map(([t, v]) => ({ x: t * 1000, y: v === null ? null : Number(v) })),
      borderColor: c,
      backgroundColor: area ? hexA(c, stacked ? 0.55 : 0.18) : c,
      fill: area ? (stacked ? (i === 0 ? 'origin' : '-1') : 'origin') : false,
      borderWidth: 1.6,
      pointRadius: 0,
      tension: 0.3,
      spanGaps: true,
    };
  });
  const opts = baseOptions(unit, { stacked, min, max, showLegend: legend });
  opts.scales.x.type = 'linear';
  opts.scales.x.ticks.callback = (v) => timeHM(v);
  const xs = datasets.flatMap((d) => d.data.map((p) => p.x));
  if (xs.length) { opts.scales.x.min = Math.min(...xs); opts.scales.x.max = Math.max(...xs); }
  return new window.Chart(canvas, { type: 'line', data: { datasets }, options: opts });
}

export function barChart(canvas, labels, values, { unit = 'none', colors, horizontal = false, max } = {}) {
  const opts = baseOptions(unit, { max });
  if (horizontal) {
    opts.indexAxis = 'y';
    [opts.scales.x, opts.scales.y] = [opts.scales.y, opts.scales.x];
    opts.scales.x.ticks.callback = (v) => fmt(v, unit, 0);
    opts.scales.y.ticks.callback = function (v) { return this.getLabelForValue(v); };
  }
  return new window.Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'value', data: values, backgroundColor: colors || labels.map(() => color('chart-1')), borderRadius: 3, maxBarThickness: 34 }] },
    options: opts,
  });
}

export function doughnut(canvas, labels, values, colors) {
  return new window.Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 0, spacing: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '72%', animation: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: color('tooltip-bg'), titleColor: color('tooltip-title'), bodyColor: color('tooltip-body'), borderColor: color('tooltip-border'), borderWidth: 1 } } },
  });
}

export function sparkline(canvas, points, lineColor = color('chart-1'), bars = false) {
  return new window.Chart(canvas, {
    type: bars ? 'bar' : 'line',
    data: {
      labels: points.map((p) => p[0]),
      datasets: [{ data: points.map((p) => Number(p[1])), borderColor: lineColor, backgroundColor: bars ? lineColor : hexA(lineColor, 0.25), fill: !bars, pointRadius: 0, borderWidth: 1.4, tension: 0.35, barPercentage: 0.7 }],
    },
    options: { responsive: true, maintainAspectRatio: false, animation: false, events: [], plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false, beginAtZero: true } } },
  });
}

export function hexA(hex, a) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex; // not a plain hex colour: use as is
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// legend row under charts (like the design)
export function legendRow(labels) {
  const pal = palette();
  return h('div', { class: 'legend-row' }, labels.map((l, i) => h('span', { class: 'legend-item' }, h('i', { style: { background: pal[i % pal.length] } }), l)));
}
