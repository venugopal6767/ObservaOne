// Investigate a moment: click any point on a time chart. A side panel shows the metric's values at that
// time, then the logs, traces and alerts around it (±5 minutes), with quick actions. Everything stays in ObservaOne.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { X, FileText, Waypoints, LayoutDashboard, Bell, Copy, ZoomIn, Server } from 'lucide-react';
import { api } from '@/lib/api';
import { dateTimeZ, escapeLabel, fmt, timeHM } from '@/lib/format';
import { useApp, windowQuery } from '@/app/AppContext';
import { ErrorState, Pill, StateView, Tabs, copyText, useDialogs } from './ui';
import { AlertWizard } from './AlertWizard';
import type { Filters } from '@/lib/catalog';

export interface InvestigateCtx {
  t: number; // ms
  values: { label: string; color: string; value: number | null }[];
  unit: string;
  query?: string;
  metric?: string;
  filters?: Filters;
  hint?: { service?: string; host?: string };
}

type Tab = 'metric' | 'logs' | 'traces' | 'alerts';

export function InvestigatePanel({ ctx, onClose }: { ctx: InvestigateCtx; onClose: () => void }) {
  const { canOpen, setRange } = useApp();
  const { open } = useDialogs();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('metric');
  const ref = useRef<HTMLDivElement>(null);
  const sec = ctx.t / 1000;
  const from = Math.floor(sec - 300), to = Math.ceil(sec + 300);
  // the host or service this point belongs to: the hint, or the label of the top series ("web-02")
  const host = ctx.hint?.host || ctx.filters?.host || (ctx.values.length === 1 ? ctx.values[0].label : undefined);
  const service = ctx.hint?.service || ctx.filters?.service;
  const logsQ = service ? `{service_name="${escapeLabel(service)}"}` : host && /^[\w.-]+$/.test(host) ? `{host="${escapeLabel(host)}"}` : '{service_name=~".+"}';

  useEffect(() => {
    ref.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const logs = useQuery({
    queryKey: ['inv-logs', logsQ, from, to], enabled: tab === 'logs' && canOpen('/logs'),
    queryFn: () => api<{ entries: { ts: number; level: string; service: string; message: string }[] }>('/logs', { query: { query: logsQ, start: from, end: to, limit: 50 } }),
  });
  const traces = useQuery({
    queryKey: ['inv-traces', service, from, to], enabled: tab === 'traces' && canOpen('/traces'),
    queryFn: () => api<{ traces: { traceId: string; rootService: string; rootName: string; durationMs: number; startMs: number }[] }>('/traces', { query: { query: service ? `service.name=${service}` : '', start: from, end: to, limit: 20 } }),
  });
  const alerts = useQuery({
    queryKey: ['inv-alerts'], enabled: tab === 'alerts' && canOpen('/alerting'),
    queryFn: () => api<{ alerts: { fingerprint: string; name: string; severity: string; startsAt: string; summary: string; labels: Record<string, string> }[] }>('/alerts'),
  });
  const go = (p: string) => { onClose(); navigate(p); };
  const tabs: [Tab, string][] = [['metric', 'Metric details']];
  if (canOpen('/logs')) tabs.push(['logs', 'Related logs']);
  if (canOpen('/traces')) tabs.push(['traces', 'Related traces']);
  if (canOpen('/alerting')) tabs.push(['alerts', 'Related alerts']);
  const nearAlerts = (alerts.data?.alerts || []).filter((a) => Math.abs(Date.parse(a.startsAt) / 1000 - sec) < 3600 || (host && (a.labels.host === host || a.labels.instance?.startsWith(host))));

  return (
    <div className="drawer-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Investigate" tabIndex={-1} ref={ref}>
        <div className="drawer-head">
          <div>
            <h3>Investigate at {dateTimeZ(ctx.t).slice(0, 16)}</h3>
            <div className="dim" style={{ fontSize: 12 }}>±5 minutes around this point</div>
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="drawer-tabs"><Tabs items={tabs} active={tab} onChange={setTab} label="Investigate" /></div>
        <div className="drawer-body">
          {tab === 'metric' && (
            <>
              <table className="tbl inv-values">
                <thead><tr><th>Series</th><th className="num">Value at {timeHM(ctx.t)}</th></tr></thead>
                <tbody>{ctx.values.map((v) => <tr key={v.label}><td><i className="dot" style={{ background: v.color, marginRight: 8 }} />{v.label}</td><td className="num">{fmt(v.value, ctx.unit)}</td></tr>)}</tbody>
              </table>
              {ctx.query && (
                <div style={{ marginTop: 14 }}>
                  <div className="field-label" style={{ marginBottom: 6 }}>PromQL</div>
                  <pre className="code" style={{ fontSize: 11.5, margin: 0 }}>{ctx.query}</pre>
                </div>
              )}
            </>
          )}
          {tab === 'logs' && (logs.isPending ? <StateView kind="loading" skeleton="table" /> : logs.isError ? <ErrorState error={logs.error} what="Logs" />
            : !logs.data.entries.length ? <StateView kind="empty" title="No log lines in this window" text={`Searched ${logsQ}.`} />
              : <div className="inv-list">{logs.data.entries.slice(0, 30).map((e, i) => (
                <div key={i} className="inv-row"><span className="mono dim">{timeHM(e.ts)}</span><Pill tone={e.level === 'ERROR' ? 'solid-red' : e.level === 'WARN' ? 'solid-orange' : 'muted'}>{e.level}</Pill><span className="ell" title={e.message}>{e.message}</span></div>))}</div>)}
          {tab === 'traces' && (traces.isPending ? <StateView kind="loading" skeleton="table" /> : traces.isError ? <ErrorState error={traces.error} what="Traces" />
            : !traces.data.traces.length ? <StateView kind="empty" title="No traces in this window" />
              : <div className="inv-list">{traces.data.traces.map((t) => (
                <button key={t.traceId} className="inv-row linkish" onClick={() => go(`/traces?id=${t.traceId}`)}><span className="mono trace-id">{t.traceId.slice(0, 10)}</span><span>{t.rootService}</span><span className="dim ell">{t.rootName}</span><span className={t.durationMs > 1000 ? 'c-orange' : ''}>{fmt(t.durationMs, 'ms')}</span></button>))}</div>)}
          {tab === 'alerts' && (alerts.isPending ? <StateView kind="loading" skeleton="table" /> : alerts.isError ? <ErrorState error={alerts.error} what="Alerts" />
            : !nearAlerts.length ? <StateView kind="empty" title="No alerts around this time" />
              : <div className="inv-list">{nearAlerts.map((a) => (
                <div key={a.fingerprint} className="inv-row"><Pill tone={a.severity === 'critical' ? 'solid-red' : a.severity === 'warning' ? 'solid-orange' : 'solid-blue'}>{a.severity}</Pill><b style={{ fontWeight: 600 }}>{a.name}</b><span className="dim ell">{a.summary}</span></div>))}</div>)}
        </div>
        <div className="drawer-foot">
          <div className="field-label" style={{ marginBottom: 6 }}>Quick actions</div>
          <div className="quick-actions">
            {canOpen('/logs') && <button onClick={() => go(`/logs?q=${encodeURIComponent(logsQ)}&${windowQuery(sec, 300)}`)}><FileText size={14} />View logs around this time</button>}
            {canOpen('/traces') && <button onClick={() => go(`/traces?q=${encodeURIComponent(service ? `service.name=${service}` : '')}&${windowQuery(sec, 300)}`)}><Waypoints size={14} />View traces around this time</button>}
            {host && canOpen('/metrics') && <button onClick={() => go(`/metrics/host/${encodeURIComponent(host)}?${windowQuery(sec, 1800)}`)}><Server size={14} />Open host view: {host}</button>}
            {host && canOpen('/dashboards') && <button onClick={() => go('/dashboards')}><LayoutDashboard size={14} />Dashboards</button>}
            {canOpen('/alerting') && <button onClick={() => { const c = ctx; onClose(); open((close) => <AlertWizard onClose={close} metric={c.metric} filters={c.filters} query={c.query} unit={c.unit} />); }}><Bell size={14} />Create alert for this metric</button>}
            {ctx.query && <button onClick={() => copyText(ctx.query!, 'Query copied')}><Copy size={14} />Copy query</button>}
            <button onClick={() => { onClose(); setRange({ kind: 'absolute', from, to }); }}><ZoomIn size={14} />Zoom to these 10 minutes</button>
          </div>
        </div>
      </aside>
    </div>
  );
}
