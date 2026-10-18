// Global time range: quick presets, or a fixed custom window. Every panel on every page follows it.
// A fixed window also goes into the page address (?from=&to=), so a link shares the exact same view.
import { useEffect, useRef, useState } from 'react';
import { Clock, ChevronDown } from 'lucide-react';
import { RANGES, useApp, type TimeRange } from './AppContext';
import { tzLabel } from '@/lib/format';

const p2 = (n: number) => String(n).padStart(2, '0');
function toLocalInput(sec: number) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function fromLocalInput(v: string): number | null {
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}
export function rangeLabel(r: TimeRange): string {
  if (r.kind === 'relative') return RANGES.find(([s]) => s === r.seconds)?.[1] || `Last ${Math.round(r.seconds / 60)} minutes`;
  const f = new Date(r.from * 1000), t = new Date(r.to * 1000);
  const day = (d: Date) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const hm = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return day(f) === day(t) ? `${day(f)} ${hm(f)} – ${hm(t)}` : `${day(f)} ${hm(f)} – ${day(t)} ${hm(t)}`;
}

export function TimePicker() {
  const { range, setRange } = useApp();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [err, setErr] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const now = Math.floor(Date.now() / 1000);
    const r = range.kind === 'absolute' ? range : { from: now - range.seconds, to: now };
    setFrom(toLocalInput(r.from));
    setTo(toLocalInput(r.to));
    setErr('');
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open, range]);

  function apply() {
    const f = fromLocalInput(from), t = fromLocalInput(to);
    if (f === null || t === null) return setErr('Enter both times.');
    if (t <= f) return setErr('"To" must be after "From".');
    if (t - f > 31 * 86400) return setErr('The longest window is 31 days.');
    setRange({ kind: 'absolute', from: f, to: t });
    setOpen(false);
  }

  return (
    <div className="time-picker" ref={box}>
      <button className={`time-btn ${range.kind === 'absolute' ? 'fixed' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        title={range.kind === 'absolute' ? 'Fixed time window (does not move with the clock)' : 'Time range for every panel'}>
        <Clock size={15} aria-hidden /><span className="time-label">{rangeLabel(range)}</span><ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div className="time-pop" role="dialog" aria-label="Time range">
          <div className="time-presets">
            <div className="time-pop-title">Quick ranges</div>
            {RANGES.map(([s, l]) => (
              <button key={s} className={range.kind === 'relative' && range.seconds === s ? 'active' : ''} onClick={() => { setRange({ kind: 'relative', seconds: s }); setOpen(false); }}>{l}</button>
            ))}
          </div>
          <div className="time-custom">
            <div className="time-pop-title">Custom window <span className="dim">({tzLabel()})</span></div>
            <label className="field"><span className="field-label">From</span><input className="input" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="field"><span className="field-label">To</span><input className="input" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            {err && <div className="c-red" style={{ fontSize: 12, marginBottom: 8 }}>{err}</div>}
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={apply}>Apply window</button>
            <p className="dim" style={{ fontSize: 11.5, margin: '8px 0 0' }}>A fixed window stops auto-refresh and can be shared as a link.</p>
          </div>
        </div>
      )}
    </div>
  );
}
