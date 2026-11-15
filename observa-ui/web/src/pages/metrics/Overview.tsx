// Metrics Overview: the whole estate at a glance, following the global filters and time range.
// KPI tiles with trends, "needs attention" (the top problems right now), resource trends, infrastructure
// and services health, top hosts by CPU, Kubernetes clusters, top services and servers by platform.
// Every tile and row leads to the detail.
import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Server, Monitor, Terminal, Network, Boxes, Cpu, MemoryStick, HardDrive, Activity, Bell, Search, Layers } from 'lucide-react';
import { api, type PromMatrix, type PromVector } from '@/lib/api';
import { buildQuery, matchers, metricById, type Filters } from '@/lib/catalog';
import { ago, changeOf, changeText, fmt, short, type Change } from '@/lib/format';
import { STATUS_META, countStatuses, statusParts } from '@/lib/status';
import { statusColor, palette, toneClass } from '@/lib/theme';
import { rangeParams, useApp, usePlainQuery, useRangeQuery } from '@/app/AppContext';
import { ErrorState, HealthPill, PageHead, Panel, Pill, Select, StateView } from '@/components/ui';
import { Doughnut, Sparkline, TimeChart, LegendRow } from '@/components/charts';
import { FilterBar } from '@/components/FilterBar';
import { AskBar } from './AskBar';

interface Target { job: string; host: string; env: string; os: string; health: string; source: string; lastScrape?: string | null }
interface Service { name: string; rps: number | null; errorRate: number | null; p95: number | null; status: string }
interface Alert { name: string; severity: string; startsAt: string; summary: string; labels: Record<string, string>; state: string }
const avgOf = (metric: string, f: Filters) => `avg(${buildQuery({ metric, filters: f })})`;
const vec = (query: string) => api<{ result: PromVector }>('/prom/query', { query: { query } }).then((r) => r.result).catch(() => [] as PromVector);

function useSeries(key: string, query: string, enabled = true) {
  return useRangeQuery([key, query], (r) => api<{ result: PromMatrix }>('/prom/query_range', { query: { query, ...r, step: Math.max(30, Math.ceil((r.end - r.start) / 60)) } }), { enabled });
}
const last = (m?: PromMatrix) => { const v = m?.[0]?.values; return v?.length ? Number(v[v.length - 1][1]) : null; };
const first = (m?: PromMatrix) => { const v = m?.[0]?.values; return v?.length ? Number(v[0][1]) : null; };

export default function MetricsOverview() {
  const [sp] = useSearchParams();
  // old links (/metrics?q=<PromQL>) open the PromQL editor
  if (sp.get('q')) return <Navigate to={`/metrics/explore?mode=code&q=${encodeURIComponent(sp.get('q')!)}`} replace />;
  return <OverviewBody />;
}

function OverviewBody() {
  const { filters, canOpen, moduleOn, range } = useApp();
  const navigate = useNavigate();
  const f = filters;
  const cpu = useSeries('ov-cpu', avgOf('cpu', f));
  const mem = useSeries('ov-mem', avgOf('memory', f));
  const disk = useSeries('ov-disk', avgOf('disk', f));
  const net = useSeries('ov-net', `sum(${buildQuery({ metric: 'network', filters: f, fn: 'sum' })})`);
  const targets = usePlainQuery(['ov-targets'], () => api<Target[]>('/prom/targets'), { enabled: moduleOn('infrastructure') });
  const alerts = usePlainQuery(['ov-alerts'], () => api<{ firing?: number; active: number; critical: number; warning?: number; muted?: number | null }>('/alerts/count'), { enabled: moduleOn('alerting') });
  const hostNow = useRangeQuery(['ov-hostnow', JSON.stringify(f)], async () => {
    const q = (m: string) => api<{ result: PromVector }>('/prom/query', { query: { query: buildQuery({ metric: m, filters: f }) } }).then((r) => new Map(r.result.map((x) => [x.metric.host, Number(x.value[1])])));  // a failure is an error, never "all healthy"
    const [c, m, d] = await Promise.all([q('cpu'), q('memory'), q('disk')]);
    return { c, m, d };
  });

  const servers = (targets.data || []).filter((t) => (t.job === 'linux' || t.job === 'windows') && (!f.env || t.env === f.env) && (!f.host || t.host === f.host)
    && (!f.platform || f.platform === 'kubernetes' ? true : (f.platform === 'windows') === (t.job === 'windows')));
  const sc = countStatuses(servers); // same words and rules as Infrastructure (lib/status.ts)

  // health: critical = down or any value past its critical line; warning = past warn; unknown = not reporting
  const health = { healthy: 0, warning: 0, critical: 0, unknown: 0 };
  for (const s of servers) {
    if (s.health === 'down') { health.critical++; continue; }
    if (s.health !== 'up') { health.unknown++; continue; }
    if (!hostNow.data) { health.unknown++; continue; } // values not known (loading or the query failed): not counted as healthy
    const vals = [['cpu', hostNow.data?.c.get(s.host)], ['memory', hostNow.data?.m.get(s.host)], ['disk', hostNow.data?.d.get(s.host)]] as const;
    let level = 0;
    for (const [id, v] of vals) { const d = metricById(id)!; if (v === undefined) continue; if (v >= d.crit!) level = 2; else if (v >= d.warn! && level < 1) level = 1; }
    if (level === 2) health.critical++; else if (level === 1) health.warning++; else health.healthy++;
  }
  const topCpu = [...(hostNow.data?.c || new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 5);

  // change over the time range: percentage points for % metrics; no badge when it would be meaningless (format.ts)
  const trend = (q: { data?: { result: PromMatrix } }, unit: string) => changeOf(last(q.data?.result), first(q.data?.result), unit);
  const Kpi = ({ icon, label, value, unit, sub, spark, tone, to, color }: { icon: React.ReactNode; label: string; value: string; unit?: string; sub?: React.ReactNode; spark?: [number, string][]; tone?: string; to?: string; color?: string }) => {
    const body = (
      <>
        <div className="kpi-top"><span className="kpi-ic" style={{ color, background: color ? `color-mix(in srgb, ${color} 16%, transparent)` : undefined }}>{icon}</span><span className="kpi-label">{label}</span></div>
        <div className={`kpi-val ${tone || ''}`}>{value}{unit && <small>{unit}</small>}</div>
        {sub && <div className="kpi-sub">{sub}</div>}
        {spark && spark.length > 1 && <div className="kpi-spark"><Sparkline points={spark} lineColor={color} /></div>}
      </>
    );
    return to ? <button className="kpi" onClick={() => navigate(to)}>{body}</button> : <div className="kpi">{body}</div>;
  };
  const pal = palette();
  const pctTone = (v: number | null, id: string) => { const d = metricById(id)!; return v === null ? '' : v >= d.crit! ? 'red' : v >= d.warn! ? 'orange' : ''; };
  // "up" is bad for resource use: an increase shows red, a decrease green
  const Trend = ({ v }: { v: Change | null }) => (!v ? null : <span className={`trend ${Math.abs(v.value) < 0.5 ? 'flat' : v.value > 0 ? 'bad' : 'up'}`} title={v.unit === 'pts' ? 'Change in percentage points since the start of the time range' : 'Change since the start of the time range'}>{changeText(v)}</span>);
  const explore = (metric: string, extra = '') => `/metrics/explore?m=${metric}${extra}`;

  const c = last(cpu.data?.result), m = last(mem.data?.result), d = last(disk.data?.result), n = last(net.data?.result);
  const warnAlerts = alerts.data ? (alerts.data.warning ?? alerts.data.active - alerts.data.critical) : 0;
  return (
    <>
      <PageHead title="Metrics Overview" sub="Real-time view of your infrastructure, applications and services"
        actions={<Link to="/metrics/explore" className="btn btn-primary"><Search size={14} />Explore metrics</Link>} />
      <AskBar compact />
      <FilterBar />
      <div className="kpi-row">
        <Kpi icon={<Server size={16} />} label="Servers" value={targets.isPending ? '…' : String(servers.length)} color={pal[3]}
          sub={<>{statusParts(sc).map(([k, v], i) => <span key={k} className={k === 'up' ? 'c-green' : k === 'down' || k === 'offline' ? 'c-red' : 'dim'}>{i ? ' · ' : ''}{v} {STATUS_META[k].label.toLowerCase()}</span>)}</>}
          to={canOpen('/infrastructure') ? '/infrastructure' : undefined} />
        <Kpi icon={<Cpu size={16} />} label="CPU usage" value={c === null ? '-' : c.toFixed(1)} unit={c === null ? '' : '%'} tone={pctTone(c, 'cpu')} sub={<Trend v={trend(cpu, 'percent')} />} spark={cpu.data?.result[0]?.values} color={pal[0]} to={explore('cpu')} />
        <Kpi icon={<MemoryStick size={16} />} label="Memory usage" value={m === null ? '-' : m.toFixed(1)} unit={m === null ? '' : '%'} tone={pctTone(m, 'memory')} sub={<Trend v={trend(mem, 'percent')} />} spark={mem.data?.result[0]?.values} color={pal[1]} to={explore('memory')} />
        <Kpi icon={<HardDrive size={16} />} label="Disk usage" value={d === null ? '-' : d.toFixed(1)} unit={d === null ? '' : '%'} tone={pctTone(d, 'disk')} sub={<Trend v={trend(disk, 'percent')} />} spark={disk.data?.result[0]?.values} color={pal[2]} to={explore('disk', '&fn=max')} />
        <Kpi icon={<Activity size={16} />} label="Network I/O" value={n === null ? '-' : fmt(n, 'Bps')} sub={<Trend v={trend(net, 'Bps')} />} spark={net.data?.result[0]?.values} color={pal[5]} to={explore('network')} />
        {moduleOn('alerting') && <Kpi icon={<Bell size={16} />} label="Firing alerts" value={alerts.data ? String(alerts.data.firing ?? alerts.data.active) : '-'} tone={(alerts.data?.firing ?? alerts.data?.active) ? 'red' : alerts.data ? 'green' : ''} color={statusColor('crit')}
          sub={alerts.data ? <span><span className="c-red">{alerts.data.critical} critical</span> · <span className="c-orange">{warnAlerts} warning</span>{alerts.data.muted ? <span className="dim"> · {alerts.data.muted} muted</span> : null}</span> : alerts.isError ? 'Alertmanager unavailable' : null} to={canOpen('/alerting') ? '/alerting' : undefined} />}
      </div>

      <div className="grid ov-top" style={{ marginTop: 14 }}>
        <NeedsAttention servers={servers} hostNow={hostNow.data} />
        <ResourceTrends f={f} cpu={cpu} mem={mem} disk={disk} />
      </div>

      <div className="grid ov-grid4" style={{ marginTop: 14 }}>
        <Panel title="Infrastructure health" right={canOpen('/infrastructure') ? <Link to="/infrastructure">View all</Link> : undefined}>
          {!servers.length ? <StateView kind="empty" title="No servers match these filters" action={canOpen('/agents') ? <Link className="btn btn-sm btn-primary" to="/agents?tab=install">Install an agent</Link> : undefined} /> : (
            <DonutList total={servers.length} rows={[['Healthy', health.healthy, 'ok'], ['Warning', health.warning, 'warn'], ['Critical', health.critical, 'crit'], ['Unknown', health.unknown, 'unknown']]} />
          )}
        </Panel>
        <Panel title="Top 5 hosts by CPU usage" right={<Link to={explore('cpu', '&topk=10')}>View all</Link>}>
          {hostNow.isPending ? <StateView kind="loading" /> : hostNow.isError ? <ErrorState error={hostNow.error} what="CPU by host" /> : !topCpu.length ? <StateView kind="empty" title="No CPU data for these filters" /> : (
            <div className="hbars">
              {topCpu.map(([h, v]) => (
                <Link key={h} className="hbar" to={`/metrics/host/${encodeURIComponent(h)}`} title={`Open ${h}`}>
                  <span className="hbar-name">{h}</span>
                  <span className="hbar-track"><span className="hbar-fill" style={{ width: `${Math.min(100, v)}%`, background: v >= 90 ? 'var(--crit)' : v >= 80 ? 'var(--warn)' : 'var(--chart-1)' }} /></span>
                  <span className={`hbar-val ${toneClass(v)}`}>{v.toFixed(0)}%</span>
                </Link>
              ))}
            </div>
          )}
        </Panel>
        <Clusters />
        {moduleOn('services') ? <ServicesHealth /> : <ServersByPlatform servers={servers} />}
      </div>

      <div className="grid ov-grid2" style={{ marginTop: 14 }}>
        {moduleOn('services') && <TopServices />}
        {moduleOn('services') && <ServersByPlatform servers={servers} />}
      </div>
      <p className="dim" style={{ fontSize: 11.5, marginTop: 10 }}>Time range: {rangeLabelShort(rangeParams(range))}. Values follow the filters above.</p>
    </>
  );
}

function rangeLabelShort(r: { start: number; end: number }) {
  const h = (r.end - r.start) / 3600;
  return h < 1 ? `${Math.round(h * 60)} minutes` : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`;
}

function DonutList({ total, rows }: { total: number; rows: [string, number, 'ok' | 'warn' | 'crit' | 'unknown'][] }) {
  return (
    <div className="health">
      <div className="donut"><Doughnut labels={rows.map((r) => r[0])} values={rows.map((r) => r[1])} colors={rows.map((r) => statusColor(r[2]))} />
        <div className="center"><b>{total}</b><span>Total</span></div></div>
      <div className="health-list">
        {rows.map(([l, v, k]) => (
          <div key={l}><i className="dot" style={{ background: statusColor(k) }} />{l}<b>{v} <span className="dim" style={{ fontWeight: 400 }}>({total ? Math.round((v / total) * 100) : 0}%)</span></b></div>
        ))}
      </div>
    </div>
  );
}

// ---------------- needs attention ----------------
interface Issue { target: string; metric: string; value: string; level: 'critical' | 'warning'; since?: string; to: string; sort: number }
function NeedsAttention({ servers, hostNow }: { servers: Target[]; hostNow?: { c: Map<string, number>; m: Map<string, number>; d: Map<string, number> } }) {
  const { moduleOn, canOpen, filters } = useApp();
  const navigate = useNavigate();
  const services = usePlainQuery(['services'], () => api<{ list: Service[] }>('/services'), { enabled: moduleOn('services') });
  const alerts = usePlainQuery(['alerts-list'], () => api<{ alerts: Alert[] }>('/alerts'), { enabled: moduleOn('alerting') });
  const m = matchers(filters);
  const k8s = useRangeQuery(['ov-k8s-issues', m.k8s], async () => {
    const sel = m.k8s.replace(/^, /, '');
    const [restarts, notReady, pending] = await Promise.all([
      vec(`sum by (cluster, namespace, pod) (increase(kube_pod_container_status_restarts_total{${sel}}[1h])) > 0`),
      vec(`kube_node_status_condition{condition="Ready", status="true"${m.k8s}} == 0`),
      vec(`sum by (cluster, namespace, pod, phase) (kube_pod_status_phase{phase=~"Pending|Failed"${m.k8s}}) > 0`),
    ]);
    return { restarts, notReady, pending };
  }, { enabled: moduleOn('metrics') });

  const al = alerts.data?.alerts.filter((a) => a.state === 'active') || [];
  const sinceFor = (match: (l: Record<string, string>) => boolean) => {
    const hit = al.filter((a) => match(a.labels)).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
    return hit ? ago(hit.startsAt).replace(' ago', '') : undefined;
  };
  const issues: Issue[] = [];
  const host = (h: string) => `/metrics/host/${encodeURIComponent(h)}`;
  for (const s of servers) {
    if (s.health === 'down') { issues.push({ target: s.host, metric: 'Server status', value: 'Down', level: 'critical', since: sinceFor((l) => l.host === s.host && l.alertname === 'HostDown') || (s.lastScrape ? ago(s.lastScrape).replace(' ago', '') : undefined), to: host(s.host), sort: 1000 }); continue; }
    for (const [id, label, map] of [['cpu', 'CPU usage', hostNow?.c], ['memory', 'Memory usage', hostNow?.m], ['disk', 'Disk usage', hostNow?.d]] as const) {
      const v = map?.get(s.host); const d = metricById(id)!;
      if (v === undefined || v < d.warn!) continue;
      issues.push({ target: s.host, metric: label, value: `${v.toFixed(0)}%`, level: v >= d.crit! ? 'critical' : 'warning', since: sinceFor((l) => l.host === s.host), to: host(s.host), sort: v });
    }
  }
  for (const sv of services.data?.list || []) {
    if (filters.service && sv.name !== filters.service) continue;
    if (sv.errorRate !== null && sv.errorRate >= 1) issues.push({ target: sv.name, metric: 'Error rate', value: `${sv.errorRate.toFixed(1)}%`, level: sv.errorRate >= 2 ? 'critical' : 'warning', since: sinceFor((l) => l.service_name === sv.name), to: `/metrics/explore?m=errors&service=${encodeURIComponent(sv.name)}`, sort: 80 + sv.errorRate });
    if (sv.p95 !== null && sv.p95 >= 1000) issues.push({ target: sv.name, metric: 'Latency (P95)', value: fmt(sv.p95, 'ms'), level: sv.p95 >= 5000 ? 'critical' : 'warning', since: sinceFor((l) => l.service_name === sv.name), to: `/metrics/explore?m=latency&service=${encodeURIComponent(sv.name)}`, sort: 70 });
  }
  for (const x of k8s.data?.notReady || []) issues.push({ target: x.metric.node, metric: 'Node not ready', value: x.metric.cluster || '', level: 'critical', since: sinceFor((l) => l.node === x.metric.node), to: `/metrics/kubernetes?cluster=${encodeURIComponent(x.metric.cluster || '')}`, sort: 900 });
  for (const x of k8s.data?.restarts || []) issues.push({ target: x.metric.pod, metric: 'Pod restarts (1h)', value: String(Math.round(Number(x.value[1]))), level: Number(x.value[1]) >= 3 ? 'critical' : 'warning', since: sinceFor((l) => l.pod === x.metric.pod), to: `/metrics/kubernetes?cluster=${encodeURIComponent(x.metric.cluster || '')}&tab=pods`, sort: 60 });
  for (const x of k8s.data?.pending || []) issues.push({ target: x.metric.pod, metric: `Pod ${x.metric.phase}`, value: x.metric.namespace, level: x.metric.phase === 'Failed' ? 'critical' : 'warning', since: sinceFor((l) => l.pod === x.metric.pod), to: `/metrics/kubernetes?cluster=${encodeURIComponent(x.metric.cluster || '')}&tab=pods`, sort: 50 });
  issues.sort((a, b) => (a.level === b.level ? b.sort - a.sort : a.level === 'critical' ? -1 : 1));
  const loading = !hostNow || services.isPending;

  return (
    <Panel title={<>Needs attention <span className="dim" style={{ fontWeight: 400, fontSize: 12 }}>(top issues)</span>{issues.length > 0 && <span className="count-badge red" style={{ marginLeft: 8 }}>{issues.length}</span>}</>}
      right={canOpen('/alerting') ? <Link to="/alerting">View all</Link> : undefined}>
      {loading && !issues.length ? <StateView kind="loading" skeleton="table" /> : !issues.length ? (
        <StateView kind="empty" title="Nothing needs attention" text="No server, service or pod is past its warning line." />
      ) : (
        <table className="tbl compact needs">
          <thead><tr><th>Target</th><th>Metric</th><th className="num">Value</th><th>Status</th><th>Since</th></tr></thead>
          <tbody>
            {issues.slice(0, 6).map((i) => (
              <tr key={`${i.target}|${i.metric}`} className="clickable" onClick={() => navigate(i.to)}>
                <td className="ell" title={i.target}><b style={{ fontWeight: 600 }}>{i.target}</b></td>
                <td>{i.metric}</td>
                <td className={`num ${i.level === 'critical' ? 'c-red' : 'c-orange'}`}>{i.value}</td>
                <td><span className={`sev ${i.level}`}><i />{i.level === 'critical' ? 'Critical' : 'Warning'}</span></td>
                <td className="dim">{i.since || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ---------------- resource trends ----------------
function ResourceTrends({ f, cpu, mem, disk }: { f: Filters; cpu: { data?: { result: PromMatrix }; isError: boolean; error: unknown }; mem: { data?: { result: PromMatrix } }; disk: { data?: { result: PromMatrix } } }) {
  const [which, setWhich] = useState<'all' | 'cpu' | 'memory' | 'disk'>('all');
  const all = [
    { id: 'cpu', label: 'CPU', points: cpu.data?.result[0]?.values || [] },
    { id: 'memory', label: 'Memory', points: mem.data?.result[0]?.values || [] },
    { id: 'disk', label: 'Disk', points: disk.data?.result[0]?.values || [] },
  ];
  const shown = which === 'all' ? all : all.filter((s) => s.id === which);
  const pal = palette();
  return (
    <Panel title="Resource trends" right={<Select className="select select-sm" label="Resource" value={which} onChange={setWhich} options={[['all', 'All resources'], ['cpu', 'CPU'], ['memory', 'Memory'], ['disk', 'Disk']]} />}>
      {cpu.isError ? <ErrorState error={cpu.error} what="Trends" /> : (
        <>
          <TimeChart series={shown.map((s) => ({ label: s.label, points: s.points, color: pal[all.findIndex((a) => a.id === s.id)] }))} unit="percent" max={100} style={{ height: 210 }} className="chart-box" correlate filters={f}
            metric={which === 'all' ? 'cpu' : which} query={which === 'all' ? undefined : avgOf(which, f)} />
          <LegendRow labels={shown.map((s) => s.label)} colors={shown.map((s) => pal[all.findIndex((a) => a.id === s.id)])} />
          <div className="dim" style={{ fontSize: 11.5, marginTop: 4 }}>Average across the servers in the filters. Click a point for logs, traces and alerts at that moment.</div>
        </>
      )}
    </Panel>
  );
}

// ---------------- services ----------------
function ServicesHealth() {
  const { canOpen } = useApp();
  const q = usePlainQuery(['services'], () => api<{ list: Service[] }>('/services'));
  const list = q.data?.list || [];
  const count = (s: string) => list.filter((x) => x.status === s).length;
  return (
    <Panel title="Services health" right={canOpen('/services') ? <Link to="/services">View services</Link> : undefined}>
      {q.isPending ? <StateView kind="loading" /> : q.isError ? <ErrorState error={q.error} what="Services" /> : !list.length ? <StateView kind="empty" title="No services discovered" text="Services appear when applications send OpenTelemetry HTTP metrics." /> : (
        <DonutList total={list.length} rows={[['Healthy', count('healthy'), 'ok'], ['Degraded', count('degraded'), 'warn'], ['Down', count('down'), 'crit'], ['No traffic', list.length - count('healthy') - count('degraded') - count('down'), 'unknown']]} />
      )}
    </Panel>
  );
}

function TopServices() {
  const { canOpen, filters } = useApp();
  const navigate = useNavigate();
  const q = usePlainQuery(['services'], () => api<{ list: Service[] }>('/services'));
  const rows = (q.data?.list || []).filter((s) => !filters.service || s.name === filters.service).sort((a, b) => (b.rps || 0) - (a.rps || 0)).slice(0, 5);
  return (
    <Panel title="Top 5 services by request rate" right={canOpen('/services') ? <Link to="/services">View all</Link> : undefined}>
      {q.isPending ? <StateView kind="loading" skeleton="table" /> : q.isError ? <ErrorState error={q.error} what="Services" /> : !rows.length ? <StateView kind="empty" title="No services discovered" /> : (
        <table className="tbl compact">
          <thead><tr><th>Service</th><th className="num">Req/s</th><th className="num">Errors</th><th className="num">P95</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.name} className="clickable" onClick={() => navigate(`/metrics/explore?m=rps&service=${encodeURIComponent(s.name)}`)}>
                <td>{s.name}</td><td className="num">{short(s.rps)}</td>
                <td className={`num ${s.errorRate === null ? 'dim' : s.errorRate >= 5 ? 'c-red' : s.errorRate >= 1 ? 'c-orange' : ''}`}>{s.errorRate === null ? '-' : `${s.errorRate.toFixed(1)}%`}</td>
                <td className="num">{s.p95 === null ? '-' : fmt(s.p95, 'ms')}</td><td><HealthPill health={s.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ---------------- kubernetes ----------------
function Clusters() {
  const { canOpen, filters } = useApp();
  const m = matchers(filters);
  const sel = m.k8s ? `{${m.k8s.replace(/^, /, '')}}` : '';
  const q = useQuery({
    queryKey: ['ov-clusters', sel],
    queryFn: async () => {
      const get = (query: string) => vec(query).then((r) => new Map(r.map((x) => [x.metric.cluster || '(no cluster label)', Number(x.value[1])])));
      const [nodes, ready, pods, running] = await Promise.all([
        get(`count by (cluster) (kube_node_info${sel})`),
        get(`sum by (cluster) (kube_node_status_condition{condition="Ready", status="true"${m.k8s}})`),
        get(`count by (cluster) (kube_pod_info${sel})`),
        get(`sum by (cluster) (kube_pod_status_phase{phase="Running"${m.k8s}})`),
      ]);
      return [...nodes.keys()].sort().map((c) => ({ name: c, nodes: nodes.get(c) || 0, ready: ready.get(c) ?? null, pods: pods.get(c) || 0, running: running.get(c) ?? null }));
    },
    staleTime: 30_000,
  });
  return (
    <Panel title="Kubernetes clusters" right={q.data?.length ? <Link to="/metrics/kubernetes">View all</Link> : undefined}>
      {q.isPending ? <StateView kind="loading" /> : !q.data?.length ? (
        <StateView kind="empty" title="No Kubernetes clusters yet" text="Install the agent on a cluster: it adds kube-state-metrics and node metrics."
          action={canOpen('/agents') ? <Link className="btn btn-sm" to="/agents?tab=kubernetes">Set up Kubernetes</Link> : undefined} />
      ) : (
        <div className="list-rows">
          {q.data.map((c) => {
            const ok = c.ready === c.nodes && c.running === c.pods;
            return (
              <Link key={c.name} className="list-row" to={`/metrics/kubernetes?cluster=${encodeURIComponent(c.name)}`}>
                <span className="pc-icon"><Boxes size={16} /></span>
                <span className="grow"><b>{c.name}</b><span className="dim" style={{ display: 'block', fontSize: 11.5 }}>{c.ready ?? c.nodes}/{c.nodes} nodes ready</span></span>
                <span className={ok ? 'c-green' : 'c-orange'} title="Running pods / all pods">{c.running ?? '-'}/{c.pods} {ok ? '✓' : '!'}</span>
              </Link>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function ServersByPlatform({ servers }: { servers: Target[] }) {
  const { canOpen } = useApp();
  const extra = useRangeQuery(['ov-platforms'], async () => {
    const [esxi, esxiDown, dev, devDown] = await Promise.all([
      vec('count(vmware_host_power_state)'), vec('count(vmware_host_power_state == 0)'),
      vec('count(count by (instance) (sysUpTime))'), vec('count(up{job="snmp"} == 0)'),
    ]);
    const n = (r: PromVector) => (r[0] ? Number(r[0].value[1]) : null);
    return { esxi: n(esxi), esxiDown: n(esxiDown) || 0, dev: n(dev), devDown: n(devDown) || 0 };
  });
  const count = (job: string) => { const l = servers.filter((s) => s.job === job); return { n: l.length, down: l.filter((s) => s.health === 'down').length }; };
  const rows: { icon: React.ReactNode; name: string; n: number | null; down: number; to?: string; connect?: string }[] = [
    { icon: <Terminal size={16} />, name: 'Linux servers', ...count('linux'), to: '/infrastructure' },
    { icon: <Monitor size={16} />, name: 'Windows servers', ...count('windows'), to: '/infrastructure' },
    { icon: <Layers size={16} />, name: 'VMware ESXi hosts', n: extra.data?.esxi ?? null, down: extra.data?.esxiDown || 0, to: '/metrics/explore?m=esxi_mem', connect: 'Add the VMware exporter to collect ESXi hosts and VMs' },
    { icon: <Network size={16} />, name: 'Network devices', n: extra.data?.dev ?? null, down: extra.data?.devDown || 0, to: '/metrics/explore?m=if_traffic', connect: 'Add the SNMP exporter to collect switches, routers and firewalls' },
  ];
  return (
    <Panel title="Infrastructure by platform" right={canOpen('/infrastructure') ? <Link to="/infrastructure">View infrastructure</Link> : undefined}>
      <div className="list-rows">
        {rows.map((r) => {
          const inner = (
            <>
              <span className="pc-icon">{r.icon}</span>
              <span className="grow"><b>{r.name}</b>{r.n === null && <span className="dim" style={{ display: 'block', fontSize: 11.5 }}>{r.connect}</span>}</span>
              {r.n === null ? <Pill tone="muted">Not connected</Pill> : <span>{r.n}{r.down > 0 && <span className="c-red"> · {r.down} down</span>}</span>}
            </>
          );
          return r.to && r.n ? <Link key={r.name} className="list-row" to={r.to}>{inner}</Link> : <div key={r.name} className="list-row">{inner}</div>;
        })}
      </div>
    </Panel>
  );
}

