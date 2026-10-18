// Data sources: where each kind of data comes from, tested live. A down source makes its pages say so.
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Pencil } from 'lucide-react';
import { api } from '@/lib/api';
import { useApp } from '@/app/AppContext';
import { ErrorState, Field, InfoBox, Modal, PageHead, Pill, StateView, TableWrap, toast, useDialogs } from '@/components/ui';

interface Ds { id: string; name: string; kind: string; url: string }
type Status = { testing?: boolean; ok?: boolean; message?: string; ms?: number };
// brand tints for the letter badges (the only hard-coded colours in the pages)
const LOOK: Record<string, [string, string]> = {
  prometheus: ['P', '#e6522c'], alertmanager: ['A', '#ef4444'], loki: ['L', '#f59e0b'],
  tempo: ['T', '#3b82f6'], services: ['S', '#a855f7'], grafana: ['G', '#f97316'],
};

export default function DataSources() {
  const { can } = useApp();
  const { open } = useDialogs();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['datasources'], queryFn: () => api<Ds[]>('/datasources') });
  const [status, setStatus] = useState<Record<string, Status>>({});

  const test = async (id: string) => {
    setStatus((s) => ({ ...s, [id]: { testing: true } }));
    const r = await api<Status>(`/datasources/${id}/test`, { method: 'POST' }).catch((e) => ({ ok: false, message: (e as Error).message }));
    setStatus((s) => ({ ...s, [id]: r }));
  };
  const testAll = () => (q.data || []).forEach((d) => test(d.id));
  useEffect(() => { if (q.data) testAll(); }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const pill = (d: Ds) => {
    const s = status[d.id];
    if (!s || s.testing) return <Pill>Testing...</Pill>;
    if (s.ok) return <Pill tone="green" title={s.ms ? `${s.ms} ms` : ''}>● Connected</Pill>;
    if (s.message === 'Not configured') return <Pill title="No address set. Click Edit to set it.">● Not configured</Pill>;
    return <Pill tone="red" title={s.message}>● Unavailable</Pill>;
  };

  return (
    <>
      <PageHead title="Data Sources" sub="Configure and manage your data sources" actions={<button className="btn btn-primary" onClick={testAll}><RefreshCw size={14} />Test all</button>} />
      {q.isPending ? <TableWrap label="Data sources"><StateView kind="loading" skeleton="table" /></TableWrap>
        : q.isError ? <TableWrap label="Data sources"><ErrorState error={q.error} what="Data sources" /></TableWrap> : (
          <>
            <TableWrap label="Data sources">
              <table className="tbl">
                <thead><tr><th>Name</th><th>URL</th><th>Type</th><th>Status</th><th>Message</th><th /></tr></thead>
                <tbody>
                  {q.data.map((d) => {
                    const [letter, c] = LOOK[d.id] || ['?', '#64748b'];
                    const s = status[d.id];
                    return (
                      <tr key={d.id}>
                        <td><div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><div className="ds-icon" style={{ background: `${c}22`, color: c, border: `1px solid ${c}66` }}>{letter}</div><b style={{ fontWeight: 600, fontSize: 14 }}>{d.name}</b></div></td>
                        <td className="mono dim" style={{ fontSize: 12 }}>{d.url}</td>
                        <td>{d.kind}</td>
                        <td>{pill(d)}</td>
                        <td className="dim" style={{ fontSize: 12, maxWidth: 280 }}>{s && !s.testing ? s.message : ''}{s?.ok && s.ms ? <span className="dim"> · {s.ms} ms</span> : null}</td>
                        <td>
                          <div className="row-actions">
                            {can('integrations.manage') && d.id !== 'services' && <button className="icon-btn" title="Edit" aria-label={`Edit ${d.name}`} onClick={() => open((close) => <EditDs d={d} onClose={close} onSaved={(r) => { setStatus((x) => ({ ...x, [d.id]: r })); qc.invalidateQueries({ queryKey: ['datasources'] }); }} />)}><Pencil size={15} /></button>}
                            <button className="icon-btn" title="Test connection" aria-label={`Test ${d.name}`} onClick={() => test(d.id)}><RefreshCw size={15} /></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            <div style={{ marginTop: 14 }}>
              <InfoBox>Every page reads these sources directly. When a source is unavailable, its pages say so instead of showing old or sample data. Service metrics use the PromQL in observa-ui/config/services.json.</InfoBox>
            </div>
          </>
        )}
    </>
  );
}

function EditDs({ d, onClose, onSaved }: { d: Ds; onClose: () => void; onSaved: (r: Status) => void }) {
  const [url, setUrl] = useState(d.url || '');
  return (
    <Modal title={`Edit ${d.name}`} onClose={onClose} actions={[
      { label: 'Cancel' },
      { label: 'Save & test', primary: true, onClick: async () => {
        const r = await api<Status>(`/datasources/${d.id}`, { method: 'PUT', body: { url: url.trim() } });
        toast(r.ok ? `${d.name} saved` : `${d.name} saved, but test failed: ${r.message}`, r.ok ? 'ok' : 'err');
        onSaved(r);
      } },
    ]}>
      <Field label="URL (as seen from the UI container)" hint="Example: http://loki:3100"><input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
    </Modal>
  );
}
