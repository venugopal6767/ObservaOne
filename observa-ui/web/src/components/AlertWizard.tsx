// Create an alert from a metric in 5 steps: metric → condition (with a preview of when it would have fired)
// → name and severity → who gets told → review. Writes a Prometheus rule through POST /api/rules.
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { api, type PromMatrix } from '@/lib/api';
import { METRICS, buildQuery, metricById, type Filters } from '@/lib/catalog';
import { fmt, legendName } from '@/lib/format';
import { color } from '@/lib/theme';
import { rangeParams, useApp } from '@/app/AppContext';
import { ErrorState, Field, InfoBox, Modal, Select, StateView, toast } from './ui';
import { TimeChart } from './charts';

type Step = 1 | 2 | 3 | 4 | 5;
const STEPS: [Step, string][] = [[1, 'Select metric'], [2, 'Set condition'], [3, 'Configure alert'], [4, 'Notification'], [5, 'Review & create']];

export function AlertWizard({ onClose, metric: initialMetric, filters: initialFilters, query: customQuery, unit: customUnit, value: initialValue }: {
  onClose: () => void; metric?: string; filters?: Filters; query?: string; unit?: string; value?: number;
}) {
  const { me, range } = useApp();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>(1);
  const [metric, setMetric] = useState(initialMetric || (customQuery ? 'custom' : 'cpu'));
  const def = metricById(metric);
  const [op, setOp] = useState<'>' | '<'>(def?.lowerIsWorse ? '<' : '>');
  const [value, setValue] = useState<number>(initialValue ?? def?.crit ?? 80);
  const [forMin, setForMin] = useState(5);
  const [severity, setSeverity] = useState<'critical' | 'warning' | 'info'>('warning');
  const filters = initialFilters || {};
  const base = metric === 'custom' ? (customQuery || '') : buildQuery({ metric, filters });
  const unit = metric === 'custom' ? (customUnit || 'none') : def!.unit;
  const pct = unit === 'percent' ? '%' : '';
  const [name, setName] = useState(() => (def ? `High${def.name.replace(/[^A-Za-z0-9]/g, '')}` : 'CustomAlert'));
  const [summary, setSummary] = useState(() => `${def?.name || 'Value'} is {{ $value | printf "%.1f" }}${pct} on {{ $labels.host }}`);
  const expr = `${base.includes(' or ') ? `(${base})` : base} ${op} ${value}`;

  // preview: the same query over the selected time range, and how often it would have fired
  const r = rangeParams(range);
  const preview = useQuery({
    queryKey: ['alert-preview', base, r.start, r.end],
    queryFn: () => api<{ result: PromMatrix }>('/prom/query_range', { query: { query: base, ...r } }),
    enabled: step >= 2 && !!base,
  });
  const fired = useMemo(() => {
    const res = preview.data?.result || [];
    let episodes = 0; const series = new Set<string>();
    for (const s of res) {
      let inside = false, run = 0;
      const stepSec = s.values.length > 1 ? s.values[1][0] - s.values[0][0] : 60;
      for (const [, v] of s.values) {
        const hit = op === '>' ? Number(v) > value : Number(v) < value;
        run = hit ? run + stepSec : 0;
        if (run >= forMin * 60 && !inside) { inside = true; episodes++; series.add(legendName(s.metric)); }
        if (!hit) inside = false;
      }
    }
    return { episodes, series: [...series] };
  }, [preview.data, op, value, forMin]);

  const notif = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ receivers: { name: string; channels: { type: string; targets: string[] }[] }[]; route: { receiver?: string } }>('/notifications'), enabled: step >= 4 });

  async function create() {
    await api('/rules', { method: 'POST', body: { name, expr, severity, forMinutes: forMin, summary, description: `Created from Metrics: ${def?.name || 'custom query'} ${op} ${value}${pct} for ${forMin} min` } });
    toast('Alert created and loaded by Prometheus');
    qc.invalidateQueries({ queryKey: ['alerting'] });
    onClose();
  }

  const canNext = step === 1 ? !!base : step === 3 ? /^[A-Za-z][A-Za-z0-9_]{2,63}$/.test(name) : true;
  return (
    <Modal title="Create alert from metric" wide onClose={onClose} actions={[
      step > 1 ? { label: 'Back', onClick: () => { setStep((step - 1) as Step); return false; } } : { label: 'Cancel' },
      step < 5
        ? { label: `Next: ${STEPS[step][1]}`, primary: true, disabled: !canNext, onClick: () => { setStep((step + 1) as Step); return false; } }
        : { label: 'Create alert', primary: true, disabled: !me.rulesEditable, onClick: create },
    ]}>
      <div className="wizard">
        <ol className="wizard-steps" aria-label="Steps">
          {STEPS.map(([n, l]) => (
            <li key={n} className={n === step ? 'on' : n < step ? 'done' : ''} aria-current={n === step ? 'step' : undefined}>
              <span className="wz-n">{n < step ? <Check size={12} /> : n}</span>{l}
            </li>
          ))}
        </ol>
        <div className="wizard-body">
          {!me.rulesEditable && <InfoBox tone="error">Rule editing is off on this server (UI_RULES_FILE is not set), so the alert cannot be saved. Ask your administrator.</InfoBox>}
          {step === 1 && (
            <>
              <Field label="Metric">
                <Select options={[...METRICS.map((m) => [m.id, m.name] as [string, string]), ...(customQuery ? [['custom', 'This chart\'s query (PromQL)'] as [string, string]] : [])]} value={metric}
                  onChange={(v) => { setMetric(v); const d = metricById(v); if (d) { setValue(d.crit ?? 80); setOp(d.lowerIsWorse ? '<' : '>'); setName(`High${d.name.replace(/[^A-Za-z0-9]/g, '')}`); } }} />
              </Field>
              {def && <p className="muted" style={{ marginTop: 0 }}>{def.description} <span className="dim">{def.normal}</span></p>}
              {Object.values(filters).some(Boolean) && <p className="muted">Only for: {Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}</p>}
              <pre className="code" style={{ fontSize: 12 }}>{base}</pre>
            </>
          )}
          {step === 2 && (
            <>
              <div className="cond-row">
                <span>Alert when</span><b>{def?.name || 'the value'}</b><span>is</span>
                <Select className="select" label="Comparison" options={[['>', 'above'], ['<', 'below']]} value={op} onChange={setOp} />
                <input className="input" type="number" aria-label="Threshold" value={value} style={{ width: 90 }} onChange={(e) => setValue(Number(e.target.value))} />
                <span>{pct}</span><span>for</span>
                <Select className="select" label="Duration" options={[[0, 'immediately'], [1, '1 minute'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes']]} value={forMin} onChange={setForMin} />
              </div>
              <div className="preview-box">
                <div className="preview-head">Preview over the selected time range</div>
                {preview.isPending ? <StateView kind="loading" skeleton="chart" /> : preview.isError ? <ErrorState error={preview.error} what="Preview" /> : !preview.data.result.length ? <StateView kind="empty" title="No data for this metric yet" /> : (
                  <>
                    <TimeChart series={[...preview.data.result.slice(0, 8).map((s) => ({ label: legendName(s.metric), points: s.values })),
                      { label: `Threshold (${value}${pct})`, color: color('crit'), points: [[r.start, value], [r.end, value]] as [number, number][] }]} unit={unit} style={{ height: 180 }} className="chart-box" />
                    <div className={fired.episodes ? 'c-orange' : 'c-green'} style={{ marginTop: 6 }}>
                      {fired.episodes ? `It would have fired ${fired.episodes} time${fired.episodes > 1 ? 's' : ''} (${fired.series.slice(0, 3).join(', ')}${fired.series.length > 3 ? '…' : ''}).` : 'It would not have fired in this period.'}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
          {step === 3 && (
            <>
              <Field label="Alert name" hint="Letters, numbers and _ only, e.g. HighCpuProdWeb."><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Severity">
                <div className="seg-row" role="radiogroup" aria-label="Severity">
                  {(['info', 'warning', 'critical'] as const).map((s) => <button key={s} type="button" role="radio" aria-checked={severity === s} className={`seg-btn sev-${s} ${severity === s ? 'on' : ''}`} onClick={() => setSeverity(s)}>{s[0].toUpperCase() + s.slice(1)}</button>)}
                </div>
              </Field>
              <Field label="Message" hint="{{ $labels.host }} and {{ $value }} are filled in for each alert."><input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
            </>
          )}
          {step === 4 && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>Alerts are delivered by Alertmanager's routing. With the current setup this alert goes to:</p>
              {notif.isPending ? <StateView kind="loading" /> : notif.isError ? <ErrorState error={notif.error} what="Notification channels" /> : (
                <div className="perm-list">
                  {notif.data.receivers.filter((x) => x.name === notif.data.route.receiver || !notif.data.route.receiver).map((rcv) => (
                    <div key={rcv.name} className="check-row"><Check size={14} className="c-green" /><b style={{ fontWeight: 600 }}>{rcv.name}</b>
                      <span className="dim">{rcv.channels.map((c) => `${c.type}: ${c.targets.join(', ')}`).join(' · ') || 'no channel set up'}</span></div>
                  ))}
                </div>
              )}
              <p className="dim" style={{ fontSize: 12 }}>To send some alerts elsewhere (e.g. critical to Teams), add a route in alertmanager/alertmanager.yml matching severity="{severity}".</p>
            </>
          )}
          {step === 5 && (
            <dl className="kv">
              <dt>Name</dt><dd>{name}</dd>
              <dt>Fires when</dt><dd>{def?.name || 'value'} {op === '>' ? 'above' : 'below'} {fmt(value, unit)} for {forMin ? `${forMin} min` : 'any time'}</dd>
              <dt>Severity</dt><dd>{severity}</dd>
              <dt>Message</dt><dd>{summary}</dd>
              <dt>Preview</dt><dd>{fired.episodes ? `would have fired ${fired.episodes}×` : 'would not have fired'} in the selected range</dd>
              <dt>Rule (PromQL)</dt><dd><pre className="code" style={{ margin: 0, fontSize: 11.5 }}>{expr}</pre></dd>
            </dl>
          )}
        </div>
      </div>
    </Modal>
  );
}
