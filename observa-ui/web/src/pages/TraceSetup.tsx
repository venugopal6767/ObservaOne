import { useMemo, useState } from 'react';
import { Copy } from 'lucide-react';
import { copyText, Select, Tabs } from '@/components/ui';
import { OTLP_LANGS, otlpSnippet, type OtlpLang } from '@/lib/otlp';

// User-friendly "send traces" setup: shows the OTLP endpoint and generates
// copy-paste instrumentation config. Everything is editable (endpoint, service, sampling).
export function TraceSetup() {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://observaone.local';
  const [endpoint, setEndpoint] = useState(`${origin}/otlp/v1/traces`);
  const [service, setService] = useState('my-service');
  const [ratio, setRatio] = useState('1.0');
  const [lang, setLang] = useState<OtlpLang>('env');
  const snippet = useMemo(() => otlpSnippet(lang, { endpoint, service, ratio }), [lang, endpoint, service, ratio]);

  return (
    <div className="otlp-setup">
      <p className="muted">
        Point your app's OpenTelemetry exporter at ObservaOne and its traces appear in this explorer.
        Authenticate with your ingest credentials (<span className="mono">INGEST_USER</span> /
        <span className="mono"> INGEST_PASSWORD</span> from your <span className="mono">.env</span>).
      </p>
      <div className="otlp-fields">
        <label>OTLP endpoint
          <input className="input" value={endpoint} spellCheck={false} onChange={(e) => setEndpoint(e.target.value)} />
        </label>
        <label>Service name
          <input className="input" value={service} spellCheck={false} onChange={(e) => setService(e.target.value)} />
        </label>
        <label>Sampling
          <Select className="select" label="Sampling ratio" value={ratio} onChange={setRatio}
            options={[['1.0', '100% (all traces)'], ['0.25', '25%'], ['0.1', '10%'], ['0.01', '1%']]} />
        </label>
      </div>
      <Tabs items={OTLP_LANGS} active={lang} onChange={setLang} label="Instrumentation" />
      <div className="otlp-snippet-wrap">
        <button className="icon-btn otlp-copy" title="Copy snippet" aria-label="Copy snippet" onClick={() => copyText(snippet)}><Copy size={14} /></button>
        <pre className="otlp-snippet mono">{snippet}</pre>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        gRPC users: send to port 4317; the HTTPS endpoint above is OTLP/HTTP (recommended through the gateway).
      </p>
    </div>
  );
}
