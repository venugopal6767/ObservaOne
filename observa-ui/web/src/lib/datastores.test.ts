import { describe, it, expect } from 'vitest';
import { groupTargets, summarize, exploreQuery, engineLabel } from './datastores';

const vec = [
  { metric: { db_engine: 'postgres', db_instance: 'core' }, value: [0, '1'] as [number, string] },
  { metric: { db_engine: 'postgres', db_instance: 'billing' }, value: [0, '0'] as [number, string] },
  { metric: { db_engine: 'redis', db_instance: 'cache-1' }, value: [0, '1'] as [number, string] },
];

describe('datastores', () => {
  it('groups by engine, sorted, with up flags', () => {
    const g = groupTargets(vec);
    expect(g.map((x) => x.engine)).toEqual(['postgres', 'redis']);
    const pg = g[0];
    expect(pg.label).toBe('PostgreSQL');
    expect(pg.targets.map((t) => t.instance)).toEqual(['billing', 'core']);
    expect(pg.targets.find((t) => t.instance === 'core')!.up).toBe(true);
  });
  it('summarizes up/down', () => {
    expect(summarize(vec)).toEqual({ total: 3, up: 2, down: 1 });
  });
  it('builds an explore selector and labels engines', () => {
    expect(exploreQuery('redis', 'cache-1')).toBe('{db_engine="redis", db_instance="cache-1"}');
    expect(engineLabel('mssql')).toBe('SQL Server');
    expect(engineLabel('weird')).toBe('weird');
  });
});
