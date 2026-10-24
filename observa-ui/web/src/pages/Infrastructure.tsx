// Infrastructure: every server (scraped by Prometheus or sending through the ObservaOne Agent), as a
// table or a host map coloured by CPU, memory or free disk. Problems sort first.
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Plus } from 'lucide-react';
import { api, type PromVector } from '@/lib/api';
import { fmt, ago } from '@/lib/format';
import { thresholdColor, readableOn, toneClass } from '@/lib/theme';
import { useApp, usePlainQuery } from '@/app/AppContext';
import { ErrorState, HealthPill, PageHead, Select, StateBanner, StateView, TableFoot, TableWrap, Tabs, Time, usePager } from '@/components/ui';
import { STATUS_META, STATUS_RANK, asStatus, countStatuses, showsLive, statusParts } from '@/lib/status';

// same queries as the server (src/queries.js): agent values only when fresh, so a stopped agent shows "-"
const CPU = "clamp(max by (host) (last_over_time(observaone_cpu_utilization_ratio[120s])) * 100, 0, 100) or (clamp(100 * (1 - sum by (host) (rate(windows_cpu_time_total{mode=\"idle\",core!=\"\"}[5m])) / sum by (host) (rate(windows_cpu_time_total{core!=\"\"}[5m]))), 0, 100) and on (host) (max by (host) (timestamp(windows_cpu_time_total{mode=\"idle\",core!=\"\"})) > time() - 120)) or (clamp(100 * (1 - sum by (host) (rate(node_cpu_seconds_total{mode=\"idle\",agent_id=\"\"}[5m])) / sum by (host) (rate(node_cpu_seconds_total{agent_id=\"\"}[5m]))), 0, 100) and on (host) (max by (host) (timestamp(node_cpu_seconds_total{mode=\"idle\",agent_id=\"\"})) > time() - 120))";
const MEM = "max by (host) (100 * last_over_time(observaone_memory_utilization_ratio[120s])) or (max by (host) (100 * (1 - windows_memory_available_bytes / windows_memory_physical_total_bytes)) and on (host) (max by (host) (timestamp(windows_memory_available_bytes)) > time() - 120)) or (max by (host) (100 * (1 - node_memory_MemAvailable_bytes{agent_id=\"\"} / node_memory_MemTotal_bytes{agent_id=\"\"})) and on (host) (max by (host) (timestamp(node_memory_MemAvailable_bytes{agent_id=\"\"})) > time() - 120))";
const DISK = "min by (host) (100 * (1 - last_over_time(observaone_filesystem_utilization_ratio{fstype!~\"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*\"}[120s]))) or (min by (host) (100 * windows_logical_disk_free_bytes{volume!~\"HarddiskVolume.*\"} / windows_logical_disk_size_bytes{volume!~\"HarddiskVolume.*\"}) and on (host) (max by (host) (timestamp(windows_logical_disk_size_bytes{volume!~\"HarddiskVolume.*\"})) > time() - 120)) or (min by (host) (100 * node_filesystem_avail_bytes{fstype!~\"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*\",agent_id=\"\"} / node_filesystem_size_bytes{fstype!~\"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*\",agent_id=\"\"}) and on (host) (max by (host) (timestamp(node_filesystem_size_bytes{fstype!~\"tmpfs|overlay|squashfs|ramfs|nsfs|fuse.*\",agent_id=\"\"})) > time() - 120))";

interface Target {
  job: string; instance: string; host: string; os: string; env: string; role: string; health: string; lastScrape: string | null; durationMs: number; lastError: string;
  source: 'scrape' | 'agent'; platform?: string; collection?: ('scrape' | 'agent')[]; scrapeHealth?: string; scrapeError?: string; lastHeartbeat?: string | null;
}
type Metric = 'cpu' | 'mem' | 'disk';

export default function Infrastructure() {
  const { can, canOpen, setDsChip } = useApp();
  const navigate = useNavigate();
  const [view, setView] = useState<'table' | 'map'>('table');
  const [metric, setMetric] = useState<Metric>('cpu');
  const [env, setEnv] = useState('');

  const q = usePlainQuery(['infrastructure'], async () => {
    // host list is required; CPU/memory/disk are extras: if they fail we say so (partial data), never show 0
    const failed: string[] = [];
    const extra = (name: string, query: string) => api<{ result: PromVector }>('/prom/query', { query: { query } }).catch((e) => { failed.push(`${name}: ${e.message}`); return { result: [] as PromVector }; });
    const [targets, cpu, mem, disk] = await Promise.all([api<Target[]>('/prom/targets'), extra('CPU', CPU), extra('Memory', MEM), extra('Disk', DISK)]);
    const m = (r: { result: PromVector }) => new Map(r.result.map((x) => [x.metric.host, Number(x.value[1])]));
    setDsChip({ label: 'Prometheus', tone: 'ok' });
    return { targets, C: m(cpu), M: m(mem), D: m(disk), failed };
  });

  const servers = useMemo(() => (q.data?.targets || []).filter((t) => (t.job === 'windows' || t.job === 'linux') && (!env || t.env === env))
    .sort((a, b) => (STATUS_RANK[asStatus(a.health)] - STATUS_RANK[asStatus(b.health)]) || a.host.localeCompare(b.host)), [q.data, env]); // eslint-disable-line react-hooks/exhaustive-deps
  const envs = useMemo(() => [...new Set((q.data?.targets || []).map((t) => t.env).filter(Boolean))].sort(), [q.data]);
  const pager = usePager(servers, 50, env);

  const head = <PageHead title="Infrastructure" sub="Every server: scraped by Prometheus or sending through the ObservaOne Agent"
    actions={can('integrations.manage') && canOpen('/agents') ? <Link className="btn btn-primary" to="/infrastructure/add"><Plus size={15} />Add target</Link> : undefined} />;
  if (q.isPending) return <>{head}<TableWrap label="Hosts"><StateView kind="loading" skeleton="table" /></TableWrap></>;
  if (q.isError) return <>{head}<TableWrap label="Hosts"><ErrorState error={q.error} what="Infrastructure" /></TableWrap></>;
  const { C, M, D, failed } = q.data;
  const dashFor = (t: Target) => `${t.os === 'windows' ? 'windows' : 'linux'}-servers`;
  const openDash = (t: Target) => { sessionStorage.setItem(`oo.var.${dashFor(t)}.host`, t.host); navigate(`/dashboards/${dashFor(t)}`); };
  // live values only for a host that is up: anything else shows "—" and when it was last seen
  const live = (map: Map<string, number>, t: Target) => (showsLive(t.health) ? map.get(t.host) : undefined);
  const value = (t: Target) => live(metric === 'cpu' ? C : metric === 'mem' ? M : D, t);
  const seen = (t: Target) => t.lastHeartbeat || t.lastScrape || null;
  const counts = countStatuses(servers);
  const cell = (map: Map<string, number>, t: Target, higherIsWorse = true) => {
    if (!showsLive(t.health)) {
      const s = seen(t);
      return <td className="num dim" title={`${STATUS_META[asStatus(t.health)].label}${s ? `, last seen ${ago(s)}` : ''}: no live value`}>—</td>;
    }
    const v = map.get(t.host);
    return <td className={`num ${toneClass(v, higherIsWorse)}`}>{fmt(v, 'percent')}</td>;
  };

  return (
    <>
      {head}
      <div className="toolbar">
        <Tabs items={[['table', 'Table'], ['map', 'Host map']]} active={view} onChange={setView} label="View" />
        {envs.length > 0 && <Select className="select select-sm" label="Environment" value={env} onChange={setEnv} options={[['', 'All environments'] as [string, string], ...envs.map((e) => [e, e] as [string, string])]} />}
        <div className="grow" />
        {view === 'map' && <><span className="muted">Colour by</span><Select className="select select-sm" label="Colour by" value={metric} onChange={setMetric} options={[['cpu', 'CPU'], ['mem', 'Memory'], ['disk', 'Lowest disk free']]} /></>}
      </div>
      {servers.length > 0 && (
        <div className="status-summary" aria-label="Servers by status">
          <b>{counts.total} {counts.total === 1 ? 'server' : 'servers'}</b>
          {statusParts(counts).map(([k, n]) => <span key={k}><i className="dot" style={{ background: STATUS_META[k].color }} />{n} {STATUS_META[k].label.toLowerCase()}</span>)}
        </div>
      )}
      {failed.length > 0 && <StateBanner>Some values could not be loaded and show "-". {failed.join(' · ')}</StateBanner>}
      {!servers.length ? (
        <TableWrap label="Hosts">
          <StateView kind="empty" title={env ? `No hosts in ${env}` : 'No monitored hosts yet'}
            text="Install the ObservaOne Agent on a server, or add it to prometheus/targets/windows.yml or linux.yml."
            action={canOpen('/agents') ? <Link to="/agents?tab=install" className="btn btn-sm btn-primary">Install an agent</Link> : undefined} />
        </TableWrap>
      ) : view === 'map' ? (
        <section className="panel">
          <div className="hostmap" role="list">
            {servers.map((t) => {
              const v = value(t);
              const st = asStatus(t.health);
              const bg = st === 'down' ? 'var(--crit)' : st !== 'up' ? 'var(--unknown)'
                : thresholdColor(v, metric === 'disk' ? { warn: 20, crit: 10, lowerIsWorse: true, base: 'ok' } : { warn: 80, crit: 90, base: 'ok' });
              return (
                <button key={`${t.job}-${t.host}`} role="listitem" className="host-tile" style={{ background: bg, color: bg.startsWith('#') ? readableOn(bg) : '#fff' }}
                  title={`${t.host} · ${STATUS_META[st].label}${v !== undefined ? ` · ${fmt(v, 'percent')}` : seen(t) ? ` · last seen ${ago(seen(t)!)}` : ''}`} onClick={() => (canOpen('/metrics') ? navigate(`/metrics/host/${encodeURIComponent(t.host)}`) : canOpen('/dashboards') && openDash(t))}>
                  <span className="host-name">{t.host}</span><span className="host-val">{st === 'up' ? fmt(v, 'percent', 0) : st === 'down' ? 'Down' : '—'}</span>
                </button>
              );
            })}
          </div>
          <div className="hostmap-legend muted">
            <span><i style={{ background: 'var(--ok)' }} />{metric === 'disk' ? '≥ 20% free' : '< 80%'}</span>
            <span><i style={{ background: 'var(--warn)' }} />{metric === 'disk' ? '10–20% free' : '80–90%'}</span>
            <span><i style={{ background: 'var(--crit)' }} />{metric === 'disk' ? '< 10% free' : '≥ 90%'} or down</span>
            <span><i style={{ background: 'var(--unknown)' }} />not reporting, offline or disabled (—)</span>
            {(canOpen('/metrics') || canOpen('/dashboards')) && <span className="dim">Click a host to open its details</span>}
          </div>
        </section>
      ) : (
        <TableWrap label="Hosts">
          <table className="tbl">
            <thead><tr>{['Server', 'Status', 'OS', 'Env', 'Role', 'CPU', 'Memory', 'Lowest disk free', 'Last seen', ''].map((x, i) => <th key={x || i} className={i >= 5 && i <= 7 ? 'num' : ''}>{x}</th>)}</tr></thead>
            <tbody>
              {pager.rows.map((t) => (
                <tr key={`${t.job}-${t.host}-${t.instance}`}>
                  <td>
                    {canOpen('/metrics') ? <Link to={`/metrics/host/${encodeURIComponent(t.host)}`} style={{ fontWeight: 600 }}>{t.host}</Link> : <b style={{ fontWeight: 600 }}>{t.host}</b>}
                    <div className="dim" style={{ fontSize: 11 }}><CollectedBy t={t} /></div>
                  </td>
                  <td><HealthPill health={asStatus(t.health)} detail={t.lastError || undefined} />
                    {!showsLive(t.health) && seen(t) && <div className="dim" style={{ fontSize: 11, marginTop: 3 }}>last seen {ago(seen(t)!)}</div>}
                    {/* both methods: a failing scrape is shown separately from the agent's own state */}
                    {t.scrapeHealth && t.scrapeHealth !== 'up' && (t.collection || []).length > 1 && <div className="c-orange" style={{ fontSize: 11, marginTop: 3 }} title={t.scrapeError || ''}>Prometheus scrape: {t.scrapeHealth}</div>}</td>
                  <td>{t.os === 'windows' ? 'Windows' : 'Linux'}</td>
                  <td>{t.env || '-'}</td><td>{t.role || '-'}</td>
                  {cell(C, t)}{cell(M, t)}{cell(D, t, false)}
                  <td className="dim" title={t.source === 'agent' ? 'Last heartbeat (or data) from the agent' : 'Last scrape by Prometheus'}>{seen(t) ? <Time ms={Date.parse(seen(t)!)} text={ago(seen(t)!)} /> : 'never'}</td>
                  <td>{canOpen('/dashboards') && <button className="icon-btn" title="Open dashboard" aria-label={`Open dashboard for ${t.host}`} onClick={() => openDash(t)}><LayoutDashboard size={15} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <TableFoot pager={pager} noun={servers.length === 1 ? 'host' : 'hosts'} />
        </TableWrap>
      )}
      {canOpen('/datasources') && <p className="dim" style={{ fontSize: 12, marginTop: 10 }}>Only your servers are listed here. The monitoring stack's own components are on <Link to="/datasources">Data Sources</Link>.</p>}
    </>
  );
}

// how a server is collected: "ObservaOne Agent", "Prometheus scrape (host:9100)" or both
function CollectedBy({ t }: { t: Target }) {
  const { canOpen } = useApp();
  const c = t.collection || [t.source];
  const agent = canOpen('/agents') ? <Link to={`/agents?tab=${t.os === 'windows' ? 'windows' : 'linux'}`}>ObservaOne Agent</Link> : <>ObservaOne Agent</>;
  const scrape = <span className="mono">scrape{t.instance && t.instance !== 'agent' ? ` ${t.instance}` : ''}</span>;
  if (c.includes('agent') && c.includes('scrape')) return <>{agent} + {scrape}</>;
  return c.includes('agent') ? agent : scrape;
}
