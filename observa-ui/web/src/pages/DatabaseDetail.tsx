// Per-target database/cache dashboard: all the metrics for one instance, from its engine catalog.
import { useParams, useNavigate } from 'react-router-dom';
import { api, type PromMatrix, type PromVector } from '@/lib/api';
import { fmt } from '@/lib/format';
import { usePlainQuery, useRangeQuery } from '@/app/AppContext';
import { ErrorState, PageHead, Panel, StateView } from '@/components/ui';
import { StatCard } from '@/components/StatCard';
import { TimeChart } from '@/components/charts';
import { engineLabel } from '@/lib/datastores';
import { dashboardFor, selector, type Panel as DashPanel } from '@/lib/db-dashboards';

function StatPanel({ title, unit, query }: { title: string; unit?: string; query: string }) {
  const q = usePlainQuery(['db-stat', query], () => api<{ result: PromVector }>('/prom/query', { query: { query } }).then((r) => r.result));
  const v = q.data && q.data[0] ? Number(q.data[0].value[1]) : null;
  return <StatCard label={title} value={q.isError ? '—' : v == null ? '—' : fmt(v, unit || 'none')} />;
}

function TsPanel({ title, unit, query }: { title: string; unit?: string; query: string }) {
  const q = useRangeQuery(['db-ts', query], (r) => api<{ result: PromMatrix }>('/prom/query_range', { query: { query, ...r } }));
  const series = (q.data?.result || []).slice(0, 8).map((s, i) => ({ label: s.metric.db_instance || title, points: s.values, color: undefined as string | undefined, _i: i }));
  return (
    <Panel title={title}>
      {q.isError ? <ErrorState error={q.error} what={title} />
        : <TimeChart series={series.map(({ label, points }) => ({ label, points }))} unit={unit || 'none'} className="chart-box" />}
    </Panel>
  );
}

export default function DatabaseDetail() {
  const { engine = '', instance = '' } = useParams();
  const navigate = useNavigate();
  const panels = dashboardFor(engine);
  const sel = selector(instance);
  const stats = panels.filter((p) => p.kind === 'stat');
  const charts = panels.filter((p) => p.kind === 'ts');

  const head = <PageHead title={`${instance}`} sub={`${engineLabel(engine)} · all metrics`} actions={<button className="btn btn-sm" onClick={() => navigate('/databases')}>← Databases</button>} />;
  if (!panels.length) {
    return <>{head}<StateView kind="empty" title="No dashboard for this engine" text={`No metric catalog for "${engine}". Use the metrics explorer with {db_instance="${instance}"}.`} /></>;
  }
  return (
    <>
      {head}
      <div className="grid cards-4" style={{ marginBottom: 14 }}>
        {stats.map((p: DashPanel) => <StatPanel key={p.title} title={p.title} unit={p.unit} query={p.q(sel)} />)}
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
        {charts.map((p: DashPanel) => <TsPanel key={p.title} title={p.title} unit={p.unit} query={p.q(sel)} />)}
      </div>
    </>
  );
}
