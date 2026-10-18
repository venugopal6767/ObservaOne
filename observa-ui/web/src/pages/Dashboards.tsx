// Dashboards: built-in (files) and custom (database). Each card previews real data from its first chart panel.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, type PromMatrix } from '@/lib/api';
import { fmt, legendName } from '@/lib/format';
import { palette } from '@/lib/theme';
import { useApp, usePlainQuery, useRangeQuery } from '@/app/AppContext';
import { ErrorState, Field, InfoBox, Modal, PageHead, Pill, Skeleton, StateView, toast, useDialogs } from '@/components/ui';
import { Sparkline } from '@/components/charts';
import type { Panel } from '@/components/PromPanel';

export interface DashSummary { id: string; title: string; description?: string; owner?: string; kind: 'system' | 'custom'; panelCount: number; preview: Panel | null; variables?: { name: string }[]; tags?: string[] }

export default function Dashboards() {
  const { can } = useApp();
  const { open } = useDialogs();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'all' | 'custom' | 'system'>('all');
  const [search, setSearch] = useState('');
  const q = usePlainQuery(['dashboards'], () => api<DashSummary[]>('/dashboards'), { autoRefresh: false });
  const list = q.data || [];
  const count = (k: string) => (k === 'all' ? list.length : list.filter((d) => d.kind === k).length);
  const shown = list.filter((d) => (filter === 'all' || d.kind === filter) && (!search || `${d.title} ${d.description || ''}`.toLowerCase().includes(search.toLowerCase())));
  const newDashboard = () => open((close) => <NewDashboard onClose={close} onCreated={(id) => navigate(`/dashboards/${id}`)} />);

  let body: React.ReactNode;
  if (q.isPending) body = <div style={{ gridColumn: '1 / -1' }}><Skeleton kind="cards" n={4} /></div>;
  else if (q.isError) body = <div style={{ gridColumn: '1 / -1' }}><ErrorState error={q.error} what="Dashboards" /></div>;
  else if (!shown.length) {
    body = (
      <div style={{ gridColumn: '1 / -1' }}>
        {search ? <StateView kind="empty" title="No dashboards match your search" text={`Nothing matches "${search}".`} />
          : filter === 'custom' ? <StateView kind="empty" title="No custom dashboards yet" text={can('dashboards.edit') ? 'Create one, then add panels from the Metrics page.' : 'Nobody has created a custom dashboard yet.'}
            action={can('dashboards.edit') ? <button className="btn btn-primary" onClick={newDashboard}><Plus size={14} />New Dashboard</button> : undefined} />
            : <StateView kind="empty" title="No dashboards" />}
      </div>
    );
  } else body = shown.map((d, i) => <DashCard key={d.id} d={d} i={i} onOpen={() => navigate(`/dashboards/${encodeURIComponent(d.id)}`)} />);

  return (
    <>
      <PageHead title="Dashboards" sub="Create and manage your dashboards" actions={can('dashboards.edit') ? <button className="btn btn-primary" onClick={newDashboard}><Plus size={15} />New Dashboard</button> : undefined} />
      <div className="toolbar">
        <div className="chips">
          {(['all', 'custom', 'system'] as const).map((k) => (
            <button key={k} className={`tab tab-outline ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>{k[0].toUpperCase() + k.slice(1)} ({count(k)})</button>
          ))}
        </div>
        <div className="grow" />
        <input className="input" placeholder="Search dashboards..." aria-label="Search dashboards" style={{ width: 260 }} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="dash-grid">{body}</div>
    </>
  );
}

/** The preview is real data: the first series of the first chart panel, with its name and latest value */
function DashCard({ d, i, onOpen }: { d: DashSummary; i: number; onOpen: () => void }) {
  let query = d.preview?.query || '';
  for (const v of d.variables || []) query = query.replaceAll(`$${v.name}`, '.+').replace(/(\w+)="\.\+"/g, '$1=~".+"');
  const q = useRangeQuery(['dash-preview', d.id, query], (r) => api<{ result: PromMatrix }>('/prom/query_range', { query: { query, ...r, step: Math.ceil((r.end - r.start) / 40) } }), { enabled: !!d.preview });
  const s = q.data?.result?.[0];
  const last = s?.values[s.values.length - 1];
  return (
    <div className="dash-card" tabIndex={0} role="link" onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <div className="t">{d.title}</div>
      <div><Pill tone={d.kind === 'system' ? 'blue' : 'purple'}>{d.kind === 'system' ? 'System' : 'Custom'}</Pill> <span className="dim" style={{ fontSize: 11 }}>{d.panelCount} panels</span></div>
      <div className="spark">
        {!d.preview ? <div className="dim spark-note">No panels yet</div>
          : q.isPending ? null
            : q.isError ? <div className="dim spark-note">Preview unavailable</div>
              : !s ? <div className="dim spark-note">No data yet</div>
                : <Sparkline points={s.values} lineColor={palette()[i % 10]} />}
      </div>
      {s && d.preview && (
        <div className="preview-meta" title={`${d.preview.title} · ${legendName(s.metric, d.preview.legend)}: latest value in the selected time range`}>
          <b>{fmt(Number(last?.[1]), d.preview.unit)}</b><span>{d.preview.title}{(q.data?.result.length || 0) > 1 ? ` · 1 of ${q.data!.result.length} series` : ''}</span>
        </div>
      )}
      <div className="d">{d.description || (d.owner ? `Created by ${d.owner}` : '')}</div>
    </div>
  );
}

function NewDashboard({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  return (
    <Modal title="New dashboard" onClose={onClose} actions={[
      { label: 'Cancel' },
      { label: 'Create', primary: true, onClick: async () => {
        const d = await api<{ id: string }>('/dashboards', { method: 'POST', body: { title: title.trim(), description: desc.trim() } });
        toast('Dashboard created');
        onCreated(d.id);
      } },
    ]}>
      <Field label="Title"><input className="input" maxLength={60} placeholder="e.g. Payments team" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Description"><input className="input" maxLength={200} placeholder="What is this dashboard for?" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
      <InfoBox>After creating it, open the Metrics page, run a query and press "Add to Dashboard".</InfoBox>
    </Modal>
  );
}
