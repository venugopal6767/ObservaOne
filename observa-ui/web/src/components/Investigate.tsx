// Investigate a moment: click any point on a time chart. A side panel shows the metric's values at that
// time, then the logs, traces and alerts around it (±5 minutes), with quick actions. "Open full view"
// goes to the Investigation page (/metrics/investigate). Everything stays in ObservaOne.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { X, FileText, Waypoints, LayoutDashboard, Bell, Copy, ZoomIn, Server, Maximize2, Share2 } from 'lucide-react';
import { api } from '@/lib/api';
import { dateTimeZ, escapeLabel, fmt, timeHM } from '@/lib/format';
import { useApp, windowQuery } from '@/app/AppContext';
import { ErrorState, Pill, StateView, Tabs, copyText, useDialogs } from './ui';
import { AlertWizard } from './AlertWizard';
import { metricById, type Filters } from '@/lib/catalog';

export interface InvestigateCtx {
  t: number; // ms
  values: { label: string; color: string; value: number | null }[];
  unit: string;
  query?: string;
  metric?: string;
  filters?: Filters;
  hint?: { service?: string; host?: string };
}

export type InvTab = 'metric' | 'logs' | 'traces' | 'alerts';

/** the host / service a point belongs to, and the logs selector for it */
export function invTarget(ctx: Pick<InvestigateCtx, 'values' | 'filters' | 'hint'>) {
  const host = ctx.hint?.host || ctx.filters?.host || (ctx.values.length === 1 && /^[\w.-]+$/.test(ctx.values[0].label) ? ctx.values[0].label : undefined);
  const service = ctx.hint?.service || ctx.filters?.service;
  const logsQ = service ? `{service_name="${escapeLabel(service)}"}` : host && /^[\w.-]+$/.test(host) ? `{host="${escapeLabel(host)}"}` : '{service_name=~".+"}';
  return { host, service, logsQ };
}

/** address of the full Investigation page for a clicked point */
export function investigateUrl(ctx: InvestigateCtx, pick?: string) {
  // comparison lines ("web-01 (yesterday)") and threshold lines are not targets
  const isExtra = (l: string) => / \((yesterday|last week)\)$/.test(l) || /^Threshold/.test(l);
  const top = (pick || ctx.values.filter((v) => v.value !== null && !isExtra(v.label)).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0]?.label)?.replace(/ \((yesterday|last week)\)$/, '');
  const { host, service } = invTarget(ctx);
  // the clicked line is a host or a service depending on what the chart draws one line per
  const lineIs = ctx.metric ? metricById(ctx.metric)?.by : undefined;
  const p = new URLSearchParams({ t: String(Math.round(ctx.t / 1000)) });
  if (ctx.metric) p.set('m', ctx.metric);
  if (ctx.query) p.set('q', ctx.query);
  p.set('unit', ctx.unit);
  const h = host || (lineIs === 'host' && top && /^[\w.-]+$/.test(top) ? top : undefined);
  const s = service || (lineIs === 'service_name' ? top : undefined);
  if (h) p.set('host', h);
  if (s) p.set('service', s);
  if (top) p.set('line', top);
  return `/metrics/investigate?${p.toString()}`;
}

export function useRelated(tab: InvTab | 'all', sec: number, logsQ: string, service?: string) {
  const { canOpen } = useApp();
  const from = Math.floor(sec - 300), to = Math.ceil(sec + 300);
  const logs = useQuery({
    queryKey: ['inv-logs', logsQ, from, to], enabled: (tab === 'logs' || tab === 'all') && canOpen('/logs'),
    queryFn: () => api<{ entries: { ts: number; level: string; service: string; message: string; traceId?: string }[] }>('/logs', { query: { query: logsQ, start: from, end: to, limit: 100 } }),
  });
  const traces = useQuery({
    queryKey: ['inv-traces', service, from, to], enabled: (tab === 'traces' || tab === 'all') && canOpen('/traces'),
    queryFn: () => api<{ traces: { traceId: string; rootService: string; rootName: string; durationMs: number; startMs: number }[] }>('/traces', { query: { query: service ? `service.name=${service}` : '', start: from, end: to, limit: 30 } }),
  });
  const alerts = useQuery({
    queryKey: ['inv-alerts'], enabled: (tab === 'alerts' || tab === 'all') && canOpen('/alerting'),
    queryFn: () => api<{ alerts: { fingerprint: string; name: string; severity: string; state: string; startsAt: string; summary: string; labels: Record<string, string> }[] }>('/alerts'),
  });
  return { logs, traces, alerts, from, to };
}

export function RelatedLogs({ q, logsQ, limit = 30 }: { q: ReturnType<typeof useRelated>['logs']; logsQ: string; limit?: number }) {
  return q.isPending ? <StateView kind="loading" skeleton="table" /> : q.isError ? <ErrorState error={q.error} what="Logs" />
    : !q.data.entries.length ? <StateView kind="empty" title="No log lines in this window" text={`Searched ${logsQ}.`} />
      : <div className="inv-list">{q.data.entries.slice(0, limit).map((e, i) => (
        <div key={i} className="inv-row"><span className="mono dim">{timeHM(e.ts)}</span><Pill tone={e.level === 'ERROR' ? 'solid-red' : e.level === 'WARN' ? 'solid-orange' : 'muted'}>{e.level}</Pill>{e.service && <span className="dim" style={{ whiteSpace: 'nowrap' }}>{e.service}</span>}<span className="ell" title={e.message}>{e.message}</span></div>))}</div>;
}
export function RelatedTraces({ q, onOpen }: { q: ReturnType<typeof useRelated>['traces']; onOpen: (id: string) => void }) {
  return q.isPending ? <StateView kind="loading" skeleton="table" /> : q.isError ? <ErrorState error={q.error} what="Traces" />
    : !q.data.traces.length ? <StateView kind="empty" title="No traces in this window" />
      : <div className="inv-list">{q.data.traces.map((t) => (
        <button key={t.traceId} className="inv-row linkish" onClick={() => onOpen(t.traceId)}><span className="mono trace-id">{t.traceId.slice(0, 10)}</span><span>{t.rootService}</span><span className="dim ell">{t.rootName}</span><span className={t.durationMs > 1000 ? 'c-orange' : ''}>{fmt(t.durationMs, 'ms')}</span></button>))}</div>;
}
export function RelatedAlerts({ q, sec, host, service }: { q: ReturnType<typeof useRelated>['alerts']; sec: number; host?: string; service?: string }) {
  const near = (q.data?.alerts || []).filter((a) => Math.abs(Date.parse(a.startsAt) / 1000 - sec) < 3600 || (host && (a.labels.host === host || a.labels.instance?.startsWith(host) || a.labels.node === host)) || (service && a.labels.service_name === service));
  return q.isPending ? <StateView kind="loading" skeleton="table" /> : q.isError ? <ErrorState error={q.error} what="Alerts" />
    : !near.length ? <StateView kind="empty" title="No alerts around this time" />
      : <div className="inv-list">{near.map((a) => (
        <div key={a.fingerprint} className="inv-row"><Pill tone={a.severity === 'critical' ? 'solid-red' : a.severity === 'warning' ? 'solid-orange' : 'solid-blue'}>{a.severity}</Pill><b style={{ fontWeight: 600 }}>{a.name}</b><span className="dim ell">{a.summary}</span><span className="dim" style={{ whiteSpace: 'nowrap' }}>{timeHM(Date.parse(a.startsAt))}</span></div>))}</div>;
}

export function QuickActions({ ctx, sec, onDone, full }: { ctx: InvestigateCtx; sec: number; onDone?: () => void; full?: boolean }) {
  const { canOpen, setRange } = useApp();
  const { open } = useDialogs();
  const navigate = useNavigate();
  const { host, service, logsQ } = invTarget(ctx);
  const go = (p: string) => { onDone?.(); navigate(p); };
  return (
    <div className="quick-actions">
      {canOpen('/logs') && <button onClick={() => go(`/logs?q=${encodeURIComponent(logsQ)}&${windowQuery(sec, 300)}`)}><FileText size={14} />View logs around this time</button>}
      {canOpen('/traces') && <button onClick={() => go(`/traces?q=${encodeURIComponent(service ? `service.name=${service}` : '')}&${windowQuery(sec, 300)}`)}><Waypoints size={14} />View traces around this time</button>}
      {host && canOpen('/metrics') && <button onClick={() => go(`/metrics/host/${encodeURIComponent(host)}?${windowQuery(sec, 1800)}`)}><Server size={14} />Open host view: {host}</button>}
      {host && canOpen('/dashboards') && <button onClick={() => go('/dashboards')}><LayoutDashboard size={14} />View host dashboard</button>}
      {canOpen('/alerting') && <button onClick={() => { onDone?.(); open((close) => <AlertWizard onClose={close} metric={ctx.metric} filters={ctx.filters} query={ctx.query} unit={ctx.unit} />); }}><Bell size={14} />Create alert for this metric</button>}
      {ctx.query && <button onClick={() => copyText(ctx.query!, 'Query copied')}><Copy size={14} />Copy query</button>}
      {full && <button onClick={() => copyText(location.href, 'Link copied')}><Share2 size={14} />Get share link</button>}
      <button onClick={() => { onDone?.(); setRange({ kind: 'absolute', from: Math.floor(sec - 300), to: Math.ceil(sec + 300) }); }}><ZoomIn size={14} />Zoom to these 10 minutes</button>
    </div>
  );
}

export function InvestigatePanel({ ctx, onClose }: { ctx: InvestigateCtx; onClose: () => void }) {
  const { canOpen } = useApp();
  const navigate = useNavigate();
  const [tab, setTab] = useState<InvTab>('metric');
  const ref = useRef<HTMLDivElement>(null);
  const sec = ctx.t / 1000;
  const { host, service, logsQ } = invTarget(ctx);
  const rel = useRelated(tab, sec, logsQ, service);

  useEffect(() => {
    ref.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const go = (p: string) => { onClose(); navigate(p); };
  const tabs: [InvTab, string][] = [['metric', 'Metric details']];
  if (canOpen('/logs')) tabs.push(['logs', 'Related logs']);
  if (canOpen('/traces')) tabs.push(['traces', 'Related traces']);
  if (canOpen('/alerting')) tabs.push(['alerts', 'Related alerts']);

  return (
    <div className="drawer-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Investigate" tabIndex={-1} ref={ref}>
        <div className="drawer-head">
          <div>
            <h3>Investigate at {dateTimeZ(ctx.t).slice(0, 16)}</h3>
            <div className="dim" style={{ fontSize: 12 }}>±5 minutes around this point</div>
          </div>
          <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => go(investigateUrl(ctx))}><Maximize2 size={13} />Open full view</button>
          <button className="icon-btn" style={{ marginLeft: 0 }} aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="drawer-tabs"><Tabs items={tabs} active={tab} onChange={setTab} label="Investigate" /></div>
        <div className="drawer-body">
          {tab === 'metric' && (
            <>
              <table className="tbl inv-values">
                <thead><tr><th>Series</th><th className="num">Value at {timeHM(ctx.t)}</th></tr></thead>
                <tbody>{ctx.values.map((v) => (
                  <tr key={v.label} className="clickable" title="Open the full investigation for this series" onClick={() => go(investigateUrl(ctx, v.label))}>
                    <td><i className="dot" style={{ background: v.color, marginRight: 8 }} />{v.label}</td><td className="num">{fmt(v.value, ctx.unit)}</td></tr>))}</tbody>
              </table>
              {ctx.query && (
                <div style={{ marginTop: 14 }}>
                  <div className="field-label" style={{ marginBottom: 6 }}>PromQL</div>
                  <pre className="code" style={{ fontSize: 11.5, margin: 0 }}>{ctx.query}</pre>
                </div>
              )}
            </>
          )}
          {tab === 'logs' && <RelatedLogs q={rel.logs} logsQ={logsQ} />}
          {tab === 'traces' && <RelatedTraces q={rel.traces} onOpen={(id) => go(`/traces?id=${id}`)} />}
          {tab === 'alerts' && <RelatedAlerts q={rel.alerts} sec={sec} host={host} service={service} />}
        </div>
        <div className="drawer-foot">
          <div className="field-label" style={{ marginBottom: 6 }}>Quick actions</div>
          <QuickActions ctx={ctx} sec={sec} onDone={onClose} />
        </div>
      </aside>
    </div>
  );
}
