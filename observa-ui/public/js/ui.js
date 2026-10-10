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
export class ApiError extends Error {}
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
  if (!res.ok) throw new ApiError(data?.error || `HTTP ${res.status}`);
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
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 9.5V21h14V9.5"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
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
  incident: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/>',
  insights: '<path d="M12 3l1.8 4.6L18 9.5l-4.2 1.9L12 16l-1.8-4.6L6 9.5l4.2-1.9z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  memory: '<rect x="2" y="7" width="20" height="10" rx="2"/><path d="M6 11h2M10 11h2M14 11h2M6 17v3M10 17v3M14 17v3M18 17v3"/>',
  disk: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  network: '<path d="M12 3v6M12 9H5v4M12 9h7v4"/><rect x="2" y="13" width="6" height="6" rx="1"/><rect x="16" y="13" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="4" rx="1"/>',
  pulse: '<path d="M2 12h4l3-8 4 16 3-8h6"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  dots: '<circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/>',
  back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
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
export function demoBadge(on, short = false) { return on ? h('span', { class: 'demo-badge', title: 'This data source is in demo mode. Connect it in Data Sources.' }, short ? 'DEMO' : 'DEMO DATA') : null; }
export function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, icon('activity', 28), h('div', { class: 'empty-title' }, title), text ? h('div', { class: 'muted' }, text) : null, action || null);
}
export function errorBox(msg) { return h('div', { class: 'error-box' }, icon('alert', 16), h('span', {}, msg)); }
export function spinner() { return h('div', { class: 'spinner' }); }

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
  const input = h('input', { type: 'checkbox', checked, disabled, 'aria-label': title || null, onchange: (e) => onchange(e.target.checked, e.target) });
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
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Close' }, icon('x'))),
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
  setTimeout(() => overlay.querySelector('input,select,textarea')?.focus(), 30);
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

// ---------- charts (Chart.js, loaded globally) ----------
export const PALETTE = ['#3b82f6', '#a855f7', '#f59e0b', '#ef4444', '#22c55e', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6'];
const cssVar = (n, d) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d);
const light = () => document.documentElement.dataset.theme === 'light';

export function baseOptions(unit, { stacked = false, min, max, showLegend = false } = {}) {
  const GRID = light() ? 'rgba(15,23,42,0.08)' : 'rgba(148,163,184,0.08)';
  const TICK = light() ? '#64748b' : '#7d8aa6';
  const tipBg = cssVar('--panel', '#0b1324'), tipText = cssVar('--text', '#e6ecf7'), tipBorder = cssVar('--border-2', '#24324f');
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: showLegend, position: 'bottom', labels: { color: TICK, boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle', font: { size: 11 } } },
      tooltip: {
        backgroundColor: tipBg, borderColor: tipBorder, borderWidth: 1, titleColor: tipText, bodyColor: tipText, padding: 10,
        callbacks: {
          title: (items) => (items[0] && typeof items[0].parsed.x === 'number' && items[0].parsed.x > 1e11 ? dateTime(items[0].parsed.x) : items[0]?.label),
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
  const datasets = series.map((s, i) => {
    const c = s.color || PALETTE[i % PALETTE.length];
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
    data: { labels, datasets: [{ label: 'value', data: values, backgroundColor: colors || labels.map(() => '#2f6bff'), borderRadius: 3, maxBarThickness: 34 }] },
    options: opts,
  });
}

export function doughnut(canvas, labels, values, colors) {
  return new window.Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 0, spacing: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '72%', animation: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#0b1324' } } },
  });
}

export function sparkline(canvas, points, color = '#3b82f6', bars = false) {
  return new window.Chart(canvas, {
    type: bars ? 'bar' : 'line',
    data: {
      labels: points.map((p) => p[0]),
      datasets: [{ data: points.map((p) => Number(p[1])), borderColor: color, backgroundColor: bars ? color : hexA(color, 0.25), fill: !bars, pointRadius: 0, borderWidth: 1.4, tension: 0.35, barPercentage: 0.7 }],
    },
    options: { responsive: true, maintainAspectRatio: false, animation: false, events: [], plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false, beginAtZero: true } } },
  });
}

export function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// legend row under charts (like the design)
export function legendRow(labels, colors) {
  return h('div', { class: 'legend-row' }, labels.map((l, i) => h('span', { class: 'legend-item' }, h('i', { style: { background: colors?.[i] || PALETTE[i % PALETTE.length] } }), l)));
}
