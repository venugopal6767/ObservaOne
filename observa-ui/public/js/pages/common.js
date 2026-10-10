// Helpers shared by several pages.
import { h, api, icon, fmt, timeChart, barChart, legendName, emptyState, errorBox, clear, spinner } from '../ui.js';

// Keeps one chart per key and destroys the old one on redraw.
export function chartSlots(ctx) {
  const slots = new Map();
  return (key, chart) => {
    if (slots.has(key)) ctx.untrack(slots.get(key));
    if (chart) slots.set(key, ctx.track(chart));
    else slots.delete(key);
    return chart;
  };
}

export function statCard(label, value, { unit, trend, trendGoodWhen = 'down', extra, tone, iconName } = {}) {
  let trendEl = null;
  if (trend !== null && trend !== undefined && Number.isFinite(trend)) {
    const up = trend >= 0;
    const good = trendGoodWhen === 'up' ? up : !up;
    const cls = Math.abs(trend) < 0.5 ? 'flat' : good ? 'up' : 'bad';
    trendEl = h('span', { class: `trend ${cls}` }, `${up ? '↑' : '↓'} ${Math.abs(trend).toFixed(1)}%`);
  }
  return h('div', { class: 'stat-card' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'row' },
      h('span', { class: `value ${tone || ''}` }, value, unit ? h('small', {}, unit) : null),
      trendEl,
      iconName ? h('span', { class: 'corner' }, icon(iconName, 20)) : null),
    extra || null);
}

// A service with no requests is idle, not down. The server still marks 0 requests/s as "down",
// so the UI shows it as "No traffic" and keeps it out of the Down/Unhealthy counts.
// It cannot tell an idle service from a stopped one; the label's tooltip says so.
export const IDLE_HINT = 'No requests in the last few minutes. ObservaOne cannot tell an idle service from a stopped one.';
export const isIdle = (x) => !!x && x.status === 'down' && !x.rps && !x.errorRate;
export const idleStatus = (x) => (isIdle(x) ? { ...x, status: 'idle' } : x);
export function withIdle(data) {
  if (!data?.list || !data.summary) return data;
  const list = data.list.map(idleStatus);
  const idle = list.filter((x) => x.status === 'idle').length;
  return { ...data, list, summary: { ...data.summary, down: data.summary.down - idle, idle } };
}

export function pctChange(now, before) {
  if (now === null || before === null || before === undefined || !Number.isFinite(before) || before === 0) return null;
  return ((now - before) / Math.abs(before)) * 100;
}

// Renders one dashboard-style panel from a PromQL query.
export async function renderPromPanel(box, panel, ctx, setChart, key, vars = {}) {
  let query = panel.query;
  for (const [k, v] of Object.entries(vars)) query = query.replaceAll(`$${k}`, v);
  // first draw shows a placeholder; a refresh keeps the current chart until new data arrives
  const had = box.dataset.ok === '1';
  if (!had) clear(box).append(h('div', { class: 'chart-box skeleton' }));
  try {
    await (async () => {
    if (panel.type === 'stat' || panel.type === 'gauge' || panel.type === 'table' || panel.type === 'bar') {
      const d = await api('/prom/query', { query: { query } });
      const res = d.result || [];
      clear(box);
      if (!res.length) return box.append(emptyState('No data', 'The query returned nothing for this time.'));
      if (panel.type === 'stat' || panel.type === 'gauge') {
        const v = Number(res[0].value[1]);
        let tone = '';
        if (panel.title.toLowerCase() === 'status' || /^up\{/.test(query)) {
          box.append(h('div', { class: 'big-stat' }, h('span', { class: `value ${v >= 1 ? 'green' : 'red'}` }, v >= 1 ? 'UP' : 'DOWN')));
          return;
        }
        if (panel.unit === 'percent') tone = v >= 90 ? 'red' : v >= 80 ? 'orange' : '';
        if (/down/i.test(panel.title)) tone = v > 0 ? 'red' : 'green';
        box.append(h('div', { class: 'big-stat' }, h('span', { class: `value ${tone}` }, fmt(v, panel.unit))));
        return;
      }
      if (panel.type === 'bar') {
        const rows = res.map((r) => [legendName(r.metric, panel.legend), Number(r.value[1])]).sort((a, b) => a[0].localeCompare(b[0]));
        const c = h('canvas');
        box.append(h('div', { class: 'chart-box' }, c));
        const colors = rows.map(([, v]) => (panel.unit === 'percent' && /free/i.test(panel.title) ? (v < 10 ? '#ef4444' : v < 20 ? '#f59e0b' : '#22c55e') : '#2f6bff'));
        setChart(key, barChart(c, rows.map((r) => r[0]), rows.map((r) => r[1]), { unit: panel.unit, colors, max: panel.unit === 'percent' ? 100 : undefined }));
        return;
      }
      // table
      const labelKeys = [...new Set(res.flatMap((r) => Object.keys(r.metric)))].filter((k) => k !== '__name__');
      box.append(h('div', { class: 'table-wrap', style: { maxHeight: '260px' } }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, labelKeys.map((k) => h('th', {}, k)), h('th', { class: 'num' }, 'Value'))),
        h('tbody', {}, res.map((r) => h('tr', {}, labelKeys.map((k) => h('td', {}, r.metric[k] || '')),
          h('td', { class: 'num' }, /^up\{/.test(query) ? h('span', { class: `pill ${Number(r.value[1]) ? 'pill-green' : 'pill-red'}` }, Number(r.value[1]) ? 'UP' : 'DOWN') : fmt(Number(r.value[1]), panel.unit))))))));
      return;
    }
    // line / area
    const { start, end } = ctx.range;
    const d = await api('/prom/query_range', { query: { query, start, end } });
    clear(box);
    const res = d.result || [];
    if (!res.length) return box.append(emptyState('No data', 'The query returned nothing for this time range.'));
    const c = h('canvas');
    box.append(h('div', { class: 'chart-box' }, c));
    setChart(key, timeChart(c, res.slice(0, 12).map((r) => ({ label: legendName(r.metric, panel.legend), points: r.values })), {
      unit: panel.unit, area: panel.type === 'area', legend: res.length > 1, max: panel.unit === 'percent' ? 100 : undefined,
    }));
    })();
    box.dataset.ok = '1';
    box.querySelector('.panel-stale')?.remove();
    return true;
  } catch (e) {
    if (had) {
      // keep the last good chart and say it is old
      box.querySelector('.panel-stale')?.remove();
      box.prepend(h('div', { class: 'panel-stale', role: 'status' }, icon('clock', 12), `Couldn't refresh: ${e.message}. Showing the last data.`));
    } else clear(box).append(errorBox(e.message));
    return false;
  }
}
