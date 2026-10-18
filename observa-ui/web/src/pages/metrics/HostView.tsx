// One server end to end: status, KPIs, CPU (with yesterday and a threshold) / memory / disk / network /
// processes / services / alerts, its logs and traces, and "create alert" for any of its metrics.
// Linux (node_exporter) and Windows (windows_exporter).
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Bell, FileText, Waypoints, Terminal, Monitor } from 'lucide-react';
import { color } from '@/lib/theme';
import { api, type PromMatrix, type PromVector } from '@/lib/api';
import { buildQuery, type Filters } from '@/lib/catalog';
import { ago, dateTime, escapeLabel, fmt, legendName, timeHM } from '@/lib/format';
import { palette, toneClass } from '@/lib/theme';
import { useApp, usePlainQuery, useRangeQuery } from '@/app/AppContext';
import { ErrorState, HealthPill, PageHead, Panel, Pill, Select, StateView, Tabs, TableWrap, Time, useDialogs } from '@/components/ui';
import { Sparkline, TimeChart, LegendRow } from '@/components/charts';
import { AlertWizard } from '@/components/AlertWizard';

type Tab = 'overview' | 'cpu' | 'memory' | 'disk' | 'network' | 'processes' | 'services' | 'alerts' | 'logs';
interface Target { job: string; host: string; os: string; env: string; role: string; health: string; lastScrape: string | null; instance: string; source: string; lastError: string }

function useRange(key: string, query: string) {
  return useRangeQuery(['host', key, query], (r) => api<{ result: PromMatrix }>('/prom/query_range', { query: { query, ...r } }));
}
function useInstant(key: string, query: string) {
  return useRangeQuery(['host-i', key, query], () => api<{ result: PromVector }>('/prom/query', { query: { query } }));
}

export default function HostView() {
  const { host = '' } = useParams();
  const { canOpen } = useApp();
  const { open } = useDialogs();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'overview';
  const setTab = (t: Tab) => { const n = new URLSearchParams(sp); if (t === 'overview') n.delete('tab'); else n.set('tab', t); setSp(n, { replace: true }); };
  const targets = usePlainQuery(['ov-targets'], () => api<Target[]>('/prom/targets'));
  const t = (targets.data || []).find((x) => x.host === host && (x.job === 'linux' || x.job === 'windows'));
  const win = t?.os === 'windows' || t?.job === 'windows';
  const f: Filters = { host, platform: t ? (win ? 'windows' : 'linux') : '' };
  const h = `host="${escapeLabel(host)}"`;
  const uptime = useInstant('up', win ? `windows_system_system_up_time{${h}}` : `time() - node_boot_time_seconds{${h}}`);
  const upSec = uptime.data?.result[0] ? (win ? Date.now() / 1000 - Number(uptime.data.result[0].value[1]) : Number(uptime.data.result[0].value[1])) : null;

  const alert = (metric: string) => open((close) => <AlertWizard onClose={close} metric={metric} filters={f} />);
  const tabs: [Tab, string][] = [['overview', 'Overview'], ['cpu', 'CPU'], ['memory', 'Memory'], ['disk', 'Disk'], ['network', 'Network'], ['processes', 'Processes'], ['services', 'Services']];
  if (canOpen('/alerting')) tabs.push(['alerts', 'Alerts']);
  if (canOpen('/logs')) tabs.push(['logs', 'Logs']);

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">{canOpen('/infrastructure') ? <Link to="/infrastructure">Infrastructure</Link> : <Link to="/metrics">Metrics</Link>} › {t ? (win ? 'Windows servers' : 'Linux servers') : 'Servers'} › <span>{host}</span></nav>
      <PageHead
        title={<>{win ? <Monitor size={22} /> : <Terminal size={22} />}{host}{t && <HealthPill health={t.health} detail={t.lastError || undefined} />}</>}
        sub={t ? [win ? 'Windows server' : 'Linux server', t.env, t.role, t.source === 'agent' ? 'via ObservaOne Agent' : t.instance, upSec ? `Uptime ${fmt(upSec, 's')}` : '', t.lastScrape ? `last data ${ago(t.lastScrape)}` : ''].filter(Boolean).join(' · ') : targets.isPending ? 'Loading…' : 'This host is not in the target list (it may only send logs or traces).'}
        actions={<>
          {canOpen('/logs') && <button className="btn" onClick={() => navigate(`/logs?q=${encodeURIComponent(`{${h}}`)}`)}><FileText size={14} />View logs</button>}
          {canOpen('/traces') && <button className="btn" onClick={() => navigate(`/traces?q=${encodeURIComponent(`host.name=${host}`)}`)}><Waypoints size={14} />View traces</button>}
          {canOpen('/alerting') && <button className="btn btn-primary" onClick={() => alert('cpu')}><Bell size={14} />Create alert</button>}
        </>} />
      <div className="toolbar"><Tabs items={tabs} active={tab} onChange={setTab} label="Host sections" /></div>

      {tab === 'overview' && <HostOverview f={f} h={h} win={win} onAlert={alert} />}
      {tab === 'cpu' && (
        <>
          <CpuTab f={f} onAlert={() => alert('cpu')} />
          <div style={{ marginTop: 14 }}><ChartPanel title="CPU by core" unit="percent" max={100} f={f} query={win ? `100 - rate(windows_cpu_time_total{mode="idle", ${h}}[5m]) * 100` : `100 - rate(node_cpu_seconds_total{mode="idle", ${h}}[5m]) * 100`} legend={win ? 'core {{core}}' : 'core {{cpu}}'} metric="cpu" /></div>
        </>
      )}
      {tab === 'memory' && <ChartPanel title="Memory used and available" unit="bytes" f={f} metric="memory"
        query={win ? `label_replace(windows_memory_physical_total_bytes{${h}} - windows_memory_available_bytes{${h}}, "kind", "used", "", "") or label_replace(windows_memory_available_bytes{${h}}, "kind", "available", "", "")`
          : `label_replace(node_memory_MemTotal_bytes{${h}} - node_memory_MemAvailable_bytes{${h}}, "kind", "used", "", "") or label_replace(node_memory_MemAvailable_bytes{${h}}, "kind", "available", "", "")`} legend="{{kind}}" />}
      {tab === 'disk' && <DiskTab h={h} win={win} f={f} />}
      {tab === 'network' && <ChartPanel title="Network traffic per interface (in + out)" unit="Bps" f={f} metric="network"
        query={win ? `rate(windows_net_bytes_total{${h}}[5m])` : `rate(node_network_receive_bytes_total{device!~"lo|veth.*|docker.*|br-.*", ${h}}[5m]) + rate(node_network_transmit_bytes_total{device!~"lo|veth.*|docker.*|br-.*", ${h}}[5m])`}
        legend={win ? '{{nic}}' : '{{device}}'} />}
      {tab === 'processes' && <Processes h={h} win={win} full />}
      {tab === 'services' && <Services h={h} win={win} />}
      {tab === 'alerts' && <HostAlerts host={host} onCreate={() => alert('cpu')} />}
      {tab === 'logs' && <HostLogs h={h} />}
    </>
  );
}

function HostOverview({ f, h, win, onAlert }: { f: Filters; h: string; win: boolean; onAlert: (m: string) => void }) {
  const pal = palette();
  const cpu = useRange('cpu', buildQuery({ metric: 'cpu', filters: f }));
  const mem = useRange('mem', buildQuery({ metric: 'memory', filters: f }));
  const disk = useRange('disk', buildQuery({ metric: 'disk', filters: f, fn: 'max' }));
  const net = useRange('net', buildQuery({ metric: 'network', filters: f, fn: 'sum' }));
  const lastV = (q: { data?: { result: PromMatrix } }) => { const v = q.data?.result[0]?.values; return v?.length ? Number(v[v.length - 1][1]) : null; };
  const tiles: [string, typeof cpu, string, string][] = [['CPU usage', cpu, 'percent', 'cpu'], ['Memory usage', mem, 'percent', 'memory'], ['Disk usage', disk, 'percent', 'disk'], ['Network in/out', net, 'Bps', 'network']];
  return (
    <>
      <div className="kpi-row k4">
        {tiles.map(([label, q, unit, id], i) => {
          const v = lastV(q);
          return (
            <div key={label} className="kpi">
              <div className="kpi-top"><span className="kpi-label">{label}</span><button className="linkish dim" style={{ marginLeft: 'auto', fontSize: 11.5 }} onClick={() => onAlert(id)}>Alert…</button></div>
              <div className={`kpi-val ${unit === 'percent' ? toneClass(v) : ''}`}>{v === null ? '-' : fmt(v, unit)}</div>
              {q.data?.result[0]?.values && q.data.result[0].values.length > 1 && <div className="kpi-spark"><Sparkline points={q.data.result[0].values} lineColor={pal[i]} /></div>}
            </div>
          );
        })}
      </div>
      <div className="grid host-grid" style={{ marginTop: 14 }}>
        <Panel title="CPU and memory" right={<span className="hint-chip">Click for logs, traces &amp; alerts</span>}>
          {cpu.isError ? <ErrorState error={cpu.error} what="CPU" /> : (
            <>
              <TimeChart series={[{ label: 'CPU %', points: cpu.data?.result[0]?.values || [] }, { label: 'Memory %', points: mem.data?.result[0]?.values || [] }]} unit="percent" max={100} className="chart-box" correlate correlateHint={{ host: f.host }} metric="cpu" filters={f} query={buildQuery({ metric: 'cpu', filters: f })} />
              <LegendRow labels={['CPU %', 'Memory %']} />
            </>
          )}
        </Panel>
        <Processes h={h} win={win} />
      </div>
    </>
  );
}

function ChartPanel({ title, query, unit, legend, f, max, metric }: { title: string; query: string; unit: string; legend: string; f: Filters; max?: number; metric: string }) {
  const q = useRange(title, query);
  const s = (q.data?.result || []).slice(0, 16).map((r) => ({ label: legendName(r.metric, legend), points: r.values }));
  return (
    <Panel title={title}>
      {q.isPending ? <StateView kind="loading" skeleton="chart" /> : q.isError ? <ErrorState error={q.error} what={title} /> : !s.length ? <StateView kind="empty" title="No data for this host" /> : (
        <>
          <TimeChart series={s} unit={unit} max={max} className="chart-box lg" correlate correlateHint={{ host: f.host }} query={query} metric={metric} filters={f} />
          <LegendRow labels={s.map((x) => x.label)} />
        </>
      )}
    </Panel>
  );
}

function DiskTab({ h, win, f }: { h: string; win: boolean; f: Filters }) {
  const q = useInstant('disks', win
    ? `100 - 100 * windows_logical_disk_free_bytes{volume!~"HarddiskVolume.*", ${h}} / windows_logical_disk_size_bytes{volume!~"HarddiskVolume.*", ${h}}`
    : `100 - 100 * node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*", ${h}} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*", ${h}}`);
  const rows = (q.data?.result || []).map((r) => ({ name: r.metric.volume || r.metric.mountpoint || r.metric.device || legendName(r.metric), v: Number(r.value[1]) })).sort((a, b) => b.v - a.v);
  return (
    <div className="grid cols-2">
      <Panel title="Space used per disk" right={<Pill tone="muted" title="Current value, not the selected time range">Now</Pill>}>
        {q.isPending ? <StateView kind="loading" /> : q.isError ? <ErrorState error={q.error} what="Disks" /> : !rows.length ? <StateView kind="empty" title="No disk data for this host" /> : (
          <div className="hbars">
            {rows.map((r) => (
              <div key={r.name} className="hbar"><span className="hbar-name mono">{r.name}</span>
                <span className="hbar-track"><span className="hbar-fill" style={{ width: `${Math.min(100, r.v)}%`, background: r.v >= 90 ? 'var(--crit)' : r.v >= 80 ? 'var(--warn)' : 'var(--chart-1)' }} /></span>
                <span className={`hbar-val ${toneClass(r.v)}`}>{r.v.toFixed(0)}%</span></div>
            ))}
          </div>
        )}
      </Panel>
      <ChartPanel title="Disk I/O (read + write)" unit="Bps" f={f} metric="disk" legend={win ? '{{volume}}' : '{{device}}'}
        query={win ? `rate(windows_logical_disk_read_bytes_total{${h}}[5m]) + rate(windows_logical_disk_write_bytes_total{${h}}[5m])` : `rate(node_disk_read_bytes_total{${h}}[5m]) + rate(node_disk_written_bytes_total{${h}}[5m])`} />
    </div>
  );
}

function Processes({ h, win, full }: { h: string; win: boolean; full?: boolean }) {
  const n = full ? 25 : 6;
  const cpu = useInstant('pcpu', win ? `topk(${n}, sum by (process) (rate(windows_process_cpu_time_total{${h}}[5m])) * 100)` : `topk(${n}, sum by (groupname) (rate(namedprocess_namegroup_cpu_seconds_total{${h}}[5m])) * 100)`);
  const mem = useInstant('pmem', win ? `sum by (process) (windows_process_working_set_private_bytes{${h}})` : `sum by (groupname) (namedprocess_namegroup_memory_bytes{memtype="resident", ${h}})`);
  const memMap = new Map((mem.data?.result || []).map((r) => [r.metric.process || r.metric.groupname, Number(r.value[1])]));
  const rows = (cpu.data?.result || []).map((r) => ({ name: r.metric.process || r.metric.groupname || '?', cpu: Number(r.value[1]), mem: memMap.get(r.metric.process || r.metric.groupname) })).sort((a, b) => b.cpu - a.cpu);
  return (
    <Panel title="Top processes by CPU" right={<Pill tone="muted" title="Current value">Now</Pill>}>
      {cpu.isPending ? <StateView kind="loading" skeleton="table" /> : cpu.isError ? <ErrorState error={cpu.error} what="Processes" /> : !rows.length ? (
        <StateView kind="empty" title="No process data for this host" text={win ? 'Enable the process collector in windows_exporter to see processes.' : 'Install process-exporter (namedprocess) next to node_exporter to see processes.'} />
      ) : (
        <TableWrap label="Processes">
          <table className="tbl compact">
            <thead><tr><th>Process</th><th className="num">CPU</th><th className="num">Memory</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.name}><td className="mono">{r.name}</td><td className={`num ${toneClass(r.cpu)}`}>{r.cpu.toFixed(1)}%</td><td className="num">{r.mem === undefined ? '-' : fmt(r.mem, 'bytes')}</td></tr>)}</tbody>
          </table>
        </TableWrap>
      )}
    </Panel>
  );
}

function HostLogs({ h }: { h: string }) {
  const navigate = useNavigate();
  const q = useRangeQuery(['host-logs', h], (r) => api<{ entries: { ts: number; level: string; service: string; message: string }[] }>('/logs', { query: { query: `{${h}}`, ...r, limit: 100 } }));
  return (
    <Panel title="Recent log lines" right={<button className="btn btn-sm" onClick={() => navigate(`/logs?q=${encodeURIComponent(`{${h}}`)}`)}><FileText size={13} />Open in Logs</button>}>
      {q.isPending ? <StateView kind="loading" skeleton="table" /> : q.isError ? <ErrorState error={q.error} what="Logs" /> : !q.data.entries.length ? <StateView kind="empty" title="No logs from this host in the selected range" /> : (
        <div className="inv-list">{q.data.entries.slice(0, 60).map((e, i) => (
          <div key={i} className="inv-row"><span className="mono dim"><Time ms={e.ts} text={timeHM(e.ts)} /></span><Pill tone={e.level === 'ERROR' ? 'solid-red' : e.level === 'WARN' ? 'solid-orange' : 'muted'}>{e.level}</Pill><span className="ell" title={e.message}>{e.message}</span></div>
        ))}</div>
      )}
    </Panel>
  );
}

// CPU now vs yesterday, with the warning line: the "is this normal?" view
function CpuTab({ f, onAlert }: { f: Filters; onAlert: () => void }) {
  const query = buildQuery({ metric: 'cpu', filters: f });
  const [cmp, setCmp] = useState<'1d' | '1w' | ''>('1d');
  const shift = cmp === '1d' ? 86400 : cmp === '1w' ? 604800 : 0;
  const now = useRange('cpu-now', query);
  const before = useRangeQuery(['host', 'cpu-before', query, shift], (r) => api<{ result: PromMatrix }>('/prom/query_range', { query: { query, start: r.start - shift, end: r.end - shift } }), { enabled: !!shift });
  const pts = now.data?.result[0]?.values || [];
  const old = (before.data?.result[0]?.values || []).map(([t, v]) => [t + shift, v] as [number, string]);
  const cur = pts.length ? Number(pts[pts.length - 1][1]) : null;
  const prev = old.length ? Number(old[old.length - 1][1]) : null;
  const delta = cur !== null && prev ? ((cur - prev) / prev) * 100 : null;
  const thr = 80;
  const label = cmp === '1d' ? 'yesterday' : 'last week';
  return (
    <Panel title="CPU usage" right={<><Select className="select select-sm" label="Compare" value={cmp} onChange={setCmp} options={[['1d', 'Compare: yesterday'], ['1w', 'Compare: last week'], ['', 'No comparison']]} /><button className="btn btn-sm" onClick={onAlert}><Bell size={13} />Alert…</button></>}>
      <div className="big-now">
        <span className={`big-num ${toneClass(cur)}`}>{cur === null ? '-' : `${cur.toFixed(0)}%`}</span>
        {delta !== null && Number.isFinite(delta) && <span className={`trend ${delta > 0 ? 'bad' : 'up'}`}>{delta > 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(0)}% vs {label}</span>}
        <span className="dim" style={{ fontSize: 12 }}>Threshold {thr}%{cur !== null && cur >= thr ? <b className="c-red"> · above the threshold</b> : ''}</span>
      </div>
      {now.isPending ? <StateView kind="loading" skeleton="chart" /> : now.isError ? <ErrorState error={now.error} what="CPU" /> : !pts.length ? <StateView kind="empty" title="No CPU data for this host" /> : (
        <>
          <TimeChart series={[
            { label: 'CPU usage', points: pts },
            ...(shift ? [{ label: `CPU ${label}`, points: old, dashed: true, color: color('muted') }] : []),
            { label: `Threshold (${thr}%)`, points: [[pts[0][0], thr], [pts[pts.length - 1][0], thr]] as [number, number][], dashed: true, color: color('crit') },
          ]} unit="percent" max={100} className="chart-box lg" correlate correlateHint={{ host: f.host }} metric="cpu" filters={f} query={query} />
          <LegendRow labels={['CPU usage', ...(shift ? [`CPU ${label}`] : []), `Threshold (${thr}%)`]} colors={[undefined, ...(shift ? [color('muted')] : []), color('crit')]} />
        </>
      )}
    </Panel>
  );
}

function Services({ h, win }: { h: string; win: boolean }) {
  const q = useInstant('svc', win ? `windows_service_state{${h}} == 1` : `node_systemd_unit_state{state=~"active|failed|activating", ${h}} == 1`);
  const rows = (q.data?.result || []).map((r) => ({ name: r.metric.name, state: r.metric.state })).sort((a, b) => (a.state === 'failed' || a.state === 'stopped' ? -1 : 1) - (b.state === 'failed' || b.state === 'stopped' ? -1 : 1) || a.name.localeCompare(b.name));
  return (
    <Panel title={win ? 'Windows services' : 'Systemd services'} right={<Pill tone="muted" title="Current state">Now</Pill>}>
      {q.isPending ? <StateView kind="loading" skeleton="table" /> : q.isError ? <ErrorState error={q.error} what="Services" /> : !rows.length ? (
        <StateView kind="empty" title="No service data for this host" text={win ? 'Enable the service collector in windows_exporter.' : 'Start node_exporter with --collector.systemd to see services.'} />
      ) : (
        <TableWrap label="Services">
          <table className="tbl compact">
            <thead><tr><th>Service</th><th>State</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.name}><td className="mono">{r.name}</td><td>{r.state === 'active' || r.state === 'running' ? <Pill tone="solid-green">{r.state}</Pill> : r.state === 'failed' ? <Pill tone="solid-red">failed</Pill> : <Pill tone="solid-orange">{r.state}</Pill>}</td></tr>
            ))}</tbody>
          </table>
        </TableWrap>
      )}
    </Panel>
  );
}

function HostAlerts({ host, onCreate }: { host: string; onCreate: () => void }) {
  const navigate = useNavigate();
  const q = usePlainQuery(['alerts-list'], () => api<{ alerts: { fingerprint: string; name: string; severity: string; state: string; startsAt: string; summary: string; labels: Record<string, string> }[] }>('/alerts'));
  const rows = (q.data?.alerts || []).filter((a) => a.labels.host === host || a.labels.instance?.split(':')[0] === host || a.labels.node === host);
  return (
    <Panel title="Alerts for this server" right={<><button className="btn btn-sm" onClick={onCreate}><Bell size={13} />Create alert</button><button className="btn btn-sm" onClick={() => navigate('/alerting')}>All alerts</button></>}>
      {q.isPending ? <StateView kind="loading" skeleton="table" /> : q.isError ? <ErrorState error={q.error} what="Alerts" /> : !rows.length ? <StateView kind="empty" title="No alerts for this server" text="Nothing is firing for it right now." /> : (
        <TableWrap label="Alerts">
          <table className="tbl compact">
            <thead><tr><th>Severity</th><th>Alert</th><th>Summary</th><th>State</th><th>Since</th></tr></thead>
            <tbody>{rows.map((a) => (
              <tr key={a.fingerprint}>
                <td><Pill tone={a.severity === 'critical' ? 'solid-red' : a.severity === 'warning' ? 'solid-orange' : 'solid-blue'}>{a.severity}</Pill></td>
                <td><b style={{ fontWeight: 600 }}>{a.name}</b></td><td className="dim">{a.summary}</td>
                <td>{a.state === 'suppressed' ? <Pill tone="muted">Silenced</Pill> : <Pill tone="red">Firing</Pill>}</td>
                <td className="dim"><Time ms={Date.parse(a.startsAt)} text={`${ago(a.startsAt)} · ${dateTime(Date.parse(a.startsAt)).slice(11, 16)}`} /></td>
              </tr>
            ))}</tbody>
          </table>
        </TableWrap>
      )}
    </Panel>
  );
}
