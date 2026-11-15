// Metrics Explorer: any PromQL over the global time range, as a graph or a table. Click the graph to jump
// to the logs and traces of that moment. Queries can be pinned to a custom dashboard.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, History } from 'lucide-react';
import { api, type PromResult } from '@/lib/api';
import { fmt, legendName, shortLabel, timeHM, dateTime, timeHeader, UNITS, type Unit } from '@/lib/format';
import { palette } from '@/lib/theme';
import { useApp, useRangeQuery } from '@/app/AppContext';
import { ErrorState, Field, Modal, PageHead, Select, StateView, Tabs, Time, TableWrap, toast, useDialogs } from '@/components/ui';
import { TimeChart } from '@/components/charts';

const EXAMPLES: [string, string][] = [
  ['up', 'Which targets are up (1) or down (0)'],
  ['100 - avg by (host) (rate(windows_cpu_time_total{mode="idle"}[5m])) * 100', 'Windows CPU % per server'],
  ['100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)', 'Linux memory used %'],
  ['rate(prometheus_http_requests_total[5m])', 'Prometheus API requests per second'],
];

export default function Metrics({ embedded = false }: { embedded?: boolean }) {
  const { can, canOpen, pref, savePref, setDsChip, theme } = useApp();
  const { open } = useDialogs();
  const [params, setParams] = useSearchParams();
  const initial = params.get('q') || pref<string>('metricsQuery') || 'rate(prometheus_http_requests_total[5m])';
  const [text, setText] = useState(initial);
  const [query, setQuery] = useState(initial);
  const [view, setView] = useState<'graph' | 'table'>('graph');
  const [unit, setUnit] = useState<Unit>('none');
  const [step, setStep] = useState('auto');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const history = pref<string[]>('metricsHistory') || [];

  // the address follows the query (shareable link), and a ?q= link opens with that query
  useEffect(() => { const q = params.get('q'); if (q && q !== query) { setText(q); setQuery(q); } }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const names = useQuery({ queryKey: ['metric-names'], queryFn: () => api<string[]>('/prom/metric-names'), staleTime: 60_000 });
  const res = useRangeQuery(['metrics', query, step], (r) => api<PromResult>('/prom/query_range', { query: { query, ...r, step: step === 'auto' ? undefined : step } }), { enabled: !!query });
  useEffect(() => { setDsChip(res.isError ? { label: 'Prometheus unavailable', tone: 'crit' } : { label: 'Prometheus', tone: 'ok' }); }, [res.isError, setDsChip]);

  function run(q = text) {
    const v = q.trim();
    if (!v) return;
    setText(v);
    setQuery(v);
    setHidden(new Set());
    const next = new URLSearchParams(params); next.set('q', v); setParams(next, { replace: true });
    if (v !== pref('metricsQuery')) savePref('metricsQuery', v);
    savePref('metricsHistory', [v, ...history.filter((x) => x !== v)].slice(0, 10));
    if (v === query) res.refetch();
  }

  const all = res.data?.result || [];
  const series = useMemo(() => all.slice(0, 20).map((r) => ({ label: legendName(r.metric), points: r.values })), [all]);
  const pal = useMemo(() => palette(), [theme]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = series.map((s, i) => ({ ...s, color: pal[i % pal.length] })).filter((s) => !hidden.has(s.label));

  function addToDashboard() {
    if (!all.length) return toast('Run a query that returns data first', 'err');
    open((close) => <AddPanelDialog query={query} unit={unit} onClose={close} />);
  }

  let body: React.ReactNode;
  if (res.isPending) body = <StateView kind="loading" skeleton="chart" />;
  else if (res.isError) body = <ErrorState error={res.error} what="Metrics" />;
  else if (!all.length) body = <StateView kind="empty" title="No metrics available for the selected time range" text="Prometheus answered, but the query returned no series. Check the metric name and labels, or widen the time range." />;
  else if (view === 'graph') {
    body = (
      <>
        <div className="metrics-graph">
          <TimeChart series={shown} unit={unit} className="chart-box lg" correlate />
          <div className="legend-col" aria-label="Series (click to show or hide)">
            {series.map((s, i) => (
              <button key={s.label} className={`legend-item legend-toggle ${hidden.has(s.label) ? 'off' : ''}`} title={s.label}
                onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(s.label)) n.delete(s.label); else n.add(s.label); return n; })}>
                <i style={{ background: pal[i % pal.length] }} /><span className="ell">{s.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          {all.length > 20 ? `Showing 20 of ${all.length} series. Narrow the query to see the rest. ` : ''}Click the graph to open the logs or traces of that moment.
        </div>
      </>
    );
  }

  return (
    <>
      {!embedded && <PageHead title="Metrics Explorer" sub="Query and visualize metrics from Prometheus" />}
      <div className="query-bar">
        <div className="query-input">
          <input value={text} list="metric-names" spellCheck={false} aria-label="PromQL query" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
          <datalist id="metric-names">{(names.data || []).slice(0, 2000).map((n) => <option key={n} value={n} />)}</datalist>
        </div>
        <button className="btn btn-primary" onClick={() => run()}>Run Query</button>
      </div>
      <div className="toolbar">
        <Tabs items={[['graph', 'Graph'], ['table', 'Table']]} active={view} onChange={setView} label="View" />
        {history.length > 1 && (
          <Select className="select select-sm" label="Recent queries" value="" style={{ maxWidth: 260 }}
            options={[['', 'Recent queries'] as [string, string], ...history.map((h) => [h, h.length > 60 ? `${h.slice(0, 57)}…` : h] as [string, string])]}
            onChange={(v) => v && run(v)} />
        )}
        <div className="grow" />
        <span className="muted">Unit</span>
        <Select className="select select-sm" label="Unit" options={UNITS} value={unit} onChange={setUnit} />
        <span className="muted">Step</span>
        <Select className="select select-sm" label="Step" options={[['auto', 'Auto'], ['15', '15s'], ['60', '1m'], ['300', '5m'], ['900', '15m']]} value={step} onChange={setStep} />
        {can('dashboards.edit') && canOpen('/dashboards') && <button className="btn btn-sm" onClick={addToDashboard}><Plus size={13} />Add to Dashboard</button>}
      </div>
      {view === 'graph' ? <section className="panel">{body}</section> : (body || <MetricsTable series={series} unit={unit} big />)}
      {view === 'graph' && !!all.length && <div style={{ marginTop: 14 }}><MetricsTable series={series} unit={unit} /></div>}
      <details className="panel" style={{ marginTop: 14 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}><History size={13} style={{ verticalAlign: -2, marginRight: 6 }} />Example queries</summary>
        <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
          {EXAMPLES.map(([q, t]) => <div key={q}><a href="#" onClick={(e) => { e.preventDefault(); run(q); }}><code>{q}</code></a><span className="muted">  {t}</span></div>)}
        </div>
      </details>
    </>
  );
}

/** rows = time (newest first), columns = series */
function MetricsTable({ series, unit, big }: { series: { label: string; points: [number, string][] }[]; unit: Unit; big?: boolean }) {
  const cols = series.slice(0, 8);
  const times = [...new Set(cols.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => b - a).slice(0, big ? 200 : 12);
  const maps = cols.map((s) => new Map(s.points.map(([t, v]) => [t, v])));
  return (
    <>
      <TableWrap label="Metric values" style={{ maxHeight: big ? 560 : 320 }}>
        <table className="tbl">
          <thead><tr><th>{timeHeader()}</th>{cols.map((s) => <th key={s.label} className="num" title={s.label}>{shortLabel(s.label)}</th>)}</tr></thead>
          <tbody>
            {times.map((t) => (
              <tr key={t}>
                <td className="mono"><Time ms={t * 1000} text={big ? dateTime(t * 1000) : timeHM(t * 1000)} /></td>
                {maps.map((m, i) => <td key={i} className="num">{m.has(t) ? fmt(Number(m.get(t)), unit) : '-'}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {series.length > 8 && <div className="muted" style={{ marginTop: 6 }}>Table shows the first 8 series.</div>}
    </>
  );
}

export function AddPanelDialog({ query, unit, onClose }: { query: string; unit: Unit; onClose: () => void }) {
  const dashes = useQuery({ queryKey: ['dashboards'], queryFn: () => api<{ id: string; title: string; kind: string }[]>('/dashboards') });
  const custom = (dashes.data || []).filter((d) => d.kind === 'custom');
  const [dashId, setDashId] = useState('');
  const [title, setTitle] = useState(query.slice(0, 60));
  const [type, setType] = useState('line');
  const [w, setW] = useState(6);
  const [legend, setLegend] = useState('');
  useEffect(() => { if (!dashId && custom[0]) setDashId(custom[0].id); }, [custom, dashId]);
  return (
    <Modal title="Add to dashboard" onClose={onClose} actions={[
      { label: 'Cancel' },
      { label: 'Add panel', primary: true, disabled: !dashId, onClick: async () => {
        await api(`/dashboards/${dashId}/panels`, { method: 'POST', body: { title, type, query, legend, unit, w } });
        toast('Panel added');
      } },
    ]}>
      {dashes.isPending ? <StateView kind="loading" /> : !custom.length ? (
        <StateView kind="empty" title="No custom dashboard yet" text="Create one first on the Dashboards page (New Dashboard)." />
      ) : (
        <>
          <Field label="Dashboard"><Select options={custom.map((d) => [d.id, d.title] as [string, string])} value={dashId} onChange={setDashId} /></Field>
          <Field label="Panel title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <div className="form-row">
            <Field label="Panel type"><Select options={[['line', 'Line'], ['area', 'Area'], ['bar', 'Bar (current values)'], ['stat', 'Single number'], ['table', 'Table']]} value={type} onChange={setType} /></Field>
            <Field label="Width"><Select options={[[4, 'Small (1/3)'], [6, 'Half'], [12, 'Full width']]} value={w} onChange={setW} /></Field>
          </div>
          <Field label="Legend" hint="Use {{label}} to show a label value, e.g. {{host}} or {{volume}}."><input className="input" placeholder="e.g. {{host}}" value={legend} onChange={(e) => setLegend(e.target.value)} /></Field>
        </>
      )}
    </Modal>
  );
}
