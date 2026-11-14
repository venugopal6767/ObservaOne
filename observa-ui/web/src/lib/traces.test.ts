import { describe, it, expect } from 'vitest';
import { buildTraceQuery, distinctServices, activeTraceFilters } from './traces';

describe('buildTraceQuery', () => {
  it('returns the base unchanged when no filters', () => {
    expect(buildTraceQuery('service.name=api', {})).toBe('service.name=api');
  });
  it('appends namespace and env as tags', () => {
    expect(buildTraceQuery('', { namespace: 'prod' })).toBe('k8s.namespace.name=prod');
    expect(buildTraceQuery('service.name=api', { namespace: 'prod', env: 'uat' }))
      .toBe('service.name=api k8s.namespace.name=prod deployment.environment=uat');
  });
});

describe('distinctServices', () => {
  it('dedupes, drops empties, sorts', () => {
    expect(distinctServices([{ rootService: 'b' }, { rootService: 'a' }, { rootService: 'b' }, { rootService: null }]))
      .toEqual(['a', 'b']);
  });
});

describe('activeTraceFilters', () => {
  it('lists only set filters with their keys', () => {
    expect(activeTraceFilters({ namespace: 'prod', service: 'api' })).toEqual([['namespace', 'prod'], ['service', 'api']]);
    expect(activeTraceFilters({})).toEqual([]);
  });
});
