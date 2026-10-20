// All settings come from environment variables (set in docker-compose / .env).
import path from 'node:path';

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
// like env(), but an explicitly empty value stays empty (used for "no default role")
const envKeep = (k, d) => (process.env[k] !== undefined ? process.env[k].trim() : d);
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
function json(k, d) {
  const v = env(k, '');
  if (!v) return d;
  try {
    return JSON.parse(v);
  } catch {
    console.error(`[config] ${k} is not valid JSON - ignored`);
    return d;
  }
}

export const config = {
  port: Number(env('PORT', 8080)),
  brand: env('UI_BRAND', 'ObservaOne'),
  demoData: env('UI_DEMO_DATA', 'false') === 'true', // set by demo/docker-compose.demo.yml: shows a 'Demo data' chip (the data itself always comes from the real data sources)
  publicUrl: env('PUBLIC_URL', '').replace(/\/+$/, ''), // e.g. https://monitoring.example.local (SSO redirects, links in alerts)

  // ---- Single sign-on (each provider is on when its client id is set) ----
  oidc: {
    label: env('OIDC_LABEL', 'SSO'),
    issuer: env('OIDC_ISSUER_URL', ''),
    clientId: env('OIDC_CLIENT_ID', ''),
    clientSecret: env('OIDC_CLIENT_SECRET', ''),
    scopes: env('OIDC_SCOPES', 'openid profile email'),
    usernameClaim: env('OIDC_USERNAME_CLAIM', 'preferred_username'),
    groupsClaim: env('OIDC_GROUPS_CLAIM', 'groups'),
    roleMap: json('OIDC_ROLE_MAP', {}), // {"monitoring-admins":"admin","sre":"operator"} - first match wins
    defaultRole: envKeep('OIDC_DEFAULT_ROLE', 'viewer'), // empty = users without a mapped group are refused
    allowHttp: env('OIDC_ALLOW_HTTP', 'false') === 'true', // testing only
  },
  google: {
    clientId: env('GOOGLE_CLIENT_ID', ''),
    clientSecret: env('GOOGLE_CLIENT_SECRET', ''),
    allowedDomains: list(env('GOOGLE_ALLOWED_DOMAINS', '')),
    roleMap: json('GOOGLE_ROLE_MAP', {}), // {"boss@example.com":"admin","@example.com":"viewer"}
    defaultRole: envKeep('GOOGLE_DEFAULT_ROLE', 'viewer'),
  },
  github: {
    clientId: env('GITHUB_CLIENT_ID', ''),
    clientSecret: env('GITHUB_CLIENT_SECRET', ''),
    url: env('GITHUB_URL', 'https://github.com').replace(/\/+$/, ''),
    apiUrl: env('GITHUB_API_URL', 'https://api.github.com').replace(/\/+$/, ''),
    allowedOrgs: list(env('GITHUB_ALLOWED_ORGS', '')),
    roleMap: json('GITHUB_ROLE_MAP', {}), // {"my-org/sre":"admin","my-org":"viewer"}
    defaultRole: envKeep('GITHUB_DEFAULT_ROLE', 'viewer'),
  },
  ldap: {
    url: env('LDAP_URL', ''), // ldaps://dc1.example.local:636
    bindDn: env('LDAP_BIND_DN', ''),
    bindPassword: env('LDAP_BIND_PASSWORD', ''),
    baseDn: env('LDAP_BASE_DN', ''),
    userFilter: env('LDAP_USER_FILTER', '(|(sAMAccountName={{username}})(uid={{username}}))'),
    groupAttr: env('LDAP_GROUP_ATTR', 'memberOf'),
    roleMap: json('LDAP_ROLE_MAP', {}), // {"CN=Monitoring-Admins,OU=Groups,DC=example,DC=local":"admin"}
    defaultRole: envKeep('LDAP_DEFAULT_ROLE', ''), // empty = users without a mapped group are refused
    startTls: env('LDAP_START_TLS', 'false') === 'true',
    caFile: env('LDAP_CA_FILE', ''),
    insecure: env('LDAP_TLS_INSECURE', 'false') === 'true',
  },
  // ObservaOne Agent: the HTTPS certificate agents must trust (shown as a SHA-256 fingerprint in the install command)
  agent: {
    serverCertFile: env('AGENT_SERVER_CERT', '/certs/server.crt'),
    onlineSeconds: Number(env('AGENT_ONLINE_SECONDS', '150')),   // no heartbeat for longer = "Not reporting"
    offlineSeconds: Number(env('AGENT_OFFLINE_SECONDS', '900')), // no heartbeat for longer = "Offline"
    heartbeatSeconds: Number(env('AGENT_HEARTBEAT_SECONDS', '30')), // told to agents at enrollment / every heartbeat
    credentialDays: Number(env('AGENT_CREDENTIAL_DAYS', '90')),        // agents (1.3+) get a new credential after this many days; 0 = never
    minVersion: env('AGENT_MIN_VERSION', '1.0.0'),                // older agents are flagged "Needs attention"
    enrollPerIpPer10Min: Number(env('AGENT_ENROLL_RATE', '300')),          // all enrollments per address / 10 min
    enrollFailuresPer10Min: Number(env('AGENT_ENROLL_FAILURES', '10')),
    tokenPurgeMinutes: Number(env('AGENT_TOKEN_PURGE_MINUTES', '5')),     // revoked/expired tokens deleted after this; 0 = keep    // failed enrollments per address / 10 min
    remoteWriteUrl: env('PROMETHEUS_REMOTE_WRITE_URL', ''),   // default: <Prometheus data source>/api/v1/write
    pkiDir: env('AGENT_PKI_DIR', ''),                          // agent CA for pull mode (default <DATA_DIR>/agent-pki)
    prometheusDir: env('AGENT_PROMETHEUS_DIR', ''),            // copy of CA + Prometheus client cert + SD token for Prometheus (empty = off)
  },
  dataDir: path.resolve(env('DATA_DIR', './data')),
  configDir: path.resolve(env('CONFIG_DIR', './config')),
  // Notification channels: ObservaOne writes Alertmanager's config = the base file + the channels from the UI
  alertmanagerConfigFile: env('AM_CONFIG_FILE', ''),          // e.g. /etc/alertmanager-ui/alertmanager.yml (empty = read-only)
  notifyTimezone: env('NOTIFY_TIMEZONE', 'UTC'),                // times in Teams / email messages, e.g. Asia/Kolkata (Slack shows each reader's own)
  alertmanagerBaseConfig: env('AM_BASE_CONFIG', '/etc/alertmanager-base/alertmanager.yml'),
  rulesFile: env('UI_RULES_FILE', ''), // e.g. /etc/prometheus/rules/ui-rules.yml (empty = UI rule editing off)

  // PostgreSQL: DATABASE_URL, or the separate DB_* settings
  databaseUrl: env('DATABASE_URL', '') || `postgresql://${encodeURIComponent(env('DB_USER', 'observa'))}:${encodeURIComponent(env('DB_PASSWORD', ''))}@${env('DB_HOST', 'observa-db')}:${env('DB_PORT', '5432')}/${env('DB_NAME', 'observa')}`,
  dbPoolSize: Number(env('DB_POOL_SIZE', 10)),
  dbSsl: env('DB_SSL', ''), // '' = off, 'require' = TLS, 'verify' = TLS + verify certificate
  auditRetentionDays: Number(env('AUDIT_RETENTION_DAYS', 365)),

  // Session rules (defaults: 30 min idle, 8 h max)
  sessionIdleMinutes: Number(env('SESSION_IDLE_MINUTES', 30)),
  sessionMaxHours: Number(env('SESSION_MAX_HOURS', 8)),
  cookieSecure: env('COOKIE_SECURE', 'auto'), // auto | true | false

  // Login lockout
  maxFailedLogins: Number(env('MAX_FAILED_LOGINS', 5)),
  lockoutMinutes: Number(env('LOCKOUT_MINUTES', 15)),

  // First-start users (only used when no user database exists yet)
  bootstrapUsers: [
    { username: env('UI_ADMIN_USER', 'admin'), password: env('UI_ADMIN_PASSWORD', ''), role: 'admin' },
    { username: env('UI_OPERATOR_USER', 'operator'), password: env('UI_OPERATOR_PASSWORD', ''), role: 'operator' },
    { username: env('UI_VIEWER_USER', 'viewer'), password: env('UI_VIEWER_PASSWORD', ''), role: 'viewer' },
  ],

  // Data sources (can be changed later in the UI by an admin)
  datasources: {
    prometheus: { url: env('PROMETHEUS_URL', 'http://prometheus:9090/prometheus'), mode: 'live' },
    alertmanager: { url: env('ALERTMANAGER_URL', 'http://alertmanager:9093/alertmanager'), mode: 'live' },
    loki: { url: env('LOKI_URL', 'http://loki:3100'), mode: 'live' },
    tempo: { url: env('TEMPO_URL', 'http://tempo:3200'), mode: 'live' },
    services: { url: '(uses Prometheus)', mode: 'live' },
    grafana: { url: env('GRAFANA_URL', 'http://grafana:3000/grafana'), mode: 'live', publicUrl: env('GRAFANA_PUBLIC_URL', '/grafana/') },
  },
};
