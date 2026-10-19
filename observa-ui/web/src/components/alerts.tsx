// Shared pieces of the alerting screens: types, state/severity pills, value + duration formatting,
// and the Create Alert form (test the query before creating it).
import { useState } from 'react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
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
const TEAMS: [string, string][] = [['', 'Default (platform team)'], ['platform', 'Platform'], ['infra', 'Infra'], ['ops', 'Ops']];
const OPS: [string, string][] = [['>', '>  above'], ['>=', '≥  at or above'], ['<', '<  below'], ['<=', '≤  at or below']];
const CPU_EXAMPLE = '100 * (1 - sum by (host) (rate(node_cpu_seconds_total{mode="idle"}[5m]))\n      / sum by (host) (rate(node_cpu_seconds_total[5m])))';

interface TestResult { valid: boolean; error?: string; instances?: number; series?: { labels: Record<string, string>; value: number }[]; expr: string }

export function CreateAlert({ onClose, onDone, initial }: { onClose: () => void; onDone: () => void; initial?: { query?: string; threshold?: number; op?: string; name?: string } }) {
  const [name, setName] = useState(initial?.name || '');
  const [query, setQuery] = useState(initial?.query || '');
  const [op, setOp] = useState(initial?.op || '>');
  const [threshold, setThreshold] = useState(initial?.threshold !== undefined ? String(initial.threshold) : '80');
  const [forMin, setForMin] = useState(5);
  const [severity, setSeverity] = useState('warning');
  const [labels, setLabels] = useState('');
  const [team, setTeam] = useState('');
  const [runbook, setRunbook] = useState('');
  const [summary, setSummary] = useState('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

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
  const thOk = threshold.trim() === '' || Number.isFinite(Number(threshold));
  const body = () => ({ query: query.trim(), op, threshold: threshold.trim() === '' ? null : Number(threshold) });

  async function runTest() {
    setTesting(true);
    try { setTest(await api<TestResult>('/rules/test', { method: 'POST', body: body() })); }
    catch (e) { setTest({ valid: false, error: (e as Error).message, expr: '' }); }
    finally { setTesting(false); }
  }

  return (
    <Modal title="Create alert" wide onClose={onClose} actions={[
      { label: 'Cancel' },
      { label: 'Create alert', primary: true, disabled: !nameOk || !query.trim() || !thOk || parsedLabels.errors.length > 0, onClick: async () => {
        await api('/rules', { method: 'POST', body: {
          name, ...body(), forMinutes: forMin, severity, labels: parsedLabels.out, team: team || undefined, runbookUrl: runbook.trim() || undefined,
          summary: summary.trim() || `${name} on {{ $labels.host }}: {{ $value | printf "%.1f" }}`,
        } });
        toast('Alert created: Prometheus evaluates it from now on');
        onDone();
      } },
    ]}>
      <div className="create-alert">
        <Field label="Alert name" hint="Letters, numbers and _ (e.g. HighCpuAppServers).">
          <input className="input" placeholder="HighCPU" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!name && !nameOk} />
        </Field>
        <Field label="PromQL query" hint="One series per instance (host, service ...). Each series past the threshold becomes one alert.">
          <textarea className="input mono" rows={3} placeholder={CPU_EXAMPLE} value={query} onChange={(e) => { setQuery(e.target.value); setTest(null); }} />
        </Field>
        {!query && <button type="button" className="btn btn-sm" style={{ marginTop: -6, marginBottom: 10 }} onClick={() => { setQuery(CPU_EXAMPLE); setName(name || 'HighCPU'); setTest(null); }}>Use the CPU example</button>}
        <div className="form-row">
          <Field label="Threshold">
            <div style={{ display: 'flex', gap: 6 }}>
              <Select className="select" label="Comparison" style={{ width: 150 }} value={op} onChange={(v) => { setOp(v); setTest(null); }} options={OPS} />
              <input className="input" style={{ width: 110 }} inputMode="decimal" value={threshold} onChange={(e) => { setThreshold(e.target.value); setTest(null); }} aria-label="Threshold value" aria-invalid={!thOk} />
            </div>
          </Field>
          <Field label="For duration" hint="How long it must stay true before it fires (Pending until then).">
            <Select className="select" label="For duration" value={forMin} onChange={setForMin} options={[[0, 'Immediately'], [1, '1 minute'], [2, '2 minutes'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour']]} />
          </Field>
          <Field label="Severity">
            <Select className="select" label="Severity" value={severity} onChange={setSeverity} options={[['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']]} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Labels (optional)" hint="key=value, comma separated: used for routing and filters (env, service ...).">
            <input className="input" placeholder="service=payments, env=prod" value={labels} onChange={(e) => setLabels(e.target.value)} aria-invalid={parsedLabels.errors.length > 0} />
            {parsedLabels.errors.map((e) => <div key={e} className="c-red" style={{ fontSize: 12, marginTop: 4 }}>{e}</div>)}
          </Field>
          <Field label="Notification policy" hint="Which team is notified (Alertmanager routes on the team label).">
            <Select className="select" label="Notification policy" value={team} onChange={setTeam} options={TEAMS} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Runbook link (optional)"><input className="input" placeholder="https://wiki.example.local/runbooks/high-cpu" value={runbook} onChange={(e) => setRunbook(e.target.value)} /></Field>
          <Field label="Message (optional)"><input className="input" placeholder={'CPU is {{ $value | printf "%.0f" }}% on {{ $labels.host }}'} value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
        </div>

        <div className="test-query">
          <button type="button" className="btn" disabled={!query.trim() || !thOk || testing} onClick={runTest}>{testing ? 'Testing…' : 'Test query'}</button>
          <span className="dim" style={{ fontSize: 12.5 }}>Runs the condition now, without creating anything.</span>
        </div>
        {test && (test.valid ? (
          <div className="ok-box" role="status"><span className="ic"><CheckCircle2 size={16} aria-hidden /></span>
            <span><b>Query is valid – {test.instances} instance{test.instances === 1 ? '' : 's'} affected</b>{test.instances ? ' right now' : ': nothing is past the threshold right now'}.
              {!!test.series?.length && <span className="test-series">{test.series.slice(0, 6).map((s) => <code key={JSON.stringify(s.labels)}>{s.labels.host || s.labels.instance || Object.values(s.labels)[0] || 'series'} = {Number.isFinite(s.value) ? Math.round(s.value * 10) / 10 : s.value}</code>)}{(test.instances || 0) > 6 && <span className="dim"> +{(test.instances || 0) - 6} more</span>}</span>}
            </span>
          </div>
        ) : (
          <div className="error-box" role="alert"><span className="ic"><AlertTriangle size={16} aria-hidden /></span><span><b>Query is not valid.</b> {test.error}</span></div>
        ))}
      </div>
    </Modal>
  );
}
