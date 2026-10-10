import { h, api, clear, icon, modal, field, toast, stateView, stateFromError } from '../ui.js';

const LOOK = {
  prometheus: ['P', '#e6522c'], alertmanager: ['A', '#ef4444'], loki: ['L', '#f59e0b'],
  tempo: ['T', '#3b82f6'], services: ['S', '#a855f7'], grafana: ['G', '#f97316'],
};

export function datasourcesPage(main, ctx) {
  const out = h('div', {}, stateView('loading', { skeleton: 'table' }));
  let list = [];
  const status = new Map();
  main.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Data Sources'), h('p', {}, 'Configure and manage your data sources')),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: testAll }, icon('refresh', 14), 'Test all'))),
    out);

  async function load() {
    try {
      list = await api('/datasources');
      draw();
      testAll();
    } catch (e) {
      clear(out).append(h('div', { class: 'table-wrap' }, stateFromError(e, 'Data sources')));
    }
  }

  async function testAll() {
    await Promise.all(list.map(async (d) => {
      status.set(d.id, { testing: true });
      draw();
      try { status.set(d.id, await api(`/datasources/${d.id}/test`, { method: 'POST' })); } catch (e) { status.set(d.id, { ok: false, message: e.message }); }
      draw();
    }));
  }

  function statusPill(d) {
    const s = status.get(d.id);
    if (!s || s.testing) return h('span', { class: 'pill pill-muted' }, 'Testing...');
    if (s.ok) return h('span', { class: 'pill pill-green', title: s.ms ? `${s.ms} ms` : '' }, '● Connected');
    if (s.message === 'Not configured') return h('span', { class: 'pill pill-muted', title: 'No address set. Click Edit to set it.' }, '● Not configured');
    return h('span', { class: 'pill pill-red', title: s.message }, '● Unavailable');
  }

  function draw() {
    clear(out).append(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'URL'), h('th', {}, 'Type'), h('th', {}, 'Status'), h('th', {}, 'Message'), h('th', {}))),
      h('tbody', {}, list.map((d) => {
        const [letter, color] = LOOK[d.id] || ['?', '#64748b'];
        const s = status.get(d.id);
        return h('tr', {},
          h('td', {}, h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
            h('div', { class: 'ds-icon', style: { background: `${color}22`, color, border: `1px solid ${color}66` } }, letter), h('b', { style: { fontWeight: 600, fontSize: '14px' } }, d.name))),
          h('td', { class: 'mono dim', style: { fontSize: '12px' } }, d.url),
          h('td', {}, d.kind),
          h('td', {}, statusPill(d)),
          h('td', { class: 'dim', style: { fontSize: '12px', maxWidth: '280px' } }, s && !s.testing ? s.message : ''),
          h('td', {}, h('div', { class: 'row-actions' },
            ctx.can('integrations.manage') && d.id !== 'services' ? h('button', { class: 'icon-btn', title: 'Edit', onclick: () => edit(d) }, icon('edit', 15)) : null,
            h('button', { class: 'icon-btn', title: 'Test connection', onclick: async () => {
              status.set(d.id, { testing: true }); draw();
              status.set(d.id, await api(`/datasources/${d.id}/test`, { method: 'POST' }).catch((e) => ({ ok: false, message: e.message }))); draw();
            } }, icon('refresh', 15)))));
      })))),
    h('div', { class: 'info-box', style: { marginTop: '14px' } }, icon('alert', 16), h('span', {},
      'Every page reads these sources directly. When a source is unavailable, its pages say so instead of showing old or sample data. ',
      'Service metrics use the PromQL in observa-ui/config/services.json.')));
  }

  function edit(d) {
    const url = h('input', { class: 'input mono', value: d.url || '', disabled: d.id === 'services' });
    modal(`Edit ${d.name}`, h('div', {},
      d.id !== 'services' ? field('URL (as seen from the UI container)', url, 'Example: http://loki:3100') : null), [
      { label: 'Cancel' },
      { label: 'Save & test', primary: true, onclick: async () => {
        const r = await api(`/datasources/${d.id}`, { method: 'PUT', body: { url: d.id === 'services' ? undefined : url.value.trim() } });
        status.set(d.id, r);
        toast(r.ok ? `${d.name} saved` : `${d.name} saved, but test failed: ${r.message}`, r.ok ? 'ok' : 'err');
        list = await api('/datasources');
        draw();
      } },
    ]);
  }

  load();
  return {};
}
