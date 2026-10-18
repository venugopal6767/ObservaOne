// Metrics Explorer: find and chart metrics without PromQL.
//   Explore   - ask a question or click through: what → split by → combine → condition → compare
//   Templates - ready-made views by category (System, Kubernetes, Applications, Network, Linux, Windows)
//   Recent    - your recent questions and queries;  Saved - views you saved
//   PromQL    - the switch top right opens the code editor for people who know PromQL
// Everything lives in the page address, so any view can be shared as a link.
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bookmark, Copy, Download, Plus, Bell, Trash2, Info, X, Code2, Table2, LineChart as LineIcon } from 'lucide-react';
import { api, type PromMatrix } from '@/lib/api';
import { CATEGORIES, METRICS, TEMPLATES, buildQuery, describe, metricById, type Category, type Combine, type Filters, type Template } from '@/lib/catalog';
import { understand, QUICK_QUESTIONS, type AskResult } from '@/lib/ask';
import { fmt, legendName, dateTime } from '@/lib/format';
import { color, palette } from '@/lib/theme';
import { useApp, useRangeQuery } from '@/app/AppContext';
import { rangeLabel } from '@/app/TimePicker';
import { ErrorState, Field, Modal, PageHead, Pill, Select, StateView, Tabs, TableWrap, Toggle, copyText, toast, useDialogs } from '@/components/ui';
import { Sparkline, TimeChart } from '@/components/charts';
import { FilterBar, useKnownValues } from '@/components/FilterBar';
import { AlertWizard } from '@/components/AlertWizard';
import { AskBar } from './AskBar';
import PromQLEditor, { AddPanelDialog } from '../Metrics';

type Tab = 'explore' | 'templates' | 'recent' | 'saved';
interface View { metric: string; by?: string; fn?: Combine; topk?: number; op?: '>' | '<'; value?: number; compare?: '' | '1d' | '1w'; thr?: number }
interface Saved { name: string; url: string; at: string }

const num = (v: string | null) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

export default function Explorer() {
  const { filters: globalFilters, setFilters, pref, savePref, range, can, canOpen, setDsChip } = useApp();
  const { open } = useDialogs();
  const [params, setParams] = useSearchParams();
  const known = useKnownValues();

  // old links (/metrics?q=...) and the PromQL switch open the code editor
  const codeMode = params.get('mode') === 'code' || (!!params.get('q') && !params.get('m'));
  const tab = (params.get('tab') as Tab) || 'explore';
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
  const setView = (v: Partial<View>) => setParam({
    m: v.metric ?? view.metric, by: 'by' in v ? v.by : view.by, fn: 'fn' in v ? v.fn : view.fn, topk: 'topk' in v ? v.topk : view.topk,
    op: 'op' in v ? v.op : view.op, v: 'value' in v ? v.value : view.value, cmp: 'compare' in v ? v.compare : view.compare, thr: 'thr' in v ? v.thr : view.thr, tab: 'explore', mode: null, q: null,
  });

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
    setParam({ m: r.metric, by: r.by, fn: r.fn, topk: r.topk, op: r.op, v: r.value, tab: 'explore', mode: null });
    const hist = pref<string[]>('askHistory') || [];
    savePref('askHistory', [ask, ...hist.filter((x) => x !== ask)].slice(0, 15));
  }, [ask, knownKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const filters: Filters = { ...globalFilters, ...askFilters };
  const def = metricById(view.metric) || METRICS[0];
  const query = buildQuery({ ...view, filters });
  const res = useRangeQuery(['explore', query], (r) => api<{ result: PromMatrix }>('/prom/query_range', { query: { query, ...r } }), { enabled: !codeMode && !!query });
  const shift = view.compare === '1d' ? 86400 : view.compare === '1w' ? 7 * 86400 : 0;
  const cmp = useRangeQuery(['explore-cmp', query, shift], (r) => api<{ result: PromMatrix }>('/prom/query_range', { query: { query, start: r.start - shift, end: r.end - shift } }), { enabled: !codeMode && !!shift });
  useEffect(() => { if (!codeMode) setDsChip(res.isError ? { label: 'Prometheus unavailable', tone: 'crit' } : { label: 'Prometheus', tone: 'ok' }); }, [res.isError, codeMode, setDsChip]);

  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [asTable, setAsTable] = useState(false);
  const pal = palette();
  const rows = res.data?.result || [];
  const seriesAll = rows.slice(0, 20).map((r, i) => ({ label: legendName(r.metric, `{{${(view.by || def.by)}}}`) || legendName(r.metric), points: r.values, color: pal[i % pal.length] }));
  const shown = seriesAll.filter((s) => !hidden.has(s.label));
  const cmpSeries = shift ? (cmp.data?.result || []).slice(0, 20).map((r, i) => ({ label: `${legendName(r.metric, `{{${view.by || def.by}}}`)} (${view.compare === '1d' ? 'yesterday' : 'last week'})`, points: r.values.map(([t, v]) => [t + shift, v] as [number, string]), color: pal[i % pal.length], dashed: true })) : [];
  const r0 = res.data?.result[0]?.values;
  const thrSeries = view.thr !== undefined && r0?.length ? [{ label: `Threshold (${fmt(view.thr, def.unit)})`, points: [[r0[0][0], view.thr], [r0[r0.length - 1][0], view.thr]] as [number, number][], color: color('crit'), dashed: true }] : [];
  const stats = seriesAll.map((s) => {
    const vs = s.points.map((p) => Number(p[1])).filter(Number.isFinite);
    return { label: s.label, color: s.color, now: vs.length ? vs[vs.length - 1] : null, min: vs.length ? Math.min(...vs) : null, max: vs.length ? Math.max(...vs) : null, avg: vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null };
  }).sort((a, b) => (b.now ?? -Infinity) - (a.now ?? -Infinity));
  const top = stats[0];

  function saveView() {
    open((close) => <SaveViewDialog onClose={close} defaultName={describe({ ...view, filters }, rangeLabel(range)).split(' · ')[0]} onSave={(name) => {
      const list = pref<Saved[]>('savedViews') || [];
      const url = `/metrics/explore?${new URLSearchParams([...params.entries()].filter(([k]) => k !== 'ask' && k !== 'tab')).toString()}${Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(String(v))}`).join('')}`;
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

  const head = (
    <PageHead title="Metrics Explorer" sub="Find, query and visualise metrics from all your data sources"
      actions={
        <label className="promql-switch">
          <Code2 size={15} /><span>PromQL</span>
          <Toggle checked={codeMode} label="PromQL code editor" onChange={(on) => setParam({ mode: on ? 'code' : null, q: on ? query : null })} />
        </label>
      } />
  );
  if (codeMode) return <>{head}<PromQLEditor embedded /></>;

  return (
    <>
      {head}
      <AskBar initial={ask} compact={tab !== 'explore'} onAsk={(q) => setParam({ ask: q, tab: 'explore' })} />
      <div className="toolbar" style={{ marginTop: 12 }}>
        <Tabs items={[['explore', 'Explore'], ['templates', 'Templates'], ['recent', 'Recent'], ['saved', 'Saved views']]} active={tab} onChange={(k) => setParam({ tab: k === 'explore' ? null : k })} label="Explorer sections" />
        <div className="grow" />
        <FilterBar show={['env', 'platform', 'cluster', 'service', 'host']} />
      </div>

      {tab === 'templates' && <Templates onUse={(t) => { setAskFilters(t.filters || {}); setUnderstood(null); setParam({ ask: null, m: t.metric, by: t.by, fn: t.fn, topk: t.topk, op: t.op, v: t.value, cmp: null, thr: null, tab: null }); }} />}
      {tab === 'recent' && <Recent onAsk={(q) => setParam({ ask: q, tab: null })} />}
      {tab === 'saved' && <SavedViews />}

      {tab === 'explore' && (
        <div className="explore">
          <aside className="builder" aria-label="Build your view">
            <div className="bstep">
              <div className="blabel"><span className="stepn">1</span>What do you want to see?</div>
              <Select className="select" label="Metric" value={view.metric} onChange={(m) => { setAskFilters({}); setUnderstood(null); setParam({ ask: null }); setView({ metric: m, by: undefined, topk: undefined, op: undefined, value: undefined }); }}
                options={CATEGORIES.flatMap((c) => METRICS.filter((m) => m.category === c.id).map((m) => [m.id, `${c.name} · ${m.name}`] as [string, string]))} style={{ width: '100%' }} />
              <div className="metric-info"><Info size={13} /><span><b>{def.description}</b> {def.normal}<span className="mono dim" style={{ display: 'block', marginTop: 3 }}>{def.raw.join(' · ')}</span></span></div>
            </div>
            <div className="bstep">
              <div className="blabel"><span className="stepn">2</span>For which servers or services?</div>
              <div className="dim" style={{ fontSize: 12 }}>Uses the filters at the top of the page{Object.keys(askFilters).length ? ', plus these from your question:' : '.'}</div>
              {Object.keys(askFilters).length > 0 && (
                <div className="chips">
                  {Object.entries(askFilters).filter(([, v]) => v).map(([k, v]) => (
                    <span key={k} className="fchip">{k} = {String(v)}<button aria-label={`Remove ${k}`} onClick={() => { const n = { ...askFilters }; delete (n as Record<string, unknown>)[k]; setAskFilters(n); }}><X size={12} /></button></span>
                  ))}
                </div>
              )}
            </div>
            <div className="bstep">
              <div className="blabel"><span className="stepn">3</span>How to show it</div>
              <div className="form-row">
                <Field label="One line per"><Select options={def.byOptions.map((b) => [b, b === 'service_name' ? 'service' : b] as [string, string])} value={view.by || def.by} onChange={(b) => setView({ by: b === def.by ? undefined : b })} /></Field>
                <Field label="Combine with"><Select options={[['avg', 'Average'], ['max', 'Maximum'], ['min', 'Minimum'], ['sum', 'Sum']]} value={view.fn || 'avg'} onChange={(fn) => setView({ fn: fn === 'avg' ? undefined : fn as Combine })} /></Field>
              </div>
              <Field label="Show"><Select options={[[0, 'All lines'], [5, 'Top 5'], [10, 'Top 10'], [20, 'Top 20']]} value={view.topk || 0} onChange={(k) => setView({ topk: k || undefined })} /></Field>
              <div className="dim" style={{ fontSize: 12 }}>Unit: <b style={{ color: 'var(--text)' }}>{{ percent: 'percent', bytes: 'bytes', Bps: 'bytes per second', ms: 'milliseconds', reqps: 'requests per second', short: 'count' }[def.unit as string] || def.unit}</b> (set for you)</div>
            </div>
            <div className="bstep">
              <div className="blabel"><span className="stepn">4</span>Extras</div>
              <div className="cond-row small">
                <span>Only where</span>
                <Select className="select select-sm" label="Condition" options={[['', 'any value'], ['>', 'above'], ['<', 'below']]} value={view.op || ''} onChange={(op) => setView({ op: (op || undefined) as View['op'], value: op ? view.value ?? def.warn ?? 0 : undefined })} />
                {view.op && <input className="input" type="number" style={{ width: 80, height: 28 }} aria-label="Condition value" value={view.value ?? ''} onChange={(e) => setView({ value: num(e.target.value) })} />}
              </div>
              <div className="cond-row small">
                <span>Compare with</span>
                <Select className="select select-sm" label="Compare" options={[['', 'nothing'], ['1d', 'yesterday'], ['1w', 'last week']]} value={view.compare || ''} onChange={(c) => setView({ compare: c as View['compare'] })} />
              </div>
              <div className="cond-row small">
                <span>Line at</span>
                <input className="input" type="number" style={{ width: 80, height: 28 }} aria-label="Threshold line" placeholder={def.warn !== undefined ? String(def.warn) : ''} value={view.thr ?? ''} onChange={(e) => setView({ thr: num(e.target.value) })} />
                <span className="dim">{def.unit === 'percent' ? '%' : ''}</span>
              </div>
            </div>
          </aside>

          <section className="result" aria-label="Result">
            {understood === 'none' && (
              <div className="info-box"><Info size={15} /><span>I couldn't match "{ask}" to a metric yet. Try words like CPU, memory, disk, network, processes, requests, errors, latency or pods, or pick a template. An AI assistant for any question can be turned on later in Settings.</span></div>
            )}
            {understood && understood !== 'none' && (
              <div className="understood">
                <span className="dim">Understood:</span>
                {understood.understood.map((u) => <span key={u} className="pill pill-blue">{u}</span>)}
                <span className="pill pill-green">Built-in · no AI</span>
              </div>
            )}
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
                <div className="seg-mini" role="group" aria-label="View as">
                  <button className={!asTable ? 'on' : ''} aria-pressed={!asTable} onClick={() => setAsTable(false)} title="Chart"><LineIcon size={14} /></button>
                  <button className={asTable ? 'on' : ''} aria-pressed={asTable} onClick={() => setAsTable(true)} title="Table"><Table2 size={14} /></button>
                </div>
              </div>
              {res.isPending ? <StateView kind="loading" skeleton="chart" /> : res.isError ? <ErrorState error={res.error} what="Metrics" />
                : !rows.length ? <StateView kind="empty" title={view.op ? 'Nothing matches the condition in this time range' : 'No data for this view'} text={view.op ? 'Good news, or loosen the condition.' : 'Your servers may not send this metric yet, or the filters exclude everything. Clear filters or pick another metric.'} />
                  : asTable ? (
                    <TableWrap label="Current values">
                      <table className="tbl">
                        <thead><tr><th>{(view.by || def.by).replace('service_name', 'service')}</th><th className="num">Now</th><th className="num">Min</th><th className="num">Avg</th><th className="num">Max</th></tr></thead>
                        <tbody>{stats.map((s) => <tr key={s.label}><td><i className="dot" style={{ background: s.color, marginRight: 8 }} />{s.label}</td><td className="num">{fmt(s.now, def.unit)}</td><td className="num">{fmt(s.min, def.unit)}</td><td className="num">{fmt(s.avg, def.unit)}</td><td className="num">{fmt(s.max, def.unit)}</td></tr>)}</tbody>
                      </table>
                    </TableWrap>
                  ) : (
                    <>
                      <div className="metrics-graph">
                        <TimeChart series={[...shown, ...cmpSeries.filter((c) => !hidden.has(c.label.replace(/ \((yesterday|last week)\)$/, ''))), ...thrSeries]} unit={def.unit} className="chart-box lg" correlate
                          query={query} metric={def.id} filters={filters} max={def.unit === 'percent' ? 100 : undefined} />
                        <div className="legend-col" aria-label="Lines (click to show or hide)">
                          {seriesAll.map((s) => (
                            <button key={s.label} className={`legend-item legend-toggle ${hidden.has(s.label) ? 'off' : ''}`} title={s.label}
                              onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(s.label)) n.delete(s.label); else n.add(s.label); return n; })}>
                              <i style={{ background: s.color }} /><span className="ell">{s.label}</span>
                            </button>
                          ))}
                          {shift > 0 && <span className="dim" style={{ fontSize: 11.5 }}>Dashed: {view.compare === '1d' ? 'yesterday' : 'last week'}</span>}
                        </div>
                      </div>
                      <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>Click any point to investigate: values, logs, traces and alerts at that moment.</div>
                    </>
                  )}
            </section>

            <section className="panel promql-box">
              <div className="row-head">
                <b>The PromQL this builds</b><span className="dim">updates as you click</span>
                <span className="grow" />
                <button className="btn btn-sm" onClick={() => copyText(query, 'Query copied')}><Copy size={13} />Copy</button>
                <button className="btn btn-sm" onClick={() => setParam({ mode: 'code', q: query })}><Code2 size={13} />Edit as code</button>
              </div>
              <pre className="code">{query}</pre>
            </section>

            <div className="action-row">
              <button className="btn" onClick={saveView}><Bookmark size={14} />Save view</button>
              {can('dashboards.edit') && canOpen('/dashboards') && <button className="btn" onClick={() => open((close) => <AddPanelDialog query={query} unit={def.unit} onClose={close} />)}><Plus size={14} />Add to dashboard</button>}
              {canOpen('/alerting') && <button className="btn" onClick={() => open((close) => <AlertWizard onClose={close} metric={def.id} filters={filters} value={view.thr ?? view.value} />)}><Bell size={14} />Create alert</button>}
              <button className="btn" onClick={exportCsv} disabled={!rows.length}><Download size={14} />Export CSV</button>
              <button className="btn" onClick={() => copyText(location.href, 'Link copied')}><Copy size={14} />Copy link</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function Templates({ onUse }: { onUse: (t: Template) => void }) {
  const [cat, setCat] = useState<Category>('system');
  const [q, setQ] = useState('');
  const list = TEMPLATES.filter((t) => t.categories.includes(cat) && (!q || `${t.title} ${t.text}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="templates">
      <nav className="tpl-cats" aria-label="Categories">
        <div className="tpl-cats-head">Categories</div>
        {CATEGORIES.map((c) => (
          <button key={c.id} className={cat === c.id ? 'on' : ''} aria-pressed={cat === c.id} onClick={() => setCat(c.id)}>
            <span>{c.name}</span><span className="count-badge">{TEMPLATES.filter((t) => t.categories.includes(c.id)).length}</span>
          </button>
        ))}
        <div className="tpl-soon dim">VMware, databases, cloud and network devices appear here once their collectors are connected.</div>
      </nav>
      <div className="tpl-main">
        <div className="toolbar">
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{CATEGORIES.find((c) => c.id === cat)!.name}</div>
            <div className="dim" style={{ fontSize: 12 }}>{CATEGORIES.find((c) => c.id === cat)!.hint}</div>
          </div>
          <div className="grow" />
          <input className="input" placeholder="Search templates..." aria-label="Search templates" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        </div>
        <div className="tpl-grid">{list.map((t) => <TemplateCard key={t.id} t={t} onUse={() => onUse(t)} />)}</div>
        {!list.length && <StateView kind="empty" title="No templates match" />}
        <div className="quick-q">
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Quick questions (try clicking)</div>
          <div className="ask-chips">{QUICK_QUESTIONS.map((x) => <Link key={x} className="ask-chip" to={`/metrics/explore?ask=${encodeURIComponent(x)}`}>{x}</Link>)}</div>
        </div>
      </div>
    </div>
  );
}

function TemplateCard({ t, onUse }: { t: Template; onUse: () => void }) {
  const { filters } = useApp();
  const query = useMemo(() => `${t.fn === 'sum' ? 'sum' : 'avg'}(${buildQuery({ metric: t.metric, filters: { ...filters, ...t.filters } })})`, [t, filters]);
  const q = useRangeQuery(['tpl-spark', query], (r) => api<{ result: PromMatrix }>('/prom/query_range', { query: { query, ...r, step: Math.ceil((r.end - r.start) / 40) } }), { autoRefresh: false });
  const d = metricById(t.metric)!;
  const s = q.data?.result[0]?.values;
  return (
    <div className="tpl-card">
      <div className="tpl-title">{t.title}</div>
      <div className="dim tpl-text">{t.text}</div>
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
  if (!list.length) return <StateView kind="empty" title="No saved views yet" text='Build a view on the Explore tab and press "Save view".' />;
  return (
    <TableWrap label="Saved views">
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
                  if (!(await confirm('Delete saved view', `Delete "${v.name}"?`, 'Delete'))) return;
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
    <Modal title="Save view" onClose={onClose} actions={[{ label: 'Cancel' }, { label: 'Save', primary: true, disabled: !name.trim(), onClick: () => onSave(name.trim()) }]}>
      <Field label="Name" hint="Saved views keep the metric, filters, split, condition and comparison."><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
    </Modal>
  );
}
