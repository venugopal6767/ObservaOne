import { describe, it, expect } from 'vitest';
import { OTLP_LANGS, otlpSnippet, otlpBase, type OtlpLang } from './otlp';

const opts = { endpoint: 'https://obs.local/otlp/v1/traces', service: 'checkout', ratio: '0.25' };

describe('otlpSnippet', () => {
  it('embeds the endpoint for every language', () => {
    for (const [lang] of OTLP_LANGS) {
      expect(otlpSnippet(lang as OtlpLang, opts)).toContain(opts.endpoint);
    }
  });
  it('env snippet includes service, sampler ratio and an auth placeholder (no real secret)', () => {
    const s = otlpSnippet('env', opts);
    expect(s).toContain('OTEL_SERVICE_NAME="checkout"');
    expect(s).toContain('0.25');
    expect(s).toContain('<base64 of INGEST_USER:INGEST_PASSWORD>');
    expect(s).not.toMatch(/password\s*[:=]\s*\S+/i);
  });
  it('node snippet names the service', () => {
    expect(otlpSnippet('node', opts)).toContain("serviceName: 'checkout'");
  });
});

describe('otlpBase', () => {
  it('strips the /v1/traces suffix', () => {
    expect(otlpBase('https://obs.local/otlp/v1/traces')).toBe('https://obs.local/otlp');
    expect(otlpBase('https://obs.local/otlp')).toBe('https://obs.local/otlp');
  });
});
