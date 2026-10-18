// Overview: one call (/api/overview) for the whole page. Only the parts whose module is on are drawn.
// Every value is real, or shown as unavailable with its reason. Nothing is filled in.
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, type PromMatrix } from '@/lib/api';
import { short, legendName } from '@/lib/format';
import { thresholdColor, statusColor } from '@/lib/theme';
import { useApp, useRangeQuery } from '@/app/AppContext';
import { ErrorState, PageHead, Panel, Pill, Skeleton, StateView } from '@/components/ui';
import { StatCard, Reason } from '@/components/StatCard';
import { BarChart, Doughnut, LegendRow, TimeChart } from '@/components/charts';

interface SvcSummary { total: number; healthy: number; degraded: number; down: number; noTraffic: number; totalRps: number; errorRate: number | null }
interface OverviewData {
  modules: { infrastructure: boolean; alerting: boolean; services: boolean };
  cpu: { now: number | null; before: number | null; error: string | null };
  mem: { now: number | null; before: number | null; error: string | null };
  cpuByHost: { host: string; value: number }[]; cpuByHostError: string | null;
  memSeries: PromMatrix; memError: string | null;
  servers: { total: number | null; down: number | null; error: string | null };
  alerts: { active: number | null; critical: number | null; error: string | null };
  services: { summary: SvcSummary } | null; servicesError: string | null;
  rpsSeries: { result: PromMatrix } | null; rpsError: string | null;
  latSeries: { result: PromMatrix } | null; latError: string | null;
}

const pct = (now: number | null, before: number | null) => (now === null || before === null || !before ? null : ((now - before) / Math.abs(before)) * 100);
/** a failed part of the overview, as the right state (unavailable vs error) */
const Failed = ({ msg, what }: { msg: string; what: string }) =>
  <ErrorState error={new ApiError(msg, { status: /Cannot reach|timeout|HTTP 5\d\d/i.test(msg) ? 502 : 400 })} what={what} />;
const NowChip = () => <Pill tone="muted" title="Current value, not the selected time range">Now</Pill>;

export default function Overview() {
  const { can, canOpen } = useApp();
  const navigate = useNavigate();
  const q = useRangeQuery(['overview'], (r) => api<OverviewData>('/overview', { query: r }));
  const head = <PageHead title="Overview" sub="Monitor your entire infrastructure and applications" />;

  if (q.isPending) return <>{head}<Skeleton kind="cards" n={6} /><div style={{ marginTop: 14 }}><Skeleton kind="chart" /></div></>;
  if (q.isError) return <>{head}<ErrorState error={q.error} what="Overview" /></>;
  const d = q.data;
  const M = d.modules;

  if (!M.infrastructure && !M.alerting && !M.services) {
    return (
      <>{head}
        <StateView kind="empty" title="No monitoring modules are enabled"
          text={can('settings.manage') ? 'Turn on the modules this deployment uses in Settings > Modules.' : 'Nothing is enabled for your account yet. Contact your administrator.'}
          action={can('settings.manage') ? <Link to="/settings?tab=modules" className="btn btn-sm">Open Modules</Link> : undefined} />
      </>
    );
  }

  const s = d.services?.summary;
  const svcReason = d.servicesError ? <Reason text={`Service metrics unavailable: ${d.servicesError}`} /> : null;
  const noTraffic = !!s && !s.totalRps;
  const agentsLink = canOpen('/agents') ? <Link to="/agents?tab=install" className="btn btn-sm btn-primary">Install an agent</Link> : undefined;

  const tiles: React.ReactNode[] = [];
  if (M.services) tiles.push(
    <StatCard key="svc" label="Total Services" value={s ? String(s.total) : '-'} onClick={canOpen('/services') ? () => navigate('/services') : undefined}
      extra={svcReason || (!M.infrastructure ? null : d.servers.total === null
        ? <Reason text={`Servers: ${d.servers.error || 'unknown'}`} />
        : <div className="muted tile-sub">{d.servers.total} servers monitored{d.servers.down ? <span className="c-red"> · {d.servers.down} down</span> : null}</div>)} />,
  );
  if (M.infrastructure) tiles.push(
    <StatCard key="cpu" label="CPU Usage" value={d.cpu.now === null ? '-' : d.cpu.now.toFixed(1)} unit={d.cpu.now === null ? '' : '%'} trend={pct(d.cpu.now, d.cpu.before)}
      tone={d.cpu.now !== null && d.cpu.now >= 90 ? 'red' : ''} onClick={canOpen('/infrastructure') ? () => navigate('/infrastructure') : undefined}
      extra={d.cpu.now === null ? <Reason text={d.cpu.error ? `Unavailable: ${d.cpu.error}` : 'No CPU data from any server'} /> : null} />,
    <StatCard key="mem" label="Memory Usage" value={d.mem.now === null ? '-' : d.mem.now.toFixed(1)} unit={d.mem.now === null ? '' : '%'} trend={pct(d.mem.now, d.mem.before)}
      tone={d.mem.now !== null && d.mem.now >= 90 ? 'red' : ''} onClick={canOpen('/infrastructure') ? () => navigate('/infrastructure') : undefined}
      extra={d.mem.now === null ? <Reason text={d.mem.error ? `Unavailable: ${d.mem.error}` : 'No memory data from any server'} /> : null} />,
  );
  if (M.services) tiles.push(
    <StatCard key="rps" label="Request Rate" value={s ? short(s.totalRps) : '-'} unit={s ? '/s' : ''} extra={svcReason || (noTraffic ? <Reason text="No traffic in this period" /> : null)} />,
    <StatCard key="err" label="Error Rate" value={s && s.errorRate !== null ? s.errorRate.toFixed(1) : '-'} unit={s && s.errorRate !== null ? '%' : ''}
      tone={s && s.errorRate !== null ? (s.errorRate >= 5 ? 'red' : s.errorRate >= 1 ? 'orange' : '') : ''}
      extra={svcReason || (noTraffic ? <Reason text="No requests, so no error rate" /> : null)} />,
  );
  if (M.alerting) tiles.push(
    // grey when unknown: an unreachable Alertmanager must not look like "no alerts"
    <StatCard key="al" label="Active Alerts" value={d.alerts.active === null ? '-' : String(d.alerts.active)} bell
      tone={d.alerts.active === null ? '' : d.alerts.active ? 'red' : 'green'} onClick={canOpen('/alerting') ? () => navigate('/alerting') : undefined}
      extra={d.alerts.error ? <Reason text={`Alertmanager unavailable: ${d.alerts.error}`} /> : <div className="muted tile-sub">{d.alerts.critical} critical</div>} />,
  );

  const seriesPanel = (title: string, s2: { result: PromMatrix } | null, errMsg: string | null, unit: string) => {
    let body: React.ReactNode;
    if (!s2) body = <Failed msg={errMsg || 'No answer'} what={title} />;
    else if (!s2.result.length) body = <StateView kind="empty" title="No request metrics for the selected time range" text="Your applications do not expose request metrics yet, or config/services.json does not match them." />;
    else {
      const series = s2.result.map((r) => ({ label: r.metric.service || legendName(r.metric), points: r.values }));
      body = <><TimeChart series={series} unit={unit} correlate /><LegendRow labels={series.map((x) => x.label)} /></>;
    }
    return <Panel title={title} right={s2?.result.length ? <span className="hint-chip">Click the chart to see logs &amp; traces</span> : undefined}>{body}</Panel>;
  };

  // ---- CPU by node / memory by server / services health ----
  let cpuBody: React.ReactNode;
  if (d.cpuByHostError) cpuBody = <Failed msg={d.cpuByHostError} what="CPU" />;
  else if (!d.cpuByHost.length) cpuBody = <StateView kind="empty" title="No monitored hosts yet" text="Install the ObservaOne Agent on a server and it appears here within a minute." action={agentsLink} />;
  else cpuBody = <BarChart labels={d.cpuByHost.map((x) => x.host || '(no host label)')} values={d.cpuByHost.map((x) => x.value)} unit="percent" max={100} colors={d.cpuByHost.map((x) => thresholdColor(x.value, { warn: 80, crit: 90 }))} />;

  let memBody: React.ReactNode;
  if (d.memError) memBody = <Failed msg={d.memError} what="Memory" />;
  else if (!d.memSeries.length) memBody = <StateView kind="empty" title="No memory data for the selected time range" action={agentsLink} />;
  else {
    const series = d.memSeries.slice(0, 8).map((r) => ({ label: r.metric.host, points: r.values }));
    memBody = <><TimeChart series={series} unit="percent" area max={100} style={{ height: 180 }} correlate /><LegendRow labels={series.map((x) => x.label)} /></>;
  }

  let healthBody: React.ReactNode;
  if (!s) healthBody = <Failed msg={d.servicesError || 'No answer'} what="Services" />;
  else if (!s.total) healthBody = <StateView kind="empty" title="No services discovered" text="No application request metrics match config/services.json yet." />;
  else healthBody = (
    <div className="health">
      <div className="donut">
        <Doughnut labels={['Healthy', 'Degraded', 'Down', 'No traffic']} values={[s.healthy, s.degraded, s.down, s.noTraffic]} colors={(['ok', 'warn', 'crit', 'unknown'] as const).map(statusColor)} />
        <div className="center"><b>{s.total}</b><span>Services</span></div>
      </div>
      <div className="health-list">
        <HealthRow dot="dot-green" label="Healthy" n={s.healthy} />
        <HealthRow dot="dot-orange" label="Degraded" n={s.degraded} />
        <HealthRow dot="dot-red" label="Down" n={s.down} />
        <HealthRow dot="" label="No traffic" n={s.noTraffic} />
      </div>
    </div>
  );

  const bottom: React.ReactNode[] = [];
  if (M.infrastructure) bottom.push(
    <Panel key="cpu" title="CPU Usage by Node" right={<NowChip />}>{cpuBody}</Panel>,
    <Panel key="mem" title="Memory Usage by Server">{memBody}</Panel>,
  );
  if (M.services) bottom.push(<Panel key="h" title="Services Health" right={<><NowChip />{canOpen('/services') && <Link to="/services" style={{ marginLeft: 10 }}>View all</Link>}</>}>{healthBody}</Panel>);

  return (
    <>
      {head}
      <div className={`grid cards-${tiles.length}`}>{tiles}</div>
      {M.services && (
        <div className="grid cols-2" style={{ marginTop: 14 }}>
          {seriesPanel('Request Rate', d.rpsSeries, d.rpsError || d.servicesError, 'reqps')}
          {seriesPanel('Latency (P95)', d.latSeries, d.latError || d.servicesError, 'ms')}
        </div>
      )}
      {bottom.length > 0 && <div className={`grid cols-${bottom.length}`} style={{ marginTop: 14 }}>{bottom}</div>}
    </>
  );
}

function HealthRow({ dot, label, n }: { dot: string; label: string; n: number }) {
  return <div><i className={`dot ${dot}`} style={dot ? undefined : { background: 'var(--unknown)' }} />{label}<b>{n}</b></div>;
}
