// Generates copy-paste OpenTelemetry instrumentation config so apps can send traces to ObservaOne.
// Pure + unit-tested. Credentials are never embedded — placeholders only.
export type OtlpLang = 'env' | 'otelcol' | 'node' | 'go' | 'curl';

export const OTLP_LANGS: [OtlpLang, string][] = [
  ['env', 'Env vars (Java / MuleSoft / Python)'],
  ['otelcol', 'OTel Collector'],
  ['node', 'Node.js'],
  ['go', 'Go'],
  ['curl', 'Test (curl)'],
];

export interface OtlpOpts { endpoint: string; service: string; ratio: string }

const AUTH = 'Basic <base64 of INGEST_USER:INGEST_PASSWORD>';
const base = (endpoint: string) => endpoint.replace(/\/v1\/traces\/?$/, '');

export function otlpSnippet(lang: OtlpLang, o: OtlpOpts): string {
  const { endpoint, service, ratio } = o;
  switch (lang) {
    case 'env':
      return [
        '# OpenTelemetry env vars — Java/MuleSoft and Python auto-instrumentation read these.',
        `export OTEL_SERVICE_NAME="${service}"`,
        'export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"',
        `export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="${endpoint}"`,
        `export OTEL_EXPORTER_OTLP_HEADERS="Authorization=${AUTH}"`,
        'export OTEL_TRACES_SAMPLER="parentbased_traceidratio"',
        `export OTEL_TRACES_SAMPLER_ARG="${ratio}"`,
      ].join('\n');
    case 'otelcol':
      return [
        '# otel-collector config.yaml — forward traces to ObservaOne',
        'receivers:',
        '  otlp:',
        '    protocols:',
        '      http: {}',
        '      grpc: {}',
        'exporters:',
        '  otlphttp/observaone:',
        `    traces_endpoint: ${endpoint}`,
        '    headers:',
        `      Authorization: ${AUTH}`,
        'service:',
        '  pipelines:',
        '    traces:',
        '      receivers: [otlp]',
        '      exporters: [otlphttp/observaone]',
      ].join('\n');
    case 'node':
      return [
        '// npm i @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http \\',
        '//       @opentelemetry/auto-instrumentations-node',
        "import { NodeSDK } from '@opentelemetry/sdk-node';",
        "import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';",
        "import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';",
        '',
        'const sdk = new NodeSDK({',
        `  serviceName: '${service}',`,
        '  traceExporter: new OTLPTraceExporter({',
        `    url: '${endpoint}',`,
        `    headers: { Authorization: '${AUTH}' },`,
        '  }),',
        '  instrumentations: [getNodeAutoInstrumentations()],',
        '});',
        'sdk.start();',
        `// sampling: set OTEL_TRACES_SAMPLER_ARG=${ratio} (parentbased_traceidratio)`,
      ].join('\n');
    case 'go':
      return [
        '// go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp',
        'exp, err := otlptracehttp.New(ctx,',
        `  otlptracehttp.WithEndpointURL("${endpoint}"),`,
        `  otlptracehttp.WithHeaders(map[string]string{"Authorization": "${AUTH}"}),`,
        ')',
        `// then: trace.NewTracerProvider(trace.WithBatcher(exp),`,
        `//   trace.WithSampler(trace.TraceIDRatioBased(${ratio})),`,
        `//   trace.WithResource(resource with service.name="${service}"))`,
      ].join('\n');
    case 'curl':
      return [
        '# Connectivity + auth check (expect HTTP 200/400 — a 401 means wrong credentials):',
        "curl -i -u 'INGEST_USER:INGEST_PASSWORD' \\",
        "  -H 'Content-Type: application/json' \\",
        `  -X POST '${endpoint}' \\`,
        `  --data '{"resourceSpans":[]}'`,
        `# service '${service}', sampling ${ratio} apply once your app's SDK is configured above.`,
      ].join('\n');
  }
}
export { base as otlpBase };
