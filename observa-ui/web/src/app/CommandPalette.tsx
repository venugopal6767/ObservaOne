// Ctrl+K / "/" command palette: jump to any page, dashboard, service, metric or trace; search logs;
// change the time range or theme. Only offers what this deployment has enabled and this user may open.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, CornerDownLeft } from 'lucide-react';
import { api } from '@/lib/api';
import { escapeLabel } from '@/lib/format';
import { NAV_SECTIONS } from './routes';
import { RANGES, useApp } from './AppContext';
import { NAV_ICONS } from '@/components/ui';

type Item = { id: string; label: string; kind: string; hint?: string; run: () => void };

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { canOpen, setRange, setThemePref, themePref, logout } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // look-up lists, fetched once when the palette is first opened (and cached)
  const metrics = useQuery({ queryKey: ['palette', 'metric-names'], queryFn: () => api<string[]>('/prom/metric-names'), enabled: open && canOpen('/metrics'), staleTime: 60_000 });
  const dashboards = useQuery({ queryKey: ['palette', 'dashboards'], queryFn: () => api<{ id: string; title: string }[]>('/dashboards'), enabled: open && canOpen('/dashboards'), staleTime: 60_000 });
  const services = useQuery({ queryKey: ['palette', 'services'], queryFn: () => api<{ list: { name: string }[] }>('/services'), enabled: open && canOpen('/services'), staleTime: 60_000 });

  useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => input.current?.focus(), 10); } }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (path: string) => () => navigate(path);
    const term = q.trim().toLowerCase();
    const raw = q.trim().replace(/"/g, '');
    const pages: Item[] = NAV_SECTIONS.flatMap((s) => s.items).filter((i) => canOpen(i.path))
      .map((i) => ({ id: `p:${i.path}`, label: i.label, kind: 'Page', hint: i.keywords, run: go(i.path) }));
    const actions: Item[] = [
      ...RANGES.map(([s, l]) => ({ id: `r:${s}`, label: `Time range: ${l}`, kind: 'Action', run: () => setRange({ kind: 'relative', seconds: s }) })),
      { id: 't:theme', label: `Switch to ${themePref === 'light' ? 'dark' : 'light'} theme`, kind: 'Action', run: () => setThemePref(themePref === 'light' ? 'dark' : 'light') },
      { id: 'a:profile', label: 'My profile & security', kind: 'Action', run: go('/settings?tab=profile') },
      { id: 'a:logout', label: 'Sign out', kind: 'Action', run: () => { logout(); } },
    ];
    if (canOpen('/agents')) actions.push({ id: 'a:install', label: 'Install an agent', kind: 'Action', run: go('/agents?tab=install') });
    if (canOpen('/metrics')) {
      actions.push({ id: 'a:explore', label: 'Explore metrics', kind: 'Action', hint: 'promql builder templates', run: go('/metrics/explore') });
      actions.push({ id: 'a:k8s', label: 'Kubernetes clusters', kind: 'Page', hint: 'k8s pods nodes namespaces', run: go('/metrics/kubernetes') });
    }
    if (!term) return [...pages, ...actions.slice(-4)];
    const has = (s: string) => s.toLowerCase().includes(term);
    const out: Item[] = [
      ...pages.filter((p) => has(p.label) || (p.hint && has(p.hint))),
      ...(dashboards.data || []).filter((d) => has(d.title)).slice(0, 6).map((d) => ({ id: `d:${d.id}`, label: d.title, kind: 'Dashboard', run: go(`/dashboards/${encodeURIComponent(d.id)}`) })),
      ...(services.data?.list || []).filter((s) => has(s.name)).slice(0, 6).flatMap((s) => [
        ...(canOpen('/logs') ? [{ id: `sl:${s.name}`, label: `Logs: ${s.name}`, kind: 'Service', run: go(`/logs?q=${encodeURIComponent(`{service_name="${escapeLabel(s.name)}"}`)}`) }] : []),
        ...(canOpen('/traces') ? [{ id: `st:${s.name}`, label: `Traces: ${s.name}`, kind: 'Service', run: go(`/traces?q=${encodeURIComponent(`service.name=${s.name}`)}`) }] : []),
      ]),
      ...(metrics.data || []).filter((m) => has(m)).slice(0, 8).map((m) => ({ id: `m:${m}`, label: m, kind: 'Metric', run: go(`/metrics/explore?mode=code&q=${encodeURIComponent(m)}`) })),
      ...actions.filter((a) => has(a.label)),
    ];
    if (canOpen('/metrics')) out.unshift({ id: 'q:ask', label: `Ask: "${raw}"`, kind: 'Metrics', run: go(`/metrics/explore?ask=${encodeURIComponent(raw)}`) });
    if (canOpen('/logs')) out.push({ id: 'q:logs', label: `Search logs for "${raw}"`, kind: 'Logs', run: go(`/logs?q=${encodeURIComponent(`{service_name=~".+"} |= "${raw}"`)}`) });
    if (canOpen('/traces')) {
      if (/^[0-9a-f]{16,32}$/i.test(raw)) out.unshift({ id: 'q:trace', label: `Open trace ${raw}`, kind: 'Trace', run: go(`/traces?id=${raw}`) });
      else out.push({ id: 'q:traces', label: `Find traces for service "${raw}"`, kind: 'Traces', run: go(`/traces?q=${encodeURIComponent(`service.name=${raw}`)}`) });
    }
    return out;
  }, [q, canOpen, navigate, setRange, setThemePref, themePref, logout, metrics.data, dashboards.data, services.data]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { list.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  if (!open) return null;
  const pick = (i: number) => { const it = items[i]; if (!it) return; onClose(); it.run(); };

  return (
    <div className="modal-overlay palette-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <Search size={17} aria-hidden />
          <input ref={input} value={q} placeholder="Jump to a page, dashboard, service, metric, trace ID…" aria-label="Search" role="combobox" aria-expanded="true" aria-controls="palette-list"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { setSel((s) => Math.min(items.length - 1, s + 1)); e.preventDefault(); }
              if (e.key === 'ArrowUp') { setSel((s) => Math.max(0, s - 1)); e.preventDefault(); }
              if (e.key === 'Enter') { pick(sel); e.preventDefault(); }
              if (e.key === 'Escape') onClose();
            }} />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {items.length === 0 && <div className="palette-empty">Nothing matches.</div>}
          {items.map((it, i) => {
            const pageIcon = it.id.startsWith('p:') ? NAV_SECTIONS.flatMap((s) => s.items).find((x) => `p:${x.path}` === it.id)?.icon : undefined;
            const Icon = pageIcon ? NAV_ICONS[pageIcon] : null;
            return (
              <button key={it.id} role="option" aria-selected={i === sel} className={i === sel ? 'sel' : ''} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); pick(i); }}>
                {Icon ? <Icon size={15} aria-hidden /> : <span className="palette-dot" />}
                <span className="ell">{it.label}</span>
                <span className="kind">{it.kind}</span>
                {i === sel && <CornerDownLeft size={13} className="dim" aria-hidden />}
              </button>
            );
          })}
        </div>
        <div className="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Ctrl</kbd>+<kbd>K</kbd> or <kbd>/</kbd> anywhere</span></div>
      </div>
    </div>
  );
}
