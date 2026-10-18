// Chart.js wrapped for React. Only the parts we use are registered (smaller bundle).
// Every chart reads its colours from the theme when drawn, and is rebuilt when the theme or data change.
import { useEffect, useRef, useState } from 'react';
import {
  Chart, LineController, BarController, DoughnutController, LineElement, PointElement, BarElement, ArcElement,
  LinearScale, CategoryScale, Filler, Tooltip, Legend, type ChartConfiguration, type ChartOptions,
} from 'chart.js';
import { color, palette, hexA, statusColor } from '@/lib/theme';
import { fmt, timeHM, dateTimeZ, type Unit } from '@/lib/format';
import { useTheme } from '@/app/AppContext';
import { InvestigatePanel, type InvestigateCtx } from './Investigate';
import type { Filters } from '@/lib/catalog';

Chart.register(LineController, BarController, DoughnutController, LineElement, PointElement, BarElement, ArcElement,
  LinearScale, CategoryScale, Filler, Tooltip, Legend);

export type Series = { label: string; points: [number, string | number | null][]; color?: string; dashed?: boolean };

function baseOptions(unit: Unit | string, { stacked = false, min, max, showLegend = false }: { stacked?: boolean; min?: number; max?: number; showLegend?: boolean } = {}): ChartOptions<any> {
  const GRID = color('chart-grid'), TICK = color('chart-tick');
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: showLegend, position: 'bottom', labels: { color: color('chart-legend'), boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle', font: { size: 11 } } },
      tooltip: {
        backgroundColor: color('tooltip-bg'), borderColor: color('tooltip-border'), borderWidth: 1,
        titleColor: color('tooltip-title'), bodyColor: color('tooltip-body'), padding: 10,
        callbacks: {
          title: (items: any[]) => (items[0] && typeof items[0].parsed.x === 'number' && items[0].parsed.x > 1e11 ? dateTimeZ(items[0].parsed.x) : items[0]?.label),
          label: (c: any) => ` ${c.dataset.label}: ${fmt(c.parsed.y ?? c.parsed, unit)}`,
        },
      },
    },
    scales: {
      x: { grid: { color: GRID }, ticks: { color: TICK, maxTicksLimit: 7, font: { size: 10 } }, border: { display: false } },
      y: {
        stacked, min: min ?? (unit === 'percent' ? 0 : undefined), max, beginAtZero: true, grid: { color: GRID },
        ticks: { color: TICK, maxTicksLimit: 5, font: { size: 10 }, callback: (v: any) => fmt(v, unit, 0) }, border: { display: false },
      },
    },
  };
}

/** Low-level: draws whatever config `build` returns; rebuilds when deps or the theme change. */
export function ChartCanvas({ build, deps, className = 'chart-box', style, label, onReady }: {
  build: () => ChartConfiguration<any>; deps: unknown[]; className?: string; style?: React.CSSProperties; label?: string;
  onReady?: (c: Chart) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { theme } = useTheme();
  useEffect(() => {
    if (!ref.current) return;
    const chart = new Chart(ref.current, build());
    onReady?.(chart);
    return () => chart.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, ...deps]);
  return (
    <div className={className} style={style}>
      <canvas ref={ref} role="img" aria-label={label || 'Chart'} />
    </div>
  );
}

/**
 * Time series. With `correlate`, clicking the chart opens a menu to jump to logs / traces around that
 * moment (the metric -> logs -> traces path). The menu only offers modules this user may open.
 */
export function TimeChart({ series, unit = 'none', area = false, stacked = false, legend = false, min, max, className, style, correlate, correlateHint, query, metric, filters }: {
  series: Series[]; unit?: Unit | string; area?: boolean; stacked?: boolean; legend?: boolean; min?: number; max?: number;
  className?: string; style?: React.CSSProperties; correlate?: boolean;
  /** extra context for the jump, e.g. { service: 'checkout' } so logs/traces are pre-filtered */
  correlateHint?: { service?: string; host?: string };
  /** shown in the Investigate panel and used for "create alert" */
  query?: string; metric?: string; filters?: Filters;
}) {
  const [inv, setInv] = useState<InvestigateCtx | null>(null);
  const key = JSON.stringify(series.map((s) => [s.label, s.points.length, s.points[s.points.length - 1]]));
  return (
    <div style={{ position: 'relative' }}>
      <ChartCanvas
        className={className}
        style={{ ...style, cursor: correlate ? 'crosshair' : undefined }}
        label={`Time series chart: ${series.map((s) => s.label).slice(0, 5).join(', ')}`}
        deps={[key, unit, area, stacked, legend, min, max, !!correlate, query]}
        build={() => {
          const pal = palette();
          const datasets = series.map((s, i) => {
            const c = s.color || pal[i % pal.length];
            return {
              label: s.label,
              data: s.points.map(([t, v]) => ({ x: t * 1000, y: v === null ? null : Number(v) })),
              borderColor: c,
              backgroundColor: area ? hexA(c, stacked ? 0.55 : 0.18) : c,
              fill: area ? (stacked ? (i === 0 ? 'origin' : '-1') : 'origin') : false,
              borderWidth: s.dashed ? 1.3 : 1.6, borderDash: s.dashed ? [5, 4] : undefined, pointRadius: 0, tension: 0.3, spanGaps: true,
            };
          });
          const opts: any = baseOptions(unit, { stacked, min, max, showLegend: legend });
          opts.scales.x.type = 'linear';
          opts.scales.x.ticks.callback = (v: number) => timeHM(v);
          const xs = datasets.flatMap((d) => d.data.map((p) => p.x));
          if (xs.length) { opts.scales.x.min = Math.min(...xs); opts.scales.x.max = Math.max(...xs); }
          if (correlate) {
            opts.onClick = (evt: any, _els: unknown, chart: Chart) => {
              const t = chart.scales.x.getValueForPixel(evt.x);
              if (typeof t !== 'number' || !Number.isFinite(t)) return;
              // each series' value at the nearest point to the click, biggest first
              const values = datasets.map((d) => {
                let best: { x: number; y: number | null } | null = null;
                for (const p of d.data) if (!best || Math.abs(p.x - t) < Math.abs(best.x - t)) best = p;
                return { label: d.label, color: d.borderColor as string, value: best?.y ?? null };
              }).filter((v) => !/^Threshold/.test(v.label)).sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
              setInv({ t, values, unit: String(unit), query, metric, filters, hint: correlateHint });
            };
          }
          return { type: 'line', data: { datasets }, options: opts };
        }}
      />
      {inv && <InvestigatePanel ctx={inv} onClose={() => setInv(null)} />}
    </div>
  );
}

export function BarChart({ labels, values, unit = 'none', colors, horizontal = false, max, className, style }: {
  labels: string[]; values: number[]; unit?: Unit | string; colors?: string[]; horizontal?: boolean; max?: number; className?: string; style?: React.CSSProperties;
}) {
  return (
    <ChartCanvas
      className={className}
      style={style}
      label={`Bar chart: ${labels.slice(0, 6).join(', ')}`}
      deps={[JSON.stringify(labels), JSON.stringify(values), unit, JSON.stringify(colors), horizontal, max]}
      build={() => {
        const opts: any = baseOptions(unit, { max });
        if (horizontal) {
          opts.indexAxis = 'y';
          [opts.scales.x, opts.scales.y] = [opts.scales.y, opts.scales.x];
          opts.scales.x.ticks.callback = (v: number) => fmt(v, unit, 0);
          opts.scales.y.ticks.callback = function (this: any, v: number) { return this.getLabelForValue(v); };
        }
        return {
          type: 'bar',
          data: { labels, datasets: [{ label: 'value', data: values, backgroundColor: colors || labels.map(() => color('chart-1')), borderRadius: 3, maxBarThickness: 34 }] },
          options: opts,
        };
      }}
    />
  );
}

export function Doughnut({ labels, values, colors }: { labels: string[]; values: number[]; colors: string[] }) {
  return (
    <ChartCanvas
      className=""
      style={{ position: 'absolute', inset: 0 }}
      label={labels.map((l, i) => `${l}: ${values[i]}`).join(', ')}
      deps={[JSON.stringify(values), JSON.stringify(colors)]}
      build={() => ({
        type: 'doughnut',
        data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 0, spacing: 2 }] },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '72%', animation: false,
          plugins: { legend: { display: false }, tooltip: { backgroundColor: color('tooltip-bg'), titleColor: color('tooltip-title'), bodyColor: color('tooltip-body'), borderColor: color('tooltip-border'), borderWidth: 1 } },
        },
      })}
    />
  );
}

export function Sparkline({ points, lineColor }: { points: [number, string][]; lineColor?: string }) {
  return (
    <ChartCanvas
      className=""
      style={{ position: 'absolute', inset: 0 }}
      label="Preview"
      deps={[points.length, points[points.length - 1]?.[1], lineColor]}
      build={() => {
        const c = lineColor || color('chart-1');
        return {
          type: 'line',
          data: { labels: points.map((p) => p[0]), datasets: [{ data: points.map((p) => Number(p[1])), borderColor: c, backgroundColor: hexA(c, 0.25), fill: true, pointRadius: 0, borderWidth: 1.4, tension: 0.35 }] },
          options: { responsive: true, maintainAspectRatio: false, animation: false, events: [], plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false, beginAtZero: true } } },
        };
      }}
    />
  );
}

export function LegendRow({ labels }: { labels: string[] }) {
  useTheme(); // re-render with the new colours when the theme changes
  const pal = palette();
  return (
    <div className="legend-row">
      {labels.map((l, i) => <span key={`${l}-${i}`} className="legend-item"><i style={{ background: pal[i % pal.length] }} />{l}</span>)}
    </div>
  );
}

export const healthColors = () => (['ok', 'warn', 'crit', 'unknown'] as const).map(statusColor);
