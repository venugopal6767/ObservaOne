// Data-store (database + cache/queue) helpers for the Databases page.
// Targets are reported by the agent as observaone_db_up{db_engine,db_instance}.
import type { PromVector } from '@/lib/api';

export const DATASTORE_ENGINES: Record<string, string> = {
  postgres: 'PostgreSQL', mysql: 'MySQL', mssql: 'SQL Server', oracle: 'Oracle',
  redis: 'Redis', kafka: 'Kafka', mongodb: 'MongoDB', memcached: 'Memcached',
};

export function engineLabel(engine: string): string {
  return DATASTORE_ENGINES[engine] ?? engine;
}

export interface DsTarget { engine: string; instance: string; up: boolean }
export interface DsGroup { engine: string; label: string; targets: DsTarget[] }

/** Group an observaone_db_up vector into engines -> instances (sorted). */
export function groupTargets(v: PromVector): DsGroup[] {
  const byEngine = new Map<string, DsTarget[]>();
  for (const s of v) {
    const engine = s.metric.db_engine || 'unknown';
    const instance = s.metric.db_instance || '(unnamed)';
    const up = Number(s.value[1]) === 1;
    if (!byEngine.has(engine)) byEngine.set(engine, []);
    byEngine.get(engine)!.push({ engine, instance, up });
  }
  return [...byEngine.entries()]
    .map(([engine, targets]) => ({ engine, label: engineLabel(engine), targets: targets.sort((a, b) => a.instance.localeCompare(b.instance)) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Totals across all targets. */
export function summarize(v: PromVector): { total: number; up: number; down: number } {
  let up = 0;
  for (const s of v) if (Number(s.value[1]) === 1) up++;
  return { total: v.length, up, down: v.length - up };
}

/** PromQL selector that matches every metric of one target (for the metrics explorer). */
export function exploreQuery(engine: string, instance: string): string {
  return `{db_engine="${engine}", db_instance="${instance}"}`;
}
