// Insights: forecasts (when will it be full?) and anomalies (is this unusual for this time?).
import { h, api, clear, icon, emptyState, select, tabs, fmt, dateTime, hexA } from '../ui.js';
import { errorState, staleNotice } from '../personas/widgets.js';
import { chartSlots } from './common.js';

const days = (d) => (d === null || d === undefined ? '—' : d < 1 ? `${Math.max(0, Math.round(d * 24))} h` : `${d.toFixed(d < 10 ? 1 : 0)} days`);
const tone = (d) => (d === null || d === undefined ? '' : d <= 1 ? 'c-red' : d <= 7 ? 'c-orange' : d <= 30 ? 'c-yellow' : 'c-green');

function chartColors() {
  const light = document.documentElement.dataset.theme === 'light';
  return { grid: light ? 'rgba(15,23,42,0.08)' : 'rgba(148,163,184,0.08)', tick: light ? '#64748b' : '#7d8aa6' };
}

function lineChart(canvas, datasets, unit, extra = {}) {
  const c = chartColors();
  return new window.Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'nearest', intersect: false },
      plugins: { legend: { display: true, position: 'bottom', labels: { color: c.tick, boxWidth: 10, font: { size: 11 }, filter: (i) => !i.text.startsWith('_') } },
        tooltip: { callbacks: { title: (it) => dateTime(it[0].parsed.x), label: (x) => ` ${x.dataset.label.replace(/^_/, '')}: ${fmt(x.parsed.y, unit)}` } } },
      scales: {
        x: { type: 'linear', grid: { color: c.grid }, ticks: { color: c.tick, maxTicksLimit: 7, font: { size: 10 }, callback: (v) => dateTime(v).slice(5, 16) } },
        y: { grid: { color: c.grid }, ticks: { color: c.tick, font: { size: 10 }, callback: (v) => fmt(v, unit, 0) }, ...extra },
      },
    },
  });
}

export function insightsPage(main, ctx) {
  const setChart = chartSlots(ctx);
  const P = ctx.params;
  let tab = P.get('tab') === 'anomalies' ? 'anomalies' : 'forecasts', sensitivity = ['low', 'high'].includes(P.get('sensitivity')) ? P.get('sensitivity') : 'medium', open = null, shownKey = null, okAt = 0;
  const tabsEl = h('div', { class: 'tabs-line' });
  const stale = h('div');
  const body = h('div');
  // statistics, not a machine-learning model: the page says so
  main.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Insights'),
      h('p', {}, 'Forecasts when disks and memory fill up, and spots what is unusual for this time of day. Plain statistics on your Prometheus history.'))),
    tabsEl, stale, body);

  function syncUrl() { history.replaceState({}, '', ctx.link('/insights', { tab: tab === 'forecasts' ? '' : tab, sensitivity: tab === 'anomalies' && sensitivity !== 'medium' ? sensitivity : '' })); }
  function drawTabs() {
    clear(tabsEl).append(tabs([['forecasts', 'Forecasts'], ['anomalies', 'Anomalies']], tab, (k) => { tab = k; open = null; syncUrl(); drawTabs(); load().catch(() => {}); }));
  }

  async function load() {
    const key = `${tab}|${sensitivity}`;
    const isNew = key !== shownKey;
    if (isNew) clear(body).append(h('div', { class: 'grid cards-4' }, ...Array.from({ length: 4 }, () => h('div', { class: 'kpi skeleton', style: { height: '96px' } }))), h('div', { class: 'table-wrap skeleton', style: { height: '320px', marginTop: '14px' } }));
    try {
      const d = tab === 'forecasts' ? await api('/insights/forecasts') : await api('/insights/anomalies', { query: { sensitivity } });
      if (`${tab}|${sensitivity}` !== key) return; // the user switched tabs meanwhile
      shownKey = key; okAt = Date.now(); clear(stale);
      if (tab === 'forecasts') drawForecasts(d); else drawAnomalies(d);
    } catch (e) {
      if (!isNew) clear(stale).append(staleNotice({ okAt, message: e.message, retry: () => ctx.refreshNow() }));
      else { shownKey = null; clear(body).append(errorState(e.message, () => ctx.refreshNow(), tab === 'forecasts' ? 'Forecasts could not load' : 'Anomalies could not load')); }
      throw e;
    }
  }

  // ---------------- forecasts ----------------
  function drawForecasts(d) {
    const s = d.summary;
    const card = (label, n, cls, sub) => h('div', { class: `kpi kpi-small` }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-title' }, label)), h('div', { class: 'kpi-val' }, h('b', { class: n ? cls : 'c-green' }, String(n))), h('div', { class: 'kpi-foot' }, h('span', { class: 'dim' }, sub)));
    clear(body).append(
      h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
        card('Full within 24 hours', s.within1d, 'c-red', 'act now'),
        card('Full within 7 days', s.within7d, 'c-orange', 'plan this week'),
        card('Full within 30 days', s.within30d, 'c-yellow', 'plan this month'),
        card('Resources watched', s.watched, '', 'disks and memory')),
      h('p', { class: 'muted' }, 'Trend = straight line fitted to recent history, ignoring spikes and clean-ups. "Range" is the earliest and latest it could happen given the noise.'));
    if (!d.items.length) { body.append(h('div', { class: 'table-wrap' }, emptyState('Not enough history yet', 'Forecasts need a few hours of metrics from your servers.'))); return; }
    const rows = [];
    for (const x of d.items) {
      const key = `${x.host}|${x.resource}`;
      const statusText = x.status === 'crossed' ? 'Full now' : x.status === 'stable' ? 'Stable' : x.status === 'far' ? `> ${d.horizonDays} days` : days(x.daysLeft);
      const toggle = () => { open = open === key ? null : key; drawForecasts(d); };
      rows.push(h('tr', { class: `clickable ${open === key ? 'sel' : ''}`, tabindex: 0, 'aria-expanded': String(open === key), title: 'Show the trend chart', onclick: toggle, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } },
        h('td', {}, h('b', { style: { fontWeight: 600 } }, x.host || '—')),
        h('td', {}, icon(x.kind === 'disk' ? 'disk' : 'memory', 14, 'dim'), ' ', x.resource),
        h('td', { class: 'num' }, fmt(x.current, 'percent')),
        h('td', { class: `num col-phone-hide ${x.slopePerDay > 0 ? '' : 'dim'}` }, `${x.slopePerDay >= 0 ? '+' : ''}${x.slopePerDay.toFixed(2)} %/day`),
        h('td', { class: `num ${tone(x.status === 'will-cross' || x.status === 'crossed' ? x.daysLeft : null)}` }, h('b', {}, statusText)),
        h('td', { class: 'dim col-phone-hide' }, x.status === 'will-cross' ? `${dateTime(x.eta * 1000).slice(0, 16)}${x.range ? ` (${days(x.range[0])} – ${days(x.range[1])})` : ''}` : '—'),
        h('td', { class: 'col-phone-hide' }, h('span', { class: `pill ${x.confidence === 'high' ? 'st-ok' : x.confidence === 'medium' ? 'st-slow' : 'st-res'}` }, x.confidence))));
      if (open === key) {
        const c = h('canvas');
        rows.push(h('tr', { class: 'expand' }, h('td', { colspan: 7 }, h('div', { class: 'chart-box', style: { height: '230px' } }, c),
          h('div', { class: 'dim', style: { fontSize: '12px' } }, `Fitted on ${x.spanHours.toFixed(1)} hours of data${x.resetAt ? `, after a clean-up at ${dateTime(x.resetAt * 1000)}` : ''}. Threshold ${x.threshold}%.`))));
        setTimeout(() => {
          const ds = [{ label: 'History', data: x.history.map(([t, v]) => ({ x: t * 1000, y: v })), borderColor: '#3b82f6', backgroundColor: hexA('#3b82f6', 0.15), fill: true, pointRadius: 0, borderWidth: 1.6, tension: 0.2 }];
          if (x.projection) ds.push({ label: 'Forecast', data: x.projection.map(([t, v]) => ({ x: t * 1000, y: v })), borderColor: '#f59e0b', borderDash: [6, 4], pointRadius: 0, borderWidth: 2 });
          const xs = ds.flatMap((q) => q.data.map((p) => p.x));
          ds.push({ label: `Threshold ${x.threshold}%`, data: [{ x: Math.min(...xs), y: x.threshold }, { x: Math.max(...xs), y: x.threshold }], borderColor: '#ef4444', borderDash: [2, 3], pointRadius: 0, borderWidth: 1.2 });
          setChart('fc', lineChart(c, ds, 'percent', { min: 0, max: 100 }));
        });
      }
    }
    body.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Host', 'Resource', 'Used now', 'Trend', 'Full in', 'When (range)', 'Confidence'].map((x, i) => h('th', { class: `${i >= 2 && i <= 4 ? 'num' : ''} ${[3, 5, 6].includes(i) ? 'col-phone-hide' : ''}` }, x)))),
      h('tbody', {}, rows))));
  }

  // ---------------- anomalies ----------------
  function drawAnomalies(d) {
    const s = d.summary;
    const seasonText = { weekly: 'same time on previous weeks', daily: 'same time on previous days', recent: 'the last 2 hours (not enough history for daily patterns yet)' };
    clear(body).append(
      h('div', { class: 'toolbar' },
        h('span', { class: 'muted' }, `${s.anomalies} unusual of ${s.watched} series watched. "Normal" = ${s.seasons.map((x) => seasonText[x]).join(' / ') || '—'}.`),
        h('div', { class: 'grow' }),
        h('span', { class: 'dim', 'aria-hidden': 'true' }, 'Sensitivity'),
        select([['low', 'Low (fewer)'], ['medium', 'Medium'], ['high', 'High (more)']], sensitivity, (v) => { sensitivity = v; syncUrl(); load().catch(() => {}); }, { class: 'select select-sm', 'aria-label': 'Sensitivity' })));
    if (!d.items.length) { body.append(h('div', { class: 'table-wrap' }, emptyState('Not enough history yet', 'Anomaly detection needs at least a couple of hours of metrics.'))); return; }
    const anomalies = d.items.filter((x) => x.status === 'anomaly');
    const grid = h('div', { class: 'grid cols-2' });
    body.append(anomalies.length ? grid : h('div', { class: 'ok-box' }, icon('check', 15), h('span', {}, 'Nothing unusual right now. Every series is inside its normal band.')));
    anomalies.forEach((x, i) => {
      const c = h('canvas');
      grid.append(h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', {}, `${x.label} · ${x.host}`),
          h('div', { class: 'right' }, h('span', { class: `pill ${x.direction === 'above' ? 'st-err' : 'st-slow'}` }, `${x.direction} normal`))),
        h('div', { class: 'inc-chart-meta' }, h('span', {}, 'Now ', h('b', {}, fmt(x.current, x.unit))), h('span', { class: 'dim' }, `normal ${fmt(x.lower, x.unit)} – ${fmt(x.upper, x.unit)}`),
          x.since ? h('span', { class: 'dim' }, `since ${dateTime(x.since * 1000).slice(11, 16)}`) : null),
        h('div', { class: 'chart-box', style: { height: '200px' } }, c)));
      setTimeout(() => {
        const pts = (k) => x.series.map((r) => ({ x: r[0] * 1000, y: r[k] }));
        setChart(`an-${i}`, lineChart(c, [
          { label: '_low', data: pts(3), borderColor: 'transparent', pointRadius: 0, fill: false },
          { label: 'Normal band', data: pts(4), borderColor: 'transparent', backgroundColor: 'rgba(34,197,94,0.14)', pointRadius: 0, fill: '-1' },
          { label: 'Expected', data: pts(2), borderColor: '#22c55e', borderDash: [5, 4], pointRadius: 0, borderWidth: 1.3 },
          { label: 'Actual', data: pts(1), borderColor: x.direction === 'above' ? '#ef4444' : '#f59e0b', pointRadius: 0, borderWidth: 2 },
        ], x.unit));
      });
    });
    body.append(h('h3', { style: { margin: '18px 0 8px' } }, 'All watched series'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Host', 'Metric', 'Now', 'Expected', 'Normal range', 'Score', 'Status'].map((k, i) => h('th', { class: `${i >= 2 && i <= 5 ? 'num' : ''} ${[3, 4, 5].includes(i) ? 'col-phone-hide' : ''}` }, k)))),
        h('tbody', {}, d.items.map((x) => h('tr', {},
          h('td', {}, x.host), h('td', {}, x.label),
          h('td', { class: 'num' }, fmt(x.current, x.unit)), h('td', { class: 'num dim col-phone-hide' }, fmt(x.expected, x.unit)),
          h('td', { class: 'num dim col-phone-hide' }, `${fmt(x.lower, x.unit)} – ${fmt(x.upper, x.unit)}`),
          h('td', { class: `num col-phone-hide ${Math.abs(x.score) >= 3 ? 'c-orange' : 'dim'}` }, x.score.toFixed(1)),
          h('td', {}, h('span', { class: `pill ${x.status === 'anomaly' ? 'st-err' : 'st-ok'}` }, x.status === 'anomaly' ? 'Unusual' : 'Normal'))))))));
  }

  drawTabs();
  syncUrl();
  const ready = load();
  ready.catch(() => {});
  return { refresh: load, ready };
}
