// App shell: login gate, sidebar, top bar, router, time range, auto-refresh.
import { h, $, clear, api, icon, logo, toast, select, modal } from './ui.js';
import { renderLogin } from './pages/login.js';
import { renderForcedMfa } from './pages/mfa.js';
import { NAV_SECTIONS, EXTRA_ROUTES } from './pages/registry.js';
import { selectorEntries, personaPath, landingFor, isLanding, setRoleAccess } from './personas/registry.js';
import { ENVIRONMENTS } from './personas/mock.js';

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

const state = {
  me: null,
  range: Number(sessionStorage.getItem('oo.range')) || 3600,
  env: sessionStorage.getItem('oo.env') || '',
  current: null, // {destroy, refresh}
  charts: [],
  timer: null,
};

export function navigate(path, replace = false) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  route();
}

function applyPrefs() {
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

// Build a URL that carries the global filters (environment, time range) plus page filters,
// so drill-downs, Back and shared links show the same slice of data.
export function link(path, extra = {}) {
  const [base, qs] = path.split('?');
  const p = new URLSearchParams(qs || '');
  if (state.env && !p.has('env')) p.set('env', state.env);
  if (!p.has('range')) p.set('range', String(state.range));
  for (const [k, v] of Object.entries(extra)) {
    if (v === '' || v === null || v === undefined) p.delete(k);
    else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}

function setEnv(v, { silent = false } = {}) {
  state.env = v || '';
  sessionStorage.setItem('oo.env', state.env);
  const sel = $('#env');
  if (sel) sel.value = state.env;
  if (!silent) {
    const p = new URLSearchParams(location.search);
    if (state.env) p.set('env', state.env); else p.delete('env');
    history.replaceState({}, '', `${location.pathname}${p.toString() ? `?${p}` : ''}`);
    route();
  }
}

function setRange(v) {
  state.range = Number(v);
  sessionStorage.setItem('oo.range', String(v));
  const sel = $('#range');
  if (sel) sel.value = String(v);
}

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
  setRoleAccess(state.me.user);
  document.title = state.me.brand;
  buildShell();
  if (location.pathname === '/' || location.pathname === '/login') {
    // a dashboard the user pinned as home wins; otherwise their role-based landing dashboard
    const home = state.me.prefs?.homePage && state.me.prefs.homePage !== '/overview' ? state.me.prefs.homePage : null;
    navigate(home || link(personaPath(landingFor(state.me, (p) => hasPerm(state.me.user, p)))), true);
  }
  else route();
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
const canNow = (p) => hasPerm(state.me?.user, p);
function visibleSections() {
  const ctx = { can: canNow, me: state.me };
  return NAV_SECTIONS.map((s) => ({ ...s, items: s.items.filter((i) => (!i.perm || canNow(i.perm)) && (!i.when || i.when(ctx))) })).filter((s) => s.items.length);
}

// Auto-refresh choices for the current page. 0 = off. Stored per user ('autoRefresh').
const REFRESH_CHOICES = [['0', 'Off'], ['15000', '15s'], ['30000', '30s'], ['60000', '1m'], ['300000', '5m']];
function refreshMs() {
  const v = state.me?.prefs?.autoRefresh;
  if (v === undefined || v === null || v === '') return state.current?.refreshMs || 30_000;
  return Number(v) || 0;
}
function startTimer() {
  clearInterval(state.timer);
  const ms = refreshMs();
  if (ms && state.current?.refresh && state.current.autoRefresh !== false) {
    state.timer = setInterval(() => { if (document.visibilityState === 'visible') refreshNow(); }, ms);
  }
}
// Freshness only moves when the page says its data loaded: a page signals failure by rejecting.
function refreshNow() {
  if (!state.current?.refresh) return Promise.resolve();
  const page = state.current;
  let r;
  try { r = Promise.resolve(page.refresh()); } catch (e) { r = Promise.reject(e); }
  return r.then(() => { if (state.current === page) markFresh(); }, () => { if (state.current === page) drawFresh(); });
}
// "Updated 12s ago": when the current page last loaded or refreshed its data
function markFresh() { state.freshAt = Date.now(); drawFresh(); }
function drawFresh() {
  const el = $('#fresh-chip');
  if (!el) return;
  // pages with nothing to reload (forms, a single log line) disable the refresh button instead of ignoring clicks
  const rb0 = $('#refresh-btn');
  if (rb0) rb0.disabled = !state.current?.refresh;
  if (state.current?.sample) { el.classList.add('hidden'); if (rb0) rb0.title = 'Redraw the sample data'; return; }
  if (!state.current?.refresh) { el.classList.add('hidden'); if (rb0) rb0.title = 'Nothing to refresh on this page'; return; }
  if (!state.freshAt) { el.classList.add('hidden'); if (rb0) rb0.title = 'Refresh now'; return; }
  const s = Math.max(0, Math.round((Date.now() - state.freshAt) / 1000));
  const txt = s < 5 ? 'just now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
  const ms = refreshMs();
  el.classList.remove('hidden');
  el.textContent = `Updated ${txt}`;
  const rb = $('#refresh-btn');
  if (rb) rb.title = `Refresh now · updated ${txt}`;
  el.title = ms && state.current?.autoRefresh !== false ? `This page reloads its data every ${ms >= 60000 ? `${ms / 60000} min` : `${ms / 1000}s`} while the tab is visible.` : 'Auto-refresh is off for this page. Use the refresh button to reload.';
}
setInterval(drawFresh, 5000);

function setNavCollapsed(on) {
  document.querySelector('.shell')?.classList.toggle('nav-collapsed', on);
  const b = $('#nav-collapse');
  if (b) { b.setAttribute('aria-expanded', String(!on)); b.title = on ? 'Expand menu' : 'Collapse menu'; clear(b).append(icon('chevron', 14), h('span', { class: 'nav-text' }, on ? '' : 'Collapse')); }
}
function closeDrawer() { document.querySelector('.shell')?.classList.remove('nav-open'); $('#nav-burger')?.setAttribute('aria-expanded', 'false'); }

function showShortcuts() {
  const rows = [['Ctrl + K  or  /', 'Search pages, dashboards, services, metrics and actions'], ['↑ ↓  then  Enter', 'Move through search results and open one'], ['Esc', 'Close search, menus and dialogs'], ['Ctrl / ⌘ + click', 'Open a link in a new tab']];
  modal('Keyboard shortcuts', h('table', { class: 'tbl shortcuts' }, h('tbody', {}, ...rows.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d))))));
}
function showAbout() {
  const close = modal(`About ${state.me.brand}`, h('div', { class: 'kv' },
    h('span', { class: 'muted' }, 'Version'), h('span', {}, state.me.version || 'unknown'),
    h('span', { class: 'muted' }, 'Signed in as'), h('span', {}, `${state.me.user.username} (${ROLE_LABEL[state.me.user.role] || state.me.user.role})`),
    h('span', { class: 'muted' }, 'Live data'), h('span', {}, 'Overview, Services, Infrastructure, Incidents, Logs, Traces, Metrics and Insights read Prometheus, Loki, Tempo and Alertmanager.'),
    h('span', { class: 'muted' }, 'Sample data'), h('span', {}, 'Role dashboards marked "Sample data" show generated examples, not your systems.'),
    h('span', { class: 'muted' }, 'Source status'), h('a', { href: '/datasources', 'data-link': true, onclick: () => close() }, 'Data Sources page')));
}


const ROLE_LABEL = { admin: 'Platform Admin', operator: 'Operator', viewer: 'Viewer' };

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  window.dispatchEvent(new CustomEvent('oo:theme'));
}

function buildShell() {
  const app = clear($('#app'));
  const brand = state.me.brand;
  const [first, ...rest] = brand.split(/(?=[A-Z][a-z]+$)/);
  applyTheme(state.me.prefs?.theme);
  state.navItems = [];
  const navItem = (i) => { const el = h('a', { href: i.path, 'data-link': true, class: 'nav-item', 'data-path': i.path, title: i.sub ? `${i.label}: ${i.sub}` : i.label, 'aria-label': i.label, onclick: closeDrawer },
    h('span', { class: 'nav-ic' }, icon(i.icon, 18)),
    h('span', { class: 'nav-text' },
      h('span', { class: 'label' }, i.label, i.badge === 'ai' ? h('span', { class: 'nav-ai' }, 'AI') : null),
      i.sub ? h('small', { class: 'sub' }, i.sub) : null),
    i.badge === 'incidents' ? h('span', { class: 'nav-badge hidden', id: 'incident-badge' }) : null);
    state.navItems.push({ el, item: i });
    return el; };
  const collapseBtn = h('button', { class: 'nav-item nav-collapse', id: 'nav-collapse', 'aria-expanded': 'true', onclick: () => {
    const on = !document.querySelector('.shell').classList.contains('nav-collapsed');
    setNavCollapsed(on);
    savePref('navCollapsed', on);
  } });
  const sidebar = h('nav', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Main' },
    visibleSections().flatMap((s) => [s.title ? h('div', { class: 'nav-group' }, s.title) : null, ...s.items.map(navItem)]),
    h('div', { class: 'side-foot' }, `Signed in as ${state.me.user.username}`), collapseBtn);
  const burger = h('button', { class: 'icon-btn nav-burger', id: 'nav-burger', 'aria-label': 'Menu', 'aria-controls': 'sidebar', 'aria-expanded': 'false', onclick: (e) => {
    e.stopPropagation();
    // the phone top bar wraps onto two lines, so the drawer starts below whatever height it has
    document.documentElement.style.setProperty('--drawer-top', `${Math.round(document.querySelector('.topbar').getBoundingClientRect().bottom)}px`);
    const open = document.querySelector('.shell').classList.toggle('nav-open');
    burger.setAttribute('aria-expanded', String(open));
  } }, icon('menu', 18));
  const backdrop = h('div', { class: 'nav-backdrop', onclick: closeDrawer });

  const searchBox = buildSearch();

  const refreshBtn = h('button', { class: 'icon-btn', id: 'refresh-btn', title: 'Refresh now', 'aria-label': 'Refresh now', onclick: () => refreshNow() }, icon('refresh', 16));
  const curAuto = state.me.prefs?.autoRefresh;
  const autoSel = select([['', 'Auto'], ...REFRESH_CHOICES], curAuto === undefined || curAuto === null ? '' : String(curAuto), (v) => {
    savePref('autoRefresh', v === '' ? null : Number(v));
    startTimer();
    drawFresh();
    toast(v === '' ? 'Auto-refresh: page default (usually every 30s)' : v === '0' ? 'Auto-refresh is off. Use the refresh button to reload.' : `Pages now refresh every ${REFRESH_CHOICES.find(([k]) => k === v)[1]}.`);
  }, { class: 'select select-auto', 'aria-label': 'Auto-refresh interval', title: 'Auto-refresh interval (Auto = page default, usually 30s)', id: 'auto-refresh' });
  const freshChip = h('span', { class: 'fresh-chip hidden', id: 'fresh-chip', 'aria-live': 'polite' });
  const helpMenu = h('div', { class: 'menu hidden' },
    h('button', { onclick: () => showShortcuts() }, icon('search', 15), 'Keyboard shortcuts'),
    h('button', { onclick: () => navigate('/settings?tab=api') }, icon('key', 15), 'API reference'),
    h('button', { onclick: () => navigate('/datasources') }, icon('datasources', 15), 'Data source status'),
    h('button', { onclick: () => showAbout() }, icon('info', 15), 'About'));
  const helpBtn = h('div', { class: 'help-wrap' },
    h('button', { class: 'icon-btn', title: 'Help', 'aria-label': 'Help', 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); helpMenu.classList.toggle('hidden'); } }, h('b', { class: 'help-q' }, '?')),
    helpMenu);
  document.addEventListener('click', () => helpMenu.classList.add('hidden'));
  const themeBtn = h('button', { class: 'icon-btn', title: 'Light / dark', onclick: () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    savePref('theme', next);
    clear(themeBtn).append(icon(next === 'light' ? 'moon' : 'sun', 16));
    route(); // charts pick up the new colours
  } }, icon(state.me.prefs?.theme === 'light' ? 'moon' : 'sun', 16));
  const rangeSel = select(RANGES, state.range, (v) => {
    setRange(v);
    savePref('timeRange', Number(v));
    flushPrefs();
    const p = new URLSearchParams(location.search);
    if (p.has('range')) { p.set('range', v); history.replaceState({}, '', `${location.pathname}?${p}`); }
    state.current?.refresh?.();
  }, { class: 'select', 'aria-label': 'Time range', id: 'range' });
  const rangeWrap = h('div', { class: 'range-wrap' }, icon('clock', 15, 'dim'), rangeSel);
  const envSel = select(ENVIRONMENTS, state.env, (v) => setEnv(v), { class: 'select', 'aria-label': 'Environment', id: 'env' });
  const envWrap = h('div', { class: 'range-wrap env-wrap' }, icon('layers', 15, 'dim'), envSel);
  const dashSel = buildDashboardSelector();
  const notif = buildNotifications();
  const liveChip = h('a', { class: 'live-chip hidden', id: 'live-chip', href: '/datasources', 'data-link': true });

  const u = state.me.user;
  const initials = (u.displayName || u.username).split(/[\s._-]+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
  const menu = h('div', { class: 'menu hidden' },
    h('button', { onclick: () => navigate('/settings?tab=profile') }, icon('user', 15), 'My profile & security'),
    h('button', { onclick: () => navigate('/settings?tab=apikeys') }, icon('key', 15), 'My API keys'),
    hasPerm(u, 'users.manage') ? h('button', { onclick: () => navigate('/settings?tab=users') }, icon('shield', 15), 'Users & roles') : null,
    h('button', { onclick: logoutNow }, icon('logout', 15), 'Sign out'));
  const userBtn = h('button', { class: 'user-btn', onclick: (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); } },
    h('div', { class: 'avatar' }, initials),
    h('div', { class: 'user-meta' }, u.displayName || u.username, h('small', {}, ROLE_LABEL[u.role] || u.role)),
    icon('chevron', 14, 'dim'), menu);
  document.addEventListener('click', () => menu.classList.add('hidden'));

  const dsChip = h('div', { class: 'ds-chip hidden', id: 'ds-chip' });

  app.append(h('div', { class: 'shell' },
    h('div', { class: 'brand' }, burger, logo(28), h('span', { class: 'brand-name' }, first, rest.length ? h('b', {}, rest.join('')) : null)),
    h('header', { class: 'topbar' }, searchBox, dashSel, h('div', { class: 'top-spacer' }), dsChip, envWrap, rangeWrap, freshChip, autoSel, refreshBtn, liveChip, notif, helpBtn, themeBtn, userBtn),
    sidebar, backdrop,
    h('main', { class: 'main', id: 'main' })));
  setNavCollapsed(!!state.me.prefs?.navCollapsed);
  updateLiveChip();
}

// "Live data" when every data source is connected, "Demo data" when some pages show sample data
async function updateLiveChip() {
  try {
    const list = await api('/datasources');
    const arr = Array.isArray(list) ? list : list.datasources || [];
    const demo = arr.some((d) => d.mode === 'demo');
    const chip = $('#live-chip');
    if (!chip) return;
    clear(chip).append(h('i', {}), demo ? 'Demo data' : 'Live data');
    chip.className = `live-chip ${demo ? 'demo' : ''}`;
    chip.title = demo ? 'Some pages show sample data. Connect them in Data Sources.' : 'All data sources are connected';
    state.demo = demo;
  } catch { /* leave hidden */ }
}

async function logoutNow() {
  try { await api('/logout', { method: 'POST' }); } catch { /* ignore */ }
  state.me = null;
  sessionStorage.removeItem('oo.after-login');
  history.replaceState({}, '', '/login');
  showLogin();
}

// top-bar data source chip (e.g. "Prometheus", "Loki DEMO")
export function setDsChip(label, color = '#f59e0b') {
  const c = $('#ds-chip');
  if (!c) return;
  if (!label) return c.classList.add('hidden');
  clear(c).append(h('i', { style: { background: color } }), label);
  c.classList.remove('hidden');
}

// ---------------- dashboard selector ----------------
// Lists Overview + every role dashboard this user may open; the current one is ticked, the landing one marked.
function buildDashboardSelector() {
  const can = (p) => hasPerm(state.me.user, p);
  const label = h('span', { class: 'dsel-label' });
  const list = h('div', { class: 'menu dsel-menu hidden', role: 'menu' });
  const btn = h('button', { class: 'dsel-btn', 'aria-haspopup': 'menu', title: 'Switch dashboard', onclick: (e) => { e.stopPropagation(); draw(); list.classList.toggle('hidden'); } },
    icon('dashboards', 15), label, icon('chevron', 13, 'dim'));
  function current() {
    const path = location.pathname;
    return selectorEntries(can).find((p) => path === personaPath(p) || path.startsWith(`${personaPath(p)}/`)) || null;
  }
  function draw() {
    clear(list).append(h('div', { class: 'menu-title' }, 'Dashboards you can open'),
      ...selectorEntries(can).map((p) => h('button', { role: 'menuitem', disabled: !p.ready, class: current()?.id === p.id ? 'sel' : '', onclick: () => { list.classList.add('hidden'); navigate(link(personaPath(p))); } },
        icon(p.icon, 15), h('span', { class: 'dsel-item' }, h('b', {}, p.label), h('small', {}, p.ready ? p.desc : 'Coming next')),
        isLanding(state.me, p.id) ? h('span', { class: 'dsel-home', title: 'Your landing dashboard' }, icon('home', 12)) : null)),
      h('a', { class: 'menu-foot', href: '/dashboards', 'data-link': true, onclick: () => list.classList.add('hidden') }, icon('dashboards', 13), 'Custom dashboards'));
  }
  function update() {
    const c = current();
    label.textContent = c ? c.short : 'Dashboards';
  }
  window.addEventListener('oo:routed', update);
  document.addEventListener('click', () => list.classList.add('hidden'));
  return h('div', { class: 'dsel' }, btn, list);
}

// ---------------- notifications ----------------
// Real alert and incident counts, plus a feed of recent events (mock until the notifications backend exists).
function buildNotifications() {
  const panelEl = h('div', { class: 'menu notif-menu hidden', onclick: (e) => e.stopPropagation() });
  const bell = h('button', { class: 'icon-btn', id: 'bell', title: 'Notifications', 'aria-haspopup': 'true', onclick: (e) => { e.stopPropagation(); draw(); panelEl.classList.toggle('hidden'); } }, icon('bell', 17));
  const readKey = `oo.notif.read.${state.me.user.username}`;
  const readSet = () => { try { return new Set(JSON.parse(localStorage.getItem(readKey) || '[]')); } catch { return new Set(); } };
  const markRead = (ids) => { try { localStorage.setItem(readKey, JSON.stringify([...new Set([...readSet(), ...ids])].slice(-200))); } catch { /* ignore */ } };
  const now = Date.now();
  const feed = [
    { id: 'n1', ic: 'incident', tone: 'red', title: 'Critical: HighErrorRate on checkout', sub: 'prod-eu-1 · incident opened', at: now - 6 * 60_000, href: '/incidents' },
    { id: 'n2', ic: 'upload', tone: 'green', title: 'payments-api v2.14.3 deployed', sub: 'production · by deploy-bot', at: now - 22 * 60_000, href: '/views/devops/deployments' },
    { id: 'n3', ic: 'upload', tone: 'orange', title: 'orders v3.2.0 rolled back', sub: 'staging · error rate above 2%', at: now - 75 * 60_000, href: '/views/devops/deployments?status=failed' },
    { id: 'n4', ic: 'insights', tone: 'purple', title: 'Disk on db-02 full in ~3 days', sub: 'Insights forecast', at: now - 3 * 3600_000, href: '/insights' },
    { id: 'n5', ic: 'agent', tone: 'blue', title: 'Agent on web-07 stopped reporting', sub: 'Last seen 18 min ago', at: now - 5 * 3600_000, href: '/agents' },
  ];
  function draw() {
    const read = readSet();
    const unread = feed.filter((n) => !read.has(n.id));
    clear(panelEl).append(
      h('div', { class: 'menu-title notif-head' }, h('span', {}, 'Notifications'), unread.length ? h('button', { class: 'link-btn', onclick: () => { markRead(feed.map((n) => n.id)); draw(); badge(); } }, 'Mark all read') : null),
      h('div', { class: 'notif-counts', id: 'notif-counts' }),
      ...feed.map((n) => h('a', { class: `notif ${read.has(n.id) ? '' : 'unread'}`, href: link(n.href), 'data-link': true, onclick: () => { markRead([n.id]); panelEl.classList.add('hidden'); badge(); } },
        h('span', { class: `notif-ic kpi-${n.tone}` }, h('span', { class: 'kpi-ic' }, icon(n.ic, 14))),
        h('span', { class: 'notif-body' }, h('b', {}, n.title), h('small', {}, `${n.sub} · ${Math.round((Date.now() - n.at) / 60000) < 60 ? `${Math.round((Date.now() - n.at) / 60000)}m` : `${Math.round((Date.now() - n.at) / 3600000)}h`} ago`)))),
      h('a', { class: 'menu-foot', href: link('/incidents'), 'data-link': true, onclick: () => panelEl.classList.add('hidden') }, 'All incidents and alerts', icon('arrowRight', 12)));
    const c = state.alertCounts;
    if (c) $('#notif-counts', panelEl).append(h('span', {}, h('b', { class: c.critical ? 'c-red' : '' }, String(c.active)), ' active alerts'), h('span', {}, h('b', { class: 'c-red' }, String(c.critical)), ' critical'));
  }
  function badge() {
    const unread = feed.filter((n) => !readSet().has(n.id)).length + (state.alertCounts?.active || 0);
    bell.querySelector('.count')?.remove();
    if (unread) bell.append(h('span', { class: 'count' }, unread > 99 ? '99+' : unread));
  }
  state.notifBadge = badge;
  document.addEventListener('click', () => panelEl.classList.add('hidden'));
  setTimeout(badge);
  return h('div', { class: 'notif-wrap' }, bell, panelEl);
}

// ---------------- global search ----------------
function buildSearch() {
  const box = h('div', { class: 'search' });
  const input = h('input', { type: 'search', placeholder: 'Search pages, dashboards, services, actions...  (Ctrl+K)', 'aria-label': 'Search' });
  const results = h('div', { class: 'search-results hidden' });
  let metricNames = null, serviceNames = null, dashList = null, items = [], sel = 0;
  const pages = visibleSections().flatMap((s) => s.items).map((i) => ({ label: i.label, kind: 'Page', go: () => navigate(i.path) }));
  // role dashboards this user's role allows (same rule as the dashboard selector)
  const roleDash = selectorEntries(canNow).filter((p) => p.id !== 'overview').map((p) => ({ label: `${p.label} dashboard`, kind: 'Dashboard', go: () => navigate(link(personaPath(p))) }));
  const actions = [
    { label: 'Switch light / dark theme', kind: 'Action', go: () => document.querySelector('.topbar .icon-btn[title="Light / dark"]')?.click() },
    { label: 'Refresh this page', kind: 'Action', go: () => refreshNow() },
    { label: 'My profile & security', kind: 'Action', go: () => navigate('/settings?tab=profile') },
    { label: 'Keyboard shortcuts', kind: 'Action', go: () => showShortcuts() },
    { label: 'Sign out', kind: 'Action', go: () => logoutNow() },
  ];

  async function update() {
    const q = input.value.trim().toLowerCase();
    if (!q) { results.classList.add('hidden'); return; }
    if (!metricNames) metricNames = await api('/prom/metric-names').catch(() => []);
    if (!serviceNames) serviceNames = await api('/services').then((d) => d.list.map((x) => x.name)).catch(() => []);
    if (!dashList) dashList = await api('/dashboards').then((d) => d.map((x) => ({ id: x.id, title: x.title }))).catch(() => []);
    if (input.value.trim().toLowerCase() !== q) return; // a newer keystroke is already being handled
    const raw = input.value.trim().replace(/"/g, '');
    items = [
      ...pages.filter((p) => p.label.toLowerCase().includes(q)),
      ...roleDash.filter((p) => p.label.toLowerCase().includes(q)),
      ...dashList.filter((d) => d.title.toLowerCase().includes(q)).slice(0, 6).map((d) => ({ label: d.title, kind: 'Dashboard', go: () => navigate(link(`/dashboards/${encodeURIComponent(d.id)}`)) })),
      ...actions.filter((a) => a.label.toLowerCase().includes(q)),
      ...serviceNames.filter((n) => n.toLowerCase().includes(q)).slice(0, 6).map((n) => ({ label: n, kind: 'Service', go: () => navigate(`/services/${encodeURIComponent(n)}`) })),
      /^(inc-?)?\d{1,6}$/i.test(raw) ? { label: `Open incident ${raw.toUpperCase()}`, kind: 'Incident', go: () => navigate(`/incidents/${Number(raw.replace(/\D/g, ''))}`) } : null,
      ...metricNames.filter((m) => m.toLowerCase().includes(q)).slice(0, 8).map((m) => ({ label: m, kind: 'Metric', go: () => navigate(`/metrics?q=${encodeURIComponent(m)}`) })),
      { label: `Search logs for "${raw}"`, kind: 'Logs', go: () => navigate(`/logs?q=${encodeURIComponent(`{service_name=~".+"} |= "${raw}"`)}`) },
      { label: `Find traces for service "${raw}"`, kind: 'Traces', go: () => navigate(`/traces?q=${encodeURIComponent(`service.name=${raw}`)}`) },
      /^[0-9a-f]{16,32}$/i.test(raw) ? { label: `Open trace ${raw}`, kind: 'Trace', go: () => navigate(`/traces/${raw}`) } : null,
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
    if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName))) { e.preventDefault(); input.focus(); }
  });
  box.append(icon('search', 15), input, results);
  return box;
}

// ---------------- alert bell ----------------
async function pollAlertCount() {
  clearTimeout(state.bellTimer);
  if (!state.me) return;
  try {
    const c = await api('/alerts/count');
    state.alertCounts = c;
    state.notifBadge?.();
    const bell = $('#bell');
    if (bell) bell.title = `Notifications · ${c.active} active alert(s), ${c.critical} critical`;
  } catch { /* Alertmanager down: leave bell as is */ }
  try {
    const n = await api('/incidents/count');
    const b = $('#incident-badge');
    if (b) { b.textContent = n.active > 99 ? '99+' : n.active; b.classList.toggle('hidden', !n.active); b.title = `${n.active} active incident(s)`; }
  } catch { /* no permission or DB busy */ }
  state.bellTimer = setTimeout(pollAlertCount, 30_000);
}

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
    if (r.match.test(path)) return { render: r.render, navPath: r.navPath, perm: r.perm };
  }
  // longest matching menu path wins, so /views/kubernetes/... belongs to Kubernetes, not Home
  // two items can share a page (Users & Roles and Settings): the one whose activeWhen matches wins, then the plain one
  const params = new URLSearchParams(location.search);
  const score = (i) => (i.activeWhen ? (i.activeWhen(path, params) ? 2 : -1) : i.path.includes('?') ? 0 : 1);
  let best = null, bestItem = null;
  for (const s of NAV_SECTIONS) {
    for (const i of s.items) {
      const base = i.path.split('?')[0];
      if (!(path === base || path.startsWith(`${base}/`))) continue;
      if (!best || base.length > best.navPath.length || (base.length === best.navPath.length && score(i) > score(bestItem))) {
        best = { render: i.render, navPath: base, perm: i.perm };
        bestItem = i;
      }
    }
  }
  return best;
}

let routeSeq = 0;
function route() {
  const seq = ++routeSeq;
  stopPage();
  setDsChip(null);
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  // filters in the URL win (shared links, Back), then they stay for the rest of the session
  if (params.has('env') && ENVIRONMENTS.some(([v]) => v === params.get('env')) && params.get('env') !== state.env) setEnv(params.get('env'), { silent: true });
  if (params.has('range') && RANGES.some(([s]) => String(s) === params.get('range'))) setRange(params.get('range'));
  const found = findRoute(path);
  window.dispatchEvent(new CustomEvent('oo:routed'));
  closeDrawer();
  for (const { el, item } of state.navItems || []) {
    const on = item.activeWhen ? item.activeWhen(path, params) : item.path.split('?')[0] === found?.navPath;
    el.classList.toggle('active', !!on);
    if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  }
  const main = clear($('#main'));
  if (!main) return;
  main.scrollTop = 0;
  if (!found) {
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
    navigate: (p, replace) => navigate(p, replace),
    get range() { return rangeParams(); },
    get rangeSeconds() { return state.range; },
    get env() { return state.env; },
    link,
    track: (chart) => { state.charts.push(chart); return chart; },
    untrack: (chart) => { state.charts = state.charts.filter((c) => c !== chart); chart?.destroy(); },
    can: (p) => hasPerm(state.me.user, p),
    setDsChip,
    refreshNow: () => refreshNow(),
    pref: (key) => state.me?.prefs?.[key],
    savePref,
    reloadMe: async () => { state.me = await api('/me'); setRoleAccess(state.me.user); return state.me; },
  };
  let result;
  try {
    result = found.render(main, ctx);
  } catch (e) {
    console.error(e);
    main.append(h('div', { class: 'error-box' }, `This page failed to load: ${e.message}`));
  }
  // the page redirected while rendering (e.g. Home → its role dashboard): the newer route owns the page now
  if (seq !== routeSeq) return;
  state.current = result || {};
  // a page that loads asynchronously hands back `ready`: freshness starts when that data arrives, not before
  const page = state.current;
  if (page?.ready) {
    state.freshAt = null;
    drawFresh();
    page.ready.then(() => { if (state.current === page) markFresh(); }, () => {});
  } else {
    state.freshAt = Date.now();
    drawFresh();
  }
  startTimer();
}

boot();
