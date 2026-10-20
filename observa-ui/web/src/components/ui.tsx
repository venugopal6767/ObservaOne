// Small shared building blocks: icons, pills, data states, tabs, form fields, modal, toasts, confirm.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  LayoutGrid, LayoutDashboard, LineChart, FileText, Waypoints, Layers, Server, Bell, Cpu, Database, Settings,
  Activity, AlertTriangle, Clock, CircleSlash, X, Check, Info, type LucideIcon,
  MoreVertical,
} from 'lucide-react';
import type { ApiError } from '@/lib/api';
import { dateTime, timeTitle } from '@/lib/format';
import type { IconName } from '@/app/routes';

export const NAV_ICONS: Record<IconName, LucideIcon> = {
  overview: LayoutGrid, dashboards: LayoutDashboard, metrics: LineChart, logs: FileText, traces: Waypoints,
  services: Layers, infrastructure: Server, alerting: Bell, agents: Cpu, datasources: Database, settings: Settings,
};

// ---------------- pills ----------------
export type Tone = 'green' | 'orange' | 'red' | 'blue' | 'purple' | 'muted' | 'solid-red' | 'solid-orange' | 'solid-green' | 'solid-blue' | 'solid-muted' | 'stale';
export function Pill({ tone = 'muted', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`pill pill-${tone}`} title={title}>{children}</span>;
}

/** Health of one thing (host, target, service). "unknown"-like states never look green or red. */
const HEALTH: Record<string, [string, Tone, string]> = {
  up: ['UP', 'solid-green', 'Answering normally'],
  healthy: ['Healthy', 'solid-green', ''],
  degraded: ['Degraded', 'solid-orange', ''],
  down: ['DOWN', 'solid-red', ''],
  not_reporting: ['Not reporting', 'stale', 'No data received recently. The host may be fine; the agent or network may have stopped.'],
  no_traffic: ['No traffic', 'muted', 'No requests in this period, so there is no error rate or latency to judge.'],
  unknown: ['Unknown', 'muted', 'Not checked yet.'],
};
export function HealthPill({ health, detail }: { health: string; detail?: string }) {
  const [label, tone, hint] = HEALTH[health] || HEALTH.unknown;
  return <Pill tone={tone} title={detail || hint || label}>{label}</Pill>;
}

// ---------------- data states ----------------
// One look and one meaning per state, on every page (same rules as before):
//   loading / empty / not_configured / unavailable / error / stale / partial. Never made-up numbers.
type StateKind = 'loading' | 'empty' | 'not_configured' | 'unavailable' | 'error' | 'stale' | 'partial' | 'module_disabled';
const STATE_META: Record<StateKind, { icon: LucideIcon | null; title: string }> = {
  loading: { icon: null, title: 'Loading...' },
  empty: { icon: Activity, title: 'No data' },
  not_configured: { icon: Settings, title: 'Not configured' },
  unavailable: { icon: AlertTriangle, title: 'Data source unavailable' },
  error: { icon: AlertTriangle, title: 'Something went wrong' },
  stale: { icon: Clock, title: 'Data is out of date' },
  partial: { icon: AlertTriangle, title: 'Some data is missing' },
  module_disabled: { icon: CircleSlash, title: 'Module not enabled' },
};

export function Skeleton({ kind = 'table', n }: { kind?: 'table' | 'chart' | 'cards'; n?: number }) {
  if (kind === 'cards') return <div className="skeleton-cards">{Array.from({ length: n || 4 }, (_, i) => <div key={i} className="sk sk-card" />)}</div>;
  if (kind === 'chart') return <div className="skeleton"><div className="sk sk-line" style={{ width: '30%' }} /><div className="sk sk-chart" /></div>;
  return (
    <div className="skeleton">
      {Array.from({ length: n || 6 }, (_, i) => (
        <div key={i} className="sk-row"><div className="sk sk-line" /><div className="sk sk-line" /><div className="sk sk-line" /><div className="sk sk-line" /></div>
      ))}
    </div>
  );
}

export function StateView({ kind, title, text, action, skeleton }: { kind: StateKind; title?: string; text?: ReactNode; action?: ReactNode; skeleton?: 'table' | 'chart' | 'cards' }) {
  const m = STATE_META[kind] || STATE_META.error;
  if (kind === 'loading') {
    return (
      <div className="state-loading" role="status" aria-live="polite" aria-busy="true">
        {skeleton ? <Skeleton kind={skeleton} /> : <div className="spinner" />}
        <span className="sr-only">{title || m.title}</span>
      </div>
    );
  }
  const Icon = m.icon;
  return (
    <div className={`state state-${kind}`} role={kind === 'error' || kind === 'unavailable' ? 'alert' : 'status'}>
      {Icon && <span className="ic"><Icon size={26} strokeWidth={1.8} aria-hidden /></span>}
      <div className="state-title">{title || m.title}</div>
      {text && <div className="state-text">{text}</div>}
      {action}
    </div>
  );
}

export function StateBanner({ kind = 'partial', children }: { kind?: StateKind; children: ReactNode }) {
  return (
    <div className={`state-banner state-banner-${kind}`} role="status">
      <span className="ic"><AlertTriangle size={15} aria-hidden /></span><span>{children}</span>
    </div>
  );
}

/** A failed API call as the right state. `what` names the data, e.g. "Logs". */
export function ErrorState({ error, what = 'Data' }: { error: unknown; what?: string }) {
  const e = error as ApiError | undefined;
  const toSources = <Link to="/datasources" className="btn btn-sm">Open Data Sources</Link>;
  if (e?.state === 'module_disabled') return <StateView kind="module_disabled" title={`${what}: module not enabled`} text="An administrator turned this module off in Settings > Modules." />;
  if (e?.state === 'not_configured') return <StateView kind="not_configured" title={`${what}: data source not configured`} text={e.message} action={toSources} />;
  if (e?.state === 'unavailable' || e?.status === 502 || e?.status === 503 || e?.status === 504) {
    return <StateView kind="unavailable" title={`${what}: data source unavailable`} text={`${e.message}. Nothing is shown until it answers again.`} action={toSources} />;
  }
  return <StateView kind="error" title={`${what} could not be loaded`} text={e?.message || 'Unknown error'} />;
}

export function InfoBox({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'ok' | 'error' }) {
  const Icon = tone === 'ok' ? Check : tone === 'error' ? AlertTriangle : Info;
  return <div className={tone === 'ok' ? 'ok-box' : tone === 'error' ? 'error-box' : 'info-box'}><span className="ic"><Icon size={16} aria-hidden /></span><span>{children}</span></div>;
}

// ---------------- timestamps ----------------
/** A timestamp: shown text + full detail (zone, UTC, age) on hover */
export function Time({ ms, text }: { ms: number; text?: string }) {
  if (!Number.isFinite(ms)) return <>-</>;
  return <time dateTime={new Date(ms).toISOString()} title={timeTitle(ms)}>{text ?? dateTime(ms)}</time>;
}

// ---------------- controls ----------------
export function Tabs<K extends string>({ items, active, onChange, label }: { items: [K, ReactNode][]; active: K; onChange: (k: K) => void; label?: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map(([k, l]) => (
        <button key={k} role="tab" aria-selected={k === active} className={`tab ${k === active ? 'active' : ''}`} onClick={() => onChange(k)}>{l}</button>
      ))}
    </div>
  );
}

export function Select<V extends string | number>({ options, value, onChange, className = 'select', label, style, disabled }: {
  options: (V | [V, string])[]; value: V; onChange: (v: V) => void; className?: string; label?: string; style?: React.CSSProperties; disabled?: boolean;
}) {
  const norm = options.map((o) => (Array.isArray(o) ? o : [o, String(o)])) as [V, string][];
  return (
    <select className={className} aria-label={label} style={style} disabled={disabled} value={String(value)}
      onChange={(e) => { const hit = norm.find(([v]) => String(v) === e.target.value); if (hit) onChange(hit[0]); }}>
      {norm.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
    </select>
  );
}

export function Toggle({ checked, onChange, disabled, title, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; title?: string; label?: string }) {
  return (
    <label className={`switch ${disabled ? 'disabled' : ''}`} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={label || title} onChange={(e) => onChange(e.target.checked)} />
      <span className="slider" />
    </label>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Panel({ title, right, children, className = '', style }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <section className={`panel ${className}`} style={style}>
      {(title || right) && <div className="panel-head">{title && <h3>{title}</h3>}{right && <div className="right">{right}</div>}</div>}
      {children}
    </section>
  );
}

export function PageHead({ title, sub, actions, children }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {children}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

// ---------------- pagination ----------------
/** Row count + paging. The count is always the real number of rows we have; never estimated. */
export function usePager<T>(rows: T[], pageSize = 50, resetKey?: unknown) {
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [resetKey]);
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { rows: rows.slice(p * pageSize, (p + 1) * pageSize), page: p, pages, total, setPage, pageSize };
}
export function TableFoot({ pager, noun = 'rows', note }: { pager: ReturnType<typeof usePager<any>>; noun?: string; note?: ReactNode }) {
  const { total, page, pages, pageSize, setPage } = pager;
  const from = total ? page * pageSize + 1 : 0, to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="table-foot" role="status">
      <span>{total ? `${from}-${to} of ${total} ${noun}` : `0 ${noun}`}</span>
      {note && <span className="dim">{note}</span>}
      {pages > 1 && (
        <div className="pager">
          <button className="btn" disabled={page === 0} aria-label="Previous page" onClick={() => setPage(page - 1)}>Previous</button>
          <span>Page {page + 1} of {pages}</span>
          <button className="btn" disabled={page >= pages - 1} aria-label="Next page" onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

/** Scrollable table box: reachable with the keyboard and named for screen readers */
export function TableWrap({ label, children, style }: { label: string; children: ReactNode; style?: React.CSSProperties }) {
  return <div className="table-wrap" tabIndex={0} role="region" aria-label={`${label} table`} style={style}>{children}</div>;
}

// ---------------- toasts ----------------
type ToastItem = { id: number; msg: string; tone: 'ok' | 'err'; hide?: boolean };
let toastId = 0;
export function toast(msg: string, tone: 'ok' | 'err' = 'ok') {
  window.dispatchEvent(new CustomEvent('oo:toast', { detail: { id: ++toastId, msg, tone } }));
}
export function Toasts() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<ToastItem>).detail;
      setItems((x) => [...x, t]);
      setTimeout(() => setItems((x) => x.map((i) => (i.id === t.id ? { ...i, hide: true } : i))), 3500);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== t.id)), 4000);
    };
    window.addEventListener('oo:toast', on);
    return () => window.removeEventListener('oo:toast', on);
  }, []);
  return (
    <div id="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone} ${t.hide ? 'hide' : ''}`}>
          <span className="ic">{t.tone === 'ok' ? <Check size={16} /> : <AlertTriangle size={16} />}</span><span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

export async function copyText(text: string, done = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(done); } catch { toast('Copy failed: the browser blocked clipboard access', 'err'); }
}

// ---------------- modal ----------------
export interface ModalAction { label: string; primary?: boolean; danger?: boolean; disabled?: boolean; onClick?: () => unknown | Promise<unknown> }

/**
 * Accessible dialog: focus moves in, Tab stays inside, Escape closes, focus returns to the opener.
 * An action's onClick may be async; it closes the dialog when it resolves (return `false` to keep it open).
 * Errors become a red toast and keep the dialog open.
 */
export function Modal({ title, onClose, actions = [], wide, drawer, children }: { title: ReactNode; onClose: () => void; actions?: ModalAction[]; wide?: boolean; drawer?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const root = ref.current!;
    const focusables = () => [...root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !(el as HTMLButtonElement).disabled);
    setTimeout(() => (root.querySelector<HTMLElement>('input:not([type=checkbox]),select,textarea') || root.querySelector<HTMLElement>('.modal-foot .btn-primary, .modal-foot .btn-danger, .modal-foot .btn') || root.querySelector<HTMLElement>('.modal-head .icon-btn'))?.focus(), 20);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab') {
        const f = focusables(); if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, [onClose]);
  return (
    <div className={`modal-overlay ${drawer ? 'side-panel' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`modal ${wide ? 'wide' : ''} ${drawer ? 'side-panel' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {actions.length > 0 && (
          <div className="modal-foot">
            {actions.map((a) => (
              <button key={a.label} className={`btn ${a.primary ? 'btn-primary' : a.danger ? 'btn-danger' : ''}`} disabled={busy || a.disabled}
                onClick={async () => {
                  if (!a.onClick) return onClose();
                  setBusy(true);
                  try { const keep = await a.onClick(); if (keep !== false) onClose(); } catch (err) { toast((err as Error).message, 'err'); } finally { setBusy(false); }
                }}>{a.label}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- row menu (⋮): a few actions behind one button ----------------
export interface MenuItem { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; icon?: ReactNode }
export function RowMenu({ items, label = 'More actions' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="row-menu" ref={ref}>
      <button className="icon-btn" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}><MoreVertical size={16} /></button>
      {open && (
        <div className="row-menu-pop" role="menu">
          {items.map((i) => (
            <button key={i.label} role="menuitem" className={i.danger ? 'c-red' : ''} disabled={i.disabled} onClick={(e) => { e.stopPropagation(); setOpen(false); i.onClick(); }}>{i.icon}{i.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------- dialogs from anywhere: confirm() and open(node) ----------------
type DialogFn = (render: (close: () => void) => ReactNode) => void;
const DialogCtx = createContext<{ open: DialogFn; confirm: (title: string, text: ReactNode, ok?: string, danger?: boolean) => Promise<boolean> } | null>(null);
export function useDialogs() {
  const c = useContext(DialogCtx);
  if (!c) throw new Error('useDialogs outside DialogProvider');
  return c;
}
export function DialogProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<{ id: number; node: ReactNode }[]>([]);
  const nextId = useRef(0);
  const open = useCallback<DialogFn>((render) => {
    const id = ++nextId.current;
    const close = () => setStack((s) => s.filter((x) => x.id !== id));
    setStack((s) => [...s, { id, node: render(close) }]);
  }, []);
  const confirm = useCallback((title: string, text: ReactNode, ok = 'Confirm', danger = true) => new Promise<boolean>((resolve) => {
    open((close) => (
      <Modal title={title} onClose={() => { resolve(false); close(); }}
        actions={[{ label: 'Cancel', onClick: () => { resolve(false); } }, { label: ok, danger, primary: !danger, onClick: () => { resolve(true); } }]}>
        <p style={{ marginTop: 0 }}>{text}</p>
      </Modal>
    ));
  }), [open]);
  return (
    <DialogCtx.Provider value={{ open, confirm }}>
      {children}
      {stack.map((d) => <div key={d.id}>{d.node}</div>)}
    </DialogCtx.Provider>
  );
}
