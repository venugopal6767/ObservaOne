// Investigation: one metric, one target, one moment. Opened from "Open full view" in the chart click panel
// (or a shared link). Shows the value then vs yesterday and the thresholds, the chart around that time,
// top processes at that moment, and the related logs, traces and alerts, with quick actions.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Copy, Search } from 'lucide-react';
import { api, type PromMatrix, type PromVector } from '@/lib/api';
import { buildQuery, metricById } from '@/lib/catalog';
import { dateTimeZ, escapeLabel, fmt, timeHM } from '@/lib/format';
import { color, toneClass } from '@/lib/theme';
import { useApp } from '@/app/AppContext';
import { useQuery } from '@tanstack/react-query';
import { ErrorState, PageHead, Panel, Pill, StateView, Tabs, TableWrap, copyText } from '@/components/ui';
import { TimeChart, LegendRow } from '@/components/charts';
import { QuickActions, RelatedAlerts, RelatedLogs, RelatedTraces, useRelated, type InvTab, type InvestigateCtx } from '@/components/Investigate';
import { metricIcon } from './icons';

const near = (vals: [number, string][], t: number) => {
  let best: [number, string] | undefined;
  for (const p of vals) if (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
  return best ? Number(best[1]) : null;
};

export default function InvestigatePage() {
  const [sp] = useSearchParams();
  const { canOpen } = useApp();
  const navigate = useNavigate();
  const t = Number(sp.get('t')) || Math.floor(Date.now() / 1000);
  const metric = sp.get('m') || '';
  const host = sp.get('host') || undefined;
  const service = sp.get('service') || undefined;
  const line = sp.get('line') || undefined;
  const def = metricById(metric);
  const unit = def?.unit || sp.get('unit') || 'none';
  const [tab, setTab] = useState<InvTab>('metric');

  // one line for this target when we know the metric; otherwise the original query
  const query = useMemo(() => {
    if (def && (host || service)) return buildQuery({ metric: def.id, filters: host ? { host } : { service } });
    return sp.get('q') || '';
  }, [def, host, service, sp]);
  const now = Date.now() / 1000;
  const start = Math.floor(t - 3600), end = Math.min(Math.ceil(t + 3600), Math.floor(now));
  const step = Math.max(30, Math.ceil((end - start) / 120));
  const data = useQuery({
    queryKey: ['investigate', query, start, end],
    enabled: !!query,
    queryFn: () => Promise.all([
      api<{ result: PromMatrix }>('/prom/query_range', { query: { query, start, end, step } }),
      api<{ result: PromMatrix }>('/prom/query_range', { query: { query, start: start - 86400, end: end - 86400, step } }),
    ]),
  });
  const pickLine = (r?: PromMatrix) => (r && r.length > 1 && line ? r.find((x) => Object.values(x.metric).includes(line)) : undefined) || r?.[0];
  const cur = pickLine(data.data?.[0].result);
  const old = pickLine(data.data?.[1].result);
  const pts = cur?.values || [];
  const oldPts = (old?.values || []).map(([x, v]) => [x + 86400, v] as [number, string]);
  const value = near(pts, t), before = near(oldPts, t);
  const delta = value !== null && before ? ((value - before) / Math.abs(before)) * 100 : null;
  const level = def && value !== null ? (def.lowerIsWorse ? (value <= def.crit! ? 2 : value <= def.warn! ? 1 : 0) : (def.crit !== undefined && value >= def.crit ? 2 : def.warn !== undefined && value >= def.warn ? 1 : 0)) : 0;
  const target = host || service || line || 'all';
  const ctx: InvestigateCtx = { t: t * 1000, values: [{ label: target, color: '', value }], unit, query, metric: def?.id, filters: host ? { host } : service ? { service } : {}, hint: { host, service } };
  const logsQ = service ? `{service_name="${escapeLabel(service)}"}` : host ? `{host="${escapeLabel(host)}"}` : '{service_name=~".+"}';
  const rel = useRelated(tab === 'metric' ? 'alerts' : tab, t, logsQ, service);
  const Icon = metricIcon(def?.id || '');
  const maxY = unit === 'percent' ? 100 : Math.max(1, ...pts.map((p) => Number(p[1])).filter(Number.isFinite), ...oldPts.map((p) => Number(p[1])).filter(Number.isFinite)) * 1.1;

  const tabs: [InvTab, string][] = [['metric', 'Metric details']];
  if (canOpen('/logs')) tabs.push(['logs', 'Related logs']);
  if (canOpen('/traces')) tabs.push(['traces', 'Related traces']);
  if (canOpen('/alerting')) tabs.push(['alerts', 'Related alerts']);

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/metrics">Investigation</Link> › {host ? <Link to={`/metrics/host/${encodeURIComponent(host)}`}>{host}</Link> : <span>{target}</span>} › {def?.name || 'Metric'} › <span>{dateTimeZ(t * 1000).slice(0, 16)}</span>
      </nav>
      <PageHead title="Investigation" sub={`What was happening around ${dateTimeZ(t * 1000).slice(0, 16)} (±1 hour shown, related data ±5 minutes)`}
        actions={<button className="btn" onClick={() => navigate(`/metrics/explore?m=${def?.id || 'cpu'}${host ? `&host=${encodeURIComponent(host)}` : ''}${service ? `&service=${encodeURIComponent(service)}` : ''}&step=4`)}><Search size={14} />Open in explorer</button>} />
      <div className="toolbar"><Tabs items={tabs} active={tab} onChange={setTab} label="Investigation" /></div>

      {tab === 'metric' && (
        <div className="inv-grid">
          <div className="inv-main">
            <Panel>
              <div className="inv-head">
                <span className="mc-ic lg"><Icon size={20} /></span>
                <div className="grow">
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{def?.name || 'Metric'}</div>
                  <div className="dim" style={{ fontSize: 12 }}>{target}{host && service ? ` · ${service}` : ''}</div>
                </div>
              </div>
              <div className="inv-facts">
                <div><div className="field-label">Value</div><div className={`big-num ${level === 2 ? 'c-red' : level === 1 ? 'c-orange' : toneClass(null)}`}>{fmt(value, unit)}</div>
                  {delta !== null && Number.isFinite(delta) && <span className={`trend ${delta > 0 ? 'bad' : 'up'}`}>{delta > 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}% vs yesterday</span>}</div>
                <div><div className="field-label">Status</div>{level === 2 ? <span className="sev critical"><i />Critical</span> : level === 1 ? <span className="sev warning"><i />Warning</span> : <span className="sev ok"><i />Normal</span>}</div>
                <div><div className="field-label">Threshold</div>{def?.warn !== undefined ? <span>{fmt(def.warn, unit)} warning{def.crit !== undefined && def.crit !== def.warn ? ` · ${fmt(def.crit, unit)} critical` : ''}</span> : <span className="dim">none set</span>}</div>
                <div><div className="field-label">Time</div><span>{dateTimeZ(t * 1000).slice(0, 19)}</span></div>
              </div>
              <div className="inv-query">
                <span className="field-label">Query</span><span className="dim" style={{ fontSize: 11.5 }}>(generated)</span>
                <span className="grow" />
                <button className="btn btn-sm" onClick={() => copyText(query, 'Query copied')}><Copy size={13} />Copy</button>
              </div>
              <pre className="code" style={{ margin: '6px 0 12px', fontSize: 11.5 }}>{query || '-'}</pre>
              {data.isPending ? <StateView kind="loading" skeleton="chart" /> : data.isError ? <ErrorState error={data.error} what="Metric" /> : !pts.length ? <StateView kind="empty" title="No data around this time" /> : (
                <>
                  <TimeChart series={[
                    { label: def?.name || 'Value', points: pts },
                    { label: 'Yesterday', points: oldPts, dashed: true, color: color('muted') },
                    ...(def?.warn !== undefined ? [{ label: `Threshold (${fmt(def.warn, unit)})`, points: [[start, def.warn], [end, def.warn]] as [number, number][], dashed: true, color: color('crit') }] : []),
                    { label: `Selected time ${timeHM(t * 1000)}`, points: [[t, 0], [t, maxY]] as [number, number][], color: color('warn') },
                  ]} unit={unit} max={unit === 'percent' ? 100 : undefined} className="chart-box lg" />
                  <LegendRow labels={[def?.name || 'Value', 'Yesterday', ...(def?.warn !== undefined ? ['Threshold'] : []), 'Selected time']} colors={[undefined, color('muted'), ...(def?.warn !== undefined ? [color('crit')] : []), color('warn')]} />
                </>
              )}
            </Panel>
          </div>
          <div className="inv-side">
            <Panel title="Quick actions"><QuickActions ctx={ctx} sec={t} full /></Panel>
            {host && <TopProcessesAt host={host} t={t} />}
            {canOpen('/alerting') && <Panel title="Alerts around this time"><RelatedAlerts q={rel.alerts} sec={t} host={host} service={service} /></Panel>}
          </div>
        </div>
      )}
      {tab === 'logs' && <Panel title={`Logs ±5 minutes · ${logsQ}`}><RelatedLogs q={rel.logs} logsQ={logsQ} limit={100} /></Panel>}
      {tab === 'traces' && <Panel title={`Traces ±5 minutes${service ? ` · ${service}` : ''}`}><RelatedTraces q={rel.traces} onOpen={(id) => navigate(`/traces?id=${id}`)} /></Panel>}
      {tab === 'alerts' && <Panel title="Related alerts"><RelatedAlerts q={rel.alerts} sec={t} host={host} service={service} /></Panel>}
    </>
  );
}

function TopProcessesAt({ host, t }: { host: string; t: number }) {
  const h = `host="${escapeLabel(host)}"`;
  const q = useQuery({
    queryKey: ['inv-procs', host, t],
    queryFn: async () => {
      const get = (query: string) => api<{ result: PromVector }>('/prom/query', { query: { query, time: t } }).then((r) => r.result).catch(() => [] as PromVector);
      const [cpu, mem] = await Promise.all([
        get(`topk(8, sum by (groupname) (rate(namedprocess_namegroup_cpu_seconds_total{${h}}[5m])) * 100) or topk(8, sum by (process) (rate(windows_process_cpu_time_total{${h}}[5m])) * 100)`),
        get(`sum by (groupname) (namedprocess_namegroup_memory_bytes{memtype="resident", ${h}}) or sum by (process) (windows_process_working_set_private_bytes{${h}})`),
      ]);
      const name = (m: Record<string, string>) => m.groupname || m.process || '?';
      const M = new Map(mem.map((x) => [name(x.metric), Number(x.value[1])]));
      return cpu.map((x) => ({ name: name(x.metric), cpu: Number(x.value[1]), mem: M.get(name(x.metric)) })).sort((a, b) => b.cpu - a.cpu);
    },
  });
  return (
    <Panel title="Top processes at this time" right={<Pill tone="muted">{timeHM(t * 1000)}</Pill>}>
      {q.isPending ? <StateView kind="loading" skeleton="table" /> : !q.data?.length ? <StateView kind="empty" title="No process data" text="Needs process-exporter (Linux) or the process collector (Windows)." /> : (
        <TableWrap label="Processes">
          <table className="tbl compact">
            <thead><tr><th>Process</th><th className="num">CPU</th><th className="num">Memory</th></tr></thead>
            <tbody>{q.data.map((r) => <tr key={r.name}><td className="mono">{r.name}</td><td className={`num ${toneClass(r.cpu)}`}>{r.cpu.toFixed(1)}%</td><td className="num">{r.mem === undefined ? '-' : fmt(r.mem, 'bytes')}</td></tr>)}</tbody>
          </table>
        </TableWrap>
      )}
    </Panel>
  );
}
