// One dashboard panel from a PromQL query: line / area (over the time range), or bar / stat / gauge /
// table (current values). Dashboard variables ($host, ...) are substituted before the query runs.
import { api, type PromMatrix, type PromVector } from '@/lib/api';
import { fmt, legendName } from '@/lib/format';
import { color, thresholdColor } from '@/lib/theme';
import { useRangeQuery } from '@/app/AppContext';
import { ErrorState, Pill, StateView, TableWrap } from './ui';
import { BarChart, TimeChart } from './charts';

export interface Panel { title: string; type: 'line' | 'area' | 'bar' | 'stat' | 'gauge' | 'table'; query: string; legend?: string; unit?: string; w?: number }

export function PromPanelBody({ panel, vars }: { panel: Panel; vars: Record<string, string> }) {
  let query = panel.query;
  for (const [k, v] of Object.entries(vars)) query = query.replaceAll(`$${k}`, v);
  const instant = panel.type !== 'line' && panel.type !== 'area';
  const q = useRangeQuery<{ result: PromVector | PromMatrix }>(['panel', query, instant], (r) => (instant
    ? api<{ result: PromVector }>('/prom/query', { query: { query } })
    : api<{ result: PromMatrix }>('/prom/query_range', { query: { query, ...r } })));

  if (q.isPending) return <StateView kind="loading" skeleton={panel.type === 'stat' || panel.type === 'gauge' ? 'cards' : panel.type === 'table' ? 'table' : 'chart'} />;
  if (q.isError) return <ErrorState error={q.error} what={panel.title || 'Panel'} />;
  const res = q.data.result || [];
  if (!res.length) return <StateView kind="empty" title={instant ? 'No data' : 'No data for the selected time range'} text="Prometheus answered, but this panel's query returned nothing." />;
  const unit = panel.unit || 'none';

  if (!instant) {
    const m = res as PromMatrix;
    return <TimeChart series={m.slice(0, 12).map((r) => ({ label: legendName(r.metric, panel.legend), points: r.values }))} unit={unit} area={panel.type === 'area'} legend={m.length > 1} max={unit === 'percent' ? 100 : undefined} correlate correlateHint={vars.host ? { host: vars.host } : undefined} />;
  }
  const v = res as PromVector;
  const isUp = /^up\{/.test(query);
  if (panel.type === 'stat' || panel.type === 'gauge') {
    const n = Number(v[0].value[1]);
    if (panel.title.toLowerCase() === 'status' || isUp) return <div className="big-stat"><span className={`value ${n >= 1 ? 'green' : 'red'}`}>{n >= 1 ? 'UP' : 'DOWN'}</span></div>;
    let tone = '';
    if (unit === 'percent') tone = n >= 90 ? 'red' : n >= 80 ? 'orange' : '';
    if (/down/i.test(panel.title)) tone = n > 0 ? 'red' : 'green';
    return <div className="big-stat"><span className={`value ${tone}`}>{fmt(n, unit)}</span></div>;
  }
  if (panel.type === 'bar') {
    const rows = v.map((r) => [legendName(r.metric, panel.legend), Number(r.value[1])] as [string, number]).sort((a, b) => a[0].localeCompare(b[0]));
    // free space: low is bad; anything else: one neutral colour (no invented good/bad)
    const colors = rows.map(([, x]) => (unit === 'percent' && /free/i.test(panel.title) ? thresholdColor(x, { warn: 20, crit: 10, lowerIsWorse: true, base: 'ok' }) : color('chart-1')));
    return <BarChart labels={rows.map((r) => r[0])} values={rows.map((r) => r[1])} unit={unit} colors={colors} max={unit === 'percent' ? 100 : undefined} />;
  }
  const keys = [...new Set(v.flatMap((r) => Object.keys(r.metric)))].filter((k) => k !== '__name__');
  return (
    <TableWrap label={panel.title} style={{ maxHeight: 260 }}>
      <table className="tbl">
        <thead><tr>{keys.map((k) => <th key={k}>{k}</th>)}<th className="num">Value</th></tr></thead>
        <tbody>
          {v.map((r, i) => (
            <tr key={i}>
              {keys.map((k) => <td key={k}>{r.metric[k] || ''}</td>)}
              <td className="num">{isUp ? <Pill tone={Number(r.value[1]) ? 'green' : 'red'}>{Number(r.value[1]) ? 'UP' : 'DOWN'}</Pill> : fmt(Number(r.value[1]), unit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}
