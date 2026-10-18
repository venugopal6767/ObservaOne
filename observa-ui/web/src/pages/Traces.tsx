// Traces Explorer: search Tempo over the global time range, open a trace as a waterfall, a span table or a
// service map. From a trace: jump to its logs (lines that carry the trace ID) and to each service's traces.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileText, Copy } from 'lucide-react';
import { api } from '@/lib/api';
import { fmt, dateTime, timeHeader, escapeLabel } from '@/lib/format';
import { color, palette, readableOn } from '@/lib/theme';
import { useApp, useRangeQuery, windowQuery } from '@/app/AppContext';
import { ErrorState, PageHead, Pill, Select, StateView, Tabs, Time, TableWrap, copyText } from '@/components/ui';

interface TraceRow { traceId: string; rootService: string; rootName: string; startMs: number; durationMs: number; error: boolean | null; spanCount: number | null }
interface Span { spanId: string; parentId: string | null; service: string; name: string; startMs: number; durationMs: number; error: boolean; statusMessage?: string }
interface Trace { traceId: string; startMs: number; durationMs: number; error: boolean; spans: Span[] }

export default function Traces() {
  const { pref, savePref, setDsChip } = useApp();
  const [params, setParams] = useSearchParams();
  const initial = params.get('q') ?? pref<string>('tracesQuery') ?? '';
  const [text, setText] = useState(initial);
  const [query, setQuery] = useState(initial);
  const [minDur, setMinDur] = useState(0);
  const [selected, setSelected] = useState<string | null>(params.get('id'));

  useEffect(() => {
    const q = params.get('q'); const id = params.get('id');
    if (q !== null && q !== query) { setText(q); setQuery(q); }
    if (id && id !== selected) setSelected(id);
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useRangeQuery(['traces', query, minDur], (r) => api<{ traces: TraceRow[] }>('/traces', { query: { query, ...r, limit: 25, minDurationMs: minDur || undefined } }), { autoRefresh: false });
  useEffect(() => {
    if (list.isError) {
      const e = list.error as { state?: string; status?: number };
      setDsChip(e.state === 'unavailable' || e.status === 502 ? { label: 'Tempo unavailable', tone: 'crit' } : null);
    } else if (list.data) setDsChip({ label: 'Tempo', tone: 'ok' });
  }, [list.isError, list.error, list.data, setDsChip]);
  // open the first trace when nothing (or something no longer listed) is selected - unless a ?id= link asked for one
  useEffect(() => {
    const t = list.data?.traces;
    if (!t?.length || params.get('id')) return;
    if (!selected || !t.some((x) => x.traceId === selected)) setSelected(t[0].traceId);
  }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps

  function run() {
    const v = text.trim();
    setQuery(v);
    const next = new URLSearchParams(params); next.set('q', v); next.delete('id'); setParams(next, { replace: true });
    if (v !== pref('tracesQuery')) savePref('tracesQuery', v);
    if (v === query) list.refetch();
  }
  function pick(id: string) {
    setSelected(id);
    const next = new URLSearchParams(params); next.set('id', id); setParams(next, { replace: true });
  }

  const traces = list.data?.traces || [];
  return (
    <>
      <PageHead title="Traces Explorer" sub="Search and analyze distributed traces" />
      <div className="query-bar">
        <div className="query-input"><input value={text} spellCheck={false} placeholder="All services, or e.g. service.name=checkout http.status_code=500" aria-label="Trace search" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} /></div>
        <Select className="select" label="Minimum duration" value={minDur} onChange={setMinDur} options={[[0, 'Any duration'], [100, '≥ 100 ms'], [500, '≥ 500 ms'], [1000, '≥ 1 s'], [5000, '≥ 5 s']]} style={{ height: 40 }} />
        <button className="btn btn-primary" onClick={run}>Search</button>
      </div>
      <div className="split">
        <div>
          {list.isPending ? <TableWrap label="Traces"><StateView kind="loading" skeleton="table" /></TableWrap>
            : list.isError ? <TableWrap label="Traces"><ErrorState error={list.error} what="Traces" /></TableWrap>
              : !traces.length ? <TableWrap label="Traces"><StateView kind="empty" title="No traces available" text="Tempo answered, but has no traces for this search and time range. Try another service name or a wider time range." /></TableWrap>
                : (
                  <TableWrap label="Traces" style={{ maxHeight: 'calc(100vh - 230px)' }}>
                    <table className="tbl">
                      <thead><tr><th>Trace ID</th><th className="num">Duration</th><th>Service</th><th>Operation</th><th>{timeHeader('Started')}</th></tr></thead>
                      <tbody>
                        {traces.map((t) => (
                          <tr key={t.traceId} className={`clickable ${t.traceId === selected ? 'sel' : ''}`} tabIndex={0} onClick={() => pick(t.traceId)} onKeyDown={(e) => e.key === 'Enter' && pick(t.traceId)}>
                            <td className="mono trace-id">{t.traceId.slice(0, 12)}</td>
                            <td className={`num ${t.durationMs > 2000 ? 'c-red' : t.durationMs > 1000 ? 'c-orange' : ''}`}>{fmt(t.durationMs, 'ms')}</td>
                            <td>{t.rootService}</td>
                            <td className="dim ell" style={{ maxWidth: 120, fontSize: 12 }} title={t.rootName}>{t.rootName}</td>
                            <td className="dim" style={{ fontSize: 12 }}><Time ms={t.startMs} text={dateTime(t.startMs).slice(11)} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                )}
        </div>
        <section className="panel">{selected ? <TraceDetail id={selected} /> : <StateView kind="empty" title="No trace selected" />}</section>
      </div>
    </>
  );
}

function TraceDetail({ id }: { id: string }) {
  const { canOpen, theme } = useApp();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'timeline' | 'spans' | 'map'>('timeline');
  const [spanSel, setSpanSel] = useState<Span | null>(null);
  const q = useQuery({ queryKey: ['trace', id], queryFn: () => api<Trace>(`/traces/${id}`), staleTime: 60_000 });
  useEffect(() => { setSpanSel(null); }, [id]);
  const trace = q.data;
  const services = useMemo(() => [...new Set((trace?.spans || []).map((s) => s.service))], [trace]);
  const pal = useMemo(() => palette(), [theme]); // eslint-disable-line react-hooks/exhaustive-deps
  const svcColor = (svc: string) => pal[services.indexOf(svc) % pal.length];

  if (q.isPending) return <StateView kind="loading" skeleton="chart" />;
  if (q.isError) return <ErrorState error={q.error} what="Trace" />;
  const t = trace!;
  const reEsc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const selector = services.length === 1 ? `{service_name="${escapeLabel(services[0])}"}` : `{service_name=~"${escapeLabel(services.map(reEsc).join('|'))}"}`;
  const logsLink = `/logs?q=${encodeURIComponent(`${selector} |= "${t.traceId}"`)}&${windowQuery(t.startMs / 1000 + t.durationMs / 2000, Math.max(120, t.durationMs / 1000))}`;
  const rows = orderTree(t.spans);
  const depth = depthMap(t.spans);
  const total = t.durationMs || 1;

  return (
    <>
      <div className="panel-head">
        <h3>Trace Details</h3>
        <button className="mono dim linkish" style={{ fontSize: 11.5 }} title="Copy trace ID" onClick={() => copyText(t.traceId)}>{t.traceId} <Copy size={11} /></button>
        <div className="right">
          {t.error ? <Pill tone="red">Error</Pill> : <Pill tone="green">OK</Pill>}
          <Pill tone="muted">{fmt(t.durationMs, 'ms')}</Pill>
          <Pill tone="muted">{t.spans.length} spans</Pill>
        </div>
      </div>
      <div className="toolbar">
        <Tabs items={[['timeline', 'Timeline'], ['spans', 'Spans'], ['map', 'Service Map']]} active={tab} onChange={setTab} label="Trace view" />
        <div className="grow" />
        {canOpen('/logs') && <button className="btn btn-sm" onClick={() => navigate(logsLink)} title="Log lines that contain this trace ID"><FileText size={13} />Logs for this trace</button>}
      </div>

      {tab === 'timeline' && (
        <>
          <div className="wf">
            {rows.map((s) => {
              const left = ((s.startMs - t.startMs) / total) * 100;
              const width = Math.max(0.6, (s.durationMs / total) * 100);
              const bg = s.error ? color('crit') : svcColor(s.service);
              return (
                <button key={s.spanId} className={`wf-row ${spanSel?.spanId === s.spanId ? 'sel' : ''}`} onClick={() => setSpanSel(s)} title={`${s.service}: ${s.name} (${fmt(s.durationMs, 'ms')})${s.statusMessage ? ` - ${s.statusMessage}` : ''}`}>
                  <div className="wf-name" style={{ paddingLeft: (depth.get(s.spanId) || 0) * 14 }}><i className="dot" style={{ background: svcColor(s.service) }} /><span>{s.service}</span><span className="dim">{s.name}</span></div>
                  <div className="wf-track"><div className={`wf-bar ${s.error ? 'err' : ''}`} style={{ left: `${left}%`, width: `${width}%`, background: bg, color: readableOn(bg) }}>{width > 12 ? fmt(s.durationMs, 'ms') : ''}</div></div>
                </button>
              );
            })}
          </div>
          <div className="wf-axis"><span /><div className="ticks">{[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f}>{fmt(total * f, 'ms')}</span>)}</div></div>
          {spanSel && <SpanInfo s={spanSel} trace={t} />}
        </>
      )}
      {tab === 'spans' && (
        <TableWrap label="Spans">
          <table className="tbl">
            <thead><tr><th>Service</th><th>Operation</th><th className="num">Start</th><th className="num">Duration</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.spanId}>
                  <td><i className="dot" style={{ background: svcColor(s.service), marginRight: 6 }} />{s.service}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{s.name}</td>
                  <td className="num">+{fmt(s.startMs - t.startMs, 'ms')}</td>
                  <td className="num">{fmt(s.durationMs, 'ms')}</td>
                  <td>{s.error ? <Pill tone="red" title={s.statusMessage}>Error</Pill> : <Pill tone="green">OK</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {tab === 'map' && <ServiceMap spans={t.spans} svcColor={svcColor} />}
    </>
  );
}

function SpanInfo({ s, trace }: { s: Span; trace: Trace }) {
  const { canOpen } = useApp();
  const navigate = useNavigate();
  return (
    <div className="span-info">
      <dl className="kv">
        <dt>Service</dt><dd>{s.service}</dd>
        <dt>Operation</dt><dd className="mono">{s.name}</dd>
        <dt>Starts at</dt><dd>+{fmt(s.startMs - trace.startMs, 'ms')} into the trace</dd>
        <dt>Duration</dt><dd>{fmt(s.durationMs, 'ms')} ({((s.durationMs / (trace.durationMs || 1)) * 100).toFixed(1)}% of the trace)</dd>
        <dt>Status</dt><dd>{s.error ? <span className="c-red">Error{s.statusMessage ? `: ${s.statusMessage}` : ''}</span> : 'OK'}</dd>
        <dt>Span ID</dt><dd className="mono">{s.spanId}</dd>
      </dl>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {canOpen('/logs') && <button className="btn btn-sm" onClick={() => navigate(`/logs?q=${encodeURIComponent(`{service_name="${escapeLabel(s.service)}"}`)}&${windowQuery(s.startMs / 1000, 60)}`)}><FileText size={13} />{s.service} logs at this time</button>}
        {canOpen('/services') && <button className="btn btn-sm" onClick={() => navigate('/services')}>Service health</button>}
      </div>
    </div>
  );
}

function depthMap(spans: Span[]) {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const d = new Map<string, number>();
  const depth = (s: Span, guard = 0): number => {
    if (d.has(s.spanId)) return d.get(s.spanId)!;
    const p = s.parentId ? byId.get(s.parentId) : undefined;
    const v = p && guard < 200 ? depth(p, guard + 1) + 1 : 0;
    d.set(s.spanId, v);
    return v;
  };
  spans.forEach((s) => depth(s));
  return d;
}

function orderTree(spans: Span[]) {
  const kids = new Map<string | null, Span[]>();
  const ids = new Set(spans.map((s) => s.spanId));
  for (const s of spans) {
    const p = s.parentId && ids.has(s.parentId) ? s.parentId : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(s);
  }
  const out: Span[] = [];
  const seen = new Set<string>();
  const walk = (p: string | null) => (kids.get(p) || []).sort((a, b) => a.startMs - b.startMs).forEach((s) => {
    if (seen.has(s.spanId)) return;
    seen.add(s.spanId); out.push(s); walk(s.spanId);
  });
  walk(null);
  return out;
}

/** Left-to-right service call graph from this trace's parent/child spans */
function ServiceMap({ spans, svcColor }: { spans: Span[]; svcColor: (s: string) => string }) {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const edges = new Map<string, number>();
  const level = new Map<string, number>();
  spans.filter((s) => !s.parentId || !byId.has(s.parentId)).forEach((r) => level.set(r.service, 0));
  for (const s of spans) {
    const p = s.parentId ? byId.get(s.parentId) : undefined;
    if (p && p.service !== s.service) edges.set(`${p.service}>${s.service}`, (edges.get(`${p.service}>${s.service}`) || 0) + 1);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const k of edges.keys()) {
      const [a, b] = k.split('>');
      const want = (level.get(a) ?? 0) + 1;
      if ((level.get(b) ?? -1) < want && want < 10) { level.set(b, want); changed = true; }
    }
  }
  [...new Set(spans.map((s) => s.service))].forEach((s) => { if (!level.has(s)) level.set(s, 0); });
  const cols = new Map<number, string[]>();
  for (const [svc, l] of level) { if (!cols.has(l)) cols.set(l, []); cols.get(l)!.push(svc); }
  const colW = 170, rowH = 70, nodeW = 140, nodeH = 36;
  const maxRows = Math.max(...[...cols.values()].map((c) => c.length));
  const H = Math.max(140, maxRows * rowH + 30);
  const W = Math.max(640, cols.size * colW + 40);
  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, list] of cols) list.forEach((svc, i) => pos.set(svc, { x: 20 + l * colW, y: (H - list.length * rowH) / 2 + i * rowH + 15 }));
  const tick = color('chart-tick');
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxHeight: 360 }} role="img" aria-label="Service map of this trace">
        <defs><marker id="svcmap-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill={tick} /></marker></defs>
        {[...edges].map(([k, n]) => {
          const [a, b] = k.split('>');
          const p1 = pos.get(a)!, p2 = pos.get(b)!;
          const x1 = p1.x + nodeW, y1 = p1.y + nodeH / 2, x2 = p2.x, y2 = p2.y + nodeH / 2;
          return (
            <g key={k}>
              <path d={`M${x1} ${y1} C${x1 + 30} ${y1}, ${x2 - 30} ${y2}, ${x2 - 2} ${y2}`} stroke={tick} strokeWidth={1.5} fill="none" markerEnd="url(#svcmap-arr)" />
              <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} fill={tick} fontSize={10} textAnchor="middle">{n} call{n > 1 ? 's' : ''}</text>
            </g>
          );
        })}
        {[...pos].map(([svc, p]) => {
          const err = spans.some((s) => s.service === svc && s.error);
          return (
            <g key={svc}>
              <rect x={p.x} y={p.y} width={nodeW} height={nodeH} rx={8} fill={color('panel-2')} stroke={err ? color('crit') : svcColor(svc)} strokeWidth={1.6} />
              <circle cx={p.x + 14} cy={p.y + nodeH / 2} r={5} fill={svcColor(svc)} />
              <text x={p.x + 26} y={p.y + nodeH / 2 + 4} fill={color('text')} fontSize={12}>{svc.length > 16 ? `${svc.slice(0, 15)}…` : svc}</text>
            </g>
          );
        })}
      </svg>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Arrows show which service called which in this trace. Red border = errors in that service.</div>
    </div>
  );
}
