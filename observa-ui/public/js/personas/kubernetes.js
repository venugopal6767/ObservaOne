// Kubernetes: clusters -> namespaces -> workloads -> pods, plus nodes and events.
// Sample data here; the built-in "Kubernetes Cluster" and "Kubernetes Workloads" dashboards show the live metrics from the agent.
import { h, clear, icon, dateTime, emptyState } from '../ui.js';
import { chartSlots } from '../pages/common.js';
import { mockFetch, clustersFor } from './mock.js';
import { k8sData, podDetail, workloadDetail, nodeDetail, namespacesFor } from './mock-k8s.js';
import { personaById } from './registry.js';
import {
  personaHead, filterBar, kpiCard, panel, chartBox, lineDrill, stackedBars, table, quickActions, loadingSkeleton, errorState,
  since, detailHead, miniStat, linkBtn, detailPage, meter, attentionStrip, stampFresh,
  notConnected, NEEDS,
} from './widgets.js';

const persona = { ...personaById('kubernetes'), title: 'Kubernetes' };
const BASE = '/views/kubernetes';
const KEYS = ['cluster', 'namespace'];
const readF = (ctx) => Object.fromEntries(KEYS.map((k) => [k, ctx.params.get(k) || '']));
const args = (ctx) => { const { start, end } = ctx.range; return { env: ctx.env, start, end }; };
const mb = (v) => (v >= 1024 ? `${(v / 1024).toFixed(1)} GiB` : `${Math.round(v)} MiB`);
const cores = (v) => (v < 1 ? `${Math.round(v * 1000)}m` : `${v.toFixed(2)}`);
const age = (h0) => (h0 < 1 ? `${Math.round(h0 * 60)}m` : h0 < 48 ? `${Math.round(h0)}h` : `${Math.round(h0 / 24)}d`);
const podUrl = (p) => `${BASE}/pods/${p.cluster}/${p.ns}/${p.name}`;
const wlUrl = (w) => `${BASE}/workloads/${w.cluster}/${w.ns}/${w.workload || w.name}`;
const podState = (p) => (p.reason
  ? h('span', { class: `pill ${p.reason.startsWith('Pending') ? 'st-slow' : 'st-err'}` }, p.reason.split(':')[0])
  : p.phase === 'Succeeded' ? h('span', { class: 'pill st-res' }, 'Completed') : h('span', { class: 'pill st-ok' }, 'Running'));
const readyTag = (ready, desired) => h('b', { class: ready < desired ? 'c-orange' : '' }, `${ready}/${desired}`);
const live = (ctx) => linkBtn(ctx.link('/dashboards/kubernetes-cluster'), 'dashboards', 'Live metrics');

// ======================= overview =======================
export function k8sDashboard(main, ctx) {
  const setChart = chartSlots(ctx);
  const f = readF(ctx);
  const filters = h('div');
  const body = h('div');
  main.append(personaHead(ctx, persona, { actions: [live(ctx)] }), filters, body);
  const defs = () => [
    { key: 'cluster', label: 'All clusters', options: clustersFor(ctx.env).map((c) => [c.name, c.name]) },
    { key: 'namespace', label: 'All namespaces', options: namespacesFor(ctx.env).map((n) => [n, n]) },
  ];

  async function refresh(silent = false) {
    clear(filters).append(filterBar(ctx, defs(), f, () => refresh()));
    if (!silent) clear(body).append(loadingSkeleton(6));
    let d;
    try { d = await mockFetch((empty) => k8sData({ ...args(ctx), ...f, empty })); } catch (e) { clear(body).append(errorState(e.message, () => refresh())); return; }
    draw(d);
    stampFresh();
  }

  function draw(d) {
    clear(body);
    if (!d.clusters.length) {
      body.append(h('div', { class: 'state-box' }, emptyState('No Kubernetes clusters yet', 'Install the agent in a cluster with one kubectl command.', linkBtn(ctx.link('/agents', { tab: 'install' }), 'plus', 'Install on Kubernetes', 'btn btn-primary'))));
      return;
    }
    const k = d.kpi;
    const L = (path, extra = {}) => ctx.link(path, { ...f, ...extra });
    const crash = d.pods.filter((p) => p.reason === 'CrashLoopBackOff' || p.reason === 'Error');
    const oom = d.pods.filter((p) => p.reason === 'OOMKilled');
    const pending = d.pods.filter((p) => p.phase === 'Pending');
    const pull = d.pods.filter((p) => p.reason === 'ImagePullBackOff');
    const notReady = d.nodes.filter((n) => !n.ready);
    body.append(attentionStrip([
      notReady.length && { level: 'critical', text: `${notReady[0].name} is NotReady`, detail: `${notReady[0].pods} pods were scheduled there`, action: { label: 'Open node', href: L(`${BASE}/nodes/${notReady[0].name}`) } },
      crash.length && { level: 'critical', text: `${crash.length} pod${crash.length > 1 ? 's' : ''} crash-looping`, detail: `${crash[0].name} · ${crash[0].restarts} restarts`, action: { label: 'Open pod', href: L(podUrl(crash[0])) } },
      oom.length && { level: 'warning', text: `${oom[0].workload} ran out of memory`, detail: `limit ${mb(oom[0].memLimitMb)} · ${oom.length} pod${oom.length > 1 ? 's' : ''}`, action: { label: 'Open pod', href: L(podUrl(oom[0])) } },
      pending.length && { level: 'warning', text: `${pending.length} pod${pending.length > 1 ? 's' : ''} cannot be scheduled`, detail: pending[0].reason.split(': ')[1] || 'waiting for a node', action: { label: 'See why', href: L(podUrl(pending[0])) } },
      pull.length && { level: 'warning', text: `${pull[0].workload}: image cannot be pulled`, detail: pull[0].image, action: { label: 'Open pod', href: L(podUrl(pull[0])) } },
    ]));

    body.append(h('div', { class: 'ov-kpis persona-kpis-6' },
      kpiCard(setChart, { ic: 'server', tone: k.nodesReady < k.nodes ? 'red' : 'green', title: 'Nodes ready', value: `${k.nodesReady}/${k.nodes}`, href: '#k8s-nodes',
        foot: [h('span', { class: k.nodesReady < k.nodes ? 'c-red' : 'dim' }, k.nodesReady < k.nodes ? `${k.nodes - k.nodesReady} not ready` : 'all ready')] }),
      kpiCard(setChart, { ic: 'cube', tone: k.podsBad ? 'orange' : 'green', title: 'Pods running', value: `${k.podsRunning}/${k.pods}`, href: '#k8s-pods',
        foot: [h('span', { class: k.podsBad ? 'c-red' : 'dim' }, `${k.podsBad} with problems`), h('span', { class: 'dim' }, `${k.pending} pending`)] }),
      kpiCard(setChart, { ic: 'refresh', tone: k.restarts > 50 ? 'orange' : 'blue', title: 'Container restarts', value: String(k.restarts), href: '#k8s-pods',
        foot: [h('span', { class: 'dim' }, 'since pods started')] }),
      kpiCard(setChart, { ic: 'cpu', tone: k.cpuReqPct > 85 ? 'red' : 'purple', title: 'CPU requested', value: k.cpuReqPct.toFixed(0), unit: '%', href: '#k8s-nodes',
        foot: [h('span', { class: 'dim' }, 'of allocatable')] }),
      kpiCard(setChart, { ic: 'memory', tone: k.memReqPct > 85 ? 'red' : 'purple', title: 'Memory requested', value: k.memReqPct.toFixed(0), unit: '%', href: '#k8s-nodes',
        foot: [h('span', { class: 'dim' }, 'of allocatable')] }),
      kpiCard(setChart, { ic: 'layers', tone: k.unavailable ? 'orange' : 'green', title: 'Workloads degraded', value: String(k.unavailable), href: '#k8s-workloads',
        foot: [h('span', { class: 'dim' }, 'fewer ready pods than desired')] })));

    const cpu = chartBox(240), ns = chartBox(240);
    const nsRows = [...d.namespaces].sort((a, b) => b.pods - a.pods).slice(0, 12);
    body.append(h('div', { class: 'ov-row persona-row-2' },
      panel('CPU: used vs requested (cores)', 'cpu', h('div', {}, cpu.el, h('div', { class: 'dim chart-hint' }, 'Requests far above use waste capacity; use above requests risks throttling.'))),
      panel('Pods per namespace', 'layers', h('div', {}, ns.el, h('div', { class: 'dim chart-hint' }, 'Click a bar to open the namespace')))));
    setChart('cpu', lineDrill(cpu.canvas, d.cpuSeries, { unit: 'short' }));
    setChart('ns', stackedBars(ns.canvas, nsRows.map((n) => (f.cluster ? n.ns : `${n.ns} (${n.cluster})`)), [
      { label: 'Healthy', data: nsRows.map((n) => n.pods - n.notReady), color: 'rgba(148,163,184,0.55)' },
      { label: 'With problems', data: nsRows.map((n) => n.notReady), color: '#ef4444' },
    ], { onPick: (i) => ctx.navigate(L(`${BASE}/namespaces/${nsRows[i].cluster}/${nsRows[i].ns}`)) }));

    const problemPods = d.pods.filter((p) => p.reason || p.restarts > 0).sort((a, b) => Number(!!b.reason) - Number(!!a.reason) || b.restarts - a.restarts);
    body.append(h('div', { class: 'ov-row persona-row-2b' },
      Object.assign(panel('Pods that need a look', 'cube', table([
        { label: 'Pod', value: (p) => h('div', {}, h('b', { class: 'mono' }, p.name), h('div', { class: 'dim', style: { fontSize: '11px' } }, `${p.ns} · ${p.cluster}`)) },
        { label: 'State', value: podState },
        { label: 'Restarts', value: (p) => h('span', { class: p.restarts > 5 ? 'c-red' : '' }, String(p.restarts)), num: true },
        { minor: true, label: 'Age', value: (p) => h('span', { class: 'dim' }, age(p.ageH)), sort: (p) => p.ageH },
      ], problemPods, { max: 8, onRow: (p) => ctx.navigate(L(podUrl(p))), empty: ['All pods are healthy', 'No restarts or failing pods.'] })), { id: 'k8s-pods' }),
      Object.assign(panel('Nodes', 'server', table([
        { label: 'Node', value: (n) => h('div', {}, h('b', {}, n.name), h('div', { class: 'dim', style: { fontSize: '11px' } }, `${n.zone} · ${n.cpuCores} CPU · ${n.memGb} GiB`)) },
        { label: 'Status', value: (n) => (n.ready ? (n.pressure ? h('span', { class: 'pill st-slow' }, n.pressure) : h('span', { class: 'pill st-ok' }, 'Ready')) : h('span', { class: 'pill st-err' }, 'NotReady')) },
        { label: 'CPU', value: (n) => meter(n.cpu, 80, 90), sort: (n) => n.cpu },
        { minor: true, label: 'Memory', value: (n) => meter(n.mem, 80, 90), sort: (n) => n.mem },
        { label: 'Pods', value: (n) => String(n.pods), num: true },
      ], [...d.nodes].sort((a, b) => Number(a.ready) - Number(b.ready) || b.cpu - a.cpu), { max: 8, onRow: (n) => ctx.navigate(L(`${BASE}/nodes/${n.name}`)) })), { id: 'k8s-nodes' })));

    body.append(h('div', { class: 'ov-row persona-row-2b' },
      Object.assign(panel('Workloads', 'layers', table([
        { label: 'Workload', value: (w) => h('div', {}, h('b', {}, w.name), h('div', { class: 'dim', style: { fontSize: '11px' } }, `${w.kind} · ${w.ns} · ${w.cluster}`)) },
        { label: 'Ready', value: (w) => readyTag(w.ready, w.desired), sort: (w) => w.ready - w.desired },
        { label: 'CPU', value: (w) => cores(w.cpu), num: true, sort: (w) => w.cpu },
        { minor: true, label: 'Memory', value: (w) => mb(w.memMb), num: true, sort: (w) => w.memMb },
        { label: 'Restarts', value: (w) => String(w.restarts), num: true },
      ], [...d.workloads].sort((a, b) => (a.ready - a.desired) - (b.ready - b.desired) || b.restarts - a.restarts), { onRow: (w) => ctx.navigate(L(`${BASE}/workloads/${w.cluster}/${w.ns}/${w.name}`)) })), { id: 'k8s-workloads' }),
      panel('Recent events', 'list', table([
        { label: 'Type', value: (e) => h('span', { class: `pill ${e.type === 'Warning' ? 'sev-warning' : 'st-res'}` }, e.type) },
        { label: 'Event', value: (e) => h('div', {}, h('b', {}, `${e.reason} · ${e.object}`), h('div', { class: 'dim', style: { fontSize: '11px' } }, e.note)) },
        { label: 'When', value: (e) => h('span', { class: 'dim' }, since(e.at)), sort: (e) => -e.at },
      ], d.events, { max: 8, empty: ['No events', ''] }), { link: ctx.link('/logs', { q: '{service_name="kubernetes-events"}' }), linkLabel: 'All events' })));

    body.append(h('div', { class: 'ov-row' }, panel('Quick actions', 'activity', h('div', { class: 'qa-wide' }, quickActions([
      { ic: 'dashboards', label: 'Live cluster metrics', sub: 'From the agent (Prometheus)', href: ctx.link('/dashboards/kubernetes-cluster') },
      { ic: 'layers', label: 'Live workload metrics', sub: 'CPU, memory, throttling, OOM', href: ctx.link('/dashboards/kubernetes-workloads') },
      { ic: 'logs', label: 'Kubernetes events', sub: 'Warnings first', href: ctx.link('/logs', { q: '{service_name="kubernetes-events"} |= "Warning"' }) },
      { ic: 'plus', label: 'Add a cluster', sub: 'kubectl apply one file', href: ctx.link('/agents', { tab: 'install' }) },
    ])))));
  }

  refresh();
  return { refresh: () => refresh(true) };
}

// ======================= namespace =======================
export function k8sNamespace(main, ctx) {
  const setChart = chartSlots(ctx);
  // /views/kubernetes/namespaces/<cluster>/<ns>
  const [, , , , cluster, ns] = location.pathname.split('/').map(decodeURIComponent);
  return detailPage(main, {
    load: () => mockFetch(() => { const d = k8sData({ ...args(ctx), env: '', cluster, namespace: ns }); return d.workloads.length ? d : null; }),
    notFound: ['Namespace not found', '', linkBtn(ctx.link(BASE), 'arrowLeft', 'Kubernetes')],
    render(body, d) {
      const n = d.namespaces[0];
      const cpu = chartBox(220);
      body.append(
        detailHead('layers', `Namespace · ${cluster}`, ns, `${n.workloads} workloads · ${n.pods} pods${n.cpuQuota ? ` · CPU quota ${n.cpuQuota} cores` : ' · no quota set'}`, [
          linkBtn(ctx.link('/dashboards/kubernetes-workloads'), 'dashboards', 'Live metrics'),
          linkBtn(ctx.link('/logs', { q: `{k8s_namespace_name="${ns}"}` }), 'logs', 'Logs'),
        ]),
        h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
          miniStat('Pods', String(n.pods), `${n.notReady} with problems`, n.notReady ? 'c-orange' : ''), miniStat('CPU used', `${cores(n.cpu)} cores`, n.cpuQuota ? `${((n.cpu / n.cpuQuota) * 100).toFixed(0)}% of quota` : null),
          miniStat('Memory used', mb(n.memMb)), miniStat('Restarts', String(n.restarts))),
        panel('CPU: used vs requested (cores)', 'cpu', cpu.el),
        h('div', { class: 'ov-row persona-row-2b' },
          panel('Workloads', 'layers', table([
            { label: 'Workload', value: (w) => h('div', {}, h('b', {}, w.name), h('div', { class: 'dim', style: { fontSize: '11px' } }, w.kind)) },
            { label: 'Ready', value: (w) => readyTag(w.ready, w.desired) },
            { label: 'CPU', value: (w) => cores(w.cpu), num: true, sort: (w) => w.cpu },
            { label: 'Memory', value: (w) => mb(w.memMb), num: true, sort: (w) => w.memMb },
          ], d.workloads, { onRow: (w) => ctx.navigate(ctx.link(`${BASE}/workloads/${cluster}/${ns}/${w.name}`)) })),
          panel('Pods', 'cube', table([
            { label: 'Pod', value: (p) => h('b', { class: 'mono' }, p.name) },
            { label: 'State', value: podState },
            { label: 'Restarts', value: (p) => String(p.restarts), num: true },
          ], d.pods, { onRow: (p) => ctx.navigate(ctx.link(podUrl(p))) }))));
      setChart('cpu', lineDrill(cpu.canvas, d.cpuSeries, { unit: 'short' }));
    },
  });
}

// ======================= workload =======================
export function k8sWorkload(main, ctx) {
  const setChart = chartSlots(ctx);
  // /views/kubernetes/<workloads|pods>/<cluster>/<ns>/<name>
  const [, , , , cluster, ns, name] = location.pathname.split('/').map(decodeURIComponent);
  return detailPage(main, {
    load: () => mockFetch(() => workloadDetail(args(ctx), cluster, ns, name)),
    notFound: ['Workload not found', '', linkBtn(ctx.link(BASE), 'arrowLeft', 'Kubernetes')],
    render(body, d) {
      const w = d.w;
      const cpu = chartBox(210), mem = chartBox(210);
      const scalable = w.kind === 'Deployment' || w.kind === 'StatefulSet';
      body.append(
        detailHead('layers', `${w.kind} · ${ns} · ${cluster}`, [w.name, ' ', w.ready < w.desired ? h('span', { class: 'pill st-slow' }, 'Degraded') : h('span', { class: 'pill st-ok' }, 'Available')], `Image ${w.image}`, [
          linkBtn(ctx.link(`${BASE}/namespaces/${cluster}/${ns}`), 'arrowLeft', ns),
          scalable ? notConnected('refresh', 'Rolling restart', NEEDS.k8s) : null,
          w.kind === 'Deployment' ? notConnected('arrowLeft', `Roll back to rev ${d.revs[1].rev}`, NEEDS.k8s) : null,
        ]),
        h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
          miniStat('Ready pods', `${w.ready}/${w.desired}`, null, w.ready < w.desired ? 'c-orange' : ''),
          miniStat('CPU', `${cores(w.cpu)} used`, `${cores(w.cpuReq)} requested`), miniStat('Memory', `${mb(w.memMb)} used`, `${mb(w.memReqMb)} requested`), miniStat('Restarts', String(w.restarts))),
        h('div', { class: 'ov-row persona-row-2', style: { marginTop: 0 } }, panel('CPU (cores)', 'cpu', cpu.el), panel('Memory (MiB)', 'memory', mem.el)),
        h('div', { class: 'ov-row persona-row-2b' },
          panel('Pods', 'cube', table([
            { label: 'Pod', value: (p) => h('b', { class: 'mono' }, p.name) },
            { label: 'State', value: podState },
            { label: 'Node', value: (p) => h('span', { class: 'dim' }, p.node || 'not scheduled') },
            { label: 'Restarts', value: (p) => String(p.restarts), num: true },
          ], d.pods, { onRow: (p) => ctx.navigate(ctx.link(podUrl(p))) })),
          panel(w.kind === 'Deployment' ? 'Rollout history' : 'Events', 'clock', w.kind === 'Deployment'
            ? table([
              { label: 'Revision', value: (x) => h('b', {}, `#${x.rev}`), num: true },
              { label: 'Image', value: (x) => h('span', { class: 'mono dim' }, x.image.split('/').pop()) },
              { label: 'When', value: (x) => h('span', { class: 'dim' }, since(x.at)), sort: (x) => -x.at },
              { label: '', value: (x) => (x.current ? h('span', { class: 'pill st-ok' }, 'current') : '') },
            ], d.revs)
            : table([{ label: 'Event', value: (e) => `${e.reason}: ${e.note}` }, { label: 'When', value: (e) => since(e.at) }], d.events, { empty: ['No events', ''] }))));
      setChart('cpu', lineDrill(cpu.canvas, d.cpu, { unit: 'short' }));
      setChart('mem', lineDrill(mem.canvas, d.mem, {}));
    },
  });
}

// ======================= pod =======================
export function k8sPod(main, ctx) {
  const setChart = chartSlots(ctx);
  // /views/kubernetes/<workloads|pods>/<cluster>/<ns>/<name>
  const [, , , , cluster, ns, name] = location.pathname.split('/').map(decodeURIComponent);
  return detailPage(main, {
    load: () => mockFetch(() => podDetail(args(ctx), cluster, ns, name)),
    notFound: ['Pod not found', 'It may have been replaced by a new pod. Open the workload to see the current ones.', linkBtn(ctx.link(BASE), 'arrowLeft', 'Kubernetes')],
    render(body, d) {
      const p = d.p;
      const cpu = chartBox(200), mem = chartBox(200);
      const why = {
        CrashLoopBackOff: 'The container keeps exiting right after it starts. Check its last log lines: usually a bad config value, a missing secret or a failed connection at startup.',
        OOMKilled: `The container used more than its ${mb(p.memLimitMb)} memory limit and was killed. Raise the limit or find the memory growth.`,
        ImagePullBackOff: 'The image cannot be downloaded: wrong tag, the image was deleted, or the cluster has no pull secret for the registry.',
        Error: 'The container exited with an error. Check the last log lines.',
      }[p.reason] || (p.reason?.startsWith('Pending') ? 'No node has enough free CPU for this pod\'s request. Lower the request, add a node, or free capacity.' : null);
      body.append(
        detailHead('cube', `Pod · ${ns} · ${cluster}`, [h('span', { class: 'mono' }, p.name), ' ', podState(p)], `${p.kind} ${p.workload} · ${p.node ? `on ${p.node}` : 'not scheduled'} · age ${age(p.ageH)}${p.ip ? ` · ${p.ip}` : ''}`, [
          linkBtn(ctx.link(wlUrl(p)), 'layers', p.workload),
          linkBtn(ctx.link('/logs', { q: `{k8s_namespace_name="${ns}", k8s_pod_name="${p.name}"}` }), 'logs', 'Logs'),
          notConnected('trash', 'Delete pod', NEEDS.k8s),
        ]),
        why ? h('div', { class: 'error-box warn', style: { marginBottom: '14px' } }, icon('alert', 16), h('span', {}, h('b', {}, `${p.reason.split(':')[0]}: `), why)) : null,
        h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
          miniStat('Restarts', String(p.restarts), null, p.restarts > 5 ? 'c-red' : ''),
          miniStat('CPU', `${cores(p.cpu)} used`, `request ${cores(p.cpuReq)} · limit ${cores(p.cpuLimit)}`),
          miniStat('Memory', `${mb(p.memMb)} used`, `request ${mb(p.memReqMb)} · limit ${mb(p.memLimitMb)}`, p.memMb > p.memLimitMb * 0.9 ? 'c-red' : ''),
          miniStat('Containers', String(p.containers.length), p.containers.join(', '))),
        p.phase === 'Pending' ? null : h('div', { class: 'ov-row persona-row-2', style: { marginTop: 0 } }, panel('CPU vs limit (cores)', 'cpu', cpu.el), panel('Memory vs limit (MiB)', 'memory', mem.el)),
        h('div', { class: 'ov-row persona-row-2b' },
          panel('Containers', 'cube', table([
            { label: 'Container', value: (c) => h('b', {}, c) },
            { label: 'Image', value: (c, i) => h('span', { class: 'mono dim' }, c === 'istio-proxy' ? 'istio/proxyv2:1.26.3' : p.image.split('/').pop()) },
            { label: 'State', value: (c) => (c === p.workload ? podState(p) : h('span', { class: 'pill st-ok' }, 'Running')) },
          ], p.containers)),
          panel('Events', 'list', table([
            { label: 'Reason', value: (e) => h('b', {}, e.reason) },
            { label: 'Message', value: (e) => h('span', { class: 'dim' }, e.note) },
            { label: 'When', value: (e) => h('span', { class: 'dim' }, since(e.at)), sort: (e) => -e.at },
          ], d.events, { empty: ['No warning events', 'Nothing went wrong recently.'] }))),
        d.sameWorkload.length ? h('div', { class: 'ov-row' }, panel(`Other pods of ${p.workload}`, 'layers', table([
          { label: 'Pod', value: (x) => h('b', { class: 'mono' }, x.name) },
          { label: 'State', value: podState },
          { label: 'Node', value: (x) => h('span', { class: 'dim' }, x.node || '-') },
          { label: 'Restarts', value: (x) => String(x.restarts), num: true },
        ], d.sameWorkload, { onRow: (x) => ctx.navigate(ctx.link(podUrl(x))) }))) : null);
      if (p.phase !== 'Pending') {
        setChart('cpu', lineDrill(cpu.canvas, d.cpu, { unit: 'short' }));
        setChart('mem', lineDrill(mem.canvas, d.mem, {}));
      }
    },
  });
}

// ======================= node =======================
export function k8sNode(main, ctx) {
  const setChart = chartSlots(ctx);
  const name = location.pathname.split('/').pop();
  return detailPage(main, {
    load: () => mockFetch(() => nodeDetail(args(ctx), name)),
    notFound: ['Node not found', '', linkBtn(ctx.link(BASE), 'arrowLeft', 'Kubernetes')],
    render(body, d) {
      const n = d.node;
      const ch = chartBox(220);
      body.append(
        detailHead('server', `Node · ${n.cluster} · ${n.zone}`, [n.name, ' ', n.ready ? (n.pressure ? h('span', { class: 'pill st-slow' }, n.pressure) : h('span', { class: 'pill st-ok' }, 'Ready')) : h('span', { class: 'pill st-err' }, 'NotReady')],
          `${n.os} · ${n.runtime} · kubelet ${n.kubelet} · ${n.age} days old`, [
            notConnected('lock', 'Cordon', NEEDS.k8s),
            notConnected('upload', 'Drain', NEEDS.k8s),
          ]),
        !n.ready ? h('div', { class: 'error-box', style: { marginBottom: '14px' } }, icon('alert', 16), h('span', {}, 'The kubelet stopped reporting. Pods on this node are being moved after 5 minutes. Check the machine, its network and the kubelet service.')) : null,
        h('div', { class: 'grid cards-4', style: { marginBottom: '14px' } },
          miniStat('CPU used', `${n.cpu.toFixed(0)}%`, `${n.cpuCores} cores`, n.cpu > 90 ? 'c-red' : ''), miniStat('Memory used', `${n.mem.toFixed(0)}%`, `${n.memGb} GiB`, n.mem > 88 ? 'c-red' : ''),
          miniStat('Pods', `${n.pods}/${n.podCapacity}`), miniStat('Zone', n.zone)),
        h('div', { class: 'ov-row persona-row-2b', style: { marginTop: 0 } },
          panel('CPU and memory', 'cpu', ch.el),
          panel('Conditions', 'check', table([
            { label: 'Condition', value: (c) => c[0] },
            { label: 'Status', value: (c) => h('span', { class: `pill ${(c[0] === 'Ready') === (c[1] === 'True') ? 'st-ok' : 'st-err'}` }, c[1]) },
          ], d.conditions))),
        h('div', { class: 'ov-row' }, panel('Pods on this node', 'cube', table([
          { label: 'Pod', value: (p) => h('div', {}, h('b', { class: 'mono' }, p.name), h('div', { class: 'dim', style: { fontSize: '11px' } }, p.ns)) },
          { label: 'State', value: podState },
          { label: 'CPU', value: (p) => cores(p.cpu), num: true, sort: (p) => p.cpu },
          { label: 'Memory', value: (p) => mb(p.memMb), num: true, sort: (p) => p.memMb },
          { label: 'Restarts', value: (p) => String(p.restarts), num: true },
        ], d.pods, { onRow: (p) => ctx.navigate(ctx.link(podUrl(p))), empty: ['No pods', ''] }))));
      setChart('ch', lineDrill(ch.canvas, [{ label: 'CPU %', points: d.cpu, color: '#3b82f6' }, { label: 'Memory %', points: d.mem, color: '#a855f7' }], { unit: 'percent', max: 100 }));
    },
  });
}

export { dateTime };
