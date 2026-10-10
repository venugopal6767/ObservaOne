import { h, api, clear, icon, pill, sparkline, modal, field, toast, select, confirmBox, stateView, stateFromError, skeleton, palette, fmt, legendName } from '../ui.js';
import { chartSlots, renderPromPanel } from './common.js';


export function dashboardsPage(main, ctx) {
  const setChart = chartSlots(ctx);
  let filter = 'all', search = '', list = [];
  const tabsEl = h('div', { class: 'chips' });
  const grid = h('div', { class: 'dash-grid' }, h('div', { style: { gridColumn: '1 / -1' } }, skeleton('cards', 4)));
  const searchInput = h('input', { class: 'input', placeholder: 'Search dashboards...', style: { width: '260px' }, oninput: (e) => { search = e.target.value.toLowerCase(); draw(); } });
  main.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Dashboards'), h('p', {}, 'Create and manage your dashboards')),
      h('div', { class: 'actions' }, ctx.can('dashboards.edit') ? h('button', { class: 'btn btn-primary', onclick: newDashboard }, icon('plus', 15), 'New Dashboard') : null)),
    h('div', { class: 'toolbar' }, tabsEl, h('div', { class: 'grow' }), searchInput),
    grid);

  async function load() {
    try {
      list = await api('/dashboards');
      draw();
    } catch (e) {
      clear(grid).append(h('div', { style: { gridColumn: '1 / -1' } }, stateFromError(e, 'Dashboards')));
    }
  }

  function draw() {
    const count = (k) => (k === 'all' ? list.length : list.filter((d) => d.kind === k).length);
    clear(tabsEl).append(...[['all', 'All'], ['custom', 'Custom'], ['system', 'System']].map(([k, l]) =>
      h('button', { class: `tab ${filter === k ? 'active' : ''}`, style: { border: '1px solid var(--border-2)', height: '30px' }, onclick: () => { filter = k; draw(); } }, `${l} (${count(k)})`)));
    const shown = list.filter((d) => (filter === 'all' || d.kind === filter) && (!search || `${d.title} ${d.description}`.toLowerCase().includes(search)));
    clear(grid);
    if (!shown.length) {
      // grid is 4 columns: the state spans the full row
      const canCreate = ctx.can('dashboards.edit');
      grid.append(h('div', { style: { gridColumn: '1 / -1' } }, search
        ? stateView('empty', { title: 'No dashboards match your search', text: `Nothing matches "${search}".` })
        : filter === 'custom'
          ? stateView('empty', {
            title: 'No custom dashboards yet',
            text: canCreate ? 'Create one, then add panels from the Metrics page.' : 'Nobody has created a custom dashboard yet.',
            action: canCreate ? h('button', { class: 'btn btn-primary', onclick: newDashboard }, icon('plus', 14), 'New Dashboard') : null,
          })
          : stateView('empty', { title: 'No dashboards' })));
      return;
    }
    shown.forEach((d, i) => {
      const spark = h('div', { class: 'spark' });
      const card = h('div', { class: 'dash-card', tabindex: 0, onclick: () => ctx.navigate(`/dashboards/${d.id}`), onkeydown: (e) => e.key === 'Enter' && ctx.navigate(`/dashboards/${d.id}`) },
        h('div', { class: 't' }, d.title),
        h('div', {}, pill(d.kind === 'system' ? 'System' : 'Custom', d.kind === 'system' ? 'blue' : 'purple'), ' ', h('span', { class: 'dim', style: { fontSize: '11px' } }, `${d.panelCount} panels`)),
        spark,
        h('div', { class: 'd' }, d.description || (d.owner ? `Created by ${d.owner}` : '')));
      grid.append(card);
      drawSpark(spark, d, i);
    });
  }

  // The preview is real data: the first series of the dashboard's first chart panel, over the selected
  // time range. Under it: that panel's name and the series' latest value, so it can't be mistaken for decoration.
  async function drawSpark(box, d, i) {
    if (!d.preview) { box.append(h('div', { class: 'dim', style: { fontSize: '11px', paddingTop: '24px' } }, 'No panels yet')); return; }
    let q = d.preview.query;
    for (const v of d.variables || []) q = q.replaceAll(`$${v.name}`, '.+').replace(/(\w+)="\.\+"/g, '$1=~".+"');
    try {
      const { start, end } = ctx.range;
      const r = await api('/prom/query_range', { query: { query: q, start, end, step: Math.ceil((end - start) / 40) } });
      const s = r.result?.[0];
      if (!s) return box.append(h('div', { class: 'dim', style: { fontSize: '11px', paddingTop: '24px' } }, 'No data yet'));
      const c = h('canvas', { 'aria-hidden': 'true' });
      const pal = palette();
      box.append(c);
      setChart(`s${d.id}`, sparkline(c, s.values, pal[i % pal.length], false));
      const lastPoint = s.values[s.values.length - 1];
      const series = legendName(s.metric, d.preview.legend);
      box.after(h('div', { class: 'preview-meta', title: `${d.preview.title}${series ? ` · ${series}` : ''}: latest value in the selected time range${r.result.length > 1 ? ` (first of ${r.result.length} series)` : ''}` },
        h('b', {}, fmt(Number(lastPoint?.[1]), d.preview.unit)),
        h('span', {}, `${d.preview.title}${r.result.length > 1 ? ` · 1 of ${r.result.length} series` : ''}`)));
    } catch {
      box.append(h('div', { class: 'dim', style: { fontSize: '11px', paddingTop: '24px' } }, 'Preview unavailable'));
    }
  }

  function newDashboard() {
    const title = h('input', { class: 'input', maxlength: 60, placeholder: 'e.g. Payments team' });
    const desc = h('input', { class: 'input', maxlength: 200, placeholder: 'What is this dashboard for?' });
    modal('New dashboard', h('div', {}, field('Title', title), field('Description', desc),
      h('div', { class: 'info-box' }, 'After creating it, open the Metrics page, run a query and press "Add to Dashboard".')), [
      { label: 'Cancel' },
      { label: 'Create', primary: true, onclick: async () => {
        const d = await api('/dashboards', { method: 'POST', body: { title: title.value.trim(), description: desc.value.trim() } });
        toast('Dashboard created');
        ctx.navigate(`/dashboards/${d.id}`);
      } },
    ]);
  }

  load();
  return { refresh: load };
}

export function dashboardViewPage(main, ctx) {
  const setChart = chartSlots(ctx);
  const id = decodeURIComponent(location.pathname.split('/')[2] || '');
  const head = h('div', { class: 'page-head' });
  const varsBar = h('div', { class: 'toolbar' });
  const grid = h('div', { class: 'grid cols-12' }, h('div', { style: { gridColumn: 'span 12' } }, skeleton('chart')));
  main.append(head, varsBar, grid);
  let dash = null;
  const vars = {};

  async function load() {
    try {
      dash = await api(`/dashboards/${encodeURIComponent(id)}`);
    } catch (e) {
      clear(grid).append(h('div', { style: { gridColumn: 'span 12' } }, stateFromError(e, 'Dashboard')));
      return;
    }
    clear(head).append(
      h('div', {}, h('h1', {}, dash.title, pill(dash.kind === 'system' ? 'System' : 'Custom', dash.kind === 'system' ? 'blue' : 'purple')), h('p', {}, dash.description || '')),
      h('div', { class: 'actions' },
        h('a', { href: '/dashboards', 'data-link': true, class: 'btn' }, 'All dashboards'),
        dash.kind === 'custom' && ctx.can('dashboards.edit') ? h('button', { class: 'btn btn-danger', onclick: async () => {
          if (!(await confirmBox('Delete dashboard', `Delete "${dash.title}"? This cannot be undone.`, 'Delete'))) return;
          await api(`/dashboards/${dash.id}`, { method: 'DELETE' });
          toast('Dashboard deleted');
          ctx.navigate('/dashboards');
        } }, icon('trash', 14), 'Delete') : null));
    clear(varsBar);
    for (const v of dash.variables || []) {
      let values = [];
      try { values = await api('/prom/label-values', { query: { label: v.label_name, match: v.match } }); } catch { /* ignore */ }
      if (!values.length) values = ['(none)'];
      const saved = sessionStorage.getItem(`oo.var.${dash.id}.${v.name}`);
      vars[v.name] = values.includes(saved) ? saved : values[0];
      varsBar.append(h('span', { class: 'muted' }, v.label), select(values, vars[v.name], (val) => {
        vars[v.name] = val;
        sessionStorage.setItem(`oo.var.${dash.id}.${v.name}`, val);
        drawPanels();
      }, { 'aria-label': v.label }));
    }
    drawPanels();
  }

  function drawPanels() {
    clear(grid);
    if (!dash.panels.length) {
      grid.append(h('div', { style: { gridColumn: 'span 12' } }, stateView('empty', { title: 'This dashboard has no panels', text: 'Open Metrics, run a query, then press "Add to Dashboard".',
        action: ctx.canOpen('/metrics') ? h('a', { href: '/metrics', 'data-link': true, class: 'btn btn-primary' }, 'Go to Metrics') : null })));
      return;
    }
    dash.panels.forEach((p, i) => {
      const body = h('div');
      const del = dash.kind === 'custom' && ctx.can('dashboards.edit')
        ? h('button', { class: 'icon-btn', title: 'Remove panel', style: { width: '26px', height: '26px' }, onclick: async () => {
          if (!(await confirmBox('Remove panel', `Remove "${p.title}"?`, 'Remove'))) return;
          dash = await api(`/dashboards/${dash.id}/panels/${i}`, { method: 'DELETE' });
          dash.kind = 'custom';
          drawPanels();
        } }, icon('trash', 13)) : null;
      grid.append(h('section', { class: 'panel', style: { gridColumn: `span ${p.w || 6}` } },
        h('div', { class: 'panel-head' }, h('h3', {}, p.title), h('div', { class: 'right' }, del)), body));
      renderPromPanel(body, p, ctx, setChart, `p${i}`, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, escapeLabel(v)])));
    });
  }

  load();
  return { refresh: () => dash && drawPanels() };
}

function escapeLabel(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
