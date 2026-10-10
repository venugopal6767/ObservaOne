import { h, api, clear, icon, emptyState, select, demoBadge, dateTime, tabs, toast } from '../ui.js';
import { errorState, staleNotice } from '../personas/widgets.js';

const skel = (cls, height) => h('div', { class: `${cls} skeleton`, style: { height } });

const LEVELS = [['ERROR', 'chip-error'], ['WARN', 'chip-warn'], ['INFO', 'chip-info'], ['DEBUG', 'chip-debug']];
const LEVEL_PILL = { ERROR: 'lv-error', WARN: 'lv-warn', INFO: 'lv-info', DEBUG: 'lv-debug' };

export function logsPage(main, ctx) {
  const startQ = ctx.params.get('q') || ctx.pref('logsQuery') || '{service_name=~".+"} |= "ERROR"';
  const input = h('input', { value: startQ, spellcheck: 'false', 'aria-label': 'LogQL query', onkeydown: (e) => { if (e.key === 'Enter') runQuiet(); } });
  const chipsEl = h('div', { class: 'chips' });
  const filtersEl = h('div', { style: { display: 'flex', gap: '8px' } });
  const out = h('div');
  const stale = h('div');
  const titleBadge = h('span');
  let data = null, okAt = 0, lastQuery = null, level = ctx.params.get('level') || 'ALL', service = ctx.params.get('service') || '', namespace = ctx.params.get('ns') || '';

  main.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Logs Explorer', titleBadge), h('p', {}, 'Search and analyze logs from Loki'))),
    h('div', { class: 'query-bar' }, h('div', { class: 'query-input' }, input), h('button', { class: 'btn btn-primary', onclick: runQuiet }, 'Search')),
    h('div', { class: 'toolbar' }, chipsEl, h('div', { class: 'grow' }), filtersEl),
    stale, out,
    h('div', { class: 'muted', style: { marginTop: '10px', fontSize: '12px' } },
      'Query syntax (LogQL): ', h('code', {}, '{app="name"}'), ' selects a stream, ', h('code', {}, '|= "text"'), ' must contain, ',
      h('code', {}, '!= "text"'), ' must not contain, ', h('code', {}, '|~ "regex"'), ' regex match.'));

  // query + filters live in the URL (with env and range), so Back and shared links show the same lines
  function syncUrl() {
    history.replaceState({}, '', ctx.link('/logs', { q: input.value.trim(), level: level === 'ALL' ? '' : level, service, ns: namespace }));
  }

  async function run() {
    const query = input.value.trim();
    if (query !== ctx.pref('logsQuery')) ctx.savePref('logsQuery', query);
    // a new query shows placeholders; an automatic refresh of the same query keeps the lines on screen
    const isNew = query !== lastQuery || !data;
    lastQuery = query;
    syncUrl();
    if (isNew) clear(out).append(skel('table-wrap', '420px'));
    try {
      const fresh = await api('/logs', { query: { query, ...ctx.range, limit: 500 } });
      data = fresh; okAt = Date.now();
      clear(stale);
      ctx.setDsChip(data.demo ? 'Loki (demo)' : 'Loki', data.demo ? '#f59e0b' : '#22c55e');
      clear(titleBadge).append(demoBadge(data.demo) || '');
      draw();
    } catch (e) {
      if (data && !isNew) clear(stale).append(staleNotice({ okAt, message: e.message, retry: () => ctx.refreshNow() }));
      else { data = null; clear(chipsEl); clear(filtersEl); clear(out).append(errorState(e.message, () => ctx.refreshNow(), 'Logs could not load')); }
      throw e;
    }
  }
  function runQuiet() { run().catch(() => {}); }

  function draw() {
    if (!data) return;
    syncUrl();
    const total = data.entries.length;
    clear(chipsEl).append(
      h('button', { class: `chip ${level === 'ALL' ? 'active' : ''}`, 'aria-pressed': String(level === 'ALL'), onclick: () => { level = 'ALL'; draw(); } }, 'All', h('b', {}, total)),
      ...LEVELS.map(([lv, cls]) => h('button', { class: `chip ${cls} ${level === lv ? 'active' : ''}`, 'aria-pressed': String(level === lv), onclick: () => { level = lv; draw(); } }, lv, h('b', {}, data.counts[lv] || 0))));
    const services = [...new Set(data.entries.map((e) => e.service).filter(Boolean))].sort();
    const namespaces = [...new Set(data.entries.map((e) => e.namespace).filter(Boolean))].sort();
    clear(filtersEl).append(
      select([['', 'Service: all'], ...services], service, (v) => { service = v; draw(); }, { class: 'select select-sm', 'aria-label': 'Service' }),
      select([['', 'Namespace: all'], ...namespaces], namespace, (v) => { namespace = v; draw(); }, { class: 'select select-sm', 'aria-label': 'Namespace' }));
    const rows = data.entries.filter((e) => (level === 'ALL' || e.level === level) && (!service || e.service === service) && (!namespace || e.namespace === namespace));
    clear(out);
    if (!rows.length) {
      const filtered = level !== 'ALL' || service || namespace;
      out.append(h('div', { class: 'table-wrap' }, emptyState(filtered ? 'No lines match these filters' : 'No log lines', filtered ? 'Clear the level, service or namespace filter.' : 'Try a wider time range or a different query.',
        filtered ? h('button', { class: 'btn btn-sm', onclick: () => { level = 'ALL'; service = ''; namespace = ''; draw(); } }, 'Clear filters') : null)));
      return;
    }
    out.append(h('div', { class: 'table-wrap', style: { maxHeight: 'calc(100vh - 290px)' } }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Level'), h('th', { class: 'col-phone-hide' }, 'Service'), h('th', { class: 'col-phone-hide' }, 'Host / pod'), h('th', {}, 'Message'))),
      h('tbody', {}, rows.slice(0, 500).map((e) => h('tr', { class: 'clickable', onclick: () => openLog(ctx, e) },
        h('td', { class: 'mono', style: { whiteSpace: 'nowrap' } }, dateTime(e.ts)),
        h('td', {}, h('span', { class: `pill ${LEVEL_PILL[e.level] || 'pill-muted'}` }, e.level)),
        h('td', { class: 'col-phone-hide' }, e.service || h('span', { class: 'dim' }, '—')),
        h('td', { class: 'mono dim col-phone-hide', style: { fontSize: '12px' } }, e.pod || '—'),
        h('td', { class: 'msg', title: e.message }, e.message)))))));
  }

  const ready = run();
  ready.catch(() => {});
  return { refresh: run, ready };
}

// ---------------- Log details (its own page; the line travels in sessionStorage) ----------------
export function openLog(ctx, e) {
  try { sessionStorage.setItem('oo.log', JSON.stringify(e)); } catch { /* storage off: page shows a hint */ }
  ctx.navigate(ctx.link('/logs/detail'));
}

export function logDetailPage(main, ctx) {
  let e = null;
  try { e = JSON.parse(sessionStorage.getItem('oo.log') || 'null'); } catch { e = null; }
  if (!e) {
    main.append(h('div', { class: 'empty' }, h('div', { class: 'empty-title' }, 'No log line selected'), h('div', { class: 'muted' }, 'Log details open from a line in Logs, Overview, a service or an incident. They are not kept after the browser tab closes.'), h('a', { href: ctx.link('/logs'), 'data-link': true }, 'Back to Logs')));
    return {};
  }
  let tab = 'message';
  const body = h('div');
  const json = { timestamp: new Date(e.ts).toISOString(), level: e.level, service: e.service, namespace: e.namespace || undefined, host: e.pod || undefined, message: e.message, traceId: e.traceId || undefined, ...(e.attrs || {}), ...(e.labels ? { labels: e.labels } : {}) };
  main.append(
    h('div', { class: 'detail-head' },
      h('a', { class: 'back', href: ctx.link('/logs'), 'data-link': true, 'aria-label': 'Back to Logs', title: 'Back to Logs' }, icon('back', 16)),
      h('div', {}, h('h1', {}, 'Log Details'),
        h('div', { class: 'detail-meta' }, h('span', { class: 'mono' }, dateTime(e.ts)), h('span', { class: `pill ${LEVEL_PILL[e.level] || 'pill-muted'}` }, e.level),
          e.service ? h('a', { href: ctx.link(`/services/${encodeURIComponent(e.service)}`), 'data-link': true }, e.service) : null)),
      h('div', { class: 'actions' }, e.traceId ? h('a', { class: 'btn btn-primary', href: ctx.link(`/traces/${e.traceId}`), 'data-link': true }, 'View Trace', icon('arrowRight', 14))
        : h('span', { class: 'btn btn-unavail', 'aria-disabled': 'true', title: 'This line carries no trace ID, so there is no trace to open.' }, 'No trace linked'))),
    h('div', { class: 'tabs-line' }, tabs([['message', 'Message'], ['json', 'JSON'], ['context', 'Context'], ['related', 'Related Traces']], tab, (k) => { tab = k; draw(); })),
    h('section', { class: 'panel' }, body));

  function draw() {
    main.querySelector('.tabs-line').replaceChildren(tabs([['message', 'Message'], ['json', 'JSON'], ['context', 'Context'], ['related', 'Related Traces']], tab, (k) => { tab = k; draw(); }));
    clear(body);
    if (tab === 'message') {
      body.append(h('pre', { class: 'code log-msg' }, e.message),
        h('dl', { class: 'kv', style: { marginTop: '14px' } },
          h('dt', {}, 'Time'), h('dd', {}, dateTime(e.ts)),
          h('dt', {}, 'Level'), h('dd', {}, e.level),
          h('dt', {}, 'Service'), h('dd', {}, e.service || '—'),
          h('dt', {}, 'Host / pod'), h('dd', {}, e.pod || '—'),
          h('dt', {}, 'Trace ID'), h('dd', { class: 'mono' }, e.traceId || '—')));
    } else if (tab === 'json') {
      body.append(h('div', { class: 'json-head' }, h('button', { class: 'btn btn-sm', onclick: async () => {
        try { await navigator.clipboard.writeText(JSON.stringify(json, null, 2)); toast('Copied'); } catch { toast('Copy is blocked by the browser here. Select the text and copy it instead.', 'err'); }
      } }, 'Copy')),
        h('pre', { class: 'code json' }, JSON.stringify(json, null, 2)));
    } else if (tab === 'context') {
      body.append(skel('table-wrap', '260px'));
      api('/logs/context', { query: { service: e.service, ts: e.ts } }).then((r) => {
        clear(body);
        if (!r.entries.length) { body.append(emptyState('No other lines', 'Nothing else from this service within a minute of this line.')); return; }
        body.append(h('p', { class: 'muted', style: { marginTop: 0 } }, `Lines from ${e.service} around this one (±1 minute).`),
          h('table', { class: 'tbl' }, h('tbody', {}, r.entries.map((x) => h('tr', { class: x.ts === e.ts && x.message === e.message ? 'sel' : '' },
            h('td', { class: 'mono dim', style: { whiteSpace: 'nowrap' } }, dateTime(x.ts).slice(11)),
            h('td', {}, h('span', { class: `pill ${LEVEL_PILL[x.level] || 'pill-muted'}` }, x.level)),
            h('td', { class: 'msg' }, x.message))))));
      }).catch((err) => clear(body).append(errorState(err.message, () => draw(), 'Nearby lines could not load')));
    } else {
      if (!e.traceId) { body.append(emptyState('No trace linked', 'This line carries no trace ID. Apps that log the trace ID get a direct link here.')); return; }
      body.append(skel('table-wrap', '120px'));
      api(`/traces/${e.traceId}`).then((t) => {
        clear(body).append(h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, ['Trace ID', 'Root', 'Services', 'Spans', 'Duration', 'Status'].map((x) => h('th', {}, x)))),
          h('tbody', {}, h('tr', { class: 'clickable', onclick: () => ctx.navigate(ctx.link(`/traces/${t.traceId}`)) },
            h('td', { class: 'mono c-link' }, t.traceId),
            h('td', {}, t.spans[0]?.name || '—'),
            h('td', {}, String(new Set(t.spans.map((x) => x.service)).size)),
            h('td', {}, String(t.spans.length)),
            h('td', {}, `${Math.round(t.durationMs)} ms`),
            h('td', {}, h('span', { class: `pill ${t.error ? 'st-err' : 'st-ok'}` }, t.error ? 'Error' : 'OK'))))));
      }).catch((err) => clear(body).append(errorState(err.message, () => draw(), 'The linked trace could not load')));
    }
  }
  draw();
  return {};
}
