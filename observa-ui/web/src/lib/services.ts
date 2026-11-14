// Pure helpers for the Services page (kept out of the component so they're unit-testable).
export type SvcStatus = 'healthy' | 'degraded' | 'down' | 'no_traffic';

/** Theme status-kind used to colour a service's trend sparkline. */
export function sparkTone(status: SvcStatus): 'ok' | 'warn' | 'crit' | 'unknown' {
  return status === 'down' ? 'crit' : status === 'degraded' ? 'warn' : status === 'no_traffic' ? 'unknown' : 'ok';
}

/** The series for a service, or null when there isn't enough to draw a line (<2 points). */
export function trendPoints(
  series: Record<string, [number, string][]> | undefined,
  name: string,
): [number, string][] | null {
  const v = series?.[name];
  return v && v.length > 1 ? v : null;
}

export type TrendMetric = 'rps' | 'p95' | 'errorRate';
export const TREND_METRICS: [TrendMetric, string][] = [['rps', 'req/s'], ['p95', 'P95'], ['errorRate', 'Error %']];

/** Short label for a trend metric (falls back to req/s). */
export function trendLabel(m: TrendMetric): string {
  return (TREND_METRICS.find(([v]) => v === m) ?? ['rps', 'req/s'])[1];
}
