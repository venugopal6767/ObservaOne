// Incidents: list (opened automatically from alerts, or declared by people) and one page per incident.
import { h, api, clear, icon, emptyState, errorBox, select, tabs, modal, field, toast, fmt, dateTime, ago, timeChart, demoBadge, legendRow } from '../ui.js';
import { chartSlots } from './common.js';
import { sevPill, statusPill, levelPill } from './overview.js';
import { openLog } from './logs.js';
import { errorState, staleNotice } from '../personas/widgets.js';

const skel = (cls, height) => h('div', { class: `${cls} skeleton`, style: { height } });

const dur = (sec) => {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
};

export function incidentsPage(main, ctx) {
  let status = ctx.params.get('status') || 'all', severity = ctx.params.get('severity') || '', search = ctx.params.get('q') || '', data = null, typing = null, okAt = 0;
  const out = h('div', {}, skel('table-wrap', '420px'));
  const stale = h('div');
  const counts = h('div', { class: 'chips' });
  const canManage = ctx.can('incidents.manage');
  main.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Incidents'), h('p', {}, 'Alerts and incident management.')),
      h('div', { class: 'actions' },
        h('a', { class: 'btn', href: ctx.link('/alerting'), 'data-link': true }, icon('alerting', 15), 'Alert rules & silences'),
        canManage ? h('button', { class: 'btn btn-primary', onclick: create }, icon('plus', 15), 'Create Incident') : null)),
    h('div', { class: 'toolbar' },
      select([['all', 'All Status'], ['active', 'Active'], ['open', 'Open'], ['acknowledged', 'Acknowledged'], ['investigating', 'Investigating'], ['resolved', 'Resolved']], status, (v) => { status = v; reload(); }, { class: 'select select-sm', 'aria-label': 'Status' }),
      select([['', 'All Severity'], ['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']], severity, (v) => { severity = v; reload(); }, { class: 'select select-sm', 'aria-label': 'Severity' }),
      h('input', { class: 'input', type: 'search', value: search, placeholder: 'Search title, service, host...', 'aria-label': 'Search incidents', style: { width: '240px' }, oninput: (e) => { search = e.target.value; clearTimeout(typing); typing = setTimeout(reload, 250); } }),
      h('div', { class: 'grow' }), counts),
    stale, out);

  // filters live in the URL, so Back and shared links show the same list
  function syncUrl() {
    const p = new URLSearchParams(location.search);
    const set = (k, v) => (v ? p.set(k, v) : p.delete(k));
    set('status', status === 'all' ? '' : status); set('severity', severity); set('q', search);
    const qs = p.toString();
    history.replaceState({}, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
  }
  const reload = () => { syncUrl(); load().catch(() => {}); };

  async function load() {
    try {
      data = await api('/incidents', { query: { status, severity, q: search } });
      okAt = Date.now();
      clear(stale);
      draw();
    } catch (e) {
      if (data) clear(stale).append(staleNotice({ okAt, message: e.message, retry: () => ctx.refreshNow() }));
      else clear(out).append(errorState(e.message, () => ctx.refreshNow(), 'Incidents could not load'));
      throw e;
    }
  }

  function draw() {
    const c = data.counts;
    clear(counts).append(
      h('span', { class: 'chip chip-error' }, 'Critical', h('b', {}, c.critical)),
      h('span', { class: 'chip chip-warn' }, 'Warning', h('b', {}, c.warning)),
      h('span', { class: 'chip' }, 'Resolved 24h', h('b', {}, c.resolved24h)),
      c.demo ? demoBadge(true, true) : '');
    clear(out);
    if (!data.incidents.length) {
      const filtered = status !== 'all' || severity || search;
      out.append(h('div', { class: 'table-wrap' }, emptyState(filtered ? 'No incidents match these filters' : 'No incidents', filtered ? 'Change or clear the filters above.' : 'Incidents open automatically when alerts fire.')));
      return;
    }
    out.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, [h('span', { class: 'sr-only' }, 'State'), 'Incident', 'Service / host', 'Severity', 'Status', 'Started', 'Duration', 'Assigned'].map((x, i) => h('th', { class: [0, 2, 6, 7].includes(i) ? 'col-phone-hide' : '' }, x)))),
      h('tbody', {}, data.incidents.map((x) => h('tr', { class: 'clickable', onclick: () => ctx.navigate(ctx.link(`/incidents/${x.id}`)) },
        h('td', { class: 'col-phone-hide' }, h('i', { class: `dot ${x.status === 'resolved' ? 'dot-muted' : x.severity === 'critical' ? 'dot-red' : 'dot-orange'}` })),
        h('td', {}, h('b', { style: { fontWeight: 600 } }, x.title), h('div', { class: 'dim mono', style: { fontSize: '11px' } }, x.number, x.source === 'demo' ? ' · demo' : x.source === 'alert' ? ' · from alert' : ' · declared')),
        h('td', { class: 'col-phone-hide' }, x.service ? h('a', { href: ctx.link(`/services/${encodeURIComponent(x.service)}`), 'data-link': true, onclick: (e) => e.stopPropagation() }, x.service) : h('span', { class: 'dim' }, x.host || '—')),
        h('td', {}, sevPill(x.severity)),
        h('td', {}, statusPill(x.status)),
        h('td', { class: 'dim' }, ago(x.startedAt)),
        h('td', { class: 'dim col-phone-hide' }, dur(x.durationSec)),
        h('td', { class: 'col-phone-hide' }, x.assignedTo || h('span', { class: 'dim' }, '—'))))))));
  }

  function create() {
    const title = h('input', { class: 'input', maxlength: 200, placeholder: 'e.g. Checkout failing for some users' });
    const service = h('input', { class: 'input', placeholder: 'payment-service (optional)' });
    const summary = h('textarea', { class: 'input', rows: 3, placeholder: 'What is happening? Who is affected?' });
    let sev = 'critical';
    modal('Create incident', h('div', {}, field('Title', title), h('div', { class: 'form-row' },
      field('Severity', select([['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']], sev, (v) => { sev = v; })), field('Service', service)),
    field('Summary', summary)), [
      { label: 'Cancel' },
      { label: 'Create', primary: true, onclick: async () => {
        const r = await api('/incidents', { method: 'POST', body: { title: title.value, severity: sev, service: service.value.trim(), summary: summary.value } });
        toast('Incident created');
        ctx.navigate(ctx.link(`/incidents/${r.id}`));
      } },
    ], { wide: true });
  }

  syncUrl();
  const ready = load();
  ready.catch(() => {});
  return { refresh: load, ready };
}

// ---------------- incident detail ----------------
export function incidentDetailPage(main, ctx) {
  const id = Number(location.pathname.split('/')[2]);
  const setChart = chartSlots(ctx);
  const canManage = ctx.can('incidents.manage');
  let tab = ctx.params.get('tab') || 'overview', d = null;
  const head = h('div', { class: 'detail-head' });
  const actions = h('div', { class: 'toolbar' });
  const tabsEl = h('div', { class: 'tabs-line' });
  const stale = h('div');
  const body = h('div', {}, h('div', { class: 'inc-grid' }, skel('panel', '300px'), skel('panel', '300px')));
  const back = () => h('a', { class: 'back', href: ctx.link('/incidents'), 'data-link': true, 'aria-label': 'Back to Incidents', title: 'Back to Incidents' }, icon('back', 16));
  clear(head).append(back(), h('h1', {}, `Incident ${id}`));
  main.append(head, stale, actions, tabsEl, body);
  let okAt = 0;

  async function load() {
    try {
      d = await api(`/incidents/${id}`);
      okAt = Date.now();
      clear(stale);
      draw();
    } catch (e) {
      if (d) clear(stale).append(staleNotice({ okAt, message: e.message, retry: () => ctx.refreshNow() }));
      else { clear(actions); clear(tabsEl); clear(body).append(errorState(e.message, () => ctx.refreshNow(), `Incident ${id} could not load`)); }
      throw e;
    }
  }
  const reloadQuiet = () => load().catch(() => {});

  const setStatus = async (s) => { try { await api(`/incidents/${id}/status`, { method: 'POST', body: { status: s } }); toast(`Marked ${s}`); reloadQuiet(); } catch (e) { toast(e.message, 'err'); } };
  const assignMe = async () => { try { await api(`/incidents/${id}/assign`, { method: 'POST', body: { username: 'me' } }); toast('Assigned to you'); reloadQuiet(); } catch (e) { toast(e.message, 'err'); } };

  function draw() {
    const x = d.incident;
    clear(head).append(
      back(),
      h('span', { class: `svc-badge ${x.severity === 'critical' ? 'st-err' : 'st-slow'}` }, icon('incident', 18)),
      h('div', {}, h('h1', {}, x.title, ' ', sevPill(x.severity), ' ', x.source === 'demo' ? demoBadge(true, true) : null),
        h('div', { class: 'detail-meta' }, h('span', { class: 'mono' }, x.number),
          x.service ? h('a', { href: ctx.link(`/services/${encodeURIComponent(x.service)}`), 'data-link': true }, x.service) : x.host ? h('span', {}, x.host) : null,
          h('span', { class: 'dim' }, `started ${ago(x.startedAt)}`))),
      h('div', { class: 'actions' }, statusPill(x.status)));
    clear(actions).append(...(canManage ? [
      x.status === 'open' ? h('button', { class: 'btn btn-sm', onclick: () => setStatus('acknowledged') }, 'Acknowledge') : null,
      x.status !== 'investigating' && x.status !== 'resolved' ? h('button', { class: 'btn btn-sm', onclick: () => setStatus('investigating') }, 'Investigating') : null,
      x.status !== 'resolved' ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => setStatus('resolved') }, icon('check', 13), 'Resolve') : h('button', { class: 'btn btn-sm', onclick: () => setStatus('open') }, 'Reopen'),
      x.assignedTo !== ctx.me.user.username ? h('button', { class: 'btn btn-sm', onclick: assignMe }, icon('user', 13), 'Assign to me') : null,
      h('button', { class: 'btn btn-sm', onclick: addNote }, icon('edit', 13), 'Add note'),
    ].filter(Boolean) : [h('span', { class: 'dim' }, 'You can view this incident. Changing it needs the incidents.manage permission.')]));
    clear(tabsEl).append(tabs([['overview', 'Overview'], ['timeline', 'Timeline'], ['metrics', 'Metrics'], ['logs', 'Logs'], ['traces', 'Traces'], ['related', 'Related Services']], tab, (k) => {
      tab = k; history.replaceState({}, '', ctx.link(`/incidents/${id}`, { tab: k === 'overview' ? '' : k })); draw();
    }));
    clear(body);
    // time window around the incident, used by charts, logs, traces
    const t0 = Math.floor(Date.parse(x.startedAt) / 1000) - 30 * 60;
    const t1 = x.resolvedAt ? Math.floor(Date.parse(x.resolvedAt) / 1000) + 30 * 60 : Math.floor(Date.now() / 1000);
    if (tab === 'overview') {
      const chartBox = h('div', {}, skel('chart-box', '220px'));
      body.append(h('div', { class: 'inc-grid' },
        h('section', { class: 'panel' }, h('dl', { class: 'kv' },
          h('dt', {}, 'Started'), h('dd', {}, `${ago(x.startedAt)} (${dateTime(Date.parse(x.startedAt))})`),
          h('dt', {}, 'Duration'), h('dd', {}, dur(x.durationSec)),
          h('dt', {}, 'Severity'), h('dd', {}, sevPill(x.severity)),
          h('dt', {}, 'Status'), h('dd', {}, statusPill(x.status)),
          h('dt', {}, 'Service'), h('dd', {}, x.service ? h('a', { href: ctx.link(`/services/${encodeURIComponent(x.service)}`), 'data-link': true }, x.service) : h('span', { class: 'dim' }, '—')),
          h('dt', {}, 'Host'), h('dd', {}, x.host || h('span', { class: 'dim' }, '—')),
          h('dt', {}, 'Environment'), h('dd', {}, x.environment || h('span', { class: 'dim' }, '—')),
          h('dt', {}, 'Assigned to'), h('dd', {}, x.assignedTo || 'nobody'),
          h('dt', {}, 'Source'), h('dd', {}, x.source === 'alert' ? `alert ${x.alertName}` : x.source === 'demo' ? 'sample data' : `declared by ${x.createdBy}`)),
        x.summary ? h('p', { style: { marginTop: '12px' } }, x.summary) : null,
        d.alerts.length ? h('div', { style: { marginTop: '12px' } }, h('div', { class: 'muted' }, `${d.alerts.length} alert(s) firing now`),
          h('ul', { class: 'agent-notes' }, d.alerts.map((a) => h('li', {}, a.summary || a.labels.alertname, ' ', h('span', { class: 'dim mono' }, a.labels.instance || a.labels.host || ''))))) : null),
        h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, x.service ? 'Error Rate' : 'Host CPU')), chartBox)));
      drawMainChart(chartBox, x, t0, t1);
    } else if (tab === 'timeline') {
      body.append(h('section', { class: 'panel' }, h('ol', { class: 'timeline' }, d.events.map((ev) => h('li', { class: `tl-${ev.kind}` },
        h('span', { class: 'tl-dot' }), h('div', {}, h('b', {}, ev.text), h('div', { class: 'dim', style: { fontSize: '11.5px' } }, `${dateTime(Date.parse(ev.at))} · ${ev.actor || 'ObservaOne'}`)))))),
      canManage ? h('button', { class: 'btn btn-sm', style: { marginTop: '10px' }, onclick: addNote }, icon('edit', 13), 'Add note') : null);
    } else if (tab === 'metrics') {
      if (!x.service && !x.host) { body.append(h('section', { class: 'panel' }, emptyState('No service or host on this incident'))); return; }
      const grid = h('div', { class: 'grid cols-2' });
      body.append(grid);
      if (x.service) {
        api(`/services/${encodeURIComponent(x.service)}`, { query: { start: t0, end: t1 } }).then((s) => {
          const p = (title, pts, unit, color, key) => { const c = h('canvas'); grid.append(h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, title)), h('div', { class: 'chart-box' }, c))); setChart(key, timeChart(c, [{ label: title, points: pts, color }], { unit })); };
          p('Requests/s', s.series.rps, 'reqps', '#3b82f6', 'i-rps'); p('Error rate', s.series.errorRate, 'percent', '#ef4444', 'i-err'); p('P95 latency', s.series.p95, 'ms', '#a855f7', 'i-p95');
        }).catch((e) => grid.append(errorBox(e.message)));
      } else {
        for (const [title, q, unit, color, key] of [['CPU used', `clamp(100 - avg by (host) (rate(node_cpu_seconds_total{mode="idle",host="${x.host}"}[5m])) * 100, 0, 100)`, 'percent', '#3b82f6', 'h-cpu'],
          ['Memory used', `100 * (1 - node_memory_MemAvailable_bytes{host="${x.host}"} / node_memory_MemTotal_bytes{host="${x.host}"})`, 'percent', '#a855f7', 'h-mem']]) {
          api('/prom/query_range', { query: { query: q, start: t0, end: t1 } }).then((r) => {
            const c = h('canvas'); grid.append(h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, `${title} · ${x.host}`)), r.result.length ? h('div', { class: 'chart-box' }, c) : emptyState('No data')));
            if (r.result.length) setChart(key, timeChart(c, r.result.slice(0, 1).map((s) => ({ label: title, points: s.values, color })), { unit, max: 100 }));
          }).catch((e) => grid.append(h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, `${title} · ${x.host}`)), errorBox(e.message))));
        }
      }
    } else if (tab === 'logs') {
      body.append(skel('table-wrap', '320px'));
      const sel = x.service ? `{service_name="${x.service}"}` : x.host ? `{host_name="${x.host}"}` : '{service_name=~".+"}';
      api('/logs', { query: { query: sel, start: t0, end: t1, limit: 200 } }).then((r) => {
        const rows = [...r.entries].sort((a, b) => (b.level === 'ERROR') - (a.level === 'ERROR') || b.ts - a.ts).slice(0, 100);
        clear(body).append(h('p', { class: 'muted', style: { marginTop: 0 } }, `Logs from ${x.service || x.host || 'all services'} during the incident (errors first).`),
          rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' }, h('tbody', {}, rows.map((e) => h('tr', { class: 'clickable', onclick: () => openLog(ctx, e) },
            h('td', { class: 'mono dim', style: { whiteSpace: 'nowrap' } }, dateTime(e.ts)), h('td', {}, levelPill(e.level)), h('td', { class: 'msg' }, e.message))))))
            : emptyState('No logs in this window'));
      }).catch((e) => clear(body).append(errorBox(e.message)));
    } else if (tab === 'traces') {
      if (!x.service) { body.append(h('section', { class: 'panel' }, emptyState('No service on this incident', 'Traces are linked by service.'))); return; }
      body.append(skel('table-wrap', '320px'));
      api('/traces', { query: { query: `service.name=${x.service}`, start: t0, end: t1, limit: 30 } }).then((r) => {
        const rows = [...r.traces].sort((a, b) => (b.error === true) - (a.error === true) || b.durationMs - a.durationMs);
        clear(body).append(rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, ['Trace ID', 'Operation', 'Started', 'Duration', 'Status'].map((c) => h('th', {}, c)))),
          h('tbody', {}, rows.map((t) => h('tr', { class: 'clickable', onclick: () => ctx.navigate(ctx.link(`/traces/${t.traceId}`)) },
            h('td', { class: 'mono c-link' }, t.traceId.slice(0, 16)), h('td', {}, t.rootName || '—'), h('td', { class: 'dim' }, dateTime(t.startMs).slice(11)),
            h('td', {}, fmt(t.durationMs, 'ms')), h('td', {}, h('span', { class: `pill ${t.error ? 'st-err' : t.durationMs > 1000 ? 'st-slow' : 'st-ok'}` }, t.error ? 'Error' : t.durationMs > 1000 ? 'Slow' : 'OK')))))))
          : emptyState('No traces in this window'));
      }).catch((e) => clear(body).append(errorBox(e.message)));
    } else {
      if (!x.service) { body.append(h('section', { class: 'panel' }, emptyState('No service on this incident'))); return; }
      body.append(skel('panel', '200px'));
      api(`/services/${encodeURIComponent(x.service)}`).then((s) => {
        const all = [...s.dependencies.calledBy.map((y) => ({ ...y, rel: 'calls it' })), ...s.dependencies.calls.map((y) => ({ ...y, rel: 'is called by it' }))];
        clear(body).append(all.length ? h('section', { class: 'panel' }, h('p', { class: 'muted', style: { marginTop: 0 } }, `Services connected to ${x.service}. A problem often spreads along these links.`),
          h('div', { class: 'dep-list' }, all.map((y) => h(y.status === 'external' ? 'div' : 'a', y.status === 'external' ? { class: 'dep dep-external' } : { class: 'dep', href: ctx.link(`/services/${encodeURIComponent(y.name)}`), 'data-link': true },
            h('b', {}, y.name), h('span', { class: 'dim' }, y.rel),
            h('span', { class: `pill ${y.status === 'healthy' ? 'st-ok' : y.status === 'degraded' ? 'st-slow' : y.status === 'down' ? 'st-err' : 'st-res'}` }, y.status)))))
          : h('section', { class: 'panel' }, emptyState('No related services known', 'They are learned from traces.')));
      }).catch((e) => clear(body).append(errorBox(e.message)));
    }
  }

  async function drawMainChart(box, x, t0, t1) {
    try {
      if (x.service) {
        const s = await api(`/services/${encodeURIComponent(x.service)}`, { query: { start: t0, end: t1 } });
        const pts = s.series.errorRate;
        const cur = pts.length ? pts[pts.length - 1][1] : null;
        const hourAgo = pts.find(([t]) => t >= t1 - 3600)?.[1];
        const c = h('canvas');
        clear(box).append(h('div', { class: 'inc-chart-meta' }, h('span', {}, 'Current ', h('b', { class: 'c-red' }, cur === null ? '—' : `${cur.toFixed(1)}%`)),
          cur !== null && hourAgo ? h('span', { class: 'dim' }, `${cur >= hourAgo ? '+' : ''}${(((cur - hourAgo) / hourAgo) * 100).toFixed(1)}% from 1h ago`) : null),
        h('div', { class: 'chart-box' }, c), legendRow(['Error rate'], ['#ef4444']));
        setChart('main', timeChart(c, [{ label: 'Error rate', points: pts, color: '#ef4444' }], { unit: 'percent', area: true }));
      } else if (x.host) {
        const r = await api('/prom/query_range', { query: { query: `clamp(100 - avg by (host) (rate(node_cpu_seconds_total{mode="idle",host="${x.host}"}[5m])) * 100, 0, 100)`, start: t0, end: t1 } });
        if (!r.result.length) { clear(box).append(emptyState('No data for this host')); return; }
        const c = h('canvas');
        clear(box).append(h('div', { class: 'chart-box' }, c));
        setChart('main', timeChart(c, [{ label: 'CPU used', points: r.result[0].values, color: '#3b82f6' }], { unit: 'percent', area: true, max: 100 }));
      } else clear(box).append(emptyState('No service or host'));
    } catch (e) {
      clear(box).append(errorBox(e.message));
    }
  }

  function addNote() {
    const text = h('textarea', { class: 'input', rows: 4, placeholder: 'What did you find or change?' });
    modal('Add note', field('Note', text), [{ label: 'Cancel' }, { label: 'Add', primary: true, onclick: async () => {
      await api(`/incidents/${id}/notes`, { method: 'POST', body: { text: text.value } });
      toast('Note added'); tab = 'timeline'; reloadQuiet();
    } }]);
  }

  const ready = load();
  ready.catch(() => {});
  return { refresh: load, ready };
}
