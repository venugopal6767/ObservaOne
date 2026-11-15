// Kubernetes cluster view: health, CPU and memory against what the nodes can give, nodes, namespaces,
// workloads, pods, services, storage and events. Uses cAdvisor + kube-state-metrics (sent by the agent)
// and Kubernetes events from Loki (job="kubernetes-events").
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Boxes, Bell } from 'lucide-react';
import { api, type PromMatrix, type PromVector } from '@/lib/api';
import { ago, escapeLabel, fmt, timeHM } from '@/lib/format';
import { palette, toneClass } from '@/lib/theme';
import { useApp, useRangeQuery } from '@/app/AppContext';
import { ErrorState, PageHead, Panel, Pill, Select, StateView, Tabs, TableWrap, Time, useDialogs } from '@/components/ui';
import { Sparkline, TimeChart, LegendRow } from '@/components/charts';
import { useLabelValues } from '@/components/FilterBar';
import { AlertWizard } from '@/components/AlertWizard';

type Tab = 'overview' | 'nodes' | 'namespaces' | 'workloads' | 'pods' | 'services' | 'storage' | 'events';
const vec = (query: string) => api<{ result: PromVector }>('/prom/query', { query: { query } }).then((r) => r.result).catch(() => [] as PromVector);
const one = (r: PromVector) => (r[0] ? Number(r[0].value[1]) : null);
const byLabel = (r: PromVector, l: string) => new Map(r.map((x) => [x.metric[l], Number(x.value[1])]));

export default function Kubernetes() {
  const { canOpen } = useApp();
  const { open } = useDialogs();
  const [params, setParams] = useSearchParams();
  const clusters = useLabelValues('cluster', 'kube_node_info');
  const list = clusters.data || [];
  const cluster = params.get('cluster') || list[0] || '';
  const tab = (params.get('tab') as Tab) || 'overview';
  const setTab = (t: Tab) => { const n = new URLSearchParams(params); if (t === 'overview') n.delete('tab'); else n.set('tab', t); setParams(n, { replace: true }); };
  const c = cluster ? `cluster="${escapeLabel(cluster)}"` : '';
  const cs = c ? `{${c}}` : '';
  const and = c ? `, ${c}` : '';

  const summary = useRangeQuery(['k8s-sum', cluster], async () => {
    const [nodes, ready, pods, running, podCap, cpuUse, cpuCap, memUse, memCap, ver] = await Promise.all([
      vec(`count(kube_node_info${cs})`), vec(`sum(kube_node_status_condition{condition="Ready", status="true"${and}})`),
      vec(`count(kube_pod_info${cs})`), vec(`sum(kube_pod_status_phase{phase="Running"${and}})`), vec(`sum(kube_node_status_allocatable{resource="pods"${and}})`),
      vec(`sum(rate(container_cpu_usage_seconds_total{container!="", container!="POD"${and}}[5m]))`), vec(`sum(kube_node_status_allocatable{resource="cpu"${and}})`),
      vec(`sum(container_memory_working_set_bytes{container!="", container!="POD"${and}})`), vec(`sum(kube_node_status_allocatable{resource="memory"${and}})`),
      vec(`count by (kubelet_version) (kube_node_info${cs})`),
    ]);
    const pct = (a: number | null, b: number | null) => (a !== null && b ? (a / b) * 100 : null);
    return { nodes: one(nodes), ready: one(ready), pods: one(pods), running: one(running), podCap: one(podCap), cpu: pct(one(cpuUse), one(cpuCap)), cpuCores: one(cpuUse), mem: pct(one(memUse), one(memCap)), memBytes: one(memUse), version: ver[0]?.metric.kubelet_version };
  }, { enabled: list.length > 0 || !clusters.isPending });

  const trend = useRangeQuery(['k8s-trend', cluster], (r) => Promise.all([
    api<{ result: PromMatrix }>('/prom/query_range', { query: { query: `100 * sum(rate(container_cpu_usage_seconds_total{container!="", container!="POD"${and}}[5m])) / sum(kube_node_status_allocatable{resource="cpu"${and}})`, ...r } }),
    api<{ result: PromMatrix }>('/prom/query_range', { query: { query: `100 * sum(container_memory_working_set_bytes{container!="", container!="POD"${and}}) / sum(kube_node_status_allocatable{resource="memory"${and}})`, ...r } }),
  ]));

  if (!clusters.isPending && !list.length) {
    return (
      <>
        <PageHead title="Kubernetes" sub="Clusters, nodes, namespaces and pods" />
        <StateView kind="empty" title="No Kubernetes clusters are sending data yet" text="Install the ObservaOne Agent on a cluster. It runs on every node and adds kube-state-metrics."
          action={canOpen('/agents') ? <Link className="btn btn-primary btn-sm" to="/agents?tab=kubernetes">Set up Kubernetes</Link> : undefined} />
      </>
    );
  }
  const s = summary.data;
  const healthy = s && s.nodes !== null && s.ready === s.nodes;
  const pal = palette();
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/metrics">Metrics</Link> › Kubernetes › <span>{cluster}</span></nav>
      <PageHead
        title={<><Boxes size={22} />{cluster || 'Kubernetes'}{s && <Pill tone={healthy ? 'solid-green' : 'solid-orange'}>{healthy ? 'Healthy' : `${(s.nodes || 0) - (s.ready || 0)} node(s) not ready`}</Pill>}</>}
        sub={s ? [s.version && `Version ${s.version}`, `Nodes: ${s.nodes ?? '-'}`, `Pods: ${s.running ?? '-'}/${s.podCap ?? s.pods ?? '-'}`].filter(Boolean).join(' · ') : 'Loading…'}
        actions={<>
          {list.length > 1 && <Select className="select" label="Cluster" options={list} value={cluster} onChange={(v) => { const n = new URLSearchParams(params); n.set('cluster', v); setParams(n, { replace: true }); }} />}
          {canOpen('/alerting') && <button className="btn btn-primary" onClick={() => open((close) => <AlertWizard onClose={close} metric="pod_restarts" filters={{ cluster }} value={3} />)}><Bell size={14} />Create alert</button>}
        </>} />
      <div className="toolbar"><Tabs items={[['overview', 'Overview'], ['nodes', 'Nodes'], ['namespaces', 'Namespaces'], ['workloads', 'Workloads'], ['pods', 'Pods'], ['services', 'Services'], ['storage', 'Storage'], ['events', 'Events']]} active={tab} onChange={setTab} label="Kubernetes sections" /></div>

      {tab === 'overview' && (
        <>
          <div className="kpi-row k4">
            <div className="kpi"><div className="kpi-top"><span className="kpi-label">CPU usage</span></div><div className={`kpi-val ${toneClass(s?.cpu ?? null)}`}>{s?.cpu == null ? '-' : `${s.cpu.toFixed(0)}%`}</div><div className="kpi-sub">{s?.cpuCores == null ? '' : `${s.cpuCores.toFixed(1)} cores used`}</div>
              {trend.data?.[0].result[0] && <div className="kpi-spark"><Sparkline points={trend.data[0].result[0].values} lineColor={pal[0]} /></div>}</div>
            <div className="kpi"><div className="kpi-top"><span className="kpi-label">Memory usage</span></div><div className={`kpi-val ${toneClass(s?.mem ?? null)}`}>{s?.mem == null ? '-' : `${s.mem.toFixed(0)}%`}</div><div className="kpi-sub">{s?.memBytes == null ? '' : `${fmt(s.memBytes, 'bytes')} used`}</div>
              {trend.data?.[1].result[0] && <div className="kpi-spark"><Sparkline points={trend.data[1].result[0].values} lineColor={pal[1]} /></div>}</div>
            <div className="kpi"><div className="kpi-top"><span className="kpi-label">Pods</span></div><div className="kpi-val">{s?.running ?? '-'} <small>/ {s?.podCap ?? '-'}</small></div><div className="kpi-sub">running / node capacity</div>
              {s?.running != null && s.podCap ? <div className="meter"><span style={{ width: `${Math.min(100, (s.running / s.podCap) * 100)}%` }} /></div> : null}</div>
            <div className="kpi"><div className="kpi-top"><span className="kpi-label">Nodes</span></div><div className={`kpi-val ${healthy ? 'green' : 'orange'}`}>{s?.ready ?? '-'} <small>/ {s?.nodes ?? '-'}</small></div><div className="kpi-sub">ready</div>
              {s?.nodes ? <div className="meter ok"><span style={{ width: `${((s.ready || 0) / s.nodes) * 100}%` }} /></div> : null}</div>
          </div>
          <div className="grid host-grid" style={{ marginTop: 14 }}>
            <Panel title="Cluster CPU & memory (% of allocatable)" right={<span className="hint-chip">Click for logs, traces &amp; alerts</span>}>
              {trend.isPending ? <StateView kind="loading" skeleton="chart" /> : trend.isError ? <ErrorState error={trend.error} what="Cluster usage" /> : (
                <>
                  <TimeChart series={[{ label: 'CPU %', points: trend.data[0].result[0]?.values || [] }, { label: 'Memory %', points: trend.data[1].result[0]?.values || [] }]} unit="percent" max={100} className="chart-box" correlate filters={{ cluster }} metric="pod_cpu" />
                  <LegendRow labels={['CPU %', 'Memory %']} />
                </>
              )}
            </Panel>
            <Namespaces and={and} compact />
          </div>
          <div style={{ marginTop: 14 }}><Workloads and={and} cs={cs} compact onAll={() => setTab('workloads')} /></div>
        </>
      )}
      {tab === 'nodes' && <Nodes and={and} cs={cs} />}
      {tab === 'namespaces' && <Namespaces and={and} />}
      {tab === 'workloads' && <Workloads and={and} cs={cs} />}
      {tab === 'pods' && <><Pods and={and} /><div style={{ marginTop: 14 }}><AllPods and={and} cs={cs} /></div></>}
      {tab === 'services' && <K8sServices cs={cs} />}
      {tab === 'storage' && <Storage and={and} cs={cs} />}
      {tab === 'events' && <Events cluster={cluster} />}
    </>
  );
}

function Namespaces({ and, compact }: { and: string; compact?: boolean }) {
  const navigate = useNavigate();
  const q = useRangeQuery(['k8s-ns', and], async () => {
    const [cpu, mem, pods] = await Promise.all([
      vec(`sum by (namespace) (rate(container_cpu_usage_seconds_total{container!="", container!="POD"${and}}[5m]))`),
      vec(`sum by (namespace) (container_memory_working_set_bytes{container!="", container!="POD"${and}})`),
      vec(`sum by (namespace) (kube_pod_status_phase{phase="Running"${and}})`),
    ]);
    const m = byLabel(mem, 'namespace'), p = byLabel(pods, 'namespace');
    return cpu.map((x) => ({ ns: x.metric.namespace, cpu: Number(x.value[1]), mem: m.get(x.metric.namespace) ?? null, pods: p.get(x.metric.namespace) ?? null })).sort((a, b) => b.cpu - a.cpu);
  });
  const rows = (q.data || []).slice(0, compact ? 6 : 200);
  return (
    <Panel title={compact ? 'Top namespaces by CPU' : 'Namespaces'} right={compact ? <Pill title="Current value">Now</Pill> : undefined}>
      {q.isPending ? <StateView kind="loading" skeleton="table" /> : q.isError ? <ErrorState error={q.error} what="Namespaces" /> : !rows.length ? <StateView kind="empty" title="No namespace data" /> : (
        <TableWrap label="Namespaces">
          <table className="tbl compact">
            <thead><tr><th>Namespace</th><th className="num">CPU (cores)</th><th className="num">Memory</th><th className="num">Pods</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.ns} className="clickable" onClick={() => navigate(`/metrics/explore?m=pod_cpu&by=pod&namespace=${encodeURIComponent(r.ns)}`)}>
                <td>{r.ns}</td><td className="num">{r.cpu.toFixed(2)}</td><td className="num">{fmt(r.mem, 'bytes')}</td><td className="num">{r.pods ?? '-'}</td>
              </tr>))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Panel>
  );
}

function Nodes({ and, cs }: { and: string; cs: string }) {
  const q = useRangeQuery(['k8s-nodes', and], async () => {
    const [info, ready, cpu, cpuCap, mem, memCap, pods] = await Promise.all([
      vec(`kube_node_info${cs}`), vec(`kube_node_status_condition{condition="Ready", status="true"${and}}`),
      vec(`sum by (node) (rate(container_cpu_usage_seconds_total{container!="", container!="POD"${and}}[5m]))`), vec(`sum by (node) (kube_node_status_allocatable{resource="cpu"${and}})`),
      vec(`sum by (node) (container_memory_working_set_bytes{container!="", container!="POD"${and}})`), vec(`sum by (node) (kube_node_status_allocatable{resource="memory"${and}})`),
      vec(`count by (node) (kube_pod_info${cs})`),
    ]);
    const R = byLabel(ready, 'node'), C = byLabel(cpu, 'node'), CC = byLabel(cpuCap, 'node'), M = byLabel(mem, 'node'), MC = byLabel(memCap, 'node'), P = byLabel(pods, 'node');
    return info.map((x) => {
      const n = x.metric.node;
      return { node: n, version: x.metric.kubelet_version, ready: R.get(n) === 1, cpu: C.has(n) && CC.get(n) ? (C.get(n)! / CC.get(n)!) * 100 : null, mem: M.has(n) && MC.get(n) ? (M.get(n)! / MC.get(n)!) * 100 : null, pods: P.get(n) ?? null };
    }).sort((a, b) => a.node.localeCompare(b.node));
  });
  return (
    <Panel title="Nodes">
      {q.isPending ? <StateView kind="loading" skeleton="table" /> : q.isError ? <ErrorState error={q.error} what="Nodes" /> : !q.data.length ? <StateView kind="empty" title="No node data" /> : (
        <TableWrap label="Nodes">
          <table className="tbl">
            <thead><tr><th>Node</th><th>Status</th><th>Version</th><th className="num">CPU</th><th className="num">Memory</th><th className="num">Pods</th></tr></thead>
            <tbody>{q.data.map((r) => (
              <tr key={r.node}><td><Link to={`/metrics/host/${encodeURIComponent(r.node)}`}>{r.node}</Link></td><td>{r.ready ? <Pill tone="solid-green">Ready</Pill> : <Pill tone="solid-red">Not ready</Pill>}</td>
                <td className="dim">{r.version || '-'}</td><td className={`num ${toneClass(r.cpu)}`}>{fmt(r.cpu, 'percent')}</td><td className={`num ${toneClass(r.mem)}`}>{fmt(r.mem, 'percent')}</td><td className="num">{r.pods ?? '-'}</td></tr>))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Panel>
  );
}

function Pods({ and }: { and: string }) {
  const navigate = useNavigate();
  const q = useRangeQuery(['k8s-pods', and], async () => {
    const [restarts, bad] = await Promise.all([
      vec(`sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total{${and.replace(/^, /, '')}}[1h])) > 0`),
      vec(`sum by (namespace, pod, phase) (kube_pod_status_phase{phase=~"Pending|Failed|Unknown"${and}}) > 0`),
    ]);
    return { restarts: restarts.map((x) => ({ ns: x.metric.namespace, pod: x.metric.pod, n: Number(x.value[1]) })).sort((a, b) => b.n - a.n), bad: bad.map((x) => ({ ns: x.metric.namespace, pod: x.metric.pod, phase: x.metric.phase })) };
  });
  return (
    <div className="grid cols-2">
      <Panel title="Pods needing attention: restarted in the last hour">
        {q.isPending ? <StateView kind="loading" skeleton="table" /> : q.isError ? <ErrorState error={q.error} what="Pods" /> : !q.data.restarts.length ? <StateView kind="empty" title="No restarts in the last hour" /> : (
          <TableWrap label="Restarting pods"><table className="tbl compact"><thead><tr><th>Pod</th><th>Namespace</th><th className="num">Restarts</th></tr></thead>
            <tbody>{q.data.restarts.map((r) => (
              <tr key={`${r.ns}/${r.pod}`} className="clickable" onClick={() => navigate(`/logs?q=${encodeURIComponent(`{namespace="${escapeLabel(r.ns)}", pod="${escapeLabel(r.pod)}"}`)}`)}>
                <td className="mono">{r.pod}</td><td>{r.ns}</td><td className={`num ${r.n >= 5 ? 'c-red' : 'c-orange'}`}>{Math.round(r.n)}</td></tr>))}</tbody></table></TableWrap>
        )}
      </Panel>
      <Panel title="Not running (Pending / Failed / Unknown)">
        {q.isPending ? <StateView kind="loading" skeleton="table" /> : q.isError ? <ErrorState error={q.error} what="Pods" /> : !q.data.bad.length ? <StateView kind="empty" title="All pods are running" /> : (
          <TableWrap label="Pods not running"><table className="tbl compact"><thead><tr><th>Pod</th><th>Namespace</th><th>Phase</th></tr></thead>
            <tbody>{q.data.bad.map((r) => <tr key={`${r.ns}/${r.pod}`}><td className="mono">{r.pod}</td><td>{r.ns}</td><td><Pill tone={r.phase === 'Failed' ? 'solid-red' : 'solid-orange'}>{r.phase}</Pill></td></tr>)}</tbody></table></TableWrap>
        )}
      </Panel>
    </div>
  );
}

// ---------------- workloads (Deployments, StatefulSets, DaemonSets, Jobs) ----------------
const KIND: Record<string, string> = { ReplicaSet: 'Deployment', StatefulSet: 'StatefulSet', DaemonSet: 'DaemonSet', Job: 'Job', CronJob: 'CronJob' };
// a Deployment's pods are created by a ReplicaSet called <deployment>-<hash>: show the deployment name
// (Kubernetes makes that hash from the letters and digits below, so "-runtime" or "-gateway" are never cut)
const workloadName = (kind: string, name: string) => (kind === 'ReplicaSet' ? name.replace(/-[bcdfghjklmnpqrstvwxz2456789]{8,10}$/, '') : name);
function Workloads({ and, cs, compact, onAll }: { and: string; cs: string; compact?: boolean; onAll?: () => void }) {
  const navigate = useNavigate();
  const q = useRangeQuery(['k8s-workloads', and], async () => {
    const join = `* on (cluster, namespace, pod) group_left(created_by_kind, created_by_name) max by (cluster, namespace, pod, created_by_kind, created_by_name) (kube_pod_info${cs})`;
    const [cpu, mem, pods, running] = await Promise.all([
      vec(`sum by (namespace, created_by_kind, created_by_name) (sum by (cluster, namespace, pod) (rate(container_cpu_usage_seconds_total{container!="", container!="POD"${and}}[5m])) ${join})`),
      vec(`sum by (namespace, created_by_kind, created_by_name) (sum by (cluster, namespace, pod) (container_memory_working_set_bytes{container!="", container!="POD"${and}}) ${join})`),
      vec(`count by (namespace, created_by_kind, created_by_name) (kube_pod_info${cs})`),
      vec(`count by (namespace, created_by_kind, created_by_name) ((kube_pod_status_phase{phase="Running"${and}} == 1) ${join})`),
    ]);
    const rows = new Map<string, { ns: string; kind: string; name: string; cpu: number; mem: number; pods: number; running: number }>();
    const get = (m: Record<string, string>) => {
      const kind = KIND[m.created_by_kind] || m.created_by_kind || 'Pod', name = workloadName(m.created_by_kind, m.created_by_name || '-');
      const k = `${m.namespace}|${kind}|${name}`;
      if (!rows.has(k)) rows.set(k, { ns: m.namespace, kind, name, cpu: 0, mem: 0, pods: 0, running: 0 });
      return rows.get(k)!;
    };
    cpu.forEach((x) => (get(x.metric).cpu += Number(x.value[1])));
    mem.forEach((x) => (get(x.metric).mem += Number(x.value[1])));
    pods.forEach((x) => (get(x.metric).pods += Number(x.value[1])));
    running.forEach((x) => (get(x.metric).running += Number(x.value[1])));
    return [...rows.values()].sort((a, b) => b.cpu - a.cpu);
  });
  const rows = (q.data || []).slice(0, compact ? 8 : 500);
  return (
    <Panel title={compact ? 'Workloads (top by CPU)' : 'Workloads'} right={compact && onAll ? <button className="linkish" onClick={onAll}>View all</button> : undefined}>
      {q.isPending ? <StateView kind="loading" skeleton="table" /> : q.isError ? <ErrorState error={q.error} what="Workloads" /> : !rows.length ? <StateView kind="empty" title="No workload data" /> : (
        <TableWrap label="Workloads">
          <table className="tbl compact">
            <thead><tr><th>Workload</th><th>Namespace</th><th>Type</th><th className="num">CPU (cores)</th><th className="num">Memory</th><th className="num">Pods</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={`${r.ns}/${r.kind}/${r.name}`} className="clickable" onClick={() => navigate(`/metrics/explore?m=pod_cpu&by=pod&namespace=${encodeURIComponent(r.ns)}`)}>
                <td><b style={{ fontWeight: 600 }}>{r.name}</b></td><td>{r.ns}</td><td className="dim">{r.kind}</td>
                <td className="num">{r.cpu.toFixed(2)}</td><td className="num">{fmt(r.mem, 'bytes')}</td>
                <td className={`num ${r.running < r.pods ? 'c-orange' : ''}`}>{r.running}/{r.pods}</td>
              </tr>))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Panel>
  );
}

function AllPods({ and, cs }: { and: string; cs: string }) {
  const [filter, setFilter] = useState('');
  const q = useRangeQuery(['k8s-allpods', and], async () => {
    const [info, phase, restarts, cpu, mem] = await Promise.all([
      vec(`kube_pod_info${cs}`), vec(`kube_pod_status_phase${cs} == 1`), vec(`sum by (namespace, pod) (kube_pod_container_status_restarts_total${cs})`),
      vec(`sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!="", container!="POD"${and}}[5m]))`),
      vec(`sum by (namespace, pod) (container_memory_working_set_bytes{container!="", container!="POD"${and}})`),
    ]);
    const key = (m: Record<string, string>) => `${m.namespace}/${m.pod}`;
    const P = new Map(phase.map((x) => [key(x.metric), x.metric.phase])), R = new Map(restarts.map((x) => [key(x.metric), Number(x.value[1])]));
    const C = new Map(cpu.map((x) => [key(x.metric), Number(x.value[1])])), M = new Map(mem.map((x) => [key(x.metric), Number(x.value[1])]));
    const order: Record<string, number> = { Failed: 0, Pending: 1, Unknown: 2, Running: 3, Succeeded: 4 };
    return info.map((x) => ({ ns: x.metric.namespace, pod: x.metric.pod, node: x.metric.node, phase: P.get(key(x.metric)) || 'Unknown', restarts: R.get(key(x.metric)) ?? 0, cpu: C.get(key(x.metric)) ?? null, mem: M.get(key(x.metric)) ?? null }))
      .sort((a, b) => (order[a.phase] ?? 5) - (order[b.phase] ?? 5) || b.restarts - a.restarts || a.pod.localeCompare(b.pod));
  });
  const rows = (q.data || []).filter((r) => !filter || `${r.pod} ${r.ns} ${r.node}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Panel title={`All pods${q.data ? ` (${q.data.length})` : ''}`} right={<input className="input" style={{ width: 200, height: 30 }} placeholder="Filter pods..." aria-label="Filter pods" value={filter} onChange={(e) => setFilter(e.target.value)} />}>
      {q.isPending ? <StateView kind="loading" skeleton="table" /> : q.isError ? <ErrorState error={q.error} what="Pods" /> : !rows.length ? <StateView kind="empty" title="No pods" /> : (
        <TableWrap label="Pods">
          <table className="tbl compact">
            <thead><tr><th>Pod</th><th>Namespace</th><th>Node</th><th>Status</th><th className="num">Restarts</th><th className="num">CPU (cores)</th><th className="num">Memory</th></tr></thead>
            <tbody>{rows.slice(0, 300).map((r) => (
              <tr key={`${r.ns}/${r.pod}`}>
                <td className="mono">{r.pod}</td><td>{r.ns}</td><td className="dim">{r.node ? <Link to={`/metrics/host/${encodeURIComponent(r.node)}`}>{r.node}</Link> : '-'}</td>
                <td><Pill tone={r.phase === 'Running' ? 'solid-green' : r.phase === 'Failed' ? 'solid-red' : r.phase === 'Succeeded' ? 'muted' : 'solid-orange'}>{r.phase}</Pill></td>
                <td className={`num ${r.restarts >= 5 ? 'c-red' : r.restarts > 0 ? 'c-orange' : ''}`}>{Math.round(r.restarts)}</td>
                <td className="num">{r.cpu === null ? '-' : r.cpu.toFixed(3)}</td><td className="num">{fmt(r.mem, 'bytes')}</td>
              </tr>))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Panel>
  );
}

function K8sServices({ cs }: { cs: string }) {
  const q = useRangeQuery(['k8s-svc', cs], async () => {
    const [info, type] = await Promise.all([vec(`kube_service_info${cs}`), vec(`kube_service_spec_type${cs}`)]);
    const T = new Map(type.map((x) => [`${x.metric.namespace}/${x.metric.service}`, x.metric.type]));
    return info.map((x) => ({ ns: x.metric.namespace, name: x.metric.service, ip: x.metric.cluster_ip, type: T.get(`${x.metric.namespace}/${x.metric.service}`) || '-' })).sort((a, b) => a.ns.localeCompare(b.ns) || a.name.localeCompare(b.name));
  });
  return (
    <Panel title="Services">
      {q.isPending ? <StateView kind="loading" skeleton="table" /> : q.isError ? <ErrorState error={q.error} what="Services" /> : !q.data.length ? <StateView kind="empty" title="No service data" text="kube-state-metrics publishes kube_service_info." /> : (
        <TableWrap label="Services">
          <table className="tbl compact">
            <thead><tr><th>Service</th><th>Namespace</th><th>Type</th><th>Cluster IP</th></tr></thead>
            <tbody>{q.data.map((r) => <tr key={`${r.ns}/${r.name}`}><td><b style={{ fontWeight: 600 }}>{r.name}</b></td><td>{r.ns}</td><td>{r.type === 'LoadBalancer' ? <Pill tone="blue">LoadBalancer</Pill> : <span className="dim">{r.type}</span>}</td><td className="mono dim">{r.ip || '-'}</td></tr>)}</tbody>
          </table>
        </TableWrap>
      )}
    </Panel>
  );
}

function Storage({ and, cs }: { and: string; cs: string }) {
  const q = useRangeQuery(['k8s-pvc', and], async () => {
    const [info, size, used, cap, phase] = await Promise.all([
      vec(`kube_persistentvolumeclaim_info${cs}`), vec(`kube_persistentvolumeclaim_resource_requests_storage_bytes${cs}`),
      vec(`kubelet_volume_stats_used_bytes${cs}`), vec(`kubelet_volume_stats_capacity_bytes${cs}`), vec(`kube_persistentvolumeclaim_status_phase${cs} == 1`),
    ]);
    const k = (m: Record<string, string>) => `${m.namespace}/${m.persistentvolumeclaim}`;
    const S = byKey(size, k), U = byKey(used, k), C = byKey(cap, k), P = new Map(phase.map((x) => [k(x.metric), x.metric.phase]));
    return info.map((x) => { const id = k(x.metric); const c = C.get(id) ?? S.get(id) ?? null, u = U.get(id) ?? null; return { ns: x.metric.namespace, name: x.metric.persistentvolumeclaim, sc: x.metric.storageclass, size: c, used: u, pct: c && u !== null ? (u / c) * 100 : null, phase: P.get(id) || '-' }; })
      .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  });
  return (
    <Panel title="Persistent volume claims">
      {q.isPending ? <StateView kind="loading" skeleton="table" /> : q.isError ? <ErrorState error={q.error} what="Storage" /> : !q.data.length ? <StateView kind="empty" title="No persistent volumes" /> : (
        <TableWrap label="Volumes">
          <table className="tbl compact">
            <thead><tr><th>Claim</th><th>Namespace</th><th>Storage class</th><th>Status</th><th className="num">Size</th><th style={{ width: '28%' }}>Used</th></tr></thead>
            <tbody>{q.data.map((r) => (
              <tr key={`${r.ns}/${r.name}`}>
                <td><b style={{ fontWeight: 600 }}>{r.name}</b></td><td>{r.ns}</td><td className="dim">{r.sc || '-'}</td>
                <td>{r.phase === 'Bound' ? <Pill tone="solid-green">Bound</Pill> : <Pill tone="solid-orange">{r.phase}</Pill>}</td>
                <td className="num">{fmt(r.size, 'bytes')}</td>
                <td>{r.pct === null ? '-' : <div className="hbar" style={{ gridTemplateColumns: '1fr 44px' }}><span className="hbar-track"><span className="hbar-fill" style={{ width: `${Math.min(100, r.pct)}%`, background: r.pct >= 90 ? 'var(--crit)' : r.pct >= 80 ? 'var(--warn)' : 'var(--chart-1)' }} /></span><span className={`hbar-val ${toneClass(r.pct)}`}>{r.pct.toFixed(0)}%</span></div>}</td>
              </tr>))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Panel>
  );
}
const byKey = (r: PromVector, k: (m: Record<string, string>) => string) => new Map(r.map((x) => [k(x.metric), Number(x.value[1])]));

function Events({ cluster }: { cluster: string }) {
  const { canOpen } = useApp();
  const navigate = useNavigate();
  const sel = `{job="kubernetes-events"${cluster ? `, cluster="${escapeLabel(cluster)}"` : ''}}`;
  const q = useRangeQuery(['k8s-events', sel], (r) => api<{ entries: { ts: number; level: string; message: string; labels?: Record<string, string> }[] }>('/logs', { query: { query: sel, ...r, limit: 200 } }), { enabled: canOpen('/logs') });
  const [only, setOnly] = useState<'all' | 'warn'>('all');
  const rows = (q.data?.entries || []).filter((e) => only === 'all' || e.level === 'WARN' || e.level === 'ERROR');
  return (
    <Panel title="Events" right={<>
      <Select className="select select-sm" label="Show" value={only} onChange={setOnly} options={[['all', 'All events'], ['warn', 'Warnings only']]} />
      {canOpen('/logs') && <button className="btn btn-sm" onClick={() => navigate(`/logs?q=${encodeURIComponent(sel)}`)}>Open in Logs</button>}
    </>}>
      {!canOpen('/logs') ? <StateView kind="empty" title="Events come from Loki" text="The Logs module is off or you cannot open it." />
        : q.isPending ? <StateView kind="loading" skeleton="table" /> : q.isError ? <ErrorState error={q.error} what="Events" />
          : !rows.length ? <StateView kind="empty" title="No Kubernetes events in this time range" text='Events are read from Loki with job="kubernetes-events" (for example from kubernetes-event-exporter).' /> : (
            <div className="inv-list">{rows.slice(0, 150).map((e, i) => {
              const m = /^(Normal|Warning) (\S+) (\S+): (.*)$/.exec(e.message);
              return (
                <div key={i} className="inv-row">
                  <span className="mono dim"><Time ms={e.ts} text={timeHM(e.ts)} /></span>
                  <Pill tone={m?.[1] === 'Warning' ? 'solid-orange' : 'muted'}>{m?.[1] || e.level}</Pill>
                  <b style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{m?.[2] || ''}</b>
                  <span className="mono dim" style={{ whiteSpace: 'nowrap' }}>{m?.[3] || ''}</span>
                  <span className="ell" title={m?.[4] || e.message}>{m?.[4] || e.message}</span>
                </div>
              );
            })}</div>
          )}
      {rows.length > 0 && <div className="dim" style={{ fontSize: 11.5, marginTop: 8 }}>Newest first · last event {ago(rows[0].ts)}</div>}
    </Panel>
  );
}
