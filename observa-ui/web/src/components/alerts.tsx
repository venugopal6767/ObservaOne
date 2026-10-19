// Shared pieces of the alerting screens: types, state/severity pills, value + duration formatting,
// and the Create Alert form (test the query before creating it).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { api, type PromVector } from '@/lib/api';
import { METRICS, buildQuery, metricById } from '@/lib/catalog';
import { useNotifyTeams } from '@/components/notifications';
import { fmt } from '@/lib/format';
import { Field, Modal, Pill, Select, toast, type Tone } from './ui';

export type AlertState = 'firing' | 'pending' | 'resolved';
export interface AlertRow {
  id: string; key: string; name: string; severity: string; state: AlertState; neverFired: boolean;
  silenced: boolean; inhibited: boolean; host: string; env: string; team: string; service: string;
  value: number | null; peak: number | null; unit: string;
  activeAt: string; firedAt: string | null; resolvedAt: string | null; durationSec: number;
  summary: string; runbook: string;
}

const SEV: Record<string, [string, Tone]> = { critical: ['Critical', 'solid-red'], warning: ['Warning', 'solid-orange'], info: ['Info', 'solid-blue'] };
export function SeverityPill({ s }: { s: string }) {
  const [l, t] = SEV[s] || [s || 'none', 'solid-muted'];
  return <Pill tone={t}>{l}</Pill>;
}

// Normal -> Pending (true, waiting for "for") -> Firing -> Resolved
const STATE: Record<AlertState, [string, Tone, string]> = {
  pending: ['Pending', 'orange', 'The condition is true; it fires if it stays true for the rule\'s "for" duration'],
  firing: ['Firing', 'solid-red', 'The condition has been true for the whole "for" duration: notifications are sent'],
  resolved: ['Resolved', 'green', 'The condition is false again'],
};
export function StatePill({ a }: { a: Pick<AlertRow, 'state' | 'silenced' | 'inhibited' | 'neverFired'> }) {
  const [l, t, title] = STATE[a.state] || [a.state, 'muted', ''];
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      <Pill tone={t} title={title}>{a.neverFired ? 'Cleared' : l}</Pill>
      {a.silenced && a.state !== 'resolved' && <Pill tone="muted" title="Silenced: no notifications until the silence ends">Silenced</Pill>}
      {a.inhibited && a.state !== 'resolved' && <Pill tone="muted" title="Muted by a related alert (e.g. the server is down)">Muted</Pill>}
    </span>
  );
}

export const valueText = (v: number | null, unit: string) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : fmt(v, unit as never));

export function durationText(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

// ---------------------------------------------------------------- Create Alert
// Default: pick a metric by NAME (CPU usage, Disk usage ...), the servers it covers and a threshold. ObservaOne
// writes the query (the same definitions as every screen) and shows each server's value now, so you see which
// ones would alert before creating it. "Advanced" keeps a PromQL field for anything else.
const OPS: [string, string][] = [['>', 'above'], ['>=', 'at or above'], ['<', 'below'], ['<=', 'at or below']];
const OP_SIGN: Record<string, string> = { '>': '>', '>=': '≥', '<': '<', '<=': '≤' };
const UNIT_WORD: Record<string, string> = { percent: '%', bytes: 'bytes', Bps: 'bytes/s', bps: 'bits/s', ms: 'ms', s: 's', reqps: 'req/s', iops: 'IO/s' };
const ALERTABLE = METRICS.filter((m) => !['pods_running'].includes(m.id));
const camel = (t: string) => t.replace(/\([^)]*\)/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');

interface TestResult { valid: boolean; error?: string; instances?: number; series?: { labels: Record<string, string>; value: number }[]; expr: string }
interface Now { name: string; value: number; hit: boolean }

export function CreateAlert({ onClose, onDone, initial }: { onClose: () => void; onDone: () => void; initial?: { query?: string; threshold?: number; op?: string; name?: string; metric?: string; host?: string } }) {
  const [mode, setMode] = useState<'metric' | 'promql'>(initial?.query ? 'promql' : 'metric');
  // metric mode
  const [metric, setMetric] = useState(initial?.metric || 'cpu');
  const def = metricById(metric)!;
  const [env, setEnv] = useState('');
  const [host, setHost] = useState(initial?.host || '');
  // advanced mode
  const [query, setQuery] = useState(initial?.query || '');
  // shared
  const [name, setName] = useState(initial?.name || `High${camel(def.name)}`);
  const [nameTouched, setNameTouched] = useState(!!initial?.name);
  const [op, setOp] = useState(initial?.op || (def.lowerIsWorse ? '<' : '>'));
  const [threshold, setThreshold] = useState(initial?.threshold !== undefined ? String(initial.threshold) : String(def.crit ?? def.warn ?? 80));
  const [forMin, setForMin] = useState(5);
  const [severity, setSeverity] = useState('warning');
  const [labels, setLabels] = useState('');
  const [team, setTeam] = useState('');
  const [runbook, setRunbook] = useState('');
  const [test, setTest] = useState<TestResult | null>(null);
  const teamsQ = useNotifyTeams();
  const TEAMS: [string, string][] = [['', 'Default team'], ...(teamsQ.data || []).map((t) => [t, t] as [string, string])];
  const [testing, setTesting] = useState(false);

  const envs = useQuery({ queryKey: ['lv', 'env'], queryFn: () => api<string[]>('/prom/label-values', { query: { label: 'env' } }).catch(() => [] as string[]), enabled: mode === 'metric' });
  const hosts = useQuery({ queryKey: ['lv', 'host', env], queryFn: () => api<string[]>('/prom/label-values', { query: { label: 'host', ...(env ? { match: `{env="${env}"}` } : {}) } }).catch(() => [] as string[]), enabled: mode === 'metric' });

  const by = def.byOptions.includes('host') ? 'host' : def.by;
  // keep env on host alerts: Alertmanager groups and routes on it
  const builtQuery = buildQuery({ metric, filters: { env: env || undefined, host: host || undefined }, by: by === 'host' ? 'host, env' : by, fn: 'max' });
  const effQuery = mode === 'metric' ? builtQuery : query.trim();
  const unit = mode === 'metric' ? def.unit : 'none';
  const th = Number(threshold);
  const thOk = threshold.trim() !== '' && Number.isFinite(th);
  const hits = (v: number) => (op === '>' ? v > th : op === '>=' ? v >= th : op === '<' ? v < th : v <= th);

  // metric mode: every server's value now, and which ones would alert
  const now = useQuery({
    queryKey: ['alert-now', builtQuery],
    queryFn: () => api<{ result: PromVector }>('/prom/query', { query: { query: builtQuery } }),
    enabled: mode === 'metric', refetchInterval: 30_000,
  });
  const rows: Now[] = (now.data?.result || [])
    .map((r) => ({ name: r.metric[by] || r.metric.host || Object.values(r.metric)[0] || '—', value: Number(r.value[1]), hit: false }))
    .filter((r) => Number.isFinite(r.value))
    .map((r) => ({ ...r, hit: thOk && hits(r.value) }))
    .sort((a, b) => Number(b.hit) - Number(a.hit) || (op.startsWith('<') ? a.value - b.value : b.value - a.value));
  const nHit = rows.filter((r) => r.hit).length;

  const pickMetric = (id: string) => {
    const d = metricById(id)!;
    setMetric(id); setOp(d.lowerIsWorse ? '<' : '>'); setThreshold(String(d.crit ?? d.warn ?? (d.unit === 'percent' ? 80 : 0)));
    if (!nameTouched) setName(`High${camel(d.name)}`);
    setTest(null);
  };
  const parsedLabels = (() => {
    const out: Record<string, string> = {}, errors: string[] = [];
    for (const item of labels.split(',').map((x) => x.trim()).filter(Boolean)) {
      const i = item.indexOf('=');
      if (i < 1) { errors.push(`"${item}": write it as name=value`); continue; }
      const k = item.slice(0, i).trim(), v = item.slice(i + 1).trim();
      if (!/^[a-z][a-z0-9_]{0,30}$/.test(k)) errors.push(`"${k}": lower-case a-z, 0-9, _`);
      else if (!v) errors.push(`${k}: needs a value`);
      else out[k] = v;
    }
    return { out, errors };
  })();
  const nameOk = /^[A-Za-z][A-Za-z0-9_]{2,63}$/.test(name);
  const ready = nameOk && !!effQuery && thOk && parsedLabels.errors.length === 0;
  const where = [env && `env ${env}`, host && `host ${host}`].filter(Boolean).join(', ') || 'all servers';
  const unitWord = UNIT_WORD[unit] || '';

  async function runTest() {
    setTesting(true);
    try { setTest(await api<TestResult>('/rules/test', { method: 'POST', body: { query: effQuery, op, threshold: th } })); }
    catch (e) { setTest({ valid: false, error: (e as Error).message, expr: '' }); }
    finally { setTesting(false); }
  }

  return (
    <Modal title="Create alert" wide onClose={onClose} actions={[
      { label: 'Cancel' },
      { label: 'Create alert', primary: true, disabled: !ready, onClick: async () => {
        await api('/rules', { method: 'POST', body: {
          name, query: effQuery, op, threshold: th, forMinutes: forMin, severity, team: team || undefined, runbookUrl: runbook.trim() || undefined,
          labels: { ...parsedLabels.out, ...(unit !== 'none' ? { unit } : {}) },
          summary: mode === 'metric'
            ? `${def.name} is {{ $value | printf "%.1f" }}${unit === 'percent' ? '%' : ''} on {{ $labels.${by} }} (${OP_SIGN[op]} ${threshold}${unit === 'percent' ? '%' : ''})`
            : `${name} on {{ $labels.host }}: {{ $value | printf "%.1f" }}`,
          description: mode === 'metric' ? `${def.name} ${OPS.find(([o]) => o === op)?.[1]} ${threshold}${unitWord && unitWord !== '%' ? ` ${unitWord}` : unitWord} for ${forMin} min, ${where}. ${def.description}` : '',
        } });
        toast('Alert created: Prometheus checks it from now on');
        onDone();
      } },
    ]}>
      <div className="create-alert">
        <div className="seg" role="tablist" aria-label="How to define the alert">
          <button type="button" role="tab" aria-selected={mode === 'metric'} className={mode === 'metric' ? 'on' : ''} onClick={() => { setMode('metric'); setTest(null); }}>Pick a metric</button>
          <button type="button" role="tab" aria-selected={mode === 'promql'} className={mode === 'promql' ? 'on' : ''} onClick={() => { setMode('promql'); setTest(null); if (!query) setQuery(builtQuery); }}>Advanced (PromQL)</button>
        </div>

        {mode === 'metric' ? (
          <>
            <div className="form-row">
              <Field label="Metric" hint={def.description}>
                <Select className="select" label="Metric" value={metric} onChange={pickMetric}
                  options={ALERTABLE.map((m) => [m.id, `${m.name}${UNIT_WORD[m.unit] ? ` (${UNIT_WORD[m.unit]})` : ''}`] as [string, string])} />
              </Field>
              <Field label="Environment">
                <Select className="select" label="Environment" value={env} onChange={(v) => { setEnv(v); setHost(''); setTest(null); }} options={[['', 'All environments'], ...(envs.data || []).map((e) => [e, e] as [string, string])]} />
              </Field>
              <Field label="Server">
                <Select className="select" label="Server" value={host} onChange={(v) => { setHost(v); setTest(null); }} options={[['', 'All servers'], ...(hosts.data || []).map((h) => [h, h] as [string, string])]} />
              </Field>
            </div>
            <div className="alert-sentence" aria-live="polite">
              Alert when <b>{def.name}</b> is <b>{OPS.find(([o]) => o === op)?.[1]} {threshold || '…'}{unit === 'percent' ? '%' : unitWord ? ` ${unitWord}` : ''}</b> on <b>{where}</b> for <b>{forMin ? `${forMin} minute${forMin > 1 ? 's' : ''}` : 'one check'}</b>.
            </div>
          </>
        ) : (
          <Field label="PromQL query" hint="One series per instance (host, service ...). Each series past the threshold becomes one alert.">
            <textarea className="input mono" rows={3} value={query} onChange={(e) => { setQuery(e.target.value); setTest(null); }} />
          </Field>
        )}

        <div className="form-row">
          <Field label="Threshold">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Select className="select" label="Comparison" style={{ width: 150 }} value={op} onChange={(v) => { setOp(v); setTest(null); }} options={OPS} />
              <input className="input" style={{ width: 100 }} inputMode="decimal" value={threshold} onChange={(e) => { setThreshold(e.target.value); setTest(null); }} aria-label="Threshold value" aria-invalid={!thOk} />
              {unitWord && <span className="dim">{unitWord}</span>}
            </div>
          </Field>
          <Field label="For" hint="How long it must stay past the threshold (Pending until then).">
            <Select className="select" label="For duration" value={forMin} onChange={setForMin} options={[[0, 'Immediately'], [1, '1 minute'], [2, '2 minutes'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour']]} />
          </Field>
          <Field label="Severity">
            <Select className="select" label="Severity" value={severity} onChange={setSeverity} options={[['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']]} />
          </Field>
        </div>

        {mode === 'metric' && (
          <div className="alert-now">
            <div className="alert-now-head">
              <b>Values now</b>
              <span className="dim">{now.isPending ? 'loading…' : now.isError ? '' : `${rows.length} ${by === 'host' ? 'server' : by}${rows.length === 1 ? '' : 's'} · `}
                {!now.isPending && !now.isError && (nHit ? <span className="c-red">{nHit} would alert now</span> : <span className="c-green">none would alert now</span>)}</span>
            </div>
            {now.isError ? <div className="c-red" style={{ fontSize: 12.5 }}>{(now.error as Error).message}</div>
              : !now.isPending && !rows.length ? <div className="dim" style={{ fontSize: 12.5 }}>No data for this metric on {where}.</div>
              : (
                <div className="alert-now-list">
                  {rows.slice(0, 12).map((r) => (
                    <span key={r.name} className={`alert-now-item ${r.hit ? 'hit' : ''}`} title={r.hit ? 'Past the threshold now' : 'Within the threshold now'}>
                      <span className="mono">{r.name}</span><b>{valueText(r.value, unit)}</b>
                    </span>
                  ))}
                  {rows.length > 12 && <span className="dim" style={{ alignSelf: 'center' }}>+{rows.length - 12} more</span>}
                </div>
              )}
          </div>
        )}

        <div className="form-row">
          <Field label="Alert name" hint="Letters, numbers and _ (suggested from the metric).">
            <input className="input" value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} aria-invalid={!!name && !nameOk} />
          </Field>
          <Field label="Notify" hint="Which team gets it (Alertmanager routes on the team).">
            <Select className="select" label="Notification policy" value={team} onChange={setTeam} options={TEAMS} />
          </Field>
        </div>
        <details className="app-collectors">
          <summary>More options: labels, runbook</summary>
          <div className="form-row" style={{ marginTop: 10 }}>
            <Field label="Labels" hint="key=value, comma separated (service, env ...): for routing and filters.">
              <input className="input" placeholder="service=payments" value={labels} onChange={(e) => setLabels(e.target.value)} aria-invalid={parsedLabels.errors.length > 0} />
              {parsedLabels.errors.map((e) => <div key={e} className="c-red" style={{ fontSize: 12, marginTop: 4 }}>{e}</div>)}
            </Field>
            <Field label="Runbook link"><input className="input" placeholder="https://wiki.example.local/runbooks/high-cpu" value={runbook} onChange={(e) => setRunbook(e.target.value)} /></Field>
          </div>
        </details>

        {mode === 'promql' && <>
          <div className="test-query">
            <button type="button" className="btn" disabled={!effQuery || !thOk || testing} onClick={runTest}>{testing ? 'Testing…' : 'Test query'}</button>
            <span className="dim" style={{ fontSize: 12.5 }}>Runs the condition now, without creating anything.</span>
          </div>
          {test && (test.valid ? (
            <div className="ok-box" role="status"><span className="ic"><CheckCircle2 size={16} aria-hidden /></span>
              <span><b>Query is valid – {test.instances} instance{test.instances === 1 ? '' : 's'} affected</b>{test.instances ? ' right now' : ': nothing is past the threshold right now'}.
                {!!test.series?.length && <span className="test-series">{test.series.slice(0, 6).map((x) => <code key={JSON.stringify(x.labels)}>{x.labels.host || x.labels.instance || Object.values(x.labels)[0] || 'series'} = {Number.isFinite(x.value) ? Math.round(x.value * 10) / 10 : x.value}</code>)}</span>}
              </span>
            </div>
          ) : (
            <div className="error-box" role="alert"><span className="ic"><AlertTriangle size={16} aria-hidden /></span><span><b>Query is not valid.</b> {test.error}</span></div>
          ))}
        </>}
      </div>
    </Modal>
  );
}
