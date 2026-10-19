// Database migrations after the initial schema (see db.js).
// Append new entries at the end; never edit one that has shipped.

const OPERATOR_PERMS = [
  'view', 'dashboards.edit', 'alerts.silence', 'incidents.manage', 'oncall.manage', 'slo.manage',
  'synthetics.manage', 'catalog.manage', 'ai.use', 'security.read',
];

export const EXTRA_MIGRATIONS = [
  {
    id: 2,
    name: 'roles, teams, api keys, mfa, sso',
    sql: `
      CREATE TABLE roles (
        name        TEXT PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_-]{1,31}$'),
        description TEXT NOT NULL DEFAULT '',
        permissions JSONB NOT NULL DEFAULT '[]',
        builtin     BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO roles (name, description, permissions, builtin) VALUES
        ('viewer',   'Read-only: sees everything, changes nothing', '["view"]', TRUE),
        ('operator', 'Viewer + dashboards, silences, incidents, on-call, SLOs, uptime checks, AI assistant', '${JSON.stringify(OPERATOR_PERMS)}', TRUE),
        ('admin',    'Full control', '["*"]', TRUE);

      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      ALTER TABLE users ADD CONSTRAINT users_role_fk FOREIGN KEY (role) REFERENCES roles(name) ON UPDATE CASCADE;
      ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
      ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE users ADD COLUMN external_id TEXT;
      ALTER TABLE users ADD COLUMN email TEXT;
      ALTER TABLE users ADD COLUMN display_name TEXT;
      ALTER TABLE users ADD COLUMN phone TEXT;
      ALTER TABLE users ADD COLUMN mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN mfa_secret TEXT;
      ALTER TABLE users ADD COLUMN mfa_pending_secret TEXT;
      ALTER TABLE users ADD COLUMN mfa_last_step BIGINT;
      ALTER TABLE users ADD COLUMN mfa_recovery JSONB NOT NULL DEFAULT '[]';
      CREATE UNIQUE INDEX users_external ON users (auth_source, external_id) WHERE external_id IS NOT NULL;

      ALTER TABLE sessions ADD COLUMN restricted TEXT;
      ALTER TABLE sessions ADD COLUMN auth_method TEXT;

      CREATE TABLE login_challenges (
        token_hash  TEXT PRIMARY KEY,
        user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose     TEXT NOT NULL,
        remember    BOOLEAN NOT NULL DEFAULT FALSE,
        auth_method TEXT,
        attempts    INT NOT NULL DEFAULT 0,
        expires_at  TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE oauth_states (
        state         TEXT PRIMARY KEY,
        provider      TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        nonce         TEXT,
        binding       TEXT NOT NULL,
        return_to     TEXT,
        expires_at    TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE teams (
        id          BIGSERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX teams_name ON teams (lower(name));
      CREATE TABLE team_members (
        team_id BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (team_id, user_id)
      );

      CREATE TABLE api_keys (
        id            BIGSERIAL PRIMARY KEY,
        name          TEXT NOT NULL,
        prefix        TEXT NOT NULL,
        key_hash      TEXT NOT NULL UNIQUE,
        role          TEXT NOT NULL REFERENCES roles(name) ON UPDATE CASCADE,
        owner_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
        created_by    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used     TIMESTAMPTZ,
        expires_at    TIMESTAMPTZ,
        revoked       BOOLEAN NOT NULL DEFAULT FALSE
      );

      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by TEXT
      );

      ALTER TABLE dashboards ADD COLUMN team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL;
      ALTER TABLE dashboards ADD COLUMN visibility TEXT NOT NULL DEFAULT 'everyone';
    `,
  },
  {
    id: 3,
    name: 'agents: enrollment tokens and fleet',
    sql: `
      CREATE TABLE agent_tokens (
        id          BIGSERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        prefix      TEXT NOT NULL UNIQUE,
        token_hash  TEXT NOT NULL UNIQUE,
        env         TEXT NOT NULL DEFAULT '',
        created_by  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used   TIMESTAMPTZ,
        expires_at  TIMESTAMPTZ,
        revoked     BOOLEAN NOT NULL DEFAULT FALSE
      );

      CREATE TABLE agents (
        id          TEXT PRIMARY KEY,
        host        TEXT NOT NULL,
        platform    TEXT NOT NULL DEFAULT 'linux',
        os          TEXT NOT NULL DEFAULT '',
        arch        TEXT NOT NULL DEFAULT '',
        version     TEXT NOT NULL DEFAULT '',
        env         TEXT NOT NULL DEFAULT '',
        role        TEXT NOT NULL DEFAULT '',
        cluster     TEXT NOT NULL DEFAULT '',
        ip          TEXT NOT NULL DEFAULT '',
        token_id    BIGINT REFERENCES agent_tokens(id) ON DELETE SET NULL,
        first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
        blocked     BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE INDEX agents_host_idx ON agents (host);
    `,
  },
  {
    id: 4,
    name: 'remove demo mode: saved demo data sources become live',
    sql: `
      UPDATE datasource_settings SET mode = 'live', updated_at = now(), updated_by = 'migration-4' WHERE mode = 'demo';
    `,
  },
  {
    id: 5,
    name: 'agents: enrollment, per-agent credentials, heartbeats',
    // Additive only: existing agents and tokens keep working (they are "legacy" until re-installed).
    sql: `
      ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS max_uses INT;              -- NULL = unlimited
      ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS uses INT NOT NULL DEFAULT 0;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS credential_hash TEXT;            -- SHA-256 of the agent's own credential
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS machine_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS enrolled_at TIMESTAMPTZ;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMPTZ;      -- server time of receipt
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS heartbeats BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS boot_time TIMESTAMPTZ;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS kernel TEXT NOT NULL DEFAULT '';
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS labels JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS diag JSONB NOT NULL DEFAULT '{}'::jsonb;
      CREATE UNIQUE INDEX IF NOT EXISTS agents_credential_uq ON agents (credential_hash) WHERE credential_hash IS NOT NULL;
      -- two enrolled agents never share a display name (it is the "host" label on their metrics)
      CREATE UNIQUE INDEX IF NOT EXISTS agents_enrolled_host_uq ON agents (platform, lower(host)) WHERE credential_hash IS NOT NULL;
    `,
  },
  {
    id: 6,
    name: 'agent tokens: revoked_at, so revoked tokens can be removed automatically',
    sql: `
      ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
      UPDATE agent_tokens SET revoked_at = now() WHERE revoked AND revoked_at IS NULL;   -- already revoked: count from now
    `,
  },
  {
    id: 7,
    name: 'agents: pull mode, reported addresses, registration nonces',
    sql: `
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'push';          -- push | pull
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS pull JSONB NOT NULL DEFAULT '{}'::jsonb;    -- port, ips, dns, cert, last scrape (from heartbeats)
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS addresses JSONB NOT NULL DEFAULT '[]'::jsonb; -- the host's own addresses (heartbeat)
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS pull_cert_at TIMESTAMPTZ;                   -- last pull certificate issued
      CREATE TABLE IF NOT EXISTS agent_nonces (
        nonce   TEXT PRIMARY KEY,
        seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS agent_nonces_seen_idx ON agent_nonces (seen_at);
    `,
  },
];
