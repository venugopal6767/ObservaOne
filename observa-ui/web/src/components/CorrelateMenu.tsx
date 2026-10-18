// Click a point on a time chart -> jump to the logs or traces of that moment (±5 minutes), or zoom the
// whole app to it. This is the metric -> logs -> traces path; every jump stays inside ObservaOne.
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Waypoints, ZoomIn } from 'lucide-react';
import { useApp, windowQuery } from '@/app/AppContext';
import { timeHM, escapeLabel } from '@/lib/format';

export function CorrelateMenu({ at, hint, onClose }: { at: { x: number; y: number; t: number }; hint?: { service?: string; host?: string }; onClose: () => void }) {
  const { canOpen, setRange } = useApp();
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const sec = at.t / 1000;
  const win = windowQuery(sec, 300);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => document.addEventListener('mousedown', away), 0);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);

  const logsQ = hint?.service ? `{service_name="${escapeLabel(hint.service)}"}` : hint?.host ? `{host="${escapeLabel(hint.host)}"}` : '{service_name=~".+"}';
  const tracesQ = hint?.service ? `service.name=${hint.service}` : '';
  const go = (path: string) => { onClose(); navigate(path); };

  return (
    <div ref={ref} className="correlate-menu" role="menu" style={{ left: Math.max(0, at.x - 10), top: at.y + 8 }}>
      <div className="correlate-head">Around {timeHM(at.t)} (±5 min)</div>
      {canOpen('/logs') && <button role="menuitem" onClick={() => go(`/logs?q=${encodeURIComponent(logsQ)}&${win}`)}><FileText size={14} />View logs</button>}
      {canOpen('/traces') && <button role="menuitem" onClick={() => go(`/traces?q=${encodeURIComponent(tracesQ)}&${win}`)}><Waypoints size={14} />View traces</button>}
      <button role="menuitem" onClick={() => { onClose(); setRange({ kind: 'absolute', from: Math.floor(sec - 300), to: Math.ceil(sec + 300) }); }}><ZoomIn size={14} />Zoom to this window</button>
    </div>
  );
}
