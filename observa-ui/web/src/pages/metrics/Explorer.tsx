// Metrics Explorer: find and chart metrics without PromQL.
//   Simple mode (default), in four steps:  1 Select metric → 2 Choose target → 3 Configure → 4 Preview
//     A plain-English question, a template or a link jumps straight to the preview.
//   Advanced PromQL - the code editor for people who know PromQL
//   Templates / Recent queries / Saved queries tabs
// Everything lives in the page address, so any view can be shared as a link.
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bookmark, Copy, Download, Plus, Bell, Trash2, Info, X, Code2, Table2, LineChart as LineIcon, ArrowRight, ArrowLeft, Check, Play } from 'lucide-react';
import { api, type PromMatrix } from '@/lib/api';
import { CATEGORIES, METRICS, TEMPLATES, buildQuery, describe, metricById, type Category, type Combine, type Filters, type MetricDef, type Template } from '@/lib/catalog';
import { understand, QUICK_QUESTIONS, type AskResult } from '@/lib/ask';
import { fmt, legendName, dateTime } from '@/lib/format';
import { color, palette } from '@/lib/theme';
import { useApp, useRangeQuery } from '@/app/AppContext';
import { rangeLabel } from '@/app/TimePicker';
import { ErrorState, Field, Modal, PageHead, Pill, Select, StateView, Tabs, TableWrap, copyText, toast, useDialogs } from '@/components/ui';
import { Sparkline, TimeChart } from '@/components/charts';
import { FilterBar, useKnownValues } from '@/components/FilterBar';
import { AlertWizard } from '@/components/AlertWizard';
import { AskBar } from './AskBar';
import { CATEGORY_ICONS, metricIcon } from './icons';
import PromQLEditor, { AddPanelDialog } from '../Metrics';

type Tab = 'explore' | 'templates' | 'recent' | 'saved';
type Step = 1 | 2 | 3 | 4;
interface View { metric: string; by?: string; fn?: Combine; topk?: number; op?: '>' | '<'; value?: number; compare?: '' | '1d' | '1w'; thr?: number }
interface Saved { name: string; url: string; at: string }

const num = (v: string | null) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const STEPS: [Step, string][] = [[1, 'Select metric'], [2, 'Choose target'], [3, 'Configure'], [4, 'Preview']];
const UNIT_WORDS: Record<string, string> = { percent: 'percent', bytes: 'bytes', Bps: 'bytes per second', ms: 'milliseconds', reqps: 'per second', short: 'count' };

export default function Explorer() {
  const { filters: globalFilters, setFilters, pref, savePref, range, can, canOpen, setDsChip } = useApp();
  const { open } = useDialogs();
  const [params, setParams] = useSearchParams();
  const known = useKnownValues();

  // old links (/metrics?q=...) and the Advanced switch open the code editor
  const codeMode = params.get('mode') === 'code' || (!!params.get('q') && !params.get('m'));
  const tab = (params.get('tab') as Tab) || 'explore';
  const step = (Number(params.get('step')) || (params.get('m') || params.get('ask') ? 4 : 1)) as Step;
  const setParam = (changes: Record<string, string | number | undefined | null>) => {
    const n = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) { if (v === undefined || v === null || v === '') n.delete(k); else n.set(k, String(v)); }
    setParams(n, { replace: true });
  };

  // links from other pages may carry a filter (?service=checkout): take it into the global filters once
  useEffect(() => {
    const take: Filters = {};
    for (const k of ['env', 'host', 'service', 'cluster', 'namespace', 'platform'] as const) { const v = params.get(k); if (v) (take as Record<string, string>)[k] = v; }
    if (Object.keys(take).length) { setFilters({ ...globalFilters, ...take }); setParam({ env: null, host: null, service: null, cluster: null, namespace: null, platform: null }); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const view: View = {
    metric: params.get('m') || 'cpu',
    by: params.get('by') || undefined,
    fn: (params.get('fn') as Combine) || undefined,
    topk: num(params.get('topk')),
    op: (params.get('op') as '>' | '<') || undefined,
    value: num(params.get('v')),
    compare: (params.get('cmp') as View['compare']) || '',
    thr: num(params.get('thr')),
  };
  const setView = (v: Partial<View>, extra: Record<string, string | number | null> = {}) => setParam({
    m: v.metric ?? view.metric, by: 'by' in v ? v.by : view.by, fn: 'fn' in v ? v.fn : view.fn, topk: 'topk' in v ? v.topk : view.topk,
    op: 'op' in v ? v.op : view.op, v: 'value' in v ? v.value : view.value, cmp: 'compare' in v ? v.compare : view.compare, thr: 'thr' in v ? v.thr : view.thr,
    tab: null, mode: null, q: null, step, ...extra,
  });
  const goStep = (s: Step) => setParam({ step: s, m: view.metric, tab: null });

  // ---- a question in plain English ----
  const ask = params.get('ask') || '';
  const [askFilters, setAskFilters] = useState<Filters>({});
  const [understood, setUnderstood] = useState<AskResult | null | 'none'>(null);
  const knownKey = `${known.hosts.length}|${known.envs.length}|${known.services.length}|${known.namespaces.length}`;
  useEffect(() => {
    if (!ask) { setUnderstood(null); return; }
    const r = understand(ask, known);
    if (!r) { setUnderstood('none'); return; }
    setUnderstood(r);
    setAskFilters(r.filters);
    setParam({ m: r.metric, by: r.by, fn: r.fn, topk: r.topk, op: r.op, v: r.value, tab: null, mode: null, step: 4 });
    const hist = pref<string[]>('askHistory') || [];
    savePref('askHistory', [ask, ...hist.filter((x) => x !== ask)].slice(0, 15));
  }, [ask, knownKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const filters: Filters = { ...globalFilters, ...askFilters };
  const def = metricById(view.metric) || METRICS[0];
  const query = buildQuery({ ...view, filters });
  const res = useRangeQuery(['explore', query], (r) => api<{ result: PromMatrix }>('/prom/query_range', { query: { query, ...r } }), { enabled: !codeMode && !!query && tab === 'explore' && step > 1 });
  const shift = view.compare === '1d' ? 86400 : view.compare === '1w' ? 7 * 86400 : 0;
  const cmp = useRangeQuery(['explore-cmp', query, shift], (r) => api<{ result: PromMatrix }>('/prom/query_range', { query: { query, start: r.start - shift, end: r.end - shift } }), { enabled: !codeMode && !!shift && step > 1 });
  useEffect(() => { if (!codeMode) setDsChip(res.isError ? { label: 'Prometheus unavailable', tone: 'crit' } : { label: 'Prometheus', tone: 'ok' }); }, [res.isError, codeMode, setDsChip]);

  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [asTable, setAsTable] = useState(false);
  const pal = palette();
  const rows = res.data?.result || [];
  const by = view.by || def.by;
  const seriesAll = rows.slice(0, 20).map((r, i) => ({ label: legendName(r.metric, `{{${by}}}`) || legendName(r.metric) || def.name, points: r.values, color: pal[i % pal.length] }));
  const shown = seriesAll.filter((s) => !hidden.has(s.label));
  const cmpSeries = shift ? (cmp.data?.result || []).slice(0, 20).map((r, i) => ({ label: `${legendName(r.metric, `{{${by}}}`) || def.name} (${view.compare === '1d' ? 'yesterday' : 'last week'})`, points: r.values.map(([t, v]) => [t + shift, v] as [number, string]), color: pal[i % pal.length], dashed: true })) : [];
  const r0 = res.data?.result[0]?.values;
  const thrSeries = view.thr !== undefined && r0?.length ? [{ label: `Threshold (${fmt(view.thr, def.unit)})`, points: [[r0[0][0], view.thr], [r0[r0.length - 1][0], view.thr]] as [number, number][], color: color('crit'), dashed: true }] : [];
  const stats = seriesAll.map((s) => {
    const vs = s.points.map((p) => Number(p[1])).filter(Number.isFinite);
    return { label: s.label, color: s.color, now: vs.length ? vs[vs.length - 1] : null, min: vs.length ? Math.min(...vs) : null, max: vs.length ? Math.max(...vs) : null, avg: vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null };
  }).sort((a, b) => (b.now ?? -Infinity) - (a.now ?? -Infinity));
  const top = stats[0];
  const chartSeries = [...shown, ...cmpSeries.filter((c) => !hidden.has(c.label.replace(/ \((yesterday|last week)\)$/, ''))), ...thrSeries];

  function saveView() {
    open((close) => <SaveViewDialog onClose={close} defaultName={describe({ ...view, filters }, rangeLabel(range)).split(' · ')[0]} onSave={(name) => {
      const list = pref<Saved[]>('savedViews') || [];
      const url = `/metrics/explore?${new URLSearchParams([...params.entries()].filter(([k]) => k !== 'ask' && k !== 'tab' && k !== 'step')).toString()}&step=4${Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(String(v))}`).join('')}`;
      savePref('savedViews', [{ name, url, at: new Date().toISOString() }, ...list.filter((x) => x.name !== name)].slice(0, 50));
      toast('View saved');
    }} />);
  }
  function exportCsv() {
    const times = [...new Set(seriesAll.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b);
    const maps = seriesAll.map((s) => new Map(s.points.map(([t, v]) => [t, v])));
    const esc = (x: string) => `"${x.replace(/"/g, '""')}"`;
    const csv = [['time', ...seriesAll.map((s) => s.label)].map(esc).join(','), ...times.map((t) => [new Date(t * 1000).toISOString(), ...maps.map((m) => m.get(t) ?? '')].join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `observaone-${def.id}-${dateTime(Date.now()).replace(/[: ]/g, '-')}.csv`;
    a.click();
  }
  const pickMetric = (m: MetricDef, next?: Step) => {
    setAskFilters({}); setUnderstood(null);
    setParam({ ask: null, m: m.id, by: null, topk: null, op: null, v: null, fn: m.id === 'disk' ? 'max' : null, step: next ?? 1, tab: null, mode: null });
  };

  const head = (
    <PageHead title="Metrics Explorer" sub="Find, query and visualise metrics from all your data sources. No PromQL needed."
      actions={
        <div className="mode-switch" role="group" aria-label="Mode">
          <button className={!codeMode ? 'on' : ''} aria-pressed={!codeMode} onClick={() => setParam({ mode: null, q: null })}>Simple mode</button>
          <button className={codeMode ? 'on' : ''} aria-pressed={codeMode} onClick={() => setParam({ mode: 'code', q: query })}><Code2 size={14} />Advanced PromQL</button>
        </div>
      } />
  );
  if (codeMode) return <>{head}<PromQLEditor embedded /></>;

  const resultBody = (big: boolean) => (
    res.isPending ? <StateView kind="loading" skeleton="chart" /> : res.isError ? <ErrorState error={res.error} what="Metrics" />
      : !rows.length ? <StateView kind="empty" title={view.op ? 'Nothing matches the condition in this time range' : 'No data for this view'} text={view.op ? 'Good news, or loosen the condition.' : 'Your servers may not send this metric yet, or the filters exclude everything. Clear filters or pick another metric.'} />
        : asTable && big ? (
          <TableWrap label="Current values">
            <table className="tbl">
              <thead><tr><th>{by.replace('service_name', 'service')}</th><th className="num">Now</th><th className="num">Min</th><th className="num">Avg</th><th className="num">Max</th></tr></thead>
              <tbody>{stats.map((s) => <tr key={s.label}><td><i className="dot" style={{ background: s.color, marginRight: 8 }} />{s.label}</td><td className="num">{fmt(s.now, def.unit)}</td><td className="num">{fmt(s.min, def.unit)}</td><td className="num">{fmt(s.avg, def.unit)}</td><td className="num">{fmt(s.max, def.unit)}</td></tr>)}</tbody>
            </table>
          </TableWrap>
        ) : (
          <div className={big ? 'metrics-graph' : ''}>
            <TimeChart series={chartSeries} unit={def.unit} className={big ? 'chart-box lg' : 'chart-box'} style={big ? undefined : { height: 170 }} correlate
              query={query} metric={def.id} filters={filters} max={def.unit === 'percent' ? 100 : undefined} />
            {big && (
              <div className="legend-col" aria-label="Lines (click to show or hide)">
                {seriesAll.map((s) => (
                  <button key={s.label} className={`legend-item legend-toggle ${hidden.has(s.label) ? 'off' : ''}`} title={s.label}
                    onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(s.label)) n.delete(s.label); else n.add(s.label); return n; })}>
                    <i style={{ background: s.color }} /><span className="ell">{s.label}</span>
                  </button>
                ))}
                {shift > 0 && <span className="dim" style={{ fontSize: 11.5 }}>Dashed: {view.compare === '1d' ? 'yesterday' : 'last week'}</span>}
              </div>
            )}
          </div>
        )
  );

  return (
    <>
      {head}
      <AskBar initial={ask} compact={tab !== 'explore' || step !== 1} onAsk={(q) => setParam({ ask: q, tab: null, step: 4 })} />
      <div className="toolbar" style={{ marginTop: 12 }}>
        <Tabs items={[['explore', 'Explore'], ['templates', 'Templates'], ['recent', 'Recent queries'], ['saved', 'Saved queries']]} active={tab} onChange={(k) => setParam({ tab: k === 'explore' ? null : k })} label="Explorer sections" />
      </div>

      {tab === 'templates' && <Templates onUse={(t) => { setAskFilters(t.filters || {}); setUnderstood(null); setParam({ ask: null, m: t.metric, by: t.by, fn: t.fn, topk: t.topk, op: t.op, v: t.value, cmp: null, thr: null, tab: null, step: 4 }); }} />}
      {tab === 'recent' && <Recent onAsk={(q) => setParam({ ask: q, tab: null, step: 4 })} />}
      {tab === 'saved' && <SavedViews />}

      {tab === 'explore' && (
        <>
          <ol className="stepper" aria-label="Steps">
            {STEPS.map(([n, label]) => (
              <li key={n} className={n === step ? 'on' : n < step ? 'done' : ''}>
                <button onClick={() => goStep(n)} aria-current={n === step ? 'step' : undefined}>
                  <span className="st-n">{n < step ? <Check size={12} /> : n}</span><span className="st-l">{label}</span>
                </button>
              </li>
            ))}
          </ol>

          {understood === 'none' && (
            <div className="info-box"><Info size={15} /><span>I couldn't match "{ask}" to a metric yet. Try words like CPU, memory, disk, network, processes, requests, errors, latency, pods, database, ESXi or interface, or pick a template.</span></div>
          )}
          {understood && understood !== 'none' && (
            <div className="understood">
              <span className="dim">Understood:</span>
              {understood.understood.map((u) => <span key={u} className="pill pill-blue">{u}</span>)}
              <span className="pill pill-green">Built-in · no AI</span>
            </div>
          )}

          {step === 1 && <PickMetric def={def} onPick={(m) => pickMetric(m)} onNext={() => goStep(2)} onShow={() => goStep(4)} />}

          {step === 2 && (
            <div className="step-grid">
              <section className="panel">
                <div className="panel-head"><h3>For which servers, clusters or services?</h3></div>
                <p className="dim" style={{ marginTop: 0, fontSize: 12.5 }}>Pick one or more. Leave a filter on "All" to include everything. These filters are shared by all Metrics pages.</p>
                <FilterBar />
                {Object.keys(askFilters).length > 0 && (
                  <div className="chips" style={{ marginBottom: 10 }}>
                    <span className="dim" style={{ fontSize: 12 }}>From your question:</span>
                    {Object.entries(askFilters).filter(([, v]) => v).map(([k, v]) => (
                      <span key={k} className="fchip">{k} = {String(v)}<button aria-label={`Remove ${k}`} onClick={() => { const n = { ...askFilters }; delete (n as Record<string, unknown>)[k]; setAskFilters(n); }}><X size={12} /></button></span>
                    ))}
                  </div>
                )}
                <div className="form-row">
                  <Field label="Draw one line per"><Select options={def.byOptions.map((b) => [b, b === 'service_name' ? 'service' : b] as [string, string])} value={by} onChange={(b) => setView({ by: b === def.by ? undefined : b })} /></Field>
                </div>
                <StepNav onBack={() => goStep(1)} onNext={() => goStep(3)} next="Next: Configure" />
              </section>
              <LivePreview title={`${stats.length || 0} ${stats.length === 1 ? 'line' : 'lines'} so far`}>{resultBody(false)}</LivePreview>
            </div>
          )}

          {step === 3 && (
            <div className="step-grid">
              <section className="panel">
                <div className="panel-head"><h3>How should it be shown?</h3></div>
                <div className="form-row">
                  <Field label="Combine with"><Select options={[['avg', 'Average'], ['max', 'Maximum'], ['min', 'Minimum'], ['sum', 'Sum']]} value={view.fn || 'avg'} onChange={(fn) => setView({ fn: fn === 'avg' ? undefined : fn as Combine })} /></Field>
                  <Field label="Show"><Select options={[[0, 'All lines'], [5, 'Top 5'], [10, 'Top 10'], [20, 'Top 20']]} value={view.topk || 0} onChange={(k) => setView({ topk: k || undefined })} /></Field>
                </div>
                <div className="cfg-rows">
                  <div className="cond-row">
                    <span className="cfg-l">Only where the value is</span>
                    <Select className="select select-sm" label="Condition" options={[['', 'any value'], ['>', 'above'], ['<', 'below']]} value={view.op || ''} onChange={(op) => setView({ op: (op || undefined) as View['op'], value: op ? view.value ?? def.warn ?? 0 : undefined })} />
                    {view.op && <input className="input" type="number" style={{ width: 90, height: 30 }} aria-label="Condition value" value={view.value ?? ''} onChange={(e) => setView({ value: num(e.target.value) })} />}
                  </div>
                  <div className="cond-row">
                    <span className="cfg-l">Compare with</span>
                    <div className="seg-row">
                      {([['', 'Nothing'], ['1d', 'Yesterday'], ['1w', 'Last week']] as const).map(([k, l]) => (
                        <button key={k} className={`seg-btn ${view.compare === k ? 'on' : ''}`} aria-pressed={view.compare === k} onClick={() => setView({ compare: k })}>{l}</button>
                      ))}
                    </div>
                  </div>
                  <div className="cond-row">
                    <span className="cfg-l">Threshold line at</span>
                    <input className="input" type="number" style={{ width: 90, height: 30 }} aria-label="Threshold line" placeholder={def.warn !== undefined ? String(def.warn) : ''} value={view.thr ?? ''} onChange={(e) => setView({ thr: num(e.target.value) })} />
                    <span className="dim">{def.unit === 'percent' ? '%' : ''}</span>
                    {def.warn !== undefined && view.thr === undefined && <button className="linkish" onClick={() => setView({ thr: def.warn })}>Use {def.warn}{def.unit === 'percent' ? '%' : ''} (warning level)</button>}
                  </div>
                  <div className="dim" style={{ fontSize: 12 }}>Unit: <b style={{ color: 'var(--text)' }}>{UNIT_WORDS[def.unit as string] || def.unit}</b> (set for you)</div>
                </div>
                <StepNav onBack={() => goStep(2)} onNext={() => goStep(4)} next="Show preview" />
              </section>
              <LivePreview title={describe({ ...view, filters }, rangeLabel(range))}>{resultBody(false)}</LivePreview>
            </div>
          )}

          {step === 4 && (
            <section className="panel">
              <div className="result-head">
                <div>
                  <div className="result-title">{describe({ ...view, filters }, rangeLabel(range))}</div>
                  {top && top.now !== null && (
                    <div className="dim" style={{ marginTop: 3 }}>
                      {view.op ? `${stats.length} ${stats.length === 1 ? 'line matches' : 'lines match'} the condition. ` : `${stats.length} ${stats.length === 1 ? 'line' : 'lines'}. `}
                      Highest now: <b style={{ color: 'var(--text)' }}>{top.label}</b> at <b style={{ color: 'var(--text)' }}>{fmt(top.now, def.unit)}</b>.
                    </div>
                  )}
                </div>
                <div className="preview-tools">
                  <Select className="select select-sm" label="Compare" options={[['', 'No comparison'], ['1d', 'Compare: yesterday'], ['1w', 'Compare: last week']]} value={view.compare || ''} onChange={(c) => setView({ compare: c as View['compare'] })} />
                  <div className="seg-mini" role="group" aria-label="View as">
                    <button className={!asTable ? 'on' : ''} aria-pressed={!asTable} onClick={() => setAsTable(false)} title="Chart"><LineIcon size={14} /></button>
                    <button className={asTable ? 'on' : ''} aria-pressed={asTable} onClick={() => setAsTable(true)} title="Table"><Table2 size={14} /></button>
                  </div>
                </div>
              </div>
              {resultBody(true)}
              {!asTable && rows.length > 0 && <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>Click any point to investigate: values, logs, traces and alerts at that moment.</div>}
              <div className="action-row" style={{ marginTop: 12 }}>
                <button className="btn" onClick={() => goStep(3)}><ArrowLeft size={14} />Change settings</button>
                <span className="grow" />
                <button className="btn" onClick={saveView}><Bookmark size={14} />Save query</button>
                {can('dashboards.edit') && canOpen('/dashboards') && <button className="btn" onClick={() => open((close) => <AddPanelDialog query={query} unit={def.unit} onClose={close} />)}><Plus size={14} />Add to dashboard</button>}
                <button className="btn" onClick={exportCsv} disabled={!rows.length}><Download size={14} />Export CSV</button>
                <button className="btn" onClick={() => copyText(location.href, 'Link copied')}><Copy size={14} />Copy link</button>
                {canOpen('/alerting') && <button className="btn btn-primary" onClick={() => open((close) => <AlertWizard onClose={close} metric={def.id} filters={filters} value={view.thr ?? view.value} />)}><Bell size={14} />Create alert</button>}
              </div>
            </section>
          )}

          <section className="panel promql-box" style={{ marginTop: 12 }}>
            <div className="row-head">
              <b>Generated PromQL</b><span className="dim">read-only, updates as you click</span>
              <span className="grow" />
              <button className="btn btn-sm" onClick={() => copyText(query, 'Query copied')}><Copy size={13} />Copy</button>
              <button className="btn btn-sm" onClick={() => setParam({ mode: 'code', q: query })}><Code2 size={13} />Edit in Advanced PromQL</button>
            </div>
            <pre className="code">{query}</pre>
          </section>
        </>
      )}
    </>
  );
}

function StepNav({ onBack, onNext, next }: { onBack: () => void; onNext: () => void; next: string }) {
  return (
    <div className="step-nav">
      <button className="btn" onClick={onBack}><ArrowLeft size={14} />Back</button>
      <button className="btn btn-primary" onClick={onNext}>{next}<ArrowRight size={14} /></button>
    </div>
  );
}

function LivePreview({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel live-preview">
      <div className="panel-head"><h3>Live preview</h3><div className="right dim" style={{ fontSize: 12 }}>{title}</div></div>
      {children}
    </section>
  );
}

// ---------------- step 1: pick a metric ----------------
function PickMetric({ def, onPick, onNext, onShow }: { def: MetricDef; onPick: (m: MetricDef) => void; onNext: () => void; onShow: () => void }) {
  const [cat, setCat] = useState<Category>(def.category);
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const list = term
    ? METRICS.filter((m) => `${m.name} ${m.description} ${m.keywords.join(' ')} ${m.raw.join(' ')}`.toLowerCase().includes(term))
    : METRICS.filter((m) => m.category === cat || m.also?.includes(cat));
  const SelIcon = metricIcon(def.id);
  return (
    <div className="pick">
      <nav className="pick-cats" aria-label="Metric category">
        <div className="pick-head">Metric category</div>
        {CATEGORIES.map((c) => {
          const Icon = CATEGORY_ICONS[c.id];
          const n = METRICS.filter((m) => m.category === c.id || m.also?.includes(c.id)).length;
          return (
            <button key={c.id} className={cat === c.id && !term ? 'on' : ''} aria-pressed={cat === c.id && !term} onClick={() => { setCat(c.id); setQ(''); }}>
              <Icon size={15} /><span className="grow">{c.name}</span>{n > 0 && <span className="count-badge">{n}</span>}
            </button>
          );
        })}
      </nav>
      <section className="pick-main">
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <div>
            <div style={{ fontWeight: 600 }}>{term ? `Metrics matching "${q}"` : 'Select a metric'}</div>
            {!term && <div className="dim" style={{ fontSize: 12 }}>{CATEGORIES.find((c) => c.id === cat)!.hint}</div>}
          </div>
          <div className="grow" />
          <input className="input" placeholder="Search metrics..." aria-label="Search metrics" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
        </div>
        {!term && cat === 'cloud' ? (
          <StateView kind="empty" title="No cloud metrics connected" text="Add the AWS CloudWatch exporter or Azure Monitor exporter to Prometheus. Their metrics then appear here and in the Advanced PromQL editor." />
        ) : !term && cat === 'custom' ? (
          <StateView kind="empty" title="Anything else" text="Every metric in Prometheus can be charted with PromQL, with autocomplete for metric and label names."
            action={<Link className="btn btn-primary btn-sm" to="/metrics/explore?mode=code"><Code2 size={14} />Open Advanced PromQL</Link>} />
        ) : !list.length ? <StateView kind="empty" title="No metrics match" /> : (
          <div className="metric-cards">
            {list.map((m) => <MetricCard key={m.id} m={m} on={m.id === def.id} onClick={() => onPick(m)} onOpen={() => { onPick(m); onShow(); }} />)}
          </div>
        )}
      </section>
      <aside className="pick-sel panel" aria-label="Selected metric">
        <div className="pick-head" style={{ padding: 0 }}>Selected metric</div>
        <div className="sel-title"><span className="mc-ic"><SelIcon size={18} /></span><div><b>{def.name}</b><div className="dim" style={{ fontSize: 11.5 }}>{CATEGORIES.find((c) => c.id === def.category)?.name}</div></div></div>
        <p className="sel-desc">{def.description}</p>
        <p className="dim" style={{ fontSize: 12, margin: 0 }}>{def.normal}</p>
        {def.uses && (
          <>
            <div className="field-label" style={{ marginTop: 12 }}>Common use cases</div>
            <ul className="uses">{def.uses.map((u) => <li key={u}>{u}</li>)}</ul>
          </>
        )}
        <div className="mono dim" style={{ fontSize: 11, marginTop: 8, wordBreak: 'break-all' }}>{def.raw.join(' · ')}</div>
        <div className="sel-actions">
          <button className="btn btn-primary" onClick={onNext}>Next: Choose target<ArrowRight size={14} /></button>
          <button className="btn" onClick={onShow}><Play size={13} />Show now</button>
        </div>
      </aside>
    </div>
  );
}

function MetricCard({ m, on, onClick, onOpen }: { m: MetricDef; on: boolean; onClick: () => void; onOpen: () => void }) {
  const { filters } = useApp();
  const query = useMemo(() => `${m.unit === 'percent' || m.unit === 'ms' ? 'avg' : 'sum'}(${buildQuery({ metric: m.id, filters })})`, [m, filters]);
  const q = useRangeQuery(['mc-spark', query], (r) => api<{ result: PromMatrix }>('/prom/query_range', { query: { query, ...r, step: Math.ceil((r.end - r.start) / 40) } }), { autoRefresh: false });
  const s = q.data?.result[0]?.values;
  const Icon = metricIcon(m.id);
  return (
    <button className={`metric-card ${on ? 'on' : ''}`} aria-pressed={on} onClick={onClick} onDoubleClick={onOpen} title="Click to select, double-click to show">
      <div className="mc-top"><span className="mc-ic"><Icon size={16} /></span><b>{m.name}</b></div>
      <div className="mc-desc dim">{m.description}</div>
      <div className="mc-foot">
        <div className="mc-spark">{s && s.length > 1 ? <Sparkline points={s} /> : <span className="dim" style={{ fontSize: 11 }}>{q.isPending ? '' : 'No data yet'}</span>}</div>
        <span className="mc-val">{s?.length ? fmt(Number(s[s.length - 1][1]), m.unit) : ''}</span>
      </div>
    </button>
  );
}

// ---------------- templates ----------------
const TPL_TABS: [Category | 'all', string][] = [['all', 'All'], ['system', 'System'], ['kubernetes', 'Kubernetes'], ['applications', 'Applications'], ['databases', 'Databases'], ['network', 'Network'], ['vmware', 'VMware']];
function Templates({ onUse }: { onUse: (t: Template) => void }) {
  const [cat, setCat] = useState<Category | 'all'>('all');
  const [q, setQ] = useState('');
  const list = TEMPLATES.filter((t) => (cat === 'all' || t.categories.includes(cat)) && (!q || `${t.title} ${t.text} ${t.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="templates2">
      <div className="toolbar">
        <div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>Metrics templates</div>
          <div className="dim" style={{ fontSize: 12 }}>Pre-built queries for common monitoring use cases. Use one to open it in the explorer.</div>
        </div>
        <div className="grow" />
        <input className="input" placeholder="Search templates..." aria-label="Search templates" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
      </div>
      <div className="toolbar"><Tabs items={TPL_TABS.map(([k, l]) => [k, `${l} (${TEMPLATES.filter((t) => k === 'all' || t.categories.includes(k)).length})`] as [Category | 'all', string])} active={cat} onChange={setCat} label="Template categories" /></div>
      <div className="tpl-grid">{list.map((t) => <TemplateCard key={t.id} t={t} onUse={() => onUse(t)} />)}</div>
      {!list.length && <StateView kind="empty" title="No templates match" />}
      <div className="quick-q">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Quick questions (try clicking)</div>
        <div className="ask-chips">{QUICK_QUESTIONS.map((x) => <Link key={x} className="ask-chip" to={`/metrics/explore?ask=${encodeURIComponent(x)}`}>{x}</Link>)}</div>
      </div>
    </div>
  );
}

function TemplateCard({ t, onUse }: { t: Template; onUse: () => void }) {
  const { filters } = useApp();
  const d = metricById(t.metric)!;
  const query = useMemo(() => `${d.unit === 'percent' || d.unit === 'ms' ? 'avg' : 'sum'}(${buildQuery({ metric: t.metric, filters: { ...filters, ...t.filters } })})`, [t, filters, d]);
  const q = useRangeQuery(['tpl-spark', query], (r) => api<{ result: PromMatrix }>('/prom/query_range', { query: { query, ...r, step: Math.ceil((r.end - r.start) / 40) } }), { autoRefresh: false });
  const s = q.data?.result[0]?.values;
  const Icon = metricIcon(t.metric);
  return (
    <div className="tpl-card">
      <div className="mc-top"><span className="mc-ic"><Icon size={16} /></span><span className="tpl-title">{t.title}</span></div>
      <div className="dim tpl-text">{t.text}</div>
      <div className="tpl-tags">{t.tags.map((x) => <span key={x} className="tag">{x}</span>)}</div>
      <div className="tpl-foot">
        <div className="tpl-spark">{s && s.length > 1 ? <Sparkline points={s} /> : <span className="dim" style={{ fontSize: 11 }}>{q.isPending ? '' : 'No data yet'}</span>}</div>
        <span className="dim" style={{ fontSize: 11.5 }}>{s?.length ? fmt(Number(s[s.length - 1][1]), d.unit) : ''}</span>
        <button className="btn btn-sm btn-primary" onClick={onUse}>Use</button>
      </div>
    </div>
  );
}

function Recent({ onAsk }: { onAsk: (q: string) => void }) {
  const { pref } = useApp();
  const asks = pref<string[]>('askHistory') || [];
  const queries = pref<string[]>('metricsHistory') || [];
  return (
    <div className="grid cols-2">
      <section className="panel">
        <div className="panel-head"><h3>Your recent questions</h3></div>
        {!asks.length ? <StateView kind="empty" title="No questions yet" text="Ask something in the box above." /> : (
          <div className="list-rows">{asks.map((a) => <button key={a} className="list-row linkish" onClick={() => onAsk(a)}>{a}</button>)}</div>
        )}
      </section>
      <section className="panel">
        <div className="panel-head"><h3>Your recent PromQL</h3></div>
        {!queries.length ? <StateView kind="empty" title="No PromQL yet" /> : (
          <div className="list-rows">{queries.map((x) => <Link key={x} className="list-row mono" style={{ fontSize: 12 }} to={`/metrics/explore?mode=code&q=${encodeURIComponent(x)}`}>{x}</Link>)}</div>
        )}
      </section>
    </div>
  );
}

function SavedViews() {
  const { pref, savePref } = useApp();
  const { confirm } = useDialogs();
  const [list, setList] = useState<Saved[]>(pref<Saved[]>('savedViews') || []);
  if (!list.length) return <StateView kind="empty" title="No saved queries yet" text='Build a view on the Explore tab and press "Save query".' />;
  return (
    <TableWrap label="Saved queries">
      <table className="tbl">
        <thead><tr><th>Name</th><th>Saved</th><th /></tr></thead>
        <tbody>
          {list.map((v) => (
            <tr key={v.name}>
              <td><Link to={v.url}>{v.name}</Link></td>
              <td className="dim">{dateTime(Date.parse(v.at)).slice(0, 16)}</td>
              <td className="num">
                <button className="icon-btn" title="Copy link" aria-label={`Copy link to ${v.name}`} onClick={() => copyText(location.origin + v.url, 'Link copied')}><Copy size={14} /></button>
                <button className="icon-btn" title="Delete" aria-label={`Delete ${v.name}`} onClick={async () => {
                  if (!(await confirm('Delete saved query', `Delete "${v.name}"?`, 'Delete'))) return;
                  const n = list.filter((x) => x.name !== v.name); setList(n); savePref('savedViews', n);
                }}><Trash2 size={14} /></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="table-foot"><Pill tone="muted">Saved for you only</Pill></div>
    </TableWrap>
  );
}

function SaveViewDialog({ onClose, onSave, defaultName }: { onClose: () => void; onSave: (n: string) => void; defaultName: string }) {
  const [name, setName] = useState(defaultName.slice(0, 80));
  return (
    <Modal title="Save query" onClose={onClose} actions={[{ label: 'Cancel' }, { label: 'Save', primary: true, disabled: !name.trim(), onClick: () => onSave(name.trim()) }]}>
      <Field label="Name" hint="Saved queries keep the metric, filters, split, condition and comparison."><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
    </Modal>
  );
}
