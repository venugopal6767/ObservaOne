// PostgreSQL connection, schema migrations and one-time import of the old JSON files.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config } from './config.js';
import { EXTRA_MIGRATIONS } from './migrations.js';

// Return BIGINT/COUNT as numbers (safe for our sizes)
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolSize,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: config.dbSsl ? { rejectUnauthorized: config.dbSsl === 'verify' } : undefined,
  application_name: 'observa-ui',
});
pool.on('error', (e) => console.error('[db] idle client error:', e.message));

export const q = (text, params) => pool.query(text, params);

export async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// ---------- schema ----------
// Append new migrations at the end; never edit one that has shipped.
const MIGRATIONS = [
  {
    id: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE users (
        id             BIGSERIAL PRIMARY KEY,
        username       TEXT NOT NULL,
        role           TEXT NOT NULL CHECK (role IN ('viewer','operator','admin')),
        password_hash  TEXT NOT NULL,
        disabled       BOOLEAN NOT NULL DEFAULT FALSE,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_login     TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX users_username_lower ON users (lower(username));

      -- Only a SHA-256 of the session token is stored: a database copy cannot be used to log in.
      CREATE TABLE sessions (
        token_hash  TEXT PRIMARY KEY,
        user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at  TIMESTAMPTZ NOT NULL,
        persistent  BOOLEAN NOT NULL DEFAULT FALSE,
        ip          TEXT,
        user_agent  TEXT
      );
      CREATE INDEX sessions_user ON sessions (user_id);
      CREATE INDEX sessions_expires ON sessions (expires_at);

      CREATE TABLE login_failures (
        key          TEXT PRIMARY KEY,           -- lower(username)|ip
        failures     INT NOT NULL DEFAULT 0,
        locked_until TIMESTAMPTZ,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE dashboards (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        owner       TEXT,
        tags        JSONB NOT NULL DEFAULT '["custom"]',
        variables   JSONB NOT NULL DEFAULT '[]',
        panels      JSONB NOT NULL DEFAULT '[]',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE datasource_settings (
        id          TEXT PRIMARY KEY,
        url         TEXT,
        mode        TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by  TEXT
      );

      CREATE TABLE user_preferences (
        user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key       TEXT NOT NULL,
        value     JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, key)
      );

      CREATE TABLE audit_log (
        id        BIGSERIAL PRIMARY KEY,
        time      TIMESTAMPTZ NOT NULL DEFAULT now(),
        username  TEXT,
        ip        TEXT,
        action    TEXT NOT NULL,
        details   JSONB NOT NULL DEFAULT '{}'
      );
      CREATE INDEX audit_time ON audit_log (time DESC);
      CREATE INDEX audit_user ON audit_log (username, time DESC);
      CREATE INDEX audit_action ON audit_log (action, time DESC);
    `,
  },
  ...EXTRA_MIGRATIONS,
];

export async function migrate() {
  // One instance migrates at a time (safe when several UI containers start together)
  await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(724100)');
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await c.query('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await c.query(m.sql);
      await c.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
      console.log(`[db] applied migration ${m.id}: ${m.name}`);
    }
  });
}

export async function waitForDb() {
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (e) {
      if (i >= 30) throw new Error(`Database not reachable after 30 tries: ${e.message}`);
      console.log(`[db] waiting for database (${e.code || e.message})...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ---------- one-time import from the old JSON files (version 1.0 of the UI) ----------
export async function importLegacyJson() {
  const dir = config.dataDir;
  const file = (n) => path.join(dir, n);
  const read = (n) => {
    try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return null; }
  };
  const users = read('users.json');
  const dashboards = read('dashboards.json');
  const datasources = read('datasources.json');
  const auditExists = fs.existsSync(file('audit.log'));
  if (!users && !dashboards && !datasources && !auditExists) return;

  const { rows } = await q('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return; // database already in use: never overwrite it

  await tx(async (c) => {
    for (const u of users || []) {
      await c.query(
        `INSERT INTO users (username, role, password_hash, disabled, created_at, last_login)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [u.username, u.role, u.hash, !!u.disabled, u.createdAt || new Date(), u.lastLogin || null]);
    }
    for (const d of dashboards || []) {
      await c.query(
        `INSERT INTO dashboards (id, title, description, owner, tags, variables, panels, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [d.id, d.title, d.description || '', d.owner || null, JSON.stringify(d.tags || ['custom']),
          JSON.stringify(d.variables || []), JSON.stringify(d.panels || []), d.createdAt || new Date()]);
    }
    for (const [id, v] of Object.entries(datasources || {})) {
      await c.query('INSERT INTO datasource_settings (id, url, mode) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [id, v.url || null, v.mode || null]);
    }
    if (auditExists) {
      const lines = fs.readFileSync(file('audit.log'), 'utf8').split('\n').filter(Boolean);
      for (const l of lines) {
        try {
          const { time, user, ip, action, ...details } = JSON.parse(l);
          await c.query('INSERT INTO audit_log (time, username, ip, action, details) VALUES ($1,$2,$3,$4,$5)', [time, user, ip, action, JSON.stringify(details)]);
        } catch { /* skip broken line */ }
      }
    }
  });
  // keep the old files, renamed, so nothing is lost
  for (const n of ['users.json', 'dashboards.json', 'datasources.json', 'audit.log']) {
    if (fs.existsSync(file(n))) fs.renameSync(file(n), file(`${n}.imported`));
  }
  console.log(`[db] imported old JSON data: ${users?.length || 0} users, ${dashboards?.length || 0} dashboards`);
}
