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
import { verifyAgent } from './routes/agents.js';
import { agentControlRouter } from './routes/agent-control.js';

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
app.use('/api', api);

// Third-party files served from node_modules (no internet needed at runtime)
app.get('/vendor/chart.js', (req, res) => res.sendFile(path.join(root, 'node_modules/chart.js/dist/chart.umd.min.js')));
app.use('/vendor/inter', express.static(path.join(root, 'node_modules/@fontsource/inter'), { maxAge: '7d' }));

app.use(express.static(path.join(root, 'public'), { index: false, maxAge: '1h' }));

// Single-page app: every other GET returns index.html
app.get(/^\/(?!api\/|vendor\/).*/, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(root, 'public/index.html'));
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

const server = app.listen(config.port, () => console.log(`[observa] ${config.brand} UI listening on :${config.port}`));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
