// One alert, with its evidence: Alert -> Evidence -> Investigation -> Action.
// The value against the threshold over time, the episode history of the same alert, its labels and annotations,
// and on the right what the server was doing (CPU now, top processes) and where to go next (host, metrics, runbook).
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, LineChart, Server, Search } from 'lucide-react';
import { api, type PromMatrix, type PromVector } from '@/lib/api';
import { buildQuery } from '@/lib/catalog';
import { dateTime } from '@/lib/format';
import { color, toneClass } from '@/lib/theme';
import { useApp } from '@/app/AppContext';
import { ErrorState, PageHead, Panel, Pill, StateView, Tabs, TableWrap } from '@/components/ui';
import { TimeChart } from '@/components/charts';
import { ProcessTable, useProcesses } from '@/components/ProcessTable';
import { SeverityPill, StatePill, durationText, valueText, type AlertRow } from '@/components/alerts';

export interface Detail {
  alert: AlertRow;
  labels: Record<string, string>; annotations: Record<string, string>;
  rule: { expr: string; forSec: number; op: string | null; threshold: number | null; graphQuery: string };
  seriesLabels: Record<string, string>;
  history: AlertRow[];
}
type Tab = 'overview' | 'graph' | 'history' | 'labels' | 'annotations';

export default function AlertDetail() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['alert-item', id], queryFn: () => api<Detail>(`/alerts/item/${encodeURIComponent(id)}`), refetchInterval: 15_000 });
  const [tab, setTab] = useState<Tab>('overview');
  const back = <Link to="/alerting/active">Active Alerts</Link>;
  if (q.isPending) return <><PageHead title="Alert" sub={back} /><StateView kind="loading" /></>;
  if (q.isError) return <><PageHead title="Alert" sub={back} /><ErrorState error={q.error} what="Alert" /></>;
  const d = q.data, a = d.alert;
  const thresholdText = d.rule.threshold === null ? 'none (the query itself decides)' : `${d.rule.op} ${valueText(d.rule.threshold, a.unit)}`;
  return (
    <>
      <div className="crumbs"><Link to="/alerting">Alerts</Link> › <Link to="/alerting/active">Active Alerts</Link> › <span>{a.name}</span></div>
      <div className={`alert-head state-${a.state}`}>
        <div className="alert-head-main">
          <span className={`alert-state-badge ${a.state}`}>{a.neverFired ? 'CLEARED' : a.state.toUpperCase()}</span>
          <h1>{a.name}</h1>
          <SeverityPill s={a.severity} />
          {a.silenced && <Pill tone="muted">Silenced</Pill>}
          {a.inhibited && <Pill tone="muted">Muted by a related alert</Pill>}
        </div>
        {a.summary && <p className="muted" style={{ margin: '6px 0 0' }}>{a.summary}</p>}
      </div>
      <div className="alert-facts">
        <Fact k="Host" v={a.host ? <Link to={`/metrics/host/${encodeURIComponent(a.host)}`}>{a.host}</Link> : '—'} />
        <Fact k={a.state === 'resolved' ? 'Peak value' : 'Current value'} v={<span className={a.unit === 'percent' && a.state !== 'resolved' ? toneClass(a.value ?? 0) : ''}>{valueText(a.state === 'resolved' ? a.peak : a.value, a.unit)}</span>} />
        <Fact k="Threshold" v={thresholdText} />
        <Fact k={a.firedAt ? 'Started firing' : 'Became true'} v={dateTime(Date.parse(a.firedAt || a.activeAt)).slice(0, 16)} />
        <Fact k="Duration" v={durationText(a.durationSec)} />
        <Fact k="For" v={d.rule.forSec ? durationText(d.rule.forSec) : 'immediately'} />
        <Fact k="Team" v={a.team || 'Platform'} />
      </div>
      <div className="alert-layout">
        <div className="alert-main">
          <div className="toolbar"><Tabs items={[['overview', 'Overview'], ['graph', 'Metric Graph'], ['history', `History (${d.history.length})`], ['labels', 'Labels'], ['annotations', 'Annotations']]} active={tab} onChange={setTab} label="Alert sections" /></div>
          {tab === 'overview' && <>
            <Evidence d={d} />
            <Panel title="What this alert checks">
              <p style={{ marginTop: 0 }}>Fires when the query below is {thresholdText === 'none (the query itself decides)' ? 'returns a series' : <b>{thresholdText}</b>} for {d.rule.forSec ? durationText(d.rule.forSec) : 'one evaluation'}. Before that it is <i>Pending</i>.</p>
              <pre className="code" style={{ whiteSpace: 'pre-wrap' }}>{d.rule.expr}</pre>
            </Panel>
          </>}
          {tab === 'graph' && <Evidence d={d} tall />}
          {tab === 'history' && <History rows={d.history} current={a.id} />}
          {tab === 'labels' && <KV obj={d.labels} empty="No labels" />}
          {tab === 'annotations' && <KV obj={d.annotations} empty="No annotations" />}
        </div>
        <Related d={d} />
      </div>
    </>
  );
}

function Fact({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="fact"><div className="dim">{k}</div><div className="fact-v">{v}</div></div>;
}

/** the rule's value for THIS alert's series, with the threshold line, from 1 h before it started */
export function Evidence({ d, tall, compact }: { d: Detail; tall?: boolean; compact?: boolean }) {
  const a = d.alert;
  const start = Math.floor(Date.parse(a.activeAt) / 1000) - 3600;
  const end = a.resolvedAt ? Math.floor(Date.parse(a.resolvedAt) / 1000) + 900 : Math.floor(Date.now() / 1000);
  const q = useQuery({
    queryKey: ['alert-graph', d.rule.graphQuery, start, a.resolvedAt ? end : 'live'],
    queryFn: () => api<{ result: PromMatrix }>('/prom/query_range', { query: { query: d.rule.graphQuery, start, end } }),
    refetchInterval: a.resolvedAt ? false : 30_000,
  });
  const series = useMemo(() => {
    const own = Object.entries(d.seriesLabels);
    // this alert's series: every label the alert carries matches (labels the query drops are ignored)
    const mine = (q.data?.result || []).filter((r) => own.every(([k, v]) => !(k in r.metric) || r.metric[k] === v));
    const out = mine.slice(0, 5).map((r, i) => ({ label: i === 0 ? `${a.name} (${a.host || 'value'})` : JSON.stringify(r.metric), points: r.values as [number, string][] }));
    if (d.rule.threshold !== null && out.length) {
      const pts = out[0].points;
      out.push({ label: `Threshold ${d.rule.op} ${d.rule.threshold}`, points: pts.map(([t]) => [t, d.rule.threshold!] as [number, number]) as never, dashed: true, color: color('red') } as never);
    }
    return out;
  }, [q.data, d, a]);
  return (
    <Panel title="Metric graph" right={<span className="dim" style={{ fontSize: 12 }}>{dateTime(start * 1000).slice(11, 16)} – {a.resolvedAt ? dateTime(end * 1000).slice(11, 16) : 'now'}</span>}>
      {q.isPending ? <StateView kind="loading" /> : q.isError ? <ErrorState error={q.error} what="Graph" /> : !series.length
        ? <StateView kind="empty" title="No data for this alert's series in this window" text="The series may have stopped (e.g. the agent stopped sending)." />
        : <TimeChart series={series} unit={a.unit} className="chart-box" style={tall ? { height: 340 } : compact ? { height: 180 } : undefined} legend={!compact} />}
      {!compact && <p className="dim" style={{ margin: '8px 0 0', fontSize: 12 }}>Started {dateTime(Date.parse(a.activeAt)).slice(0, 16)}{a.firedAt ? `, firing from ${dateTime(Date.parse(a.firedAt)).slice(11, 16)}` : ''}{a.resolvedAt ? `, resolved ${dateTime(Date.parse(a.resolvedAt)).slice(11, 16)}` : ''}.</p>}
    </Panel>
  );
}

function History({ rows, current }: { rows: AlertRow[]; current: string }) {
  if (!rows.length) return <StateView kind="empty" title="No history yet" />;
  return (
    <TableWrap label="Alert history">
      <table className="tbl">
        <thead><tr><th>State</th><th>Became true</th><th>Fired</th><th>Resolved</th><th className="num">Duration</th><th className="num">Peak</th></tr></thead>
        <tbody>{rows.map((h) => (
          <tr key={h.id} className={h.id === current ? 'row-current' : ''}>
            <td><StatePill a={h} />{h.id === current && <span className="dim" style={{ fontSize: 11, marginLeft: 6 }}>this one</span>}</td>
            <td className="mono">{dateTime(Date.parse(h.activeAt)).slice(0, 16)}</td>
            <td className="mono">{h.firedAt ? dateTime(Date.parse(h.firedAt)).slice(11, 16) : '—'}</td>
            <td className="mono">{h.resolvedAt ? dateTime(Date.parse(h.resolvedAt)).slice(0, 16) : '—'}</td>
            <td className="num">{durationText(h.durationSec)}</td>
            <td className="num">{valueText(h.peak, h.unit)}</td>
          </tr>
        ))}</tbody>
      </table>
    </TableWrap>
  );
}

function KV({ obj, empty }: { obj: Record<string, string>; empty: string }) {
  const e = Object.entries(obj);
  if (!e.length) return <StateView kind="empty" title={empty} />;
  return (
    <TableWrap label={empty.replace('No ', '')}>
      <table className="tbl"><tbody>{e.map(([k, v]) => <tr key={k}><td className="mono" style={{ width: 200 }}>{k}</td><td className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{/^https?:\/\//.test(v) ? <a href={v} target="_blank" rel="noreferrer">{v}</a> : v}</td></tr>)}</tbody></table>
    </TableWrap>
  );
}

/** right column: the server's state now, and where to go next */
function Related({ d }: { d: Detail }) {
  const { canOpen } = useApp();
  const navigate = useNavigate();
  const a = d.alert, host = a.host;
  const win = d.labels.job === 'windows' || d.labels.os === 'windows';
  const cpu = useQuery({
    queryKey: ['alert-cpu', host],
    queryFn: () => api<{ result: PromVector }>('/prom/query', { query: { query: buildQuery({ metric: 'cpu', filters: { host }, by: 'host', fn: 'max' }) } }),
    enabled: !!host, refetchInterval: 30_000,
  });
  const procs = useProcesses(host, win, 5);
  const cpuNow = cpu.data?.result?.[0] ? Number(cpu.data.result[0].value[1]) : null;
  const t = Math.floor(Date.parse(a.firedAt || a.activeAt) / 1000);
  const investigate = `/metrics/investigate?${new URLSearchParams({ t: String(t), q: d.rule.graphQuery, unit: a.unit, ...(host ? { host } : {}) })}`;
  return (
    <aside className="alert-related">
      <Panel title="Related information">
        <div className="rel-row"><Server size={15} aria-hidden /><span className="dim">Host</span>{host ? <Link to={`/metrics/host/${encodeURIComponent(host)}`} className="mono">{host}</Link> : <span>—</span>}</div>
        <div className="rel-row"><LineChart size={15} aria-hidden /><span className="dim">CPU usage now</span>
          <b className={cpuNow === null ? '' : toneClass(cpuNow)}>{cpu.isPending && host ? '…' : cpuNow === null ? 'no value' : `${cpuNow.toFixed(1)}%`}</b></div>
        <div className="rel-row"><BookOpen size={15} aria-hidden /><span className="dim">Runbook</span>{a.runbook ? <a href={a.runbook} target="_blank" rel="noreferrer">Runbook guide</a> : <span className="dim">none on this rule</span>}</div>
      </Panel>
      {host && <Panel title="Top processes now"><ProcessTable q={procs} win={win} compact emptyText="No process data for this server." /></Panel>}
      <div className="alert-actions">
        {canOpen('/metrics') && <button className="btn" onClick={() => navigate(`/metrics/explore?mode=code&q=${encodeURIComponent(d.rule.graphQuery)}`)}><LineChart size={14} />Open Metrics</button>}
        {host && <button className="btn" onClick={() => navigate(`/metrics/host/${encodeURIComponent(host)}`)}><Server size={14} />Open Host</button>}
        {canOpen('/metrics') && <button className="btn" onClick={() => navigate(investigate)}><Search size={14} />Investigate</button>}
        {a.runbook && <a className="btn btn-primary" href={a.runbook} target="_blank" rel="noreferrer"><BookOpen size={14} />Runbook</a>}
      </div>
    </aside>
  );
}
