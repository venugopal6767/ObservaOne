// One dashboard: variables (label values from Prometheus) and a 12-column grid of panels.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { escapeLabel } from '@/lib/format';
import { useApp } from '@/app/AppContext';
import { ErrorState, PageHead, Pill, Select, Skeleton, StateView, toast, useDialogs } from '@/components/ui';
import { PromPanelBody, type Panel } from '@/components/PromPanel';

interface Variable { name: string; label: string; label_name: string; match?: string }
interface Dash { id: string; title: string; description?: string; kind: 'system' | 'custom'; panels: Panel[]; variables?: Variable[] }

export default function DashboardView() {
  const { id = '' } = useParams();
  const { can, canOpen } = useApp();
  const { confirm } = useDialogs();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['dashboard', id], queryFn: () => api<Dash>(`/dashboards/${encodeURIComponent(id)}`) });
  const dash = q.data;
  const [vars, setVars] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<Record<string, string[]>>({});

  // load each variable's values; remember the choice per dashboard (this browser tab)
  useEffect(() => {
    if (!dash) return;
    let stop = false;
    (async () => {
      const opts: Record<string, string[]> = {}, chosen: Record<string, string> = {};
      for (const v of dash.variables || []) {
        let values: string[] = [];
        try { values = await api<string[]>('/prom/label-values', { query: { label: v.label_name, match: v.match } }); } catch { /* none */ }
        if (!values.length) values = ['(none)'];
        const saved = sessionStorage.getItem(`oo.var.${dash.id}.${v.name}`);
        opts[v.name] = values;
        chosen[v.name] = saved && values.includes(saved) ? saved : values[0];
      }
      if (!stop) { setOptions(opts); setVars(chosen); }
    })();
    return () => { stop = true; };
  }, [dash]);

  if (q.isPending) return <Skeleton kind="chart" />;
  if (q.isError) return <ErrorState error={q.error} what="Dashboard" />;
  const d = dash!;
  const editable = d.kind === 'custom' && can('dashboards.edit');
  const ready = (d.variables || []).every((v) => vars[v.name] !== undefined);
  const escVars = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, escapeLabel(v)]));

  return (
    <>
      <PageHead title={<>{d.title}<Pill tone={d.kind === 'system' ? 'blue' : 'purple'}>{d.kind === 'system' ? 'System' : 'Custom'}</Pill></>} sub={d.description}
        actions={<>
          <Link to="/dashboards" className="btn">All dashboards</Link>
          {editable && <button className="btn btn-danger" onClick={async () => {
            if (!(await confirm('Delete dashboard', `Delete "${d.title}"? This cannot be undone.`, 'Delete'))) return;
            try { await api(`/dashboards/${d.id}`, { method: 'DELETE' }); toast('Dashboard deleted'); qc.invalidateQueries({ queryKey: ['dashboards'] }); navigate('/dashboards'); } catch (e) { toast((e as Error).message, 'err'); }
          }}><Trash2 size={14} />Delete</button>}
        </>} />
      {(d.variables || []).length > 0 && (
        <div className="toolbar">
          {(d.variables || []).map((v) => (
            <span key={v.name} className="var-pick">
              <span className="muted">{v.label}</span>
              <Select label={v.label} options={options[v.name] || []} value={vars[v.name] || ''} onChange={(val) => { setVars({ ...vars, [v.name]: val }); sessionStorage.setItem(`oo.var.${d.id}.${v.name}`, val); }} />
            </span>
          ))}
        </div>
      )}
      {!d.panels.length ? (
        <StateView kind="empty" title="This dashboard has no panels" text='Open Metrics, run a query, then press "Add to Dashboard".'
          action={canOpen('/metrics') ? <Link to="/metrics" className="btn btn-primary">Go to Metrics</Link> : undefined} />
      ) : !ready ? <Skeleton kind="chart" /> : (
        <div className="grid cols-12">
          {d.panels.map((p, i) => (
            <section key={`${i}-${p.title}`} className="panel" style={{ gridColumn: `span ${p.w || 6}` }}>
              <div className="panel-head">
                <h3>{p.title}</h3>
                <div className="right">
                  {editable && <button className="icon-btn icon-btn-sm" title="Remove panel" aria-label={`Remove panel ${p.title}`} onClick={async () => {
                    if (!(await confirm('Remove panel', `Remove "${p.title}"?`, 'Remove'))) return;
                    try { const next = await api<Dash>(`/dashboards/${d.id}/panels/${i}`, { method: 'DELETE' }); qc.setQueryData(['dashboard', id], { ...next, kind: 'custom' }); } catch (e) { toast((e as Error).message, 'err'); }
                  }}><Trash2 size={13} /></button>}
                </div>
              </div>
              <PromPanelBody panel={p} vars={escVars} />
            </section>
          ))}
        </div>
      )}
    </>
  );
}
