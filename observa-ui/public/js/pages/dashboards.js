// Dashboards: every user has their own dashboards and chooses who else can see each one
// (only me / my team / everyone). Built-in system dashboards can be copied to make a personal version.
import { h, api, clear, icon, pill, sparkline, modal, field, toast, emptyState, select, confirmBox } from '../ui.js';
import { errorState, staleNotice } from '../personas/widgets.js';
import { chartSlots, renderPromPanel } from './common.js';
import { selectorEntries, personaPath, landingFor } from '../personas/registry.js';

// Overview and the role dashboards this user's role may open; the landing one is marked.
// Which role sees which is set in Users & Roles; it controls what is listed, not access to data.
function roleDashboards(ctx) {
  const entries = selectorEntries(ctx.can).filter((p) => p.ready);
  if (!entries.length) return h('div'); // never null: it is passed to main.append
  const landing = landingFor(ctx.me, ctx.can)?.id;
  return h('nav', { class: 'role-dash', 'aria-label': 'Role dashboards' }, h('span', { class: 'role-dash-label' }, 'Role dashboards'),
    ...entries.map((p) => h('a', { class: 'btn btn-sm', href: ctx.link(personaPath(p)), 'data-link': true, title: p.desc },
      icon(p.icon, 13), p.short, p.id === landing ? h('span', { class: 'role-dash-home', title: 'Opens when you press Home' }, icon('home', 12)) : null)));
}

const COLORS = ['#3b82f6', '#3b82f6', '#a855f7', '#22c55e', '#06b6d4', '#f59e0b'];
const WIDTHS = [[3, '1/4'], [4, '1/3'], [6, '1/2'], [8, '2/3'], [12, 'Full']];

// "Private", "Team: Payments", "Everyone", "System"
export function visibilityTag(d) {
  if (d.kind === 'system') return h('span', { class: 'vis-tag', title: 'Built-in, read-only' }, icon('shield', 12), 'System');
  if (d.visibility === 'private') return h('span', { class: 'vis-tag', title: 'Only the owner can see it' }, icon('lock', 12), 'Private');
  if (d.visibility === 'team') return h('span', { class: 'vis-tag', title: 'Owner and team members' }, icon('users', 12), `Team: ${d.teamName || '?'}`);
  return h('span', { class: 'vis-tag', title: 'Every signed-in user' }, icon('globe', 12), 'Everyone');
}

const isHome = (ctx, d) => ctx.pref('homePage') === `/dashboards/${d.id}`;

// "Who can see it" fields used by New, Copy and Share.
function sharingFields(ctx, cur = {}) {
  const teams = ctx.me.teams || [];
  const vis = select([
    ['private', 'Only me'],
    ['team', teams.length ? 'My team' : 'My team (you are not in a team)'],
    ['everyone', 'Everyone'],
  ], cur.visibility || 'private', () => sync());
  const team = select(teams.map((t) => [t.id, t.name]), cur.teamId ?? teams[0]?.id ?? '', () => {});
  const teamField = field('Team', team, 'Members of this team can open it. Only you (and admins) can change it.');
  const hint = h('div', { class: 'info-box' });
  function sync() {
    teamField.style.display = vis.value === 'team' ? '' : 'none';
    hint.textContent = {
      private: 'Only you can see this dashboard. Admins can see it for support.',
      team: teams.length ? 'You and your team members can see it. Only you can change it.' : 'Ask an admin to add you to a team (Settings > Teams) to share with a team.',
      everyone: 'Every signed-in user can see it. Only you can change it.',
    }[vis.value];
  }
  sync();
  return {
    el: h('div', {}, field('Who can see it', vis), teamField, hint),
    value: () => ({ visibility: vis.value, teamId: vis.value === 'team' ? Number(team.value) || null : null }),
  };
}

async function toggleFavorite(d) {
  await api(`/dashboards/${encodeURIComponent(d.id)}/favorite`, { method: 'PUT', body: { favorite: !d.favorite } });
  d.favorite = !d.favorite;
  toast(d.favorite ? 'Added to favourites' : 'Removed from favourites');
}

function setHome(ctx, d) {
  const on = isHome(ctx, d);
  ctx.savePref('homePage', on ? '/overview' : `/dashboards/${d.id}`);
  toast(on ? 'Home page reset to Overview' : `"${d.title}" is now your home page`);
}

function copyDashboard(ctx, d) {
  const title = h('input', { class: 'input', maxlength: 60, value: `${d.title} (my copy)`.slice(0, 60) });
  const share = sharingFields(ctx);
  modal(`Copy "${d.title}"`, h('div', {}, field('Title', title), share.el), [
    { label: 'Cancel' },
    { label: 'Copy', primary: true, onclick: async () => {
      const c = await api(`/dashboards/${encodeURIComponent(d.id)}/copy`, { method: 'POST', body: { title: title.value.trim(), ...share.value() } });
      toast('Copied. This version is yours to change.');
      ctx.navigate(ctx.link(`/dashboards/${c.id}`));
    } },
  ]);
}

function editDetails(ctx, d, onSaved) {
  const title = h('input', { class: 'input', maxlength: 60, value: d.title });
  const desc = h('input', { class: 'input', maxlength: 200, value: d.description || '' });
  const share = sharingFields(ctx, d);
  const owner = !d.mine ? h('div', { class: 'dim', style: { fontSize: '12px', marginBottom: '8px' } }, `Owner: ${d.owner}. You can change it because you are an admin.`) : null;
  modal('Dashboard settings', h('div', {}, owner, field('Title', title), field('Description', desc), share.el), [
    { label: 'Cancel' },
    { label: 'Save', primary: true, onclick: async () => {
      const r = await api(`/dashboards/${encodeURIComponent(d.id)}`, { method: 'PUT', body: { title: title.value.trim(), description: desc.value.trim(), ...share.value() } });
      toast('Saved');
      onSaved(r);
    } },
  ]);
}

// ---------------- list ----------------
export function dashboardsPage(main, ctx) {
  const setChart = chartSlots(ctx);
  const me = ctx.me.user?.username;
  let filter = ctx.params.get('tab') || null, search = '', list = [], loaded = false, okAt = 0;
  const tabsEl = h('div', { class: 'chips' });
  const stale = h('div');
  const grid = h('div', { class: 'dash-grid' }, ...Array.from({ length: 6 }, () => h('div', { class: 'dash-card skeleton', style: { height: '170px' } })));
  const searchInput = h('input', { class: 'input', type: 'search', placeholder: 'Search dashboards...', 'aria-label': 'Search dashboards', style: { width: '260px' }, oninput: (e) => { search = e.target.value.toLowerCase(); draw(); } });
  main.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Dashboards'), h('p', {}, 'Your own dashboards, the ones shared with you, and the built-in ones')),
      h('div', { class: 'actions' }, ctx.can('dashboards.edit') ? h('button', { class: 'btn btn-primary', onclick: newDashboard }, icon('plus', 15), 'New Dashboard') : null)),
    roleDashboards(ctx),
    h('div', { class: 'toolbar' }, tabsEl, h('div', { class: 'grow' }), searchInput),
    stale, grid);

  const GROUPS = {
    mine: ['My dashboards', (d) => d.kind === 'custom' && d.mine],
    shared: ['Shared with me', (d) => d.kind === 'custom' && !d.mine],
    favorites: ['Favourites', (d) => d.favorite],
    system: ['System', (d) => d.kind === 'system'],
    all: ['All', () => true],
  };

  async function load() {
    try {
      list = await api('/dashboards');
      if (!filter || !GROUPS[filter]) filter = list.some((d) => d.mine) ? 'mine' : 'all';
      loaded = true; okAt = Date.now(); clear(stale);
      draw();
    } catch (e) {
      if (loaded) clear(stale).append(staleNotice({ okAt, message: e.message, retry: () => ctx.refreshNow() }));
      else clear(grid).append(errorState(e.message, () => ctx.refreshNow(), 'Dashboards could not load'));
      throw e;
    }
  }

  function draw() {
    clear(tabsEl).append(...Object.entries(GROUPS).map(([k, [label, fn]]) =>
      h('button', { class: `tab ${filter === k ? 'active' : ''}`, style: { border: '1px solid var(--border-2)', height: '30px' }, 'aria-pressed': String(filter === k), onclick: () => { filter = k; history.replaceState({}, '', ctx.link('/dashboards', { tab: k })); draw(); } },
        k === 'favorites' ? icon('star', 12) : null, `${label} (${list.filter(fn).length})`)));
    const fn = GROUPS[filter][1];
    // favourites first, then by title
    const shown = list.filter((d) => fn(d) && (!search || `${d.title} ${d.description} ${d.owner || ''}`.toLowerCase().includes(search)))
      .sort((a, b) => (b.favorite - a.favorite) || a.title.localeCompare(b.title));
    clear(grid);
    if (!shown.length) {
      const msg = {
        mine: ['You have no dashboards yet', 'Press "New Dashboard", or open a System dashboard and press "Copy" to make your own version.'],
        shared: ['Nothing shared with you', 'Dashboards that teammates share with your team or with everyone show up here.'],
        favorites: ['No favourites', 'Press the star on any dashboard to pin it here.'],
      }[filter] || ['No dashboards', ''];
      grid.append(emptyState(...msg));
      return;
    }
    shown.forEach((d, i) => {
      const spark = h('div', { class: 'spark' });
      const star = h('button', { class: `star ${d.favorite ? 'on' : ''}`, title: d.favorite ? 'Remove from favourites' : 'Add to favourites', onclick: async (e) => {
        e.stopPropagation();
        try { await toggleFavorite(d); draw(); } catch (err) { toast(err.message, 'err'); }
      } }, icon('star', 15));
      const card = h('div', { class: 'dash-card', tabindex: 0, role: 'link', 'aria-label': `Open dashboard ${d.title}`, onclick: () => ctx.navigate(ctx.link(`/dashboards/${d.id}`)), onkeydown: (e) => e.key === 'Enter' && e.target === e.currentTarget && ctx.navigate(ctx.link(`/dashboards/${d.id}`)) },
        star,
        h('div', { class: 't' }, d.title),
        h('div', { class: 'dash-meta' }, visibilityTag(d), h('span', { class: 'dim' }, `· ${d.panelCount} panels`),
          d.kind === 'custom' && !d.mine ? h('span', { class: 'dim' }, `· by ${d.owner}`) : null,
          isHome(ctx, d) ? h('span', { class: 'home-tag' }, icon('home', 12), 'Home') : null),
        spark,
        h('div', { class: 'd' }, d.description || (d.kind === 'custom' ? (d.owner === me ? 'Created by you' : `Created by ${d.owner}`) : '')));
      grid.append(card);
      drawSpark(spark, d, i);
    });
  }

  async function drawSpark(box, d, i) {
    if (!d.preview) { box.append(h('div', { class: 'dim', style: { fontSize: '11px', paddingTop: '24px' } }, 'No panels yet')); return; }
    let q = d.preview.query;
    for (const v of d.variables || []) q = q.replaceAll(`$${v.name}`, '.+').replace(/(\w+)="\.\+"/g, '$1=~".+"');
    try {
      const { start, end } = ctx.range;
      const r = await api('/prom/query_range', { query: { query: q, start, end, step: Math.ceil((end - start) / 40) } });
      const s = r.result?.[0];
      if (!s) return box.append(h('div', { class: 'dim', style: { fontSize: '11px', paddingTop: '24px' } }, 'No data yet'));
      const c = h('canvas');
      box.append(c);
      setChart(`s${d.id}`, sparkline(c, s.values, COLORS[i % COLORS.length], i % 2 === 0));
    } catch {
      box.append(h('div', { class: 'dim', style: { fontSize: '11px', paddingTop: '24px' } }, 'Preview unavailable'));
    }
  }

  function newDashboard() {
    const title = h('input', { class: 'input', maxlength: 60, placeholder: 'e.g. My checkout service' });
    const desc = h('input', { class: 'input', maxlength: 200, placeholder: 'What is this dashboard for?' });
    const share = sharingFields(ctx);
    modal('New dashboard', h('div', {}, field('Title', title), field('Description', desc), share.el,
      h('div', { class: 'dim', style: { fontSize: '12px', marginTop: '8px' } }, 'Then add panels: open Metrics, run a query and press "Add to Dashboard".')), [
      { label: 'Cancel' },
      { label: 'Create', primary: true, onclick: async () => {
        const d = await api('/dashboards', { method: 'POST', body: { title: title.value.trim(), description: desc.value.trim(), ...share.value() } });
        toast('Dashboard created');
        ctx.navigate(ctx.link(`/dashboards/${d.id}`));
      } },
    ]);
  }

  const readyList = load();
  readyList.catch(() => {});
  return { refresh: load, ready: readyList };
}

// ---------------- one dashboard ----------------
export function dashboardViewPage(main, ctx) {
  const setChart = chartSlots(ctx);
  const id = decodeURIComponent(location.pathname.split('/')[2] || '');
  const head = h('div', { class: 'page-head' });
  const editBar = h('div');
  const varsBar = h('div', { class: 'toolbar' });
  const grid = h('div', { class: 'grid cols-12' }, ...[6, 6, 12].map((w) => h('div', { class: 'panel skeleton', style: { gridColumn: `span ${w}`, height: '240px' } })));
  main.append(head, editBar, varsBar, grid);
  let dash = null, editing = false, draft = null;
  const vars = {};

  async function load() {
    try {
      dash = await api(`/dashboards/${encodeURIComponent(id)}`);
    } catch (e) {
      clear(head).append(h('div', {}, h('h1', {}, 'Dashboard')), h('div', { class: 'actions' }, h('a', { href: ctx.link('/dashboards'), 'data-link': true, class: 'btn' }, icon('arrowLeft', 14), 'All')));
      clear(grid).append(h('div', { style: { gridColumn: 'span 12' } }, errorState(e.message, () => ctx.refreshNow(), 'This dashboard could not load')));
      throw e;
    }
    drawHead();
    clear(varsBar);
    for (const v of dash.variables || []) {
      let values = [];
      let why = '';
      try { values = await api('/prom/label-values', { query: { label: v.label_name, match: v.match } }); } catch (e) { why = e.message; }
      // say why a filter has no choices instead of offering a silent "(none)"
      if (!values.length) { values = ['(none)']; varsBar.append(h('span', { class: 'dim', style: { fontSize: '12px' } }, why ? `${v.label || v.name}: choices could not load (${why})` : `${v.label || v.name}: no values found`)); }
      const saved = sessionStorage.getItem(`oo.var.${dash.id}.${v.name}`);
      vars[v.name] = values.includes(saved) ? saved : values[0];
      varsBar.append(h('span', { class: 'muted' }, v.label), select(values, vars[v.name], (val) => {
        vars[v.name] = val;
        sessionStorage.setItem(`oo.var.${dash.id}.${v.name}`, val);
        drawPanels();
      }));
    }
    drawPanels();
  }

  function drawHead() {
    const owner = dash.kind === 'custom' ? (dash.mine ? 'Yours' : `Owner: ${dash.owner}`) : null;
    const star = h('button', { class: `btn star ${dash.favorite ? 'on' : ''}`, title: 'Favourite', onclick: async () => {
      try { await toggleFavorite(dash); drawHead(); } catch (e) { toast(e.message, 'err'); }
    } }, icon('star', 14), dash.favorite ? 'Favourite' : 'Favourite');
    const home = isHome(ctx, dash);
    clear(head).append(
      h('div', {},
        h('h1', {}, dash.title, ' ', pill(dash.kind === 'system' ? 'System' : 'Custom', dash.kind === 'system' ? 'blue' : 'purple')),
        h('p', { class: 'dash-meta', style: { fontSize: '12.5px' } }, visibilityTag(dash), owner ? h('span', {}, `· ${owner}`) : null,
          dash.description ? h('span', {}, `· ${dash.description}`) : null)),
      h('div', { class: 'actions' },
        h('a', { href: ctx.link('/dashboards'), 'data-link': true, class: 'btn' }, icon('arrowLeft', 14), 'All'),
        star,
        h('button', { class: 'btn', title: home ? 'Stop opening this dashboard after sign-in' : 'Open this dashboard after sign-in', onclick: () => { setHome(ctx, dash); drawHead(); } },
          icon('home', 14), home ? 'Home page ✓' : 'Set as home'),
        ctx.can('dashboards.edit') ? h('button', { class: 'btn', onclick: () => copyDashboard(ctx, dash) }, icon('copy', 14), 'Copy') : null,
        dash.editable ? h('button', { class: 'btn', onclick: () => editDetails(ctx, dash, (r) => { dash = r; drawHead(); }) }, icon('share', 14), 'Share & settings') : null,
        dash.editable && !editing ? h('button', { class: 'btn btn-primary', onclick: startEdit }, icon('edit', 14), 'Edit panels') : null,
        dash.editable ? h('button', { class: 'btn btn-danger', title: 'Delete dashboard', onclick: async () => {
          if (!(await confirmBox('Delete dashboard', `Delete "${dash.title}"? This cannot be undone.`, 'Delete'))) return;
          await api(`/dashboards/${encodeURIComponent(dash.id)}`, { method: 'DELETE' });
          if (isHome(ctx, dash)) ctx.savePref('homePage', '/overview');
          toast('Dashboard deleted');
          ctx.navigate(ctx.link('/dashboards'));
        } }, icon('trash', 14)) : null));
  }

  // ---- edit mode: reorder, resize, rename, remove; saved in one go ----
  function startEdit() {
    editing = true;
    draft = dash.panels.map((p) => ({ ...p }));
    drawHead();
    clear(editBar).append(h('div', { class: 'edit-bar' }, icon('edit', 15), h('span', {}, 'Editing: move, resize, rename or remove panels, then Save.'), h('div', { class: 'grow', style: { flex: 1 } }),
      h('a', { href: ctx.link('/metrics'), 'data-link': true, class: 'btn btn-sm' }, icon('plus', 13), 'Add panel from Metrics'),
      h('button', { class: 'btn btn-sm', onclick: stopEdit }, 'Cancel'),
      h('button', { class: 'btn btn-sm btn-primary', onclick: saveEdit }, icon('check', 13), 'Save')));
    drawPanels();
  }
  function stopEdit() {
    editing = false; draft = null;
    clear(editBar);
    drawHead();
    drawPanels();
  }
  async function saveEdit() {
    try {
      dash = await api(`/dashboards/${encodeURIComponent(dash.id)}/panels`, { method: 'PUT', body: { panels: draft } });
      toast('Dashboard saved');
      stopEdit();
    } catch (e) { toast(e.message, 'err'); }
  }

  function panelTools(i) {
    const p = draft[i];
    const move = (to) => { const [x] = draft.splice(i, 1); draft.splice(to, 0, x); drawPanels(); };
    return h('div', { class: 'panel-tools' },
      h('button', { class: 'icon-btn', title: 'Move left', disabled: i === 0, onclick: () => move(i - 1) }, icon('arrowLeft', 13)),
      h('button', { class: 'icon-btn', title: 'Move right', disabled: i === draft.length - 1, onclick: () => move(i + 1) }, icon('arrowRight', 13)),
      select(WIDTHS, p.w || 6, (v) => { p.w = Number(v); drawPanels(); }, { title: 'Width' }),
      h('button', { class: 'icon-btn', title: 'Rename', onclick: () => {
        const t = h('input', { class: 'input', maxlength: 80, value: p.title });
        modal('Rename panel', field('Title', t), [{ label: 'Cancel' }, { label: 'OK', primary: true, onclick: () => { p.title = t.value.trim() || p.title; drawPanels(); } }]);
      } }, icon('edit', 13)),
      h('button', { class: 'icon-btn', title: 'Remove', onclick: () => { draft.splice(i, 1); drawPanels(); } }, icon('trash', 13)));
  }

  function drawPanels() {
    clear(grid);
    const panels = editing ? draft : dash.panels;
    if (!panels.length) {
      const hint = dash.editable ? 'Open Metrics, run a query, then press "Add to Dashboard".' : dash.kind === 'system' ? '' : 'Only the owner can add panels. Press "Copy" to make your own version.';
      grid.append(h('div', { style: { gridColumn: 'span 12' } }, emptyState('This dashboard has no panels', hint,
        dash.editable ? h('a', { href: ctx.link('/metrics'), 'data-link': true, class: 'btn btn-primary' }, 'Go to Metrics') : null)));
      return;
    }
    bodies = [];
    panels.forEach((p, i) => {
      const body = h('div');
      bodies.push(body);
      grid.append(h('section', { class: `panel ${editing ? 'editing' : ''}`, style: { gridColumn: `span ${p.w || 6}` } },
        h('div', { class: 'panel-head' }, h('h3', {}, p.title), h('div', { class: 'right' }, editing ? panelTools(i) : null)), body));
      renderPromPanel(body, p, ctx, setChart, `p${i}`, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, escapeLabel(v)])));
    });
  }

  // refresh redraws each panel in place (no flash); it fails only when every panel failed
  let bodies = [];
  const varValues = () => Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, escapeLabel(v)]));
  async function refresh() {
    if (!dash) return load();
    if (editing || bodies.length !== dash.panels.length) { drawPanels(); return; }
    const results = await Promise.all(dash.panels.map((p, i) => renderPromPanel(bodies[i], p, ctx, setChart, `p${i}`, varValues())));
    if (results.length && results.every((x) => x === false)) throw new Error('No panel could refresh');
  }
  const ready = load();
  ready.catch(() => {});
  return { refresh, ready };
}

function escapeLabel(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
