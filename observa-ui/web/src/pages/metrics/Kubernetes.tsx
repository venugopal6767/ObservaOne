// Kubernetes cluster view: health, CPU and memory against what the nodes can give, pods, nodes,
// namespaces and pods that need attention. Uses cAdvisor + kube-state-metrics sent by the agent.
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Boxes, Bell } from 'lucide-react';
import { api, type PromMatrix, type PromVector } from '@/lib/api';
import { escapeLabel, fmt } from '@/lib/format';
import { palette, toneClass } from '@/lib/theme';
import { useApp, useRangeQuery } from '@/app/AppContext';
import { ErrorState, PageHead, Panel, Pill, Select, StateView, Tabs, TableWrap, useDialogs } from '@/components/ui';
import { Sparkline, TimeChart, LegendRow } from '@/components/charts';
import { useLabelValues } from '@/components/FilterBar';
import { AlertWizard } from '@/components/AlertWizard';

type Tab = 'overview' | 'nodes' | 'namespaces' | 'pods';
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
  const [tab, setTab] = useState<Tab>('overview');
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
          {list.length > 1 && <Select className="select" label="Cluster" options={list} value={cluster} onChange={(v) => setParams({ cluster: v }, { replace: true })} />}
          {canOpen('/alerting') && <button className="btn btn-primary" onClick={() => open((close) => <AlertWizard onClose={close} metric="pod_restarts" filters={{ cluster }} value={3} />)}><Bell size={14} />Create alert</button>}
        </>} />
      <div className="toolbar"><Tabs items={[['overview', 'Overview'], ['nodes', 'Nodes'], ['namespaces', 'Namespaces'], ['pods', 'Pods needing attention']]} active={tab} onChange={setTab} label="Kubernetes sections" /></div>

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
        </>
      )}
      {tab === 'nodes' && <Nodes and={and} cs={cs} />}
      {tab === 'namespaces' && <Namespaces and={and} />}
      {tab === 'pods' && <Pods and={and} />}
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
      <Panel title="Restarted in the last hour">
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
