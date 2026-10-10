import { h, api, clear, icon, emptyState, demoBadge, fmt, short, tabs, timeChart, legendRow, dateTime } from '../ui.js';
import { chartSlots } from './common.js';
import { openLog } from './logs.js';
import { levelPill, sevPill, statusPill } from './overview.js';
import { errorState, staleNotice } from '../personas/widgets.js';

const skel = (cls, height) => h('div', { class: `${cls} skeleton`, style: { height } });

const STATUS = { healthy: ['Healthy', 'pill-solid-green'], degraded: ['Degraded', 'pill-solid-orange'], down: ['Down', 'pill-solid-red'] };

export function servicesPage(main, ctx) {
  const summary = h('div', { class: 'grid cards-4' }, ...Array.from({ length: 4 }, () => skel('summary-card', '76px')));
  const out = h('div', { style: { marginTop: '14px' } }, skel('table-wrap', '360px'));
  const stale = h('div');
  const titleBadge = h('span');
  let data = null, okAt = 0, sortKey = ctx.params.get('sort') || 'status', sortDir = ctx.params.get('dir') === 'desc' || (!ctx.params.get('dir') && ctx.params.get('sort') === 'errorRate') ? -1 : 1, search = ctx.params.get('q') || '', statusFilter = ctx.params.get('status') || '';
  const searchInput = h('input', { class: 'input', type: 'search', placeholder: 'Filter services...', 'aria-label': 'Filter services by name', value: search, style: { width: '240px' }, oninput: (e) => { search = e.target.value.toLowerCase(); draw(); } });

  main.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Services', titleBadge), h('p', {}, 'Monitor your application services')),
      h('div', { class: 'actions' }, searchInput)),
    stale, summary, out);

  // filters live in the URL, so Back, Forward and shared links show the same list
  function syncUrl() {
    const p = new URLSearchParams(location.search);
    const set = (k, v) => (v ? p.set(k, v) : p.delete(k));
    set('status', statusFilter); set('q', search); set('sort', sortKey === 'status' ? '' : sortKey); set('dir', sortDir < 0 ? 'desc' : '');
    const qs = p.toString();
    history.replaceState({}, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
  }

  async function load() {
    try {
      data = await api('/services');
      okAt = Date.now();
      clear(stale);
      clear(titleBadge).append(demoBadge(data.demo) || '');
      draw();
    } catch (e) {
      if (data) clear(stale).append(staleNotice({ okAt, message: e.message, retry: () => ctx.refreshNow() }));
      else { clear(summary); clear(out).append(errorState(e.message, () => ctx.refreshNow(), 'Services could not load')); }
      throw e; // the shell keeps "Updated … ago" at the last success
    }
  }

  function card(label, value, bubble, ic, key) {
    const on = statusFilter === key;
    return h('button', { class: `summary-card summary-btn ${on ? 'on' : ''}`, 'aria-pressed': String(on), title: key ? (on ? 'Show all services' : `Show only ${label.toLowerCase()} services`) : 'Show all services',
      onclick: () => { statusFilter = statusFilter === key ? '' : key; draw(); } },
      h('div', { class: `bubble ${bubble}` }, icon(ic, 18)), h('div', {}, h('div', { class: 'k' }, label), h('div', { class: 'v' }, value)));
  }

  function draw() {
    if (!data) return;
    syncUrl();
    const s = data.summary;
    clear(summary).append(
      card('Total Services', s.total, 'bubble-blue', 'cube', ''),
      card('Healthy', s.healthy, 'bubble-green', 'heart', 'healthy'),
      card('Degraded', s.degraded, 'bubble-orange', 'alert', 'degraded'),
      card('Down', s.down, 'bubble-red', 'down', 'down'));
    clear(out);
    if (!data.list.length) {
      out.append(h('div', { class: 'table-wrap' }, emptyState('No services found',
        'The live service queries returned nothing. Edit config/services.json to match your application metrics, or switch "Service metrics" to demo in Data Sources.')));
      return;
    }
    const order = { down: 0, degraded: 1, healthy: 2 };
    const val = (x, k) => (k === 'status' ? order[x.status] : k === 'name' ? x.name : x[k] ?? -1);
    const rows = data.list
      .filter((x) => (!search || x.name.toLowerCase().includes(search)) && (!statusFilter || x.status === statusFilter))
      .sort((a, b) => { const A = val(a, sortKey), B = val(b, sortKey); return (A > B ? 1 : A < B ? -1 : a.name.localeCompare(b.name)) * sortDir; });
    // sortable headers are buttons, so they work from the keyboard and say their state
    const th = (label, key, num, minor) => h('th', { class: `${num ? 'num' : ''} ${minor ? 'col-phone-hide' : ''}`, 'aria-sort': sortKey === key ? (sortDir > 0 ? 'ascending' : 'descending') : 'none' },
      h('button', { class: 'th-btn', onclick: () => { sortDir = sortKey === key ? -sortDir : (num ? -1 : 1); sortKey = key; draw(); } },
        label, h('span', { class: 'sort-ic', 'aria-hidden': 'true' }, sortKey === key ? (sortDir > 0 ? '▲' : '▼') : '')));
    out.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, th('Service', 'name'), th('Status', 'status'), th('Requests/s', 'rps', true, true), th('Latency (P95)', 'p95', true, true), th('Error Rate', 'errorRate', true), h('th', { class: 'num col-phone-hide' }, 'Actions'))),
      h('tbody', {}, !rows.length ? h('tr', {}, h('td', { colspan: 6, class: 'dim', style: { textAlign: 'center', padding: '22px' } }, 'No services match this filter. ',
        h('button', { class: 'linkish', onclick: () => { search = ''; statusFilter = ''; searchInput.value = ''; draw(); } }, 'Clear filter'))) : rows.map((x) => {
        const [label, cls] = STATUS[x.status] || ['?', 'pill-muted'];
        const errCls = x.errorRate >= 5 ? 'c-red' : x.errorRate >= 1 ? 'c-orange' : 'c-green';
        const latCls = x.p95 >= 1000 ? 'c-red' : x.p95 >= 500 ? 'c-orange' : '';
        return h('tr', {},
          h('td', {}, h('a', { href: ctx.link(`/services/${encodeURIComponent(x.name)}`), 'data-link': true, style: { fontWeight: 600 } }, x.name), x.namespace ? h('span', { class: 'dim svc-ns' }, x.namespace) : null),
          h('td', {}, h('span', { class: `pill ${cls}`, style: { minWidth: '74px' } }, label)),
          h('td', { class: 'num col-phone-hide' }, short(x.rps)),
          h('td', { class: `num col-phone-hide ${latCls}` }, x.p95 === null ? h('span', { class: 'dim', title: 'No latency data in this range' }, 'n/a') : fmt(x.p95, 'ms')),
          h('td', { class: `num ${errCls}` }, `${x.errorRate.toFixed(1)}%`),
          h('td', { class: 'col-phone-hide' }, h('div', { class: 'row-actions' },
            h('button', { class: 'icon-btn', title: `View logs for ${x.name}`, 'aria-label': `View logs for ${x.name}`, onclick: () => ctx.navigate(ctx.link('/logs', { q: `{service_name="${x.name}"}` })) }, icon('logs', 15)),
            h('button', { class: 'icon-btn', title: `View traces for ${x.name}`, 'aria-label': `View traces for ${x.name}`, onclick: () => ctx.navigate(ctx.link('/traces', { q: `service.name=${x.name}` })) }, icon('traces', 15)))));
      })))));
  }

  const ready = load();
  ready.catch(() => {});
  return { refresh: load, ready };
}

// ---------------- service detail ----------------
const HEALTH = { healthy: ['Healthy', 'st-ok'], degraded: ['Degraded', 'st-slow'], down: ['Unhealthy', 'st-err'] };

export function serviceDetailPage(main, ctx) {
  const name = decodeURIComponent(location.pathname.split('/')[2] || '');
  const setChart = chartSlots(ctx);
  let tab = ctx.params.get('tab') || 'overview', d = null;
  const head = h('div', { class: 'detail-head' });
  const tabsEl = h('div', { class: 'tabs-line' });
  const stale = h('div');
  const body = h('div', {}, h('div', { class: 'grid cards-4' }, ...Array.from({ length: 4 }, () => skel('kpi', '96px'))), h('div', { style: { marginTop: '14px' } }, skel('panel', '300px')));
  const back = () => h('a', { class: 'back', href: ctx.link('/services'), 'data-link': true, 'aria-label': 'Back to Services', title: 'Back to Services' }, icon('back', 16));
  clear(head).append(back(), h('h1', {}, name));
  main.append(head, stale, tabsEl, body);
  let okAt = 0;
  const tabUrl = (k) => ctx.link(`/services/${encodeURIComponent(name)}`, { tab: k === 'overview' ? '' : k });

  async function load() {
    try {
      d = await api(`/services/${encodeURIComponent(name)}`, { query: ctx.range });
      okAt = Date.now();
      clear(stale);
      draw();
    } catch (e) {
      if (d) clear(stale).append(staleNotice({ okAt, message: e.message, retry: () => ctx.refreshNow() }));
      else { clear(tabsEl); clear(body).append(errorState(e.message, () => ctx.refreshNow(), `${name} could not load`)); }
      throw e;
    }
  }

  function draw() {
    const sv = d.service;
    const [hl, hc] = HEALTH[sv.status] || ['Unknown', 'st-res'];
    clear(head).append(
      back(),
      h('span', { class: `svc-badge ${hc}` }, icon(sv.status === 'healthy' ? 'check' : 'alert', 18)),
      h('div', {}, h('h1', {}, sv.name, ' ', h('span', { class: `pill ${hc}` }, hl), ' ', demoBadge(d.demo, true)),
        h('div', { class: 'detail-meta' }, sv.namespace ? h('span', {}, `namespace ${sv.namespace}`) : null, h('span', { class: 'dim' }, 'Request, error and latency data for this service'))));
    clear(tabsEl).append(tabs([['overview', 'Overview'], ['metrics', 'Metrics'], ['logs', 'Logs'], ['traces', 'Traces'], ['dependencies', 'Dependencies'], ['deployments', 'Deployments']], tab, (k) => {
      tab = k; history.replaceState({}, '', tabUrl(k)); draw();
    }));
    clear(body);
    const card = (label, value, tone, ic) => h('div', { class: `kpi kpi-${tone} kpi-small` }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ic' }, icon(ic, 16)), h('span', { class: 'kpi-title' }, label)), h('div', { class: 'kpi-val' }, h('b', {}, value)));
    const chartPanel = (title, series, unit, key) => {
      const c = h('canvas');
      const p = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, title)), h('div', { class: 'chart-box' }, c), legendRow(series.map((x) => x.label), series.map((x) => x.color)));
      setChart(key, timeChart(c, series, { unit, area: false }));
      return p;
    };
    if (tab === 'overview') {
      const errTone = sv.errorRate >= 5 ? 'red' : sv.errorRate >= 1 ? 'orange' : 'green';
      const errors = d.series.rps.map(([t, v], i) => [t, v === null ? null : (v * (d.series.errorRate[i]?.[1] || 0)) / 100]);
      body.append(
        h('div', { class: 'grid cards-4' },
          card('Requests', `${short(sv.rps * 60)}/min`, 'blue', 'pulse'),
          card('Error Rate', `${sv.errorRate.toFixed(1)}%`, errTone, 'alert'),
          card('P95 Latency', sv.p95 === null ? 'No data' : fmt(sv.p95, 'ms'), sv.p95 >= 1000 ? 'orange' : 'purple', 'timer'),
          card('Uptime', d.uptime === null ? 'No data' : `${d.uptime.toFixed(1)}%`, d.uptime >= 99 ? 'green' : 'orange', 'check')),
        h('div', { style: { marginTop: '14px' } }, chartPanel('Service Rate & Errors', [{ label: 'Requests/s', points: d.series.rps, color: '#3b82f6' }, { label: 'Errors/s', points: errors, color: '#ef4444' }], 'reqps', 'rate')));
      relatedIncidents(body);
    } else if (tab === 'metrics') {
      body.append(h('div', { class: 'grid cols-2' },
        chartPanel('Requests per second', [{ label: 'Requests/s', points: d.series.rps }], 'reqps', 'm-rps'),
        chartPanel('Error rate', [{ label: 'Error %', points: d.series.errorRate, color: '#ef4444' }], 'percent', 'm-err'),
        chartPanel('P95 latency', [{ label: 'P95', points: d.series.p95, color: '#a855f7' }], 'ms', 'm-p95')));
    } else if (tab === 'logs') {
      body.append(skel('table-wrap', '320px'));
      api('/logs', { query: { query: `{service_name="${name}"}`, ...ctx.range, limit: 100 } }).then((r) => {
        clear(body).append(h('div', { class: 'toolbar' }, h('div', { class: 'grow' }), h('a', { class: 'btn btn-sm', href: ctx.link('/logs', { q: `{service_name="${name}"}` }), 'data-link': true }, 'Open in Logs')),
          r.entries.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' }, h('tbody', {}, r.entries.slice(0, 100).map((e) => h('tr', { class: 'clickable', onclick: () => openLog(ctx, e) },
            h('td', { class: 'mono dim', style: { whiteSpace: 'nowrap' } }, dateTime(e.ts)), h('td', {}, levelPill(e.level)), h('td', { class: 'msg' }, e.message))))))
            : emptyState('No logs for this service', 'In this time range.'));
      }).catch((e) => clear(body).append(errorState(e.message, () => draw(), 'Logs for this service could not load')));
    } else if (tab === 'traces') {
      body.append(skel('table-wrap', '320px'));
      api('/traces', { query: { query: `service.name=${name}`, ...ctx.range, limit: 25 } }).then((r) => {
        clear(body).append(r.traces.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, ['Trace ID', 'Operation', 'Started', 'Duration', 'Status'].map((x) => h('th', {}, x)))),
          h('tbody', {}, r.traces.map((t) => h('tr', { class: 'clickable', onclick: () => ctx.navigate(ctx.link(`/traces/${t.traceId}`)) },
            h('td', { class: 'mono c-link' }, t.traceId.slice(0, 16)), h('td', {}, t.rootName || '—'), h('td', { class: 'dim' }, dateTime(t.startMs).slice(11)),
            h('td', {}, fmt(t.durationMs, 'ms')), h('td', {}, h('span', { class: `pill ${t.error ? 'st-err' : t.durationMs > 1000 ? 'st-slow' : 'st-ok'}` }, t.error ? 'Error' : t.durationMs > 1000 ? 'Slow' : 'OK')))))))
          : emptyState('No traces for this service', 'In this time range.'));
      }).catch((e) => clear(body).append(errorState(e.message, () => draw(), 'Traces for this service could not load')));
    } else if (tab === 'dependencies') {
      const list = (title, items, hint) => h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, title)),
        items.length ? h('div', { class: 'dep-list' }, items.map((x) => {
          const [l, c] = HEALTH[x.status] || ['External', 'st-res'];
          // an external system has no page here: plain text, not a link that goes nowhere
          return h(x.status === 'external' ? 'div' : 'a', x.status === 'external' ? { class: 'dep dep-external' } : { class: 'dep', href: ctx.link(`/services/${encodeURIComponent(x.name)}`), 'data-link': true },
            h('b', {}, x.name), h('span', { class: `pill ${c}` }, l), x.errorRate !== null ? h('span', { class: 'dim' }, `${x.errorRate.toFixed(1)}% errors`) : h('span', { class: 'dim' }, 'outside ObservaOne'));
        })) : h('p', { class: 'muted' }, hint));
      body.append(d.dependencies.known ? null : h('div', { class: 'note' }, 'Dependencies are learned from traces. Connect Tempo (Data Sources) and send traces from your apps to see who calls whom.'),
        h('div', { class: 'grid cols-2' },
          list('Calls (downstream)', d.dependencies.calls, 'No downstream calls seen.'),
          list('Called by (upstream)', d.dependencies.calledBy, 'No callers seen.')));
    } else {
      body.append(h('section', { class: 'panel' }, emptyState('No deployments recorded', 'Deployment tracking arrives in a later update: CI pipelines will post each release so it shows on the charts.')));
    }
  }

  async function relatedIncidents(box) {
    try {
      const r = await api('/incidents', { query: { service: name, status: 'all', limit: 5 } });
      if (!r.incidents.length || !box.isConnected) return;
      box.append(h('section', { class: 'panel', style: { marginTop: '14px' } }, h('div', { class: 'panel-head' }, h('h3', {}, 'Incidents for this service')),
        h('table', { class: 'tbl' }, h('tbody', {}, r.incidents.map((x) => h('tr', { class: 'clickable', onclick: () => ctx.navigate(ctx.link(`/incidents/${x.id}`)) },
          h('td', {}, sevPill(x.severity)), h('td', {}, x.title), h('td', { class: 'dim' }, dateTime(Date.parse(x.startedAt))), h('td', {}, statusPill(x.status))))))));
    } catch (e) {
      // say the panel is missing instead of silently leaving it out
      if (box.isConnected) box.append(h('p', { class: 'muted', style: { marginTop: '14px' } }, `Incidents for this service could not be loaded: ${e.message}`));
    }
  }

  const ready = load();
  ready.catch(() => {});
  return { refresh: load, ready };
}
