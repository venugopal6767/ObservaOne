// Metrics Overview: the whole estate at a glance, following the global filters and time range.
// KPI tiles with trends, infrastructure health, top hosts by CPU, resource trends, top services,
// Kubernetes clusters and servers by platform. Every tile and row leads to the detail.
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Server, Monitor, Terminal, Network, Boxes, Cpu, MemoryStick, HardDrive, Activity, Bell, Search } from 'lucide-react';
import { api, type PromMatrix, type PromVector } from '@/lib/api';
import { buildQuery, matchers, metricById, type Filters } from '@/lib/catalog';
import { fmt, short } from '@/lib/format';
import { statusColor, palette, toneClass } from '@/lib/theme';
import { rangeParams, useApp, usePlainQuery, useRangeQuery } from '@/app/AppContext';
import { ErrorState, HealthPill, PageHead, Panel, StateView } from '@/components/ui';
import { Doughnut, Sparkline, TimeChart, LegendRow } from '@/components/charts';
import { FilterBar } from '@/components/FilterBar';
import { AskBar } from './AskBar';

interface Target { job: string; host: string; env: string; os: string; health: string; source: string }
const avgOf = (metric: string, f: Filters) => {
  const e = buildQuery({ metric, filters: f });
  return `avg(${e})`;
};

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
  const alerts = usePlainQuery(['ov-alerts'], () => api<{ active: number; critical: number }>('/alerts/count'), { enabled: moduleOn('alerting') });
  const hostNow = useRangeQuery(['ov-hostnow', JSON.stringify(f)], async () => {
    const q = (m: string) => api<{ result: PromVector }>('/prom/query', { query: { query: buildQuery({ metric: m, filters: f }) } }).then((r) => new Map(r.result.map((x) => [x.metric.host, Number(x.value[1])]))).catch(() => new Map<string, number>());
    const [c, m, d] = await Promise.all([q('cpu'), q('memory'), q('disk')]);
    return { c, m, d };
  });

  const servers = (targets.data || []).filter((t) => (t.job === 'linux' || t.job === 'windows') && (!f.env || t.env === f.env) && (!f.host || t.host === f.host)
    && (!f.platform || f.platform === 'kubernetes' ? true : (f.platform === 'windows') === (t.job === 'windows')));
  const up = servers.filter((s) => s.health === 'up').length;
  const down = servers.filter((s) => s.health === 'down').length;

  // health: critical = down or any value past its critical line; warning = past warn; unknown = not reporting
  const health = { healthy: 0, warning: 0, critical: 0, unknown: 0 };
  for (const s of servers) {
    if (s.health === 'down') { health.critical++; continue; }
    if (s.health !== 'up') { health.unknown++; continue; }
    const vals = [['cpu', hostNow.data?.c.get(s.host)], ['memory', hostNow.data?.m.get(s.host)], ['disk', hostNow.data?.d.get(s.host)]] as const;
    let level = 0;
    for (const [id, v] of vals) { const d = metricById(id)!; if (v === undefined) continue; if (v >= d.crit!) level = 2; else if (v >= d.warn! && level < 1) level = 1; }
    if (level === 2) health.critical++; else if (level === 1) health.warning++; else health.healthy++;
  }
  const topCpu = [...(hostNow.data?.c || new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const trend = (q: { data?: { result: PromMatrix } }) => { const a = first(q.data?.result), b = last(q.data?.result); return a && b !== null ? ((b - a) / Math.abs(a)) * 100 : null; };
  const Kpi = ({ icon, label, value, unit, sub, spark, tone, to, color }: { icon: React.ReactNode; label: string; value: string; unit?: string; sub?: React.ReactNode; spark?: [number, string][]; tone?: string; to?: string; color?: string }) => {
    const body = (
      <>
        <div className="kpi-top"><span className="kpi-ic" style={{ color }}>{icon}</span><span className="kpi-label">{label}</span></div>
        <div className={`kpi-val ${tone || ''}`}>{value}{unit && <small>{unit}</small>}</div>
        {sub && <div className="kpi-sub">{sub}</div>}
        {spark && spark.length > 1 && <div className="kpi-spark"><Sparkline points={spark} lineColor={color} /></div>}
      </>
    );
    return to ? <button className="kpi" onClick={() => navigate(to)}>{body}</button> : <div className="kpi">{body}</div>;
  };
  const pal = palette();
  const pctTone = (v: number | null, id: string) => { const d = metricById(id)!; return v === null ? '' : v >= d.crit! ? 'red' : v >= d.warn! ? 'orange' : ''; };
  const Trend = ({ v }: { v: number | null }) => (v === null || !Number.isFinite(v) ? null : <span className={`trend ${Math.abs(v) < 0.5 ? 'flat' : v > 0 ? 'bad' : 'up'}`}>{v > 0 ? '↑' : '↓'} {Math.abs(v).toFixed(1)}% in range</span>);
  const explore = (metric: string, extra = '') => `/metrics/explore?m=${metric}${extra}`;

  const c = last(cpu.data?.result), m = last(mem.data?.result), d = last(disk.data?.result), n = last(net.data?.result);
  return (
    <>
      <PageHead title="Metrics Overview" sub="Real-time view of your infrastructure, applications and services"
        actions={<Link to="/metrics/explore" className="btn btn-primary"><Search size={14} />Explore metrics</Link>} />
      <AskBar compact />
      <FilterBar />
      <div className="kpi-row">
        <Kpi icon={<Server size={16} />} label="Total servers" value={targets.isPending ? '…' : String(servers.length)} color={pal[0]}
          sub={<><span className="c-green">{up} up</span>{down > 0 && <span className="c-red"> · {down} down</span>}{servers.length - up - down > 0 && <span className="dim"> · {servers.length - up - down} not reporting</span>}</>}
          to={canOpen('/infrastructure') ? '/infrastructure' : undefined} />
        <Kpi icon={<Cpu size={16} />} label="CPU usage" value={c === null ? '-' : c.toFixed(1)} unit={c === null ? '' : '%'} tone={pctTone(c, 'cpu')} sub={<Trend v={trend(cpu)} />} spark={cpu.data?.result[0]?.values} color={pal[0]} to={explore('cpu')} />
        <Kpi icon={<MemoryStick size={16} />} label="Memory usage" value={m === null ? '-' : m.toFixed(1)} unit={m === null ? '' : '%'} tone={pctTone(m, 'memory')} sub={<Trend v={trend(mem)} />} spark={mem.data?.result[0]?.values} color={pal[1]} to={explore('memory')} />
        <Kpi icon={<HardDrive size={16} />} label="Disk usage" value={d === null ? '-' : d.toFixed(1)} unit={d === null ? '' : '%'} tone={pctTone(d, 'disk')} sub={<Trend v={trend(disk)} />} spark={disk.data?.result[0]?.values} color={pal[2]} to={explore('disk', '&fn=max')} />
        <Kpi icon={<Activity size={16} />} label="Network I/O" value={n === null ? '-' : fmt(n, 'Bps')} sub={<Trend v={trend(net)} />} spark={net.data?.result[0]?.values} color={pal[5]} to={explore('network')} />
        {moduleOn('alerting') && <Kpi icon={<Bell size={16} />} label="Active alerts" value={alerts.data ? String(alerts.data.active) : '-'} tone={alerts.data?.active ? 'red' : alerts.data ? 'green' : ''} color={statusColor('crit')}
          sub={alerts.data ? <span>{alerts.data.critical} critical · {alerts.data.active - alerts.data.critical} other</span> : alerts.isError ? 'Alertmanager unavailable' : null} to={canOpen('/alerting') ? '/alerting' : undefined} />}
      </div>

      <div className="grid ov-grid" style={{ marginTop: 14 }}>
        <Panel title="Infrastructure health" right={canOpen('/infrastructure') ? <Link to="/infrastructure">View all</Link> : undefined}>
          {!servers.length ? <StateView kind="empty" title="No servers match these filters" action={canOpen('/agents') ? <Link className="btn btn-sm btn-primary" to="/agents?tab=install">Install an agent</Link> : undefined} /> : (
            <div className="health">
              <div className="donut"><Doughnut labels={['Healthy', 'Warning', 'Critical', 'Unknown']} values={[health.healthy, health.warning, health.critical, health.unknown]} colors={(['ok', 'warn', 'crit', 'unknown'] as const).map(statusColor)} />
                <div className="center"><b>{servers.length}</b><span>Total</span></div></div>
              <div className="health-list">
                {([['Healthy', health.healthy, 'dot-green'], ['Warning', health.warning, 'dot-orange'], ['Critical', health.critical, 'dot-red'], ['Unknown', health.unknown, '']] as const).map(([l, v, dot]) => (
                  <div key={l}><i className={`dot ${dot}`} style={dot ? undefined : { background: 'var(--unknown)' }} />{l}<b>{v} <span className="dim" style={{ fontWeight: 400 }}>({servers.length ? Math.round((v / servers.length) * 100) : 0}%)</span></b></div>
                ))}
              </div>
            </div>
          )}
        </Panel>
        <Panel title="CPU usage by top hosts" right={<Link to={explore('cpu', '&topk=10')}>View all</Link>}>
          {hostNow.isPending ? <StateView kind="loading" /> : !topCpu.length ? <StateView kind="empty" title="No CPU data for these filters" /> : (
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
        <Panel title="Resource trends" right={<span className="hint-chip">Click for logs, traces &amp; alerts</span>}>
          {cpu.isError ? <ErrorState error={cpu.error} what="Trends" /> : (
            <>
              <TimeChart series={[
                { label: 'CPU', points: cpu.data?.result[0]?.values || [] },
                { label: 'Memory', points: mem.data?.result[0]?.values || [] },
                { label: 'Disk', points: disk.data?.result[0]?.values || [] },
              ]} unit="percent" max={100} style={{ height: 170 }} className="chart-box" correlate filters={f} />
              <LegendRow labels={['CPU', 'Memory', 'Disk']} />
            </>
          )}
        </Panel>
      </div>

      <div className="grid ov-grid" style={{ marginTop: 14 }}>
        {moduleOn('services') && <TopServices />}
        <Clusters />
        <ServersByPlatform servers={servers} allTargets={targets.data || []} />
      </div>
      <p className="dim" style={{ fontSize: 11.5, marginTop: 10 }}>Time range: {rangeLabelShort(rangeParams(range))}. Values follow the filters above.</p>
    </>
  );
}

function rangeLabelShort(r: { start: number; end: number }) {
  const h = (r.end - r.start) / 3600;
  return h < 1 ? `${Math.round(h * 60)} minutes` : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`;
}

function TopServices() {
  const { canOpen, filters } = useApp();
  const navigate = useNavigate();
  const q = usePlainQuery(['services'], () => api<{ list: { name: string; rps: number | null; errorRate: number | null; p95: number | null; status: string }[] }>('/services'));
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

function Clusters() {
  const { canOpen, filters } = useApp();
  const m = matchers(filters);
  const sel = m.k8s ? `{${m.k8s.replace(/^, /, '')}}` : '';
  const q = useQuery({
    queryKey: ['ov-clusters', sel],
    queryFn: async () => {
      const get = (query: string) => api<{ result: PromVector }>('/prom/query', { query: { query } }).then((r) => new Map(r.result.map((x) => [x.metric.cluster || '(no cluster label)', Number(x.value[1])]))).catch(() => new Map<string, number>());
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
    <Panel title="Kubernetes clusters" right={q.data?.length ? <Link to="/metrics/kubernetes">View clusters</Link> : undefined}>
      {q.isPending ? <StateView kind="loading" /> : !q.data?.length ? (
        <StateView kind="empty" title="No Kubernetes clusters yet" text="Install the agent on a cluster: it adds kube-state-metrics and node metrics."
          action={canOpen('/agents') ? <Link className="btn btn-sm" to="/agents?tab=kubernetes">Set up Kubernetes</Link> : undefined} />
      ) : (
        <div className="list-rows">
          {q.data.map((c) => (
            <Link key={c.name} className="list-row" to={`/metrics/kubernetes?cluster=${encodeURIComponent(c.name)}`}>
              <span className="pc-icon"><Boxes size={16} /></span>
              <span className="grow"><b>{c.name}</b><span className="dim"> · {c.ready ?? c.nodes}/{c.nodes} nodes ready</span></span>
              <span className={c.running !== null && c.running < c.pods ? 'c-orange' : ''}>{c.running ?? '-'}/{c.pods} pods</span>
            </Link>
          ))}
        </div>
      )}
    </Panel>
  );
}

function ServersByPlatform({ servers, allTargets }: { servers: Target[]; allTargets: Target[] }) {
  const { canOpen } = useApp();
  const count = (job: string) => { const l = servers.filter((s) => s.job === job); return { n: l.length, down: l.filter((s) => s.health === 'down').length }; };
  const vmware = allTargets.filter((t) => /vmware|esxi|vsphere/i.test(t.job));
  const snmp = allTargets.filter((t) => /snmp|network/i.test(t.job));
  const rows: { icon: React.ReactNode; name: string; n: number | null; down: number; to?: string; connect?: string }[] = [
    { icon: <Terminal size={16} />, name: 'Linux servers', ...count('linux'), to: '/infrastructure' },
    { icon: <Monitor size={16} />, name: 'Windows servers', ...count('windows'), to: '/infrastructure' },
    { icon: <Server size={16} />, name: 'VMware ESXi', n: vmware.length || null, down: vmware.filter((t) => t.health === 'down').length, connect: 'Add the VMware exporter to collect ESXi hosts and VMs' },
    { icon: <Network size={16} />, name: 'Network devices', n: snmp.length || null, down: snmp.filter((t) => t.health === 'down').length, connect: 'Add the SNMP exporter to collect switches, routers and firewalls' },
  ];
  return (
    <Panel title="Infrastructure (servers)" right={canOpen('/infrastructure') ? <Link to="/infrastructure">View infrastructure</Link> : undefined}>
      <div className="list-rows">
        {rows.map((r) => {
          const inner = (
            <>
              <span className="pc-icon">{r.icon}</span>
              <span className="grow"><b>{r.name}</b>{r.n === null && <span className="dim" style={{ display: 'block', fontSize: 11.5 }}>{r.connect}</span>}</span>
              {r.n === null ? <span className="pill pill-muted">Not connected</span> : <span>{r.n}{r.down > 0 && <span className="c-red"> · {r.down} down</span>}</span>}
            </>
          );
          return r.to && r.n ? <Link key={r.name} className="list-row" to={r.to}>{inner}</Link> : <div key={r.name} className="list-row">{inner}</div>;
        })}
      </div>
      <p className="dim" style={{ fontSize: 11.5, margin: '8px 0 0' }}>Filtered by environment, platform and host above.</p>
    </Panel>
  );
}
