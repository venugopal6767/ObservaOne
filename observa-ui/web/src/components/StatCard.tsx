import type { ReactNode } from 'react';
import { Bell } from 'lucide-react';

export function StatCard({ label, value, unit, trend, trendGoodWhen = 'down', extra, tone, bell, onClick, title }: {
  label: string; value: ReactNode; unit?: string; trend?: number | null; trendGoodWhen?: 'up' | 'down';
  extra?: ReactNode; tone?: 'red' | 'green' | 'orange' | ''; bell?: boolean; onClick?: () => void; title?: string;
}) {
  let trendEl = null;
  if (trend !== null && trend !== undefined && Number.isFinite(trend)) {
    const up = trend >= 0;
    const good = trendGoodWhen === 'up' ? up : !up;
    const cls = Math.abs(trend) < 0.5 ? 'flat' : good ? 'up' : 'bad';
    trendEl = <span className={`trend ${cls}`} title="Change against one hour earlier">{up ? '↑' : '↓'} {Math.abs(trend).toFixed(1)}%</span>;
  }
  const body = (
    <>
      <div className="label">{label}</div>
      <div className="row">
        <span className={`value ${tone || ''}`}>{value}{unit && <small>{unit}</small>}</span>
        {trendEl}
        {bell && <span className="corner"><Bell size={20} aria-hidden /></span>}
      </div>
      {extra}
    </>
  );
  return onClick
    ? <button className="stat-card clickable" onClick={onClick} title={title}>{body}</button>
    : <div className="stat-card" title={title}>{body}</div>;
}

/** small grey line under a tile that explains a missing value */
export function Reason({ text }: { text: string }) {
  return <div className="stat-reason" title={text}>{text.length > 60 ? `${text.slice(0, 57)}...` : text}</div>;
}
