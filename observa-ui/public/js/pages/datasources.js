import { h, api, clear, icon, modal, field, select, toast } from '../ui.js';
import { errorState } from '../personas/widgets.js';

const LOOK = {
  prometheus: ['P', '#e6522c'], alertmanager: ['A', '#ef4444'], loki: ['L', '#f59e0b'],
  tempo: ['T', '#3b82f6'], services: ['S', '#a855f7'], grafana: ['G', '#f97316'],
};

export function datasourcesPage(main, ctx) {
  const out = h('div', {}, h('div', { class: 'table-wrap skeleton', style: { height: '300px' } }));
  let list = [], testing = false;
  const status = new Map();
  const testBtn = h('button', { class: 'btn btn-primary', onclick: () => testAll() }, icon('refresh', 14), 'Test all');
  main.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Data Sources'), h('p', {}, 'Configure and manage your data sources')),
      h('div', { class: 'actions' }, testBtn)),
    out);

  async function load() {
    try {
      list = await api('/datasources');
      draw();
      testAll();
    } catch (e) {
      clear(out).append(errorState(e.message, () => ctx.refreshNow(), 'Data sources could not load'));
      throw e;
    }
  }

  // "Test all" (and the top-bar refresh) re-test every source; the button says when it is busy
  async function testAll() {
    if (testing) return;
    testing = true; testBtn.disabled = true; testBtn.title = 'Testing all data sources…';
    try { await testEach(); } finally { testing = false; testBtn.disabled = false; testBtn.removeAttribute('title'); }
  }
  async function testEach() {
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
    if (s.mode === 'demo') return h('span', { class: 'pill pill-orange', title: 'Showing demo data. Switch to live after you connect it.' }, '● Demo');
    return s.ok ? h('span', { class: 'pill pill-green', title: s.ms ? `${s.ms} ms` : '' }, '● Connected') : h('span', { class: 'pill pill-red', title: s.message }, '● Error');
  }

  function draw() {
    clear(out).append(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', { class: 'col-phone-hide' }, 'URL'), h('th', { class: 'col-phone-hide' }, 'Type'), h('th', {}, 'Status'), h('th', { class: 'col-phone-hide' }, 'Message'), h('th', {}, h('span', { class: 'sr-only' }, 'Actions')))),
      h('tbody', {}, list.map((d) => {
        const [letter, color] = LOOK[d.id] || ['?', '#64748b'];
        const s = status.get(d.id);
        return h('tr', {},
          h('td', {}, h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
            h('div', { class: 'ds-icon', style: { background: `${color}22`, color, border: `1px solid ${color}66` } }, letter), h('b', { style: { fontWeight: 600, fontSize: '14px' } }, d.name))),
          h('td', { class: 'mono dim col-phone-hide', style: { fontSize: '12px' } }, d.url),
          h('td', { class: 'col-phone-hide' }, d.kind),
          h('td', {}, statusPill(d)),
          h('td', { class: 'dim col-phone-hide', style: { fontSize: '12px', maxWidth: '280px' } }, s && !s.testing ? s.message : ''),
          h('td', {}, h('div', { class: 'row-actions' },
            ctx.can('integrations.manage') && (d.id !== 'services' || d.modes.length > 1) ? h('button', { class: 'icon-btn', title: `Edit ${d.name}`, 'aria-label': `Edit ${d.name}`, onclick: () => edit(d) }, icon('edit', 15)) : null,
            h('button', { class: 'icon-btn', title: `Test ${d.name}`, 'aria-label': `Test ${d.name}`, disabled: !!s?.testing, onclick: async () => {
              status.set(d.id, { testing: true }); draw();
              status.set(d.id, await api(`/datasources/${d.id}/test`, { method: 'POST' }).catch((e) => ({ ok: false, message: e.message }))); draw();
            } }, icon('refresh', 15)))));
      })))),
    h('div', { class: 'info-box', style: { marginTop: '14px' } }, icon('alert', 16), h('span', {},
      'Demo means the page shows generated sample data, marked with a DEMO DATA badge. Switch Loki, Tempo or Service metrics to live once you have connected them. ',
      'Service metrics use the PromQL in observa-ui/config/services.json.')));
  }

  function edit(d) {
    const url = h('input', { class: 'input mono', value: d.url, disabled: d.id === 'services' });
    let mode = d.mode;
    modal(`Edit ${d.name}`, h('div', {},
      d.id !== 'services' ? field('URL (as seen from the UI container)', url, 'Example: http://loki:3100') : null,
      d.modes.length > 1 ? field('Mode', select(d.modes.map((m) => [m, m === 'live' ? 'Live - read real data' : 'Demo - generated sample data']), mode, (v) => { mode = v; })) : null), [
      { label: 'Cancel' },
      { label: 'Save & test', primary: true, onclick: async () => {
        const r = await api(`/datasources/${d.id}`, { method: 'PUT', body: { url: d.id === 'services' ? undefined : url.value.trim(), mode } });
        status.set(d.id, r);
        toast(r.ok ? `${d.name} saved` : `${d.name} saved, but test failed: ${r.message}`, r.ok ? 'ok' : 'err');
        list = await api('/datasources');
        draw();
      } },
    ]);
  }

  const ready = load();
  ready.catch(() => {});
  return { refresh: () => (list.length ? testAll() : load()), ready, autoRefresh: false };
}
