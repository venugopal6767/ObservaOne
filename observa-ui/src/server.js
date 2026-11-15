import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { bootstrapUsers, cleanupSessions, setExternalPasswordAuth } from './auth.js';
import { ldapEnabled, ldapPasswordAuth } from './ldap.js';
import { pool, waitForDb, migrate, importLegacyJson } from './db.js';
import { pruneAudit } from './store.js';
import { loadDatasourceSettings } from './datasources.js';
import { api } from './api.js';
import { verifyAgent, purgeOldTokens } from './routes/agents.js';
import { agentControlRouter, purgeNonces } from './routes/agent-control.js';
import { startAlertTracker } from './alerting.js';
import { applyConfig as applyNotificationConfig } from './notify.js';
import { agentSdRouter } from './routes/agent-sd.js';
import { initAgentPki } from './agentpki.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 'loopback, uniquelocal'); // Nginx in front

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
  );
  next();
});

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'ok' });
  } catch (e) {
    res.status(503).json({ ok: false, db: e.message });
  }
});
// Nginx asks this for every agent upload (auth_request). Nginx blocks /internal/ from outside.
app.all('/internal/agent-verify', verifyAgent);
// Agent enrollment + heartbeats: their own small body limit and credential checks, before the main API.
app.use('/api', agentControlRouter);
// Prometheus service discovery for agents (its own token; Nginx does not expose it, Prometheus calls the UI directly)
app.use('/api', agentSdRouter);
app.use('/api', api);

// The web UI: a React app built into web/dist (see web/README.md). Built files have a content hash in their
// name, so they can be cached for a long time; index.html is never cached so a new build shows up at once.
const webRoot = path.join(root, 'web/dist');
app.use('/assets', express.static(path.join(webRoot, 'assets'), { immutable: true, maxAge: '365d', fallthrough: false }));
app.use(express.static(webRoot, { index: false, maxAge: '1h' }));

// Single-page app: every other GET returns index.html
app.get(/^\/(?!api\/|assets\/|internal\/).*/, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(webRoot, 'index.html'), (err) => {
    if (err && !res.headersSent) res.status(503).type('text').send('The web UI is not built. Run: cd web && npm ci && npm run build');
  });
});

// ---- start: database first, then HTTP ----
await waitForDb();
await migrate();
await importLegacyJson();
await bootstrapUsers();
await loadDatasourceSettings();
if (ldapEnabled()) {
  setExternalPasswordAuth(ldapPasswordAuth);
  console.log(`[auth] LDAP sign-in enabled (${config.ldap.url})`);
}
setInterval(() => cleanupSessions().catch((e) => console.error('[db] session cleanup:', e.message)), 60_000).unref();
setInterval(() => pruneAudit().catch((e) => console.error('[db] audit prune:', e.message)), 6 * 3_600_000).unref();
pruneAudit().catch(() => {});
setInterval(() => purgeOldTokens().catch((e) => console.error('[db] token purge:', e.message)), 60_000).unref();
applyNotificationConfig({ force: true }); // channels from the UI -> Alertmanager's config (notify.js)
startAlertTracker(); // alert history: pending -> firing -> resolved (alerting.js)
setInterval(() => purgeNonces().catch((e) => console.error('[db] nonce purge:', e.message)), 60_000).unref();
// pull mode: agent CA + Prometheus client certificate + SD token (created on first start, renewed daily)
try { initAgentPki(); } catch (e) { console.error('[agent-pki] not available, pull mode will fail:', e.message); }
setInterval(() => { try { initAgentPki(); } catch (e) { console.error('[agent-pki]', e.message); } }, 86_400_000).unref();

const server = app.listen(config.port, () => console.log(`[observa] ${config.brand} UI listening on :${config.port}`));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
