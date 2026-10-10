// DevOps Engineer: is delivery healthy (deployments, pipelines) and is the platform healthy (clusters, alerts)?
// Mock data for now. Every card, row and chart bar opens a page behind it, keeping env / time range / filters.
import { h, clear, icon, fmt, dateTime, emptyState } from '../ui.js';
import { chartSlots } from '../pages/common.js';
import { devopsData, mockFetch, SERVICES, TEAMS, clustersFor, rng, series } from './mock.js';
import { personaById } from './registry.js';
import {
  personaHead, filterBar, kpiCard, delta, panel, chartBox, lineDrill, stackedBars, table, quickActions,
  loadingSkeleton, errorState, statusPill, dur, since, meter, legendRow,
  attentionStrip, stampFresh, detailHead,
  notConnected, NEEDS,
} from './widgets.js';

const persona = { ...personaById('devops'), title: 'DevOps Engineer' };
const FILTER_KEYS = ['cluster', 'team', 'service'];

function readFilters(ctx) {
  return Object.fromEntries(FILTER_KEYS.map((k) => [k, ctx.params.get(k) || '']));
}
function filterDefs(ctx) {
  return [
    { key: 'cluster', label: 'All clusters', options: clustersFor(ctx.env).map((c) => [c.name, c.name]) },
    { key: 'team', label: 'All teams', options: TEAMS.map((t) => [t, t]) },
    { key: 'service', label: 'All services', options: SERVICES.map((s) => [s.name, s.name]) },
  ];
}
function load(ctx, f) {
  const { start, end } = ctx.range;
  return mockFetch((empty) => devopsData({ env: ctx.env, rangeSeconds: ctx.rangeSeconds, start, end, ...f, empty }));
}
const svcLink = (ctx, name) => h('a', { href: ctx.link(`/services/${encodeURIComponent(name)}`), 'data-link': true, onclick: (e) => e.stopPropagation() }, name);
const backLink = (ctx, f, label = 'DevOps dashboard') => h('a', { class: 'btn btn-sm', href: ctx.link('/views/devops', f), 'data-link': true }, icon('arrowLeft', 13), label);

// ======================= dashboard =======================
export function devopsDashboard(main, ctx) {
  const setChart = chartSlots(ctx);
  const f = readFilters(ctx);
  const body = h('div');
  const filters = h('div');
  main.append(personaHead(ctx, persona, {
    actions: [h('a', { class: 'btn btn-sm', href: ctx.link('/views/devops/deployments', f), 'data-link': true }, icon('list', 13), 'All deployments')],
  }), filters, body);

  function drawFilters() { clear(filters).append(filterBar(ctx, filterDefs(ctx), f, refresh)); }

  async function refresh(silent = false) {
    drawFilters();
    if (!silent) clear(body).append(loadingSkeleton(6));
    let d;
    try { d = await load(ctx, f); } catch (e) { clear(body).append(errorState(e.message, () => refresh())); return; }
    draw(d);
    stampFresh();
  }

  function draw(d) {
    clear(body);
    if (!d.deployments.length && !d.clusters.length) {
      body.append(h('div', { class: 'state-box' }, emptyState('No data for these filters', 'Nothing was deployed and no clusters match. Clear the filters or pick another environment.',
        h('a', { class: 'btn btn-primary', href: ctx.link('/views/devops'), 'data-link': true }, 'Clear filters'))));
      return;
    }
    const k = d.kpi;
    const dl = (path, extra = {}) => ctx.link(path, { ...f, ...extra });
    const day = Date.now() - 86400_000;
    const badDeploys = d.deployments.filter((x) => (x.status === 'failed' || x.status === 'rolled_back') && x.at > day);
    const crit = d.alerts.filter((a) => a.severity === 'critical');
    const sick = d.clusters.filter((c) => c.status !== 'healthy');
    const failedRuns = d.pipelines.filter((p) => p.status === 'failed' && p.branch === 'main');
    body.append(attentionStrip([
      crit.length && { level: 'critical', text: `${crit.length} critical alert${crit.length > 1 ? 's' : ''} firing`, detail: `${crit[0].name} on ${crit[0].service}`, action: { label: 'Open incidents', href: ctx.link('/incidents') } },
      badDeploys.length && { level: 'critical', text: `${badDeploys.length} deployment${badDeploys.length > 1 ? 's' : ''} failed in 24 h`, detail: `latest: ${badDeploys[0].service} ${badDeploys[0].version}`, action: { label: 'Review', href: dl(`/views/devops/deployments/${badDeploys[0].id}`) } },
      sick.length && { level: 'warning', text: `${sick[0].name} is ${sick[0].notReady ? `missing ${sick[0].notReady} node${sick[0].notReady > 1 ? 's' : ''}` : 'running hot'}`, detail: `CPU ${sick[0].cpu.toFixed(0)}%`, action: { label: 'Open cluster', href: dl(`/views/devops/clusters/${sick[0].name}`) } },
      failedRuns.length && { level: 'warning', text: `Main branch build broken for ${failedRuns[0].service}`, detail: failedRuns[0].stages.find((s) => s.status === 'failed')?.name, action: { label: 'Open run', href: dl(`/views/devops/pipelines/${failedRuns[0].id}`) } },
    ]));
    const succRate = 100 - k.changeFailure;
    body.append(h('div', { class: 'ov-kpis persona-kpis-6' },
      kpiCard(setChart, { key: 'dep', ic: 'upload', tone: 'blue', title: 'Deployments', value: String(k.deploys), delta: delta(k.deploys, k.deploysBefore), href: dl('/views/devops/deployments'),
        spark: d.perDay.map((x, i) => [i, x.succeeded + x.failed]), bars: true, sparkColor: '#3b82f6', foot: [h('span', { class: 'c-green' }, `${succRate.toFixed(0)}% succeeded`)] }),
      kpiCard(setChart, { key: 'cfr', ic: 'alert', tone: k.changeFailure > 15 ? 'red' : 'orange', title: 'Change failure rate', value: k.changeFailure.toFixed(1), unit: '%', href: dl('/views/devops/deployments', { status: 'failed' }),
        foot: [h('span', { class: 'dim' }, 'failed + rolled back')] }),
      kpiCard(setChart, { key: 'lead', ic: 'timer', tone: 'purple', title: 'Lead time for changes', value: k.leadTimeH.toFixed(1), unit: 'h', href: dl('/views/devops/deployments'),
        foot: [h('span', { class: 'dim' }, 'commit to production (median)')] }),
      kpiCard(setChart, { key: 'mttr', ic: 'clock', tone: 'green', title: 'Time to restore', value: String(Math.round(k.mttrMin)), unit: 'min', href: ctx.link('/incidents'),
        foot: [h('span', { class: 'dim' }, 'median, last 30 days')] }),
      kpiCard(setChart, { key: 'pipe', ic: 'play', tone: k.pipelineSuccess < 85 ? 'orange' : 'green', title: 'Pipeline success', value: k.pipelineSuccess.toFixed(0), unit: '%', href: '#pipelines',
        foot: [h('span', { class: 'dim' }, `${d.pipelines.length} runs`), h('span', { class: 'c-red' }, `${d.pipelines.filter((p) => p.status === 'failed').length} failed`)] }),
      kpiCard(setChart, { key: 'alerts', ic: 'bell', tone: k.critical ? 'red' : 'orange', title: 'Active alerts', value: String(k.activeAlerts), href: ctx.link('/incidents'),
        foot: [h('span', { class: 'c-red' }, `${k.critical} critical`), h('span', { class: 'c-orange' }, `${k.activeAlerts - k.critical} warning`)] })));

    // ---- row: deployment frequency (click a day) + cluster utilisation ----
    const freq = chartBox(240), util = chartBox(240);
    const dayLabels = d.perDay.map((x) => new Date(x.day).toLocaleDateString(undefined, { day: '2-digit', month: 'short' }));
    body.append(h('div', { class: 'ov-row persona-row-2' },
      panel('Deployment frequency (14 days)', 'upload', h('div', {}, freq.el, h('div', { class: 'dim chart-hint' }, 'Click a bar to see that day\'s deployments')), { link: dl('/views/devops/deployments') }),
      panel('Cluster CPU utilisation', 'cpu', h('div', {}, util.el, h('div', { class: 'dim chart-hint' }, 'Click a line to open the cluster')), { link: ctx.link('/infrastructure') })));
    setChart('freq', stackedBars(freq.canvas, dayLabels, [
      { label: 'Succeeded', data: d.perDay.map((x) => x.succeeded), color: '#22c55e' },
      { label: 'Failed', data: d.perDay.map((x) => x.failed), color: '#ef4444' },
    ], { onPick: (i, ds) => ctx.navigate(dl('/views/devops/deployments', { day: String(d.perDay[i].day), status: ds === 1 ? 'failed' : '' })) }));
    setChart('util', lineDrill(util.canvas, d.clusters.map((c) => ({ label: c.name, points: c.cpuSeries })), {
      unit: 'percent', max: 100, onPick: (pt, ds) => ctx.navigate(dl(`/views/devops/clusters/${d.clusters[ds].name}`)),
    }));

    // ---- row: recent deployments + clusters ----
    body.append(h('div', { class: 'ov-row persona-row-2b' },
      panel('Recent deployments', 'upload', table([
        { label: 'Service', value: (x) => h('b', {}, x.service) },
        { label: 'Version', value: (x) => h('code', {}, x.version) },
        { minor: true, label: 'Env', value: (x) => h('span', { class: 'dim' }, x.env) },
        { label: 'Status', value: (x) => statusPill(x.status) },
        { label: 'Duration', value: (x) => dur(x.durationSec), num: true },
        { label: 'When', value: (x) => h('span', { class: 'dim' }, since(x.at)) },
      ], d.deployments, { max: 7, onRow: (x) => ctx.navigate(dl(`/views/devops/deployments/${x.id}`)), empty: ['No deployments', 'Nothing was deployed in this period.'] }), { link: dl('/views/devops/deployments') }),
      panel('Clusters', 'infrastructure', table([
        { label: 'Cluster', value: (c) => h('div', {}, h('b', {}, c.name), h('div', { class: 'dim', style: { fontSize: '11px' } }, `${c.region} · ${c.nodes} nodes`)) },
        { label: 'CPU', value: (c) => meter(c.cpu) },
        { minor: true, label: 'Memory', value: (c) => meter(c.mem) },
        { label: 'Status', value: (c) => statusPill(c.status) },
      ], d.clusters, { onRow: (c) => ctx.navigate(dl(`/views/devops/clusters/${c.name}`)), empty: ['No clusters', 'No cluster matches these filters.'] }), { link: ctx.link('/infrastructure'), linkLabel: 'Infrastructure' })));

    // ---- row: pipelines + alerts + quick actions ----
    const pipeEl = panel('CI/CD pipelines', 'play', table([
      { label: 'Run', value: (p) => h('div', {}, h('b', {}, p.service), h('div', { class: 'dim', style: { fontSize: '11px' } }, `${p.branch} · ${dur(p.durationSec)}`)) },
      { label: 'Stages', value: (p) => h('div', { class: 'stage-dots', title: `${p.status}: ${p.stages.map((s) => `${s.name} ${s.status}`).join(', ')}` }, p.stages.map((s) => h('i', { class: `sd sd-${s.status}` }))), sort: (p) => p.status },
      { label: 'Status', value: (p) => (p.status === 'passed' ? h('span', { class: 'dim' }, 'Passed') : statusPill(p.status)), sort: (p) => p.status },
    ], d.pipelines, { max: 6, onRow: (p) => ctx.navigate(dl(`/views/devops/pipelines/${p.id}`)), empty: ['No pipeline runs', ''] }));
    pipeEl.id = 'pipelines';
    const dur1 = chartBox(170);
    body.append(h('div', { class: 'ov-row ov-row-c' },
      pipeEl,
      panel('Active alerts', 'bell', table([
        { label: 'Severity', value: (a) => statusPill(a.severity) },
        { label: 'Alert', value: (a) => h('span', {}, h('b', {}, a.name), h('div', { class: 'dim', style: { fontSize: '11px' } }, `${a.service} · ${a.cluster}`)) },
        { label: 'Since', value: (a) => h('span', { class: 'dim' }, since(a.since)) },
      ], d.alerts, { max: 6, onRow: (a) => ctx.navigate(ctx.link('/incidents', { q: a.service })), empty: ['No active alerts', 'All quiet.'] }), { link: ctx.link('/incidents') }),
      panel('Quick actions', 'activity', h('div', {},
        quickActions([
          { ic: 'refresh', label: 'Roll back a deployment', sub: 'Pick from recent deployments', href: dl('/views/devops/deployments', { status: 'succeeded' }) },
          { ic: 'bellOff', label: 'Silence an alert', sub: 'Maintenance window', href: ctx.link('/alerting') },
          { ic: 'logs', label: 'Search deploy logs', sub: 'Last 1 hour', href: ctx.link('/logs', { q: `{service_name=~"${f.service || '.+'}"} |= "deploy"` }) },
          { ic: 'incident', label: 'Declare incident', sub: 'Page the on-call', href: ctx.link('/incidents') },
          { ic: 'agent', label: 'Install an agent', sub: 'Linux, Windows, K8s', href: ctx.link('/agents') },
        ]),
        h('div', { class: 'dim', style: { fontSize: '12px', margin: '12px 0 4px' } }, 'Pipeline duration'), dur1.el))));
    setChart('pdur', lineDrill(dur1.canvas, d.pipelineDuration, { unit: 's', legend: true }));
  }

  refresh();
  return { refresh: () => refresh(true) };
}

// ======================= deployments list =======================
export function devopsDeployments(main, ctx) {
  const f = { ...readFilters(ctx), status: ctx.params.get('status') || '', day: ctx.params.get('day') || '' };
  const body = h('div', {}, loadingSkeleton(0));
  const filters = h('div');
  main.append(detailHead('server', 'DevOps Engineer', 'Deployments',
    f.day ? `Deployments on ${new Date(Number(f.day)).toDateString()}` : 'Every deployment in the selected environment and filters.', [backLink(ctx, readFilters(ctx))]), filters, body);

  async function refresh() {
    const defs = [...filterDefs(ctx), { key: 'status', label: 'Any status', options: [['succeeded', 'Succeeded'], ['failed', 'Failed or rolled back'], ['in_progress', 'In progress']] }];
    clear(filters).append(filterBar(ctx, defs, f, refresh));
    if (f.day) filters.firstChild.append(h('span', { class: 'chip-filter' }, `Day: ${new Date(Number(f.day)).toLocaleDateString()}`, h('button', { onclick: () => { f.day = ''; history.replaceState({}, '', ctx.link(location.pathname, f)); refresh(); }, 'aria-label': 'Remove day filter' }, icon('x', 11))));
    let d;
    try { d = await load(ctx, readFilters({ params: new URLSearchParams(f) })); } catch (e) { clear(body).append(errorState(e.message, refresh)); return; }
    let rows = d.deployments;
    if (f.status === 'failed') rows = rows.filter((x) => x.status === 'failed' || x.status === 'rolled_back');
    else if (f.status) rows = rows.filter((x) => x.status === f.status);
    if (f.day) rows = rows.filter((x) => x.at >= Number(f.day) && x.at < Number(f.day) + 86400_000);
    clear(body).append(h('div', { class: 'muted', style: { margin: '0 0 8px' } }, `${rows.length} deployment(s)`), table([
      { label: 'Service', value: (x) => h('b', {}, x.service) },
      { label: 'Team', value: (x) => x.team },
      { label: 'Version', value: (x) => h('span', {}, h('code', {}, x.version), h('span', { class: 'dim' }, ` from ${x.previous}`)) },
      { label: 'Env / cluster', value: (x) => h('span', { class: 'dim' }, `${x.env} · ${x.cluster}`) },
      { label: 'Status', value: (x) => statusPill(x.status) },
      { label: 'By', value: (x) => x.by },
      { label: 'Duration', value: (x) => dur(x.durationSec), num: true },
      { label: 'When', value: (x) => h('span', { class: 'dim', title: dateTime(x.at) }, since(x.at)) },
    ], rows, { onRow: (x) => ctx.navigate(ctx.link(`/views/devops/deployments/${x.id}`, readFilters({ params: new URLSearchParams(f) }))), empty: ['No deployments match', 'Try another status, day or clear the filters.'] }));
  }
  refresh();
  return { refresh };
}

// ======================= deployment detail =======================
export function devopsDeploymentDetail(main, ctx) {
  const setChart = chartSlots(ctx);
  const id = location.pathname.split('/').pop();
  const f = readFilters(ctx);
  const body = h('div', {}, loadingSkeleton(0));
  main.append(body);

  async function refresh() {
    let d;
    try { d = await load(ctx, f); } catch (e) { clear(body).append(errorState(e.message, refresh)); return; }
    const x = d.deployments.find((y) => y.id === id);
    if (!x) {
      clear(body).append(h('div', { class: 'state-box' }, emptyState('Deployment not found', 'It may be outside the selected time range or filters.', backLink(ctx, f))));
      return;
    }
    const r = rng(x.id);
    const t0 = Math.floor(x.at / 1000);
    const win = { start: t0 - 3600, end: t0 + 3600 };
    const bad = x.status === 'failed' || x.status === 'rolled_back';
    const err = series(r, { ...win, base: 0.6, amp: 0.2, noise: 0.1 }).map(([t, v]) => [t, t > t0 && bad ? v + 3 + r() * 2 : v]);
    const lat = series(r, { ...win, base: 180, amp: 20, noise: 10 }).map(([t, v]) => [t, t > t0 && bad ? v * 1.8 : v]);
    const steps = [
      ['Queued', 4], ['Image pulled', 22], ['Rolling update (3/3 pods)', Math.round(x.durationSec * 0.6)], ['Health checks', 30],
      [bad ? 'Error rate above 2% - rollback started' : 'Traffic shifted 100%', 15], ...(x.status === 'rolled_back' ? [[`Rolled back to ${x.previous}`, 40]] : []),
    ];
    const errC = h('canvas'), latC = h('canvas');
    clear(body).append(
      detailHead('upload', 'Deployment', [`${x.service} ${x.version} `, statusPill(x.status)], `${x.env} · ${x.cluster} · by ${x.by} · ${dateTime(x.at)}`, [
          h('a', { class: 'btn btn-sm', href: ctx.link('/views/devops/deployments', f), 'data-link': true }, icon('arrowLeft', 13), 'Deployments'),
          h('a', { class: 'btn btn-sm', href: ctx.link(`/services/${encodeURIComponent(x.service)}`), 'data-link': true }, icon('cube', 13), 'Service'),
          x.status === 'succeeded' ? notConnected('refresh', `Roll back to ${x.previous}`, NEEDS.cicd) : null,
          x.env === 'staging' && x.status === 'succeeded' ? notConnected('arrowRight', 'Promote to production', NEEDS.cicd) : null]),
      h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
        miniStat('Duration', dur(x.durationSec)), miniStat('Commit', h('code', {}, x.commit)), miniStat('Changes', `${x.changes} commits`), miniStat('Team', x.team)),
      h('div', { class: 'ov-row persona-row-2' },
        panel('Error rate around the deploy', 'pulse', h('div', { class: 'chart-box', style: { height: '220px' } }, errC)),
        panel('P95 latency around the deploy', 'timer', h('div', { class: 'chart-box', style: { height: '220px' } }, latC))),
      h('div', { class: 'ov-row persona-row-2b' },
        panel('Rollout timeline', 'clock', h('ol', { class: 'rollout' }, steps.map(([label, s], i) =>
          h('li', { class: bad && i >= 4 ? 'bad' : '' }, h('b', {}, label), h('span', { class: 'dim' }, `+${dur(steps.slice(0, i + 1).reduce((a, z) => a + z[1], 0))}`))))),
        panel('Investigate', 'search', quickActions([
          { ic: 'logs', label: 'Logs after the deploy', sub: `${x.service}, 1 hour window`, href: ctx.link('/logs', { q: `{service_name="${x.service}"}` }) },
          { ic: 'traces', label: 'Traces after the deploy', sub: 'Slowest requests', href: ctx.link('/traces', { q: `service.name=${x.service}` }) },
          { ic: 'metrics', label: 'Metrics explorer', sub: 'Request rate by version', href: ctx.link('/metrics') },
          { ic: 'incident', label: 'Related incidents', sub: x.service, href: ctx.link('/incidents', { q: x.service }) },
        ]))));
    setChart('err', lineDrill(errC, [{ label: 'Error rate %', points: err, color: '#ef4444' }], { unit: 'none' }));
    setChart('lat', lineDrill(latC, [{ label: 'P95 ms', points: lat, color: '#a855f7' }], { unit: 'ms' }));
    errC.parentElement.parentElement.append(h('div', { class: 'dim chart-hint' }, `Deploy at ${dateTime(x.at).slice(11, 16)} (middle of the chart)`));
  }
  refresh();
  return { refresh, autoRefresh: false };
}

function miniStat(label, value) {
  return h('div', { class: 'kpi kpi-small' }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-title' }, label)), h('div', { class: 'kpi-val' }, h('b', { style: { fontSize: '18px' } }, value)));
}

// ======================= pipeline run detail =======================
export function devopsPipelineDetail(main, ctx) {
  const id = location.pathname.split('/').pop();
  const f = readFilters(ctx);
  const body = h('div', {}, loadingSkeleton(0));
  main.append(body);
  async function refresh() {
    let d;
    try { d = await load(ctx, f); } catch (e) { clear(body).append(errorState(e.message, refresh)); return; }
    const p = d.pipelines.find((y) => y.id === id);
    if (!p) { clear(body).append(h('div', { class: 'state-box' }, emptyState('Pipeline run not found', 'It may be outside the selected time range or filters.', backLink(ctx, f)))); return; }
    const failed = p.stages.find((s) => s.status === 'failed');
    clear(body).append(
      detailHead('play', 'Pipeline run', [`${p.service} · ${p.id} `, statusPill(p.status)], `Branch ${p.branch} · started by ${p.by} · ${dateTime(p.at)} · ${dur(p.durationSec)}`, [backLink(ctx, f),
        notConnected('refresh', 'Re-run', NEEDS.cicd)]),
      ...(failed ? [h('div', { class: 'error-box', style: { marginBottom: '14px' } }, icon('alert', 16), h('span', {}, `Failed at "${failed.name}". Later stages were skipped.`))] : []),
      panel('Stages', 'list', h('div', { class: 'stages' }, p.stages.map((s, i) => h('div', { class: `stage stage-${s.status}` },
        h('div', { class: 'stage-n' }, String(i + 1)), h('div', {}, h('b', {}, s.name), h('div', { class: 'dim' }, s.status === 'skipped' || s.status === 'pending' ? s.status : dur(s.durationSec))), statusPill(s.status))))),
      h('div', { style: { marginTop: '14px' } }, panel('Next steps', 'activity', quickActions([
        { ic: 'logs', label: 'Build logs', sub: p.id, href: ctx.link('/logs', { q: `{service_name="ci"} |= "${p.id}"` }) },
        { ic: 'cube', label: 'Open service', sub: p.service, href: ctx.link(`/services/${encodeURIComponent(p.service)}`) },
        { ic: 'upload', label: 'Deployments of this service', sub: 'History', href: ctx.link('/views/devops/deployments', { ...f, service: p.service }) },
      ]))));
  }
  refresh();
  return { refresh, autoRefresh: false };
}

// ======================= cluster detail =======================
export function devopsClusterDetail(main, ctx) {
  const setChart = chartSlots(ctx);
  const name = decodeURIComponent(location.pathname.split('/').pop());
  const f = { ...readFilters(ctx), cluster: '' };
  const body = h('div', {}, loadingSkeleton(0));
  main.append(body);
  async function refresh() {
    let d;
    try { d = await load(ctx, f); } catch (e) { clear(body).append(errorState(e.message, refresh)); return; }
    const c = d.clusters.find((y) => y.name === name);
    if (!c) { clear(body).append(h('div', { class: 'state-box' }, emptyState('Cluster not in this environment', 'Switch the environment filter to "All environments".', backLink(ctx, readFilters(ctx))))); return; }
    const r = rng(c.name);
    const nodes = Array.from({ length: c.nodes }, (_, i) => {
      const cpu = Math.min(99, Math.max(5, c.cpu + (r() - 0.5) * 40));
      return { name: `${c.name}-node-${String(i + 1).padStart(2, '0')}`, cpu, mem: Math.min(99, Math.max(10, c.mem + (r() - 0.5) * 30)), pods: Math.floor(r() * 30) + 8, ready: i >= c.notReady };
    });
    const cv = h('canvas');
    clear(body).append(
      detailHead('infrastructure', 'Cluster', [`${c.name} `, statusPill(c.status)], `${c.env} · ${c.region} · ${c.nodes} nodes · ${c.pods} pods · ${c.restarts} restarts in range`, [backLink(ctx, readFilters(ctx)),
        h('a', { class: 'btn btn-sm', href: ctx.link('/views/devops/deployments', { ...readFilters(ctx), cluster: c.name }), 'data-link': true }, icon('upload', 13), 'Deployments here')]),
      panel('CPU and memory', 'cpu', h('div', { class: 'chart-box', style: { height: '230px' } }, cv)),
      h('div', { style: { marginTop: '14px' } }, panel('Nodes', 'server', table([
        { label: 'Node', value: (n) => h('b', {}, n.name) },
        { label: 'Ready', value: (n) => statusPill(n.ready ? 'healthy' : 'failed') },
        { label: 'CPU', value: (n) => meter(n.cpu) },
        { label: 'Memory', value: (n) => meter(n.mem) },
        { label: 'Pods', value: (n) => String(n.pods), num: true },
      ], nodes.sort((a, b) => a.ready - b.ready || b.cpu - a.cpu), { onRow: () => ctx.navigate(ctx.link('/infrastructure')) }))));
    setChart('c', lineDrill(cv, [{ label: 'CPU', points: c.cpuSeries, color: '#3b82f6' }, { label: 'Memory', points: c.memSeries, color: '#a855f7' }], { unit: 'percent', max: 100 }));
  }
  refresh();
  return { refresh };
}

export { fmt, legendRow, svcLink };
