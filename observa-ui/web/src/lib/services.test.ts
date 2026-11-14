import { describe, it, expect } from 'vitest';
import { sparkTone, trendPoints } from './services';

describe('sparkTone', () => {
  it('maps service status to a theme tone', () => {
    expect(sparkTone('down')).toBe('crit');
    expect(sparkTone('degraded')).toBe('warn');
    expect(sparkTone('healthy')).toBe('ok');
    expect(sparkTone('no_traffic')).toBe('unknown');
  });
});

describe('trendPoints', () => {
  const series = { api: [[1, '2'], [2, '3']] as [number, string][], solo: [[1, '2']] as [number, string][] };
  it('returns the series when it has 2+ points', () => {
    expect(trendPoints(series, 'api')).toHaveLength(2);
  });
  it('returns null for <2 points, a missing name, or undefined series', () => {
    expect(trendPoints(series, 'solo')).toBeNull();
    expect(trendPoints(series, 'nope')).toBeNull();
    expect(trendPoints(undefined, 'api')).toBeNull();
  });
});
