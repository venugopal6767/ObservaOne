import { h, api, clear, icon, select, modal, toast, stateView, stateFromError, stateBanner, paginate, timeEl, timeHeader, timeTitle, dateTimeZ, color } from '../ui.js';

const LEVELS = [['ERROR', 'chip-error'], ['WARN', 'chip-warn'], ['INFO', 'chip-info'], ['DEBUG', 'chip-debug']];
const LEVEL_PILL = { ERROR: 'pill-solid-red', WARN: 'pill-solid-orange', INFO: 'pill-solid-blue', DEBUG: 'pill-solid-muted' };

export function logsPage(main, ctx) {
  const startQ = ctx.params.get('q') || ctx.pref('logsQuery') || '{service_name=~".+"} |= "ERROR"';
  const input = h('input', { value: startQ, spellcheck: 'false', 'aria-label': 'LogQL query', onkeydown: (e) => { if (e.key === 'Enter') run(); } });
  const chipsEl = h('div', { class: 'chips' });
  const filtersEl = h('div', { style: { display: 'flex', gap: '8px' } });
  const out = h('div');
  let data = null, level = 'ALL', service = '', namespace = '', page = 0;

  main.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Logs Explorer'), h('p', {}, 'Search and analyze logs from Loki'))),
    h('div', { class: 'query-bar' }, h('div', { class: 'query-input' }, input), h('button', { class: 'btn btn-primary', onclick: run }, 'Search')),
    h('div', { class: 'toolbar' }, chipsEl, h('div', { class: 'grow' }), filtersEl),
    out,
    h('div', { class: 'muted', style: { marginTop: '10px', fontSize: '12px' } },
      'Query syntax (LogQL): ', h('code', {}, '{app="name"}'), ' selects a stream, ', h('code', {}, '|= "text"'), ' must contain, ',
      h('code', {}, '!= "text"'), ' must not contain, ', h('code', {}, '|~ "regex"'), ' regex match.'));

  async function run() {
    const query = input.value.trim();
    if (query !== ctx.pref('logsQuery')) ctx.savePref('logsQuery', query);
    history.replaceState({}, '', `/logs?q=${encodeURIComponent(query)}`);
    page = 0;
    clear(out).append(h('div', { class: 'table-wrap' }, stateView('loading', { skeleton: 'table' })));
    try {
      data = await api('/logs', { query: { query, ...ctx.range, limit: 500 } });
      ctx.setDsChip('Loki', color('ok'));
      draw();
    } catch (e) {
      data = null;
      clear(chipsEl); clear(filtersEl);
      // red chip only when we know Loki did not answer; otherwise hide it
      if (e.state === 'unavailable' || e.status === 502) ctx.setDsChip('Loki unavailable', color('crit')); else ctx.setDsChip(null);
      clear(out).append(h('div', { class: 'table-wrap' }, stateFromError(e, 'Logs')));
    }
  }

  function draw() {
    if (!data) return;
    const total = data.entries.length;
    clear(chipsEl).append(
      h('button', { class: `chip ${level === 'ALL' ? 'active' : ''}`, onclick: () => { level = 'ALL'; page = 0; draw(); } }, 'All', h('b', {}, total)),
      ...LEVELS.map(([lv, cls]) => h('button', { class: `chip ${cls} ${level === lv ? 'active' : ''}`, onclick: () => { level = lv; page = 0; draw(); } }, lv, h('b', {}, data.counts[lv] || 0))));
    const services = [...new Set(data.entries.map((e) => e.service).filter(Boolean))].sort();
    const namespaces = [...new Set(data.entries.map((e) => e.namespace).filter(Boolean))].sort();
    clear(filtersEl).append(
      select([['', 'Service: all'], ...services], service, (v) => { service = v; page = 0; draw(); }, { class: 'select select-sm', 'aria-label': 'Filter by service' }),
      select([['', 'Namespace: all'], ...namespaces], namespace, (v) => { namespace = v; page = 0; draw(); }, { class: 'select select-sm', 'aria-label': 'Filter by namespace' }));
    const rows = data.entries.filter((e) => (level === 'ALL' || e.level === level) && (!service || e.service === service) && (!namespace || e.namespace === namespace));
    clear(out);
    if (!rows.length) {
      out.append(h('div', { class: 'table-wrap' }, total
        ? stateView('empty', { title: 'No log lines match these filters', text: 'Clear the level, service or namespace filter.' })
        : stateView('empty', { title: 'No logs available', text: 'Loki answered, but has no lines for this query and time range. Try a wider time range or a different query.' })));
      return;
    }
    // Loki returns at most data.limit lines (newest first). Say so when we hit it: the list is not complete.
    if (data.truncated) {
      out.append(stateBanner('partial', `Showing the newest ${data.limit} lines only. Loki has more for this query and time range: narrow the query or the time range to see older lines.`));
    }
    const pg = paginate(rows, { page, pageSize: 100, noun: rows.length === 1 ? 'line' : 'lines', onPage: (p) => { page = p; draw(); },
      note: rows.length < total ? `(filtered from ${total}${data.truncated ? ' loaded' : ''})` : data.truncated ? '(limit reached)' : null });
    page = pg.page;
    out.append(h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Log lines', style: { maxHeight: 'calc(100vh - 290px)' } }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, timeHeader()), h('th', {}, 'Level'), h('th', {}, 'Service'), h('th', {}, 'Host / pod'), h('th', {}, 'Message'))),
      h('tbody', {}, pg.rows.map((e) => h('tr', { class: 'clickable', tabindex: 0, onclick: () => detail(e), onkeydown: (ev) => ev.key === 'Enter' && detail(e) },
        h('td', { class: 'mono', style: { whiteSpace: 'nowrap' } }, timeEl(e.ts)),
        h('td', {}, h('span', { class: `pill ${LEVEL_PILL[e.level] || 'pill-muted'}` }, e.level)),
        h('td', {}, e.service),
        h('td', { class: 'mono dim', style: { fontSize: '12px' } }, e.pod),
        h('td', { class: 'msg', title: e.message }, e.message))))), pg.foot));
  }

  function detail(e) {
    modal('Log line', h('div', {},
      h('dl', { class: 'kv' },
        h('dt', {}, 'Time'), h('dd', { title: timeTitle(e.ts) }, dateTimeZ(e.ts)),
        h('dt', {}, 'Level'), h('dd', {}, e.level),
        h('dt', {}, 'Service'), h('dd', {}, e.service || '-'),
        h('dt', {}, 'Namespace'), h('dd', {}, e.namespace || '-'),
        h('dt', {}, 'Pod / host'), h('dd', {}, e.pod || '-')),
      h('pre', { class: 'code', style: { marginTop: '12px' } }, e.message),
      e.labels ? h('pre', { class: 'code' }, JSON.stringify(e.labels, null, 2)) : null,
      h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        copyBtn('Copy message', e.message),
        e.labels ? copyBtn('Copy labels', JSON.stringify(e.labels, null, 2)) : null,
        copyBtn('Copy as JSON', JSON.stringify({ time: new Date(e.ts).toISOString(), level: e.level, service: e.service || undefined, message: e.message, labels: e.labels }, null, 2)),
        e.service && ctx.canOpen('/traces') ? h('button', { class: 'btn btn-sm', onclick: () => { document.querySelector('.modal-overlay')?.remove(); ctx.navigate(`/traces?q=${encodeURIComponent(`service.name=${e.service}`)}`); } }, icon('traces', 13), 'Traces for this service') : null)), [], { wide: true });
  }

  // copies the full text (never the shortened table cell)
  function copyBtn(label, text) {
    return h('button', { class: 'btn btn-sm', onclick: async () => {
      try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed: the browser blocked clipboard access', 'err'); }
    } }, icon('list', 13), label);
  }

  run();
  return { refresh: run };
}
