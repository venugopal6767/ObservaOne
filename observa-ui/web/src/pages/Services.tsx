// Services: request rate, P95 latency and error rate per application (rules in src/health.js).
// Each row links to that service's logs and traces.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Boxes, HeartPulse, AlertTriangle, CircleX, Activity, FileText, Waypoints } from 'lucide-react';
import { api } from '@/lib/api';
import { fmt, short, escapeLabel } from '@/lib/format';
import { useApp, usePlainQuery } from '@/app/AppContext';
import { ErrorState, HealthPill, PageHead, StateView, TableFoot, TableWrap, usePager } from '@/components/ui';

interface Svc { name: string; namespace: string; rps: number | null; errorRate: number | null; p95: number | null; status: 'healthy' | 'degraded' | 'down' | 'no_traffic' }
interface SvcData { list: Svc[]; summary: { total: number; healthy: number; degraded: number; down: number; noTraffic: number } }
type SortKey = 'status' | 'name' | 'rps' | 'p95' | 'errorRate';
const ORDER = { down: 0, degraded: 1, healthy: 2, no_traffic: 3 };

export default function Services() {
  const { canOpen } = useApp();
  const navigate = useNavigate();
  const q = usePlainQuery(['services'], () => api<SvcData>('/services'));
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('status');
  const [dir, setDir] = useState(1);

  const rows = useMemo(() => {
    const val = (x: Svc, k: SortKey) => (k === 'status' ? ORDER[x.status] : k === 'name' ? x.name : x[k] ?? -1);
    return (q.data?.list || [])
      .filter((x) => (!search || x.name.toLowerCase().includes(search.toLowerCase())) && (!status || x.status === status))
      .sort((a, b) => { const A = val(a, sortKey), B = val(b, sortKey); return (A > B ? 1 : A < B ? -1 : a.name.localeCompare(b.name)) * dir; });
  }, [q.data, search, status, sortKey, dir]);
  const pager = usePager(rows, 50, `${search}|${status}`);

  const head = <PageHead title="Services" sub="Monitor your application services" actions={<input className="input" placeholder="Filter services..." aria-label="Filter services" style={{ width: 240 }} value={search} onChange={(e) => setSearch(e.target.value)} />} />;
  if (q.isPending) return <>{head}<TableWrap label="Services"><StateView kind="loading" skeleton="table" /></TableWrap></>;
  if (q.isError) return <>{head}<TableWrap label="Services"><ErrorState error={q.error} what="Services" /></TableWrap></>;
  const s = q.data.summary;

  const Card = ({ label, value, bubble, Icon, k }: { label: string; value: number; bubble: string; Icon: typeof Boxes; k: string }) => (
    <button className={`summary-card ${status === k ? 'active' : ''}`} aria-pressed={status === k} onClick={() => setStatus(status === k ? '' : k)}>
      <div className={`bubble ${bubble}`}><Icon size={18} /></div><div><div className="k">{label}</div><div className="v">{value}</div></div>
    </button>
  );
  const Th = ({ label, k, num }: { label: string; k: SortKey; num?: boolean }) => (
    <th className={`sortable ${num ? 'num' : ''}`} aria-sort={sortKey === k ? (dir > 0 ? 'ascending' : 'descending') : 'none'} onClick={() => { setDir(sortKey === k ? -dir : 1); setSortKey(k); }}>
      {label}{sortKey === k ? (dir > 0 ? ' ▲' : ' ▼') : ' ⌄'}
    </th>
  );

  return (
    <>
      {head}
      <div className={`grid ${s.noTraffic ? 'cards-5' : 'cards-4'}`}>
        <Card label="Total Services" value={s.total} bubble="bubble-blue" Icon={Boxes} k="" />
        <Card label="Healthy" value={s.healthy} bubble="bubble-green" Icon={HeartPulse} k="healthy" />
        <Card label="Degraded" value={s.degraded} bubble="bubble-orange" Icon={AlertTriangle} k="degraded" />
        <Card label="Down" value={s.down} bubble="bubble-red" Icon={CircleX} k="down" />
        {!!s.noTraffic && <Card label="No traffic" value={s.noTraffic} bubble="bubble-blue" Icon={Activity} k="no_traffic" />}
      </div>
      <div style={{ marginTop: 14 }}>
        {!q.data.list.length ? (
          <TableWrap label="Services"><StateView kind="empty" title="No services discovered" text="Prometheus answered, but no application request metrics match the queries in config/services.json. Instrument your apps with OpenTelemetry (or edit that file to match your metrics)." /></TableWrap>
        ) : !rows.length ? (
          <TableWrap label="Services"><StateView kind="empty" title="No services match these filters" text="Clear the search box or the status tile filter." /></TableWrap>
        ) : (
          <TableWrap label="Services">
            <table className="tbl">
              <thead><tr><Th label="Service" k="name" /><Th label="Status" k="status" /><Th label="Requests/s" k="rps" num /><Th label="Latency (P95)" k="p95" num /><Th label="Error Rate" k="errorRate" num /><th className="num">Jump to</th></tr></thead>
              <tbody>
                {pager.rows.map((x) => {
                  // null = not reported / not meaningful (e.g. no traffic): "-", never 0 or 100%
                  const errCls = x.errorRate === null ? 'dim' : x.errorRate >= 5 ? 'c-red' : x.errorRate >= 1 ? 'c-orange' : 'c-green';
                  const latCls = x.p95 === null ? 'dim' : x.p95 >= 1000 ? 'c-red' : x.p95 >= 500 ? 'c-orange' : '';
                  const sel = `{service_name="${escapeLabel(x.name)}"}`;
                  return (
                    <tr key={x.name}>
                      <td><b style={{ fontWeight: 600 }}>{x.name}</b>{x.namespace && <span className="dim" style={{ marginLeft: 8, fontSize: 11.5 }}>{x.namespace}</span>}</td>
                      <td><HealthPill health={x.status} /></td>
                      <td className="num">{short(x.rps)}</td>
                      <td className={`num ${latCls}`}>{x.p95 === null ? '-' : fmt(x.p95, 'ms')}</td>
                      <td className={`num ${errCls}`}>{x.errorRate === null ? '-' : `${x.errorRate.toFixed(1)}%`}</td>
                      <td>
                        <div className="row-actions">
                          {canOpen('/logs') && <button className="icon-btn" title="Logs" aria-label={`Logs for ${x.name}`} onClick={() => navigate(`/logs?q=${encodeURIComponent(sel)}`)}><FileText size={15} /></button>}
                          {canOpen('/logs') && x.errorRate !== null && x.errorRate > 0 && <button className="icon-btn" title="Error logs" aria-label={`Error logs for ${x.name}`} onClick={() => navigate(`/logs?q=${encodeURIComponent(`${sel} |~ "(?i)error|exception|fatal"`)}`)}><AlertTriangle size={15} /></button>}
                          {canOpen('/traces') && <button className="icon-btn" title="Traces" aria-label={`Traces for ${x.name}`} onClick={() => navigate(`/traces?q=${encodeURIComponent(`service.name=${x.name}`)}`)}><Waypoints size={15} /></button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <TableFoot pager={pager} noun={rows.length === 1 ? 'service' : 'services'} note={rows.length < q.data.list.length ? `(filtered from ${q.data.list.length})` : undefined} />
          </TableWrap>
        )}
      </div>
    </>
  );
}
