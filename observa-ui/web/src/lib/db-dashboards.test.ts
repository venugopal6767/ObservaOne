import { describe, it, expect } from 'vitest';
import { DB_DASHBOARDS, dashboardFor, selector } from './db-dashboards';

describe('db-dashboards', () => {
  it('has panels for every supported engine', () => {
    for (const e of ['postgres', 'mysql', 'mssql', 'oracle', 'redis', 'kafka', 'mongodb', 'memcached']) {
      expect(dashboardFor(e).length).toBeGreaterThan(0);
    }
  });
  it('every panel query embeds the selector and is non-empty', () => {
    const sel = selector('core');
    for (const panels of Object.values(DB_DASHBOARDS)) {
      for (const p of panels) {
        const q = p.q(sel);
        expect(q).toContain('db_instance="core"');
        expect(q.length).toBeGreaterThan(5);
      }
    }
  });
  it('postgres has the key metrics', () => {
    const titles = DB_DASHBOARDS.postgres.map((p) => p.title);
    expect(titles).toContain('Cache hit ratio %');
    expect(titles).toContain('Replication lag (s)');
  });
  it('selector builds a db_instance matcher', () => {
    expect(selector('x')).toBe('db_instance="x"');
  });
});
