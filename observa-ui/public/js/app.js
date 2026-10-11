// App shell: login gate, sidebar, top bar, router, time range, auto-refresh.
import { h, $, clear, api, icon, logo, toast, select } from './ui.js';
import { renderLogin } from './pages/login.js';
import { renderForcedMfa } from './pages/mfa.js';
import { NAV_SECTIONS, EXTRA_ROUTES } from './pages/registry.js';

export const RANGES = [
  [900, 'Last 15 minutes'], [3600, 'Last 1 hour'], [6 * 3600, 'Last 6 hours'],
  [24 * 3600, 'Last 24 hours'], [7 * 86400, 'Last 7 days'], [30 * 86400, 'Last 30 days'],
];

const LEGACY = { viewer: 'view', operator: 'dashboards.edit', admin: 'users.manage' };
export function hasPerm(user, p) {
  const perms = user?.permissions || [];
  const need = LEGACY[p] || p;
  return perms.includes('*') || perms.includes(need);
}

// Is this product module enabled for the deployment? (Settings > Modules, sent in /api/me)
// The server enforces the same rule on its API; this only decides what the screen shows.
export function moduleOn(id) {
  return !id || (state.me?.modules || []).includes(id);
}
// Can the current user see this page / item? Needs the module AND the permission.
function allowed(item) {
  return moduleOn(item.module) && (!item.perm || hasPerm(state.me.user, item.perm));
}

const state = {
  me: null,
  range: Number(sessionStorage.getItem('oo.range')) || 3600,
  current: null, // {destroy, refresh}
  charts: [],
  timer: null,
};

export function navigate(path, replace = false) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  route();
}

// ---------------- theme ----------------
// "dark" (default, the original look), "light", or "system" (follow the OS setting).
// Saved per user (prefs.theme) and in this browser, so the sign-in page uses it too.
const THEMES = [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']];
let themePref = 'dark';
try { themePref = localStorage.getItem('oo.theme') || 'dark'; } catch { /* storage blocked */ }
const lightQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
function applyTheme(pref) {
  themePref = THEMES.some(([k]) => k === pref) ? pref : 'dark';
  const t = themePref === 'system' ? (lightQuery?.matches ? 'light' : 'dark') : themePref;
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('oo.theme', themePref); } catch { /* storage blocked */ }
}
applyTheme(themePref);
lightQuery?.addEventListener?.('change', () => { if (themePref === 'system') { applyTheme('system'); if (state.me) route(); } });
function setTheme(pref) {
  applyTheme(pref);
  savePref('theme', themePref);
  route(); // charts read their colours when drawn: redraw the page
}

function applyPrefs() {
  if (state.me?.prefs?.theme) applyTheme(state.me.prefs.theme);
  const r = Number(state.me?.prefs?.timeRange);
  if (RANGES.some(([s]) => s === r)) state.range = r;
}

// Saves a per-user setting in the database (fire and forget).
let prefTimer = null;
const pendingPrefs = {};
export function savePref(key, value) {
  if (!state.me) return;
  state.me.prefs = { ...(state.me.prefs || {}), [key]: value };
  pendingPrefs[key] = value;
  clearTimeout(prefTimer);
  prefTimer = setTimeout(flushPrefs, 800);
}

// Send unsaved settings now; keepalive lets the request finish even if the page is closing.
function flushPrefs() {
  clearTimeout(prefTimer);
  if (!Object.keys(pendingPrefs).length) return;
  const body = JSON.stringify(pendingPrefs);
  Object.keys(pendingPrefs).forEach((k) => delete pendingPrefs[k]);
  fetch('/api/me/prefs', {
    method: 'PUT', keepalive: true, credentials: 'same-origin', body,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'observa' },
  }).catch(() => {});
}
window.addEventListener('pagehide', flushPrefs);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushPrefs());

function rangeParams() {
  const end = Math.floor(Date.now() / 1000);
  return { start: end - state.range, end };
}

// ---------------- boot ----------------
async function boot() {
  try {
    state.me = await api('/me');
  } catch {
    state.me = null;
  }
  if (!state.me) return showLogin();
  if (state.me.user.restricted === 'mfa_setup') {
    stopPage();
    return renderForcedMfa(clear($('#app')), { onDone: () => boot(), onLogout: logoutNow });
  }
  applyPrefs();
  document.title = state.me.brand;
  buildShell();
  if (location.pathname === '/' || location.pathname === '/login') {
    const home = state.me.prefs?.homePage;
    const r = home && findRoute(home.split('?')[0]);
    navigate(r && allowed(r) ? home : '/overview', true);
  } else route();
  pollAlertCount();
}

function showLogin() {
  stopPage();
  const app = clear($('#app'));
  if (location.pathname !== '/login') {
    sessionStorage.setItem('oo.after-login', location.pathname + location.search);
    history.replaceState({}, '', '/login' + (location.search.includes('sso_error') ? location.search : ''));
  }
  renderLogin(app, async (user) => {
    toast(`Welcome, ${user.username}`);
    const back = sessionStorage.getItem('oo.after-login');
    sessionStorage.removeItem('oo.after-login');
    history.replaceState({}, '', back && !back.startsWith('/login') ? back : '/');
    boot();
  });
}

window.addEventListener('oo:unauthorized', (e) => {
  if (!state.me) return;
  state.me = null;
  sessionStorage.setItem('oo.after-login', location.pathname + location.search);
  toast(e.detail || 'Session expired. Please sign in again.', 'err');
  showLogin();
});

window.addEventListener('popstate', () => state.me && route());

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.ctrlKey && !e.metaKey && !e.shiftKey && a.origin === location.origin) {
    e.preventDefault();
    navigate(a.pathname + a.search);
  }
});

// ---------------- shell ----------------
function visibleSections() {
  return NAV_SECTIONS.map((s) => ({ ...s, items: s.items.filter(allowed) })).filter((s) => s.items.length);
}

// Rebuild the shell after the module selection changes (Settings > Modules), keeping the current page if allowed.
export async function reloadShell() {
  state.me = await api('/me');
  buildShell();
  route();
  pollAlertCount();
}

function buildShell() {
  const app = clear($('#app'));
  const brand = state.me.brand;
  const [first, ...rest] = brand.split(/(?=[A-Z][a-z]+$)/);
  const collapsed = new Set(state.me.prefs?.navCollapsed || []);
  const sidebar = h('nav', { class: 'sidebar', 'aria-label': 'Main' },
    visibleSections().map((s) => {
      const items = h('div', { class: `nav-group ${collapsed.has(s.title) ? 'collapsed' : ''}` },
        s.items.map((i) => h('a', { href: i.path, 'data-link': true, class: 'nav-item', 'data-path': i.path, title: i.label }, icon(i.icon, 17), h('span', { class: 'label' }, i.label))));
      if (!s.title) return items;
      const head = h('button', { class: 'nav-section', 'aria-label': `${s.title} section`, 'aria-expanded': String(!collapsed.has(s.title)), onclick: () => {
        const isCollapsed = items.classList.toggle('collapsed');
        head.setAttribute('aria-expanded', String(!isCollapsed));
        if (isCollapsed) collapsed.add(s.title); else collapsed.delete(s.title);
        savePref('navCollapsed', [...collapsed]);
      } }, h('span', {}, s.title), icon('chevron', 12));
      return [head, items];
    }),
    h('div', { class: 'side-foot' }, `Signed in as ${state.me.user.username}`, h('br'), `Role: ${state.me.user.role}`));

  const searchBox = buildSearch();
  // the alert bell belongs to the Alerting module
  const bell = moduleOn('alerting') ? h('button', { class: 'icon-btn', id: 'bell', title: 'Active alerts', onclick: () => navigate('/alerting') }, icon('alerting', 17)) : null;
  const refreshBtn = h('button', { class: 'icon-btn', title: 'Refresh now', onclick: () => state.current?.refresh?.() }, icon('refresh', 16));
  const rangeSel = select(RANGES, state.range, (v) => {
    state.range = Number(v);
    sessionStorage.setItem('oo.range', v);
    savePref('timeRange', Number(v));
    flushPrefs();
    state.current?.refresh?.();
  }, { class: 'select', 'aria-label': 'Time range', id: 'range' });
  const rangeWrap = h('div', { class: 'range-wrap' }, icon('clock', 15, 'dim'), rangeSel);
  // auto-refresh: every page with live data reloads itself at this pace (only while the tab is visible)
  const autoSel = select(AUTO_REFRESH, autoRefreshMs(), (v) => {
    savePref('autoRefresh', Number(v));
    flushPrefs();
    startAutoRefresh();
  }, { class: 'select', style: { width: '78px' }, 'aria-label': 'Auto-refresh', title: 'Auto-refresh', id: 'auto-refresh' });

  const u = state.me.user;
  const initials = (u.displayName || u.username).slice(0, 1).toUpperCase();
  const menu = h('div', { class: 'menu hidden' },
    h('button', { onclick: () => navigate('/settings?tab=profile') }, icon('user', 15), 'My profile & security'),
    h('button', { onclick: () => navigate('/settings?tab=apikeys') }, icon('key', 15), 'My API keys'),
    h('div', { class: 'menu-theme', role: 'group', 'aria-label': 'Theme' }, h('span', { class: 'dim' }, 'Theme'),
      THEMES.map(([k, label]) => h('button', { class: `theme-opt ${themePref === k ? 'active' : ''}`, 'aria-pressed': String(themePref === k),
        onclick: (e) => { e.stopPropagation(); setTheme(k); menu.querySelectorAll('.theme-opt').forEach((b) => { const on = b.dataset.k === themePref; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }); }, 'data-k': k }, label))),
    hasPerm(u, 'users.manage') ? h('button', { onclick: () => navigate('/settings?tab=users') }, icon('shield', 15), 'Users & roles') : null,
    h('button', { onclick: logoutNow }, icon('logout', 15), 'Sign out'));
  const userBtn = h('button', { class: 'user-btn', 'aria-haspopup': 'menu', 'aria-label': `Account menu for ${u.displayName || u.username}`, onclick: (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); } },
    h('div', { class: 'avatar' }, initials),
    h('div', { class: 'user-meta' }, u.displayName || u.username, h('small', {}, u.role)),
    icon('chevron', 14, 'dim'), menu);
  document.addEventListener('click', () => menu.classList.add('hidden'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.classList.contains('hidden')) { menu.classList.add('hidden'); userBtn.focus(); } });

  const dsChip = h('div', { class: 'ds-chip hidden', id: 'ds-chip' });

  app.append(h('div', { class: 'shell' },
    h('div', { class: 'brand' }, logo(28), h('span', { class: 'brand-name' }, first, rest.length ? h('b', {}, rest.join('')) : null)),
    h('header', { class: 'topbar' }, searchBox, h('div', { class: 'top-spacer' }), dsChip, rangeWrap, refreshBtn, autoSel, bell, userBtn),
    sidebar,
    h('main', { class: 'main', id: 'main' })));
}

async function logoutNow() {
  try { await api('/logout', { method: 'POST' }); } catch { /* ignore */ }
  state.me = null;
  sessionStorage.removeItem('oo.after-login');
  history.replaceState({}, '', '/login');
  showLogin();
}

// top-bar data source chip (e.g. "Prometheus", "Loki unavailable")
export function setDsChip(label, color = 'var(--warn)') {
  const c = $('#ds-chip');
  if (!c) return;
  if (!label) return c.classList.add('hidden');
  clear(c).append(h('i', { style: { background: color } }), label);
  c.classList.remove('hidden');
}

// ---------------- global search ----------------
function buildSearch() {
  const box = h('div', { class: 'search' });
  const input = h('input', { type: 'search', placeholder: 'Search pages, metrics, services...  ( / )', 'aria-label': 'Search' });
  const results = h('div', { class: 'search-results hidden' });
  let metricNames = null, items = [], sel = 0;
  const pages = visibleSections().flatMap((s) => s.items).map((i) => ({ label: i.label, kind: 'Page', go: () => navigate(i.path) }));

  async function update() {
    const q = input.value.trim().toLowerCase();
    if (!q) { results.classList.add('hidden'); return; }
    // each kind of result appears only when its module is on and the user may open it
    const can = (path) => { const r = findRoute(path); return !!r && allowed(r); };
    if (!metricNames) metricNames = can('/metrics') ? await api('/prom/metric-names').catch(() => []) : [];
    const raw = input.value.trim().replace(/"/g, '');
    items = [
      ...pages.filter((p) => p.label.toLowerCase().includes(q)),
      ...metricNames.filter((m) => m.toLowerCase().includes(q)).slice(0, 8).map((m) => ({ label: m, kind: 'Metric', go: () => navigate(`/metrics?q=${encodeURIComponent(m)}`) })),
      can('/logs') ? { label: `Search logs for "${raw}"`, kind: 'Logs', go: () => navigate(`/logs?q=${encodeURIComponent(`{service_name=~".+"} |= "${raw}"`)}`) } : null,
      can('/traces') ? { label: `Find traces for service "${raw}"`, kind: 'Traces', go: () => navigate(`/traces?q=${encodeURIComponent(`service.name=${raw}`)}`) } : null,
      can('/traces') && /^[0-9a-f]{16,32}$/i.test(raw) ? { label: `Open trace ${raw}`, kind: 'Trace', go: () => navigate(`/traces?id=${raw}`) } : null,
    ].filter(Boolean);
    sel = 0;
    draw();
  }
  function draw() {
    clear(results).append(...items.map((it, i) => h('button', { class: i === sel ? 'sel' : '', onmousedown: (e) => { e.preventDefault(); pick(i); } }, it.label, h('span', { class: 'kind' }, it.kind))));
    results.classList.toggle('hidden', !items.length);
  }
  function pick(i) {
    items[i]?.go();
    input.value = '';
    results.classList.add('hidden');
    input.blur();
  }
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    if (e.key === 'Enter') pick(sel);
    if (e.key === 'Escape') { results.classList.add('hidden'); input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(() => results.classList.add('hidden'), 150));
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) { e.preventDefault(); input.focus(); }
  });
  box.append(icon('search', 15), input, results);
  return box;
}

// ---------------- alert bell ----------------
async function pollAlertCount() {
  clearTimeout(state.bellTimer);
  if (!state.me || !moduleOn('alerting')) return;
  try {
    const c = await api('/alerts/count');
    const bell = $('#bell');
    if (bell) {
      bell.querySelector('.count')?.remove();
      if (c.active) bell.append(h('span', { class: 'count' }, c.active > 99 ? '99+' : c.active));
      bell.title = `${c.active} active alert(s), ${c.critical} critical`;
    }
  } catch { /* Alertmanager down: leave bell as is */ }
  state.bellTimer = setTimeout(pollAlertCount, 30_000);
}

// ---------------- accessibility: scrollable tables ----------------
// A table box that scrolls must be reachable with the keyboard (Tab, then arrow keys) and have a name.
const tableA11y = new MutationObserver(() => {
  document.querySelectorAll('#main .table-wrap:not([tabindex])').forEach((el) => {
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'region');
    const head = el.closest('section, main')?.querySelector('h1, h3');
    el.setAttribute('aria-label', `${head?.textContent?.trim() || 'Data'} table`);
  });
});
tableA11y.observe(document.getElementById('app') || document.body, { childList: true, subtree: true });

// ---------------- router ----------------
function stopPage() {
  clearInterval(state.timer);
  state.current?.destroy?.();
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
  state.current = null;
}

function findRoute(path) {
  for (const r of EXTRA_ROUTES) {
    if (r.match.test(path)) return { render: r.render, navPath: r.navPath, perm: r.perm, module: r.module };
  }
  for (const s of NAV_SECTIONS) {
    for (const i of s.items) {
      if (path === i.path || path.startsWith(`${i.path}/`)) return { render: i.render, navPath: i.path, perm: i.perm, module: i.module };
    }
  }
  return null;
}

function route() {
  stopPage();
  setDsChip(null);
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  const found = findRoute(path);
  document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.path === found?.navPath));
  const main = clear($('#main'));
  if (!main) return;
  main.scrollTop = 0;
  // a disabled module looks exactly like a page that does not exist (no hint that it is there)
  if (!found || !moduleOn(found.module)) {
    main.append(h('div', { class: 'empty' }, h('div', { class: 'empty-title' }, 'Page not found'), h('a', { href: '/overview', 'data-link': true }, 'Go to Overview')));
    return;
  }
  if (found.perm && !hasPerm(state.me.user, found.perm)) {
    main.append(h('div', { class: 'empty' }, h('div', { class: 'empty-title' }, 'No access'), h('div', { class: 'muted' }, `This page needs the "${found.perm}" permission.`)));
    return;
  }
  const ctx = {
    me: state.me,
    params,
    navigate,
    get range() { return rangeParams(); },
    get rangeSeconds() { return state.range; },
    track: (chart) => { state.charts.push(chart); return chart; },
    untrack: (chart) => { state.charts = state.charts.filter((c) => c !== chart); chart?.destroy(); },
    can: (p) => hasPerm(state.me.user, p),
    // page-to-page links: show a link only if the target page is allowed (module on + permission)
    canOpen: (path) => { const r = findRoute(path.split('?')[0]); return !!r && allowed(r); },
    hasModule: moduleOn,
    reloadShell,
    setDsChip,
    pref: (key) => state.me?.prefs?.[key],
    savePref,
    reloadMe: async () => { state.me = await api('/me'); return state.me; },
  };
  try {
    state.current = found.render(main, ctx) || {};
  } catch (e) {
    console.error(e);
    main.append(h('div', { class: 'error-box' }, `This page failed to load: ${e.message}`));
  }
  startAutoRefresh();
}

const AUTO_REFRESH = [[0, 'Off'], [10_000, '10s'], [30_000, '30s'], [60_000, '1m'], [300_000, '5m']];
function autoRefreshMs() {
  const v = Number(state.me?.prefs?.autoRefresh);
  return AUTO_REFRESH.some(([ms]) => ms === v) ? v : 10_000; // default: every 10 seconds
}
function startAutoRefresh() {
  clearInterval(state.timer);
  state.timer = null;
  const ms = autoRefreshMs();
  if (ms && state.current?.refresh && state.current.autoRefresh !== false) {
    state.timer = setInterval(() => document.visibilityState === 'visible' && state.current?.refresh?.(), ms);
  }
}

boot();
