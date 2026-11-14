// Databases & caches: targets reported by the DB agent (observaone_db_up{db_engine,db_instance}),
// grouped by engine with up/down status and a jump into the metrics explorer for each target.
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Database, LineChart } from 'lucide-react';
import { api, type PromVector } from '@/lib/api';
import { useApp, usePlainQuery } from '@/app/AppContext';
import { ErrorState, PageHead, Pill, StateView, TableWrap } from '@/components/ui';
import { groupTargets, summarize, exploreQuery } from '@/lib/datastores';

export default function Databases() {
  const { canOpen } = useApp();
  const navigate = useNavigate();
  const q = usePlainQuery(['datastores'], () => api<{ result: PromVector }>('/prom/query', { query: { query: 'observaone_db_up' } }).then((r) => r.result));

  const groups = useMemo(() => groupTargets(q.data || []), [q.data]);
  const sum = useMemo(() => summarize(q.data || []), [q.data]);

  const head = <PageHead title="Databases" sub="Database & cache targets reported by the agents" />;
  if (q.isPending) return <>{head}<TableWrap label="Databases"><StateView kind="loading" skeleton="table" /></TableWrap></>;
  if (q.isError) return <>{head}<TableWrap label="Databases"><ErrorState error={q.error} what="Databases" /></TableWrap></>;
  if (!groups.length) {
    return <>{head}<TableWrap label="Databases"><StateView kind="empty" title="No database targets yet"
      text="Configure a DB agent with databases.<name> = <engine>|<exporter-url> (postgres, mysql, mssql, oracle, redis, kafka...). See docs/agent/DB-METRICS.md." /></TableWrap></>;
  }

  return (
    <>
      {head}
      <div className="grid cards-4" style={{ marginBottom: 14 }}>
        <div className="summary-card"><div className="bubble bubble-blue"><Database size={18} /></div><div><div className="k">Targets</div><div className="v">{sum.total}</div></div></div>
        <div className="summary-card"><div className="bubble bubble-green" /><div><div className="k">Up</div><div className="v">{sum.up}</div></div></div>
        <div className="summary-card"><div className="bubble bubble-red" /><div><div className="k">Down</div><div className="v">{sum.down}</div></div></div>
        <div className="summary-card"><div className="bubble bubble-blue" /><div><div className="k">Engines</div><div className="v">{groups.length}</div></div></div>
      </div>
      {groups.map((g) => (
        <div key={g.engine} style={{ marginBottom: 16 }}>
          <TableWrap label={g.label}>
            <div style={{ padding: '10px 14px', fontWeight: 600 }}>{g.label} <span className="dim" style={{ fontSize: 12 }}>· {g.targets.length}</span></div>
            <table className="tbl">
              <thead><tr><th>Instance</th><th>Status</th><th className="num">Metrics</th></tr></thead>
              <tbody>
                {g.targets.map((t) => (
                  <tr key={t.instance}>
                    <td><b style={{ fontWeight: 600 }}>{t.instance}</b></td>
                    <td>{t.up ? <Pill tone="green">Up</Pill> : <Pill tone="red">Down</Pill>}</td>
                    <td className="num">
                      {canOpen('/metrics') && <button className="icon-btn" title="Explore metrics" aria-label={`Explore metrics for ${t.instance}`}
                        onClick={() => navigate(`/metrics/explore?q=${encodeURIComponent(exploreQuery(g.engine, t.instance))}`)}><LineChart size={15} /></button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </div>
      ))}
    </>
  );
}
