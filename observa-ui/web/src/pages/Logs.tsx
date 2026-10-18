// Logs Explorer: LogQL search over the global time range, level/service/namespace filters, a volume
// histogram, live tail, and a detail view that links to the trace (when the line carries a trace ID),
// to the service's traces, and to the lines around it.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Copy, Waypoints, Radio, Clock3 } from 'lucide-react';
import { api } from '@/lib/api';
import { dateTimeZ, escapeLabel, timeHeader, timeHM, timeTitle } from '@/lib/format';
import { color } from '@/lib/theme';
import { rangeKey, rangeParams, useApp, windowQuery } from '@/app/AppContext';
import { ErrorState, Modal, PageHead, Select, StateBanner, StateView, TableFoot, TableWrap, Time, copyText, useDialogs, usePager } from '@/components/ui';
import { ChartCanvas } from '@/components/charts';

interface LogEntry { ts: number; level: string; service: string; namespace: string; pod: string; message: string; labels: Record<string, string> }
interface LogsData { entries: LogEntry[]; counts: Record<string, number>; limit: number; truncated: boolean }

const LEVELS: [string, string][] = [['ERROR', 'chip-error'], ['WARN', 'chip-warn'], ['INFO', 'chip-info'], ['DEBUG', 'chip-debug']];
const LEVEL_PILL: Record<string, string> = { ERROR: 'pill-solid-red', WARN: 'pill-solid-orange', INFO: 'pill-solid-blue', DEBUG: 'pill-solid-muted' };
const LEVEL_COLOR: Record<string, string> = { ERROR: 'crit', WARN: 'warn', INFO: 'chart-1', DEBUG: 'unknown' };
const TRACE_RE = /\b(?:trace[_-]?id|traceID|trace)["'=:\s]+([0-9a-fA-F]{16,32})\b/;

export function traceIdOf(e: LogEntry): string | null {
  const l = e.labels || {};
  const fromLabels = l.trace_id || l.traceid || l.traceID || l.TraceId;
  if (fromLabels && /^[0-9a-fA-F]{16,32}$/.test(fromLabels)) return fromLabels;
  return TRACE_RE.exec(e.message)?.[1] ?? null;
}

export default function Logs() {
  const { range, refreshMs, pref, savePref, setDsChip, canOpen } = useApp();
  const { open } = useDialogs();
  const [params, setParams] = useSearchParams();
  const initial = params.get('q') || pref<string>('logsQuery') || '{service_name=~".+"} |~ "(?i)error"';
  const [text, setText] = useState(initial);
  const [query, setQuery] = useState(initial);
  const [level, setLevel] = useState('ALL');
  const [service, setService] = useState('');
  const [namespace, setNamespace] = useState('');
  const [live, setLive] = useState(false);

  useEffect(() => { const q = params.get('q'); if (q && q !== query) { setText(q); setQuery(q); } }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  // live tail = the last 5 minutes, re-read every 3 s (ignores the global range while on)
  const res = useQuery({
    queryKey: ['logs', query, live ? 'live' : rangeKey(range)],
    queryFn: () => {
      const r = live ? (() => { const end = Math.floor(Date.now() / 1000); return { start: end - 300, end }; })() : rangeParams(range);
      return api<LogsData>('/logs', { query: { query, ...r, limit: 500 } });
    },
    refetchInterval: live ? 3000 : range.kind === 'relative' && refreshMs ? refreshMs : false,
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    if (res.isError) {
      const e = res.error as { state?: string; status?: number };
      setDsChip(e.state === 'unavailable' || e.status === 502 ? { label: 'Loki unavailable', tone: 'crit' } : null);
    } else if (res.data) setDsChip({ label: live ? 'Loki · live' : 'Loki', tone: 'ok' });
  }, [res.isError, res.error, res.data, live, setDsChip]);

  function run(q = text) {
    const v = q.trim();
    setQuery(v);
    const next = new URLSearchParams(params); next.set('q', v); setParams(next, { replace: true });
    if (v !== pref('logsQuery')) savePref('logsQuery', v);
    if (v === query) res.refetch();
  }

  const data = res.data;
  const rows = useMemo(() => (data?.entries || []).filter((e) => (level === 'ALL' || e.level === level) && (!service || e.service === service) && (!namespace || e.namespace === namespace)), [data, level, service, namespace]);
  const pager = usePager(rows, 100, `${level}|${service}|${namespace}|${query}`);
  const services = useMemo(() => [...new Set((data?.entries || []).map((e) => e.service).filter(Boolean))].sort(), [data]);
  const namespaces = useMemo(() => [...new Set((data?.entries || []).map((e) => e.namespace).filter(Boolean))].sort(), [data]);
  const total = data?.entries.length || 0;

  function detail(e: LogEntry) {
    const tid = traceIdOf(e);
    open((close) => (
      <Modal title="Log line" wide onClose={close}>
        <LogDetail e={e} traceId={tid} onGo={close} canTraces={canOpen('/traces')} />
      </Modal>
    ));
  }

  let body: React.ReactNode;
  if (res.isPending) body = <TableWrap label="Log lines"><StateView kind="loading" skeleton="table" /></TableWrap>;
  else if (res.isError) body = <TableWrap label="Log lines"><ErrorState error={res.error} what="Logs" /></TableWrap>;
  else if (!rows.length) {
    body = <TableWrap label="Log lines">{total
      ? <StateView kind="empty" title="No log lines match these filters" text="Clear the level, service or namespace filter." />
      : <StateView kind="empty" title="No logs available" text="Loki answered, but has no lines for this query and time range. Try a wider time range or a different query." />}</TableWrap>;
  } else {
    body = (
      <>
        {data!.truncated && <StateBanner>Showing the newest {data!.limit} lines only. Loki has more for this query and time range: narrow the query or the time range to see older lines.</StateBanner>}
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Log lines" style={{ maxHeight: 'calc(100vh - 380px)' }}>
          <table className="tbl">
            <thead><tr><th>{timeHeader()}</th><th>Level</th><th>Service</th><th>Host / pod</th><th>Message</th></tr></thead>
            <tbody>
              {pager.rows.map((e, i) => (
                <tr key={`${e.ts}-${i}`} className="clickable" tabIndex={0} onClick={() => detail(e)} onKeyDown={(ev) => ev.key === 'Enter' && detail(e)}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}><Time ms={e.ts} /></td>
                  <td><span className={`pill ${LEVEL_PILL[e.level] || 'pill-muted'}`}>{e.level}</span></td>
                  <td>{e.service}</td>
                  <td className="mono dim" style={{ fontSize: 12 }}>{e.pod}</td>
                  <td className="msg" title={e.message}>{traceIdOf(e) && <Waypoints size={12} className="trace-mark" aria-label="Has a trace" />}{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <TableFoot pager={pager} noun={rows.length === 1 ? 'line' : 'lines'} note={rows.length < total ? `(filtered from ${total}${data!.truncated ? ' loaded' : ''})` : data!.truncated ? '(limit reached)' : undefined} />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead title="Logs Explorer" sub="Search and analyze logs from Loki" />
      <div className="query-bar">
        <div className="query-input"><input value={text} spellCheck={false} aria-label="LogQL query" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} /></div>
        <button className="btn btn-primary" onClick={() => run()}>Search</button>
        <button className={`btn live-btn ${live ? 'on' : ''}`} aria-pressed={live} title="Live tail: the last 5 minutes, updated every 3 seconds" onClick={() => setLive(!live)}>
          <Radio size={14} />{live ? 'Live' : 'Live tail'}
        </button>
      </div>
      {data && total > 0 && <LogVolume entries={data.entries} live={live} />}
      <div className="toolbar">
        {data && (
          <div className="chips">
            <button className={`chip ${level === 'ALL' ? 'active' : ''}`} onClick={() => setLevel('ALL')}>All<b>{total}</b></button>
            {LEVELS.map(([lv, cls]) => <button key={lv} className={`chip ${cls} ${level === lv ? 'active' : ''}`} onClick={() => setLevel(lv)}>{lv}<b>{data.counts[lv] || 0}</b></button>)}
          </div>
        )}
        <div className="grow" />
        {data && (
          <>
            <Select className="select select-sm" label="Filter by service" options={[['', 'Service: all'] as [string, string], ...services.map((s) => [s, s] as [string, string])]} value={service} onChange={setService} />
            <Select className="select select-sm" label="Filter by namespace" options={[['', 'Namespace: all'] as [string, string], ...namespaces.map((s) => [s, s] as [string, string])]} value={namespace} onChange={setNamespace} />
          </>
        )}
      </div>
      {body}
      <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
        Query syntax (LogQL): <code>{'{app="name"}'}</code> selects a stream, <code>|= "text"</code> must contain, <code>!= "text"</code> must not contain, <code>|~ "regex"</code> regex match.
      </div>
    </>
  );
}

/** Log volume over time, stacked by level (from the lines loaded) */
function LogVolume({ entries, live }: { entries: LogEntry[]; live: boolean }) {
  const { buckets, labels } = useMemo(() => {
    const ts = entries.map((e) => e.ts);
    const min = Math.min(...ts), max = Math.max(...ts);
    const n = 40, size = Math.max(1000, Math.ceil((max - min + 1) / n));
    const b: Record<string, number[]> = { ERROR: [], WARN: [], INFO: [], DEBUG: [] };
    for (const k of Object.keys(b)) b[k] = Array(n).fill(0);
    for (const e of entries) {
      const i = Math.min(n - 1, Math.floor((e.ts - min) / size));
      (b[e.level] || b.INFO)[i]++;
    }
    return { buckets: b, labels: Array.from({ length: n }, (_, i) => timeHM(min + i * size)) };
  }, [entries]);
  return (
    <section className="panel log-volume" aria-label="Log volume">
      <ChartCanvas className="chart-box xs" label="Log volume by level" deps={[JSON.stringify(buckets), live]}
        build={() => ({
          type: 'bar',
          data: { labels, datasets: Object.entries(buckets).map(([lv, data]) => ({ label: lv, data, backgroundColor: color(LEVEL_COLOR[lv]), borderRadius: 2, maxBarThickness: 18 })) },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false, backgroundColor: color('tooltip-bg'), titleColor: color('tooltip-title'), bodyColor: color('tooltip-body'), borderColor: color('tooltip-border'), borderWidth: 1 } },
            scales: {
              x: { stacked: true, grid: { display: false }, ticks: { color: color('chart-tick'), maxTicksLimit: 8, font: { size: 10 } }, border: { display: false } },
              y: { stacked: true, beginAtZero: true, grid: { color: color('chart-grid') }, ticks: { color: color('chart-tick'), maxTicksLimit: 3, font: { size: 10 } }, border: { display: false } },
            },
          },
        })} />
    </section>
  );
}

function LogDetail({ e, traceId, onGo, canTraces }: { e: LogEntry; traceId: string | null; onGo: () => void; canTraces: boolean }) {
  const navigate = useNavigate();
  const go = (p: string) => { onGo(); navigate(p); };
  const around = e.service ? `{service_name="${escapeLabel(e.service)}"}` : '{service_name=~".+"}';
  return (
    <div>
      <dl className="kv">
        <dt>Time</dt><dd title={timeTitle(e.ts)}>{dateTimeZ(e.ts)}</dd>
        <dt>Level</dt><dd>{e.level}</dd>
        <dt>Service</dt><dd>{e.service || '-'}</dd>
        <dt>Namespace</dt><dd>{e.namespace || '-'}</dd>
        <dt>Pod / host</dt><dd>{e.pod || '-'}</dd>
        {traceId && <><dt>Trace ID</dt><dd className="mono">{traceId}</dd></>}
      </dl>
      <pre className="code" style={{ marginTop: 12 }}>{e.message}</pre>
      {e.labels && <pre className="code">{JSON.stringify(e.labels, null, 2)}</pre>}
      <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {traceId && canTraces && <button className="btn btn-sm btn-primary" onClick={() => go(`/traces?id=${traceId}`)}><Waypoints size={13} />Open this trace</button>}
        <button className="btn btn-sm" onClick={() => go(`/logs?q=${encodeURIComponent(around)}&${windowQuery(e.ts / 1000, 60)}`)}><Clock3 size={13} />Lines around this one (±1 min)</button>
        {e.service && canTraces && <button className="btn btn-sm" onClick={() => go(`/traces?q=${encodeURIComponent(`service.name=${e.service}`)}&${windowQuery(e.ts / 1000, 300)}`)}><Waypoints size={13} />Traces for this service</button>}
        <button className="btn btn-sm" onClick={() => copyText(e.message)}><Copy size={13} />Copy message</button>
        {e.labels && <button className="btn btn-sm" onClick={() => copyText(JSON.stringify(e.labels, null, 2))}><Copy size={13} />Copy labels</button>}
        <button className="btn btn-sm" onClick={() => copyText(JSON.stringify({ time: new Date(e.ts).toISOString(), level: e.level, service: e.service || undefined, message: e.message, labels: e.labels }, null, 2))}><Copy size={13} />Copy as JSON</button>
      </div>
    </div>
  );
}
