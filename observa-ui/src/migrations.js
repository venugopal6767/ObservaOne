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
    name: 'incidents',
    sql: `
      CREATE TABLE incidents (
        id              BIGSERIAL PRIMARY KEY,
        fingerprint     TEXT,
        title           TEXT NOT NULL,
        severity        TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('critical', 'warning', 'info')),
        status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'investigating', 'resolved')),
        service         TEXT NOT NULL DEFAULT '',
        host            TEXT NOT NULL DEFAULT '',
        environment     TEXT NOT NULL DEFAULT '',
        summary         TEXT NOT NULL DEFAULT '',
        source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('alert', 'manual', 'demo')),
        alert_name      TEXT NOT NULL DEFAULT '',
        labels          JSONB NOT NULL DEFAULT '{}',
        assigned_to     TEXT,
        created_by      TEXT,
        started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        acknowledged_at TIMESTAMPTZ,
        resolved_at     TIMESTAMPTZ,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- only one open incident per alert group
      CREATE UNIQUE INDEX incidents_open_fp ON incidents (fingerprint) WHERE status <> 'resolved' AND fingerprint IS NOT NULL;
      CREATE INDEX incidents_started_idx ON incidents (started_at DESC);

      CREATE TABLE incident_events (
        id          BIGSERIAL PRIMARY KEY,
        incident_id BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        actor       TEXT,
        kind        TEXT NOT NULL,
        text        TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX incident_events_inc_idx ON incident_events (incident_id, at);
    `,
  },
  {
    id: 5,
    name: 'user dashboards',
    sql: `
      -- new dashboards are private to their owner until shared
      ALTER TABLE dashboards ALTER COLUMN visibility SET DEFAULT 'private';
      ALTER TABLE dashboards ADD CONSTRAINT dashboards_visibility_chk CHECK (visibility IN ('private', 'team', 'everyone'));
      ALTER TABLE dashboards ADD COLUMN copied_from TEXT;
      CREATE INDEX dashboards_owner_idx ON dashboards (lower(owner));

      -- starred dashboards per user (system ids are not in the dashboards table, so no FK)
      CREATE TABLE dashboard_favorites (
        user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        dashboard_id TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, dashboard_id)
      );
    `,
  },
  {
    id: 6,
    name: 'unique user e-mail',
    sql: `
      UPDATE users SET email = lower(trim(email)) WHERE email IS NOT NULL;
      UPDATE users SET email = NULL WHERE email = '';
      -- one account per e-mail address (skipped if old data already has duplicates; the app still checks)
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT lower(email) FROM users WHERE email IS NOT NULL GROUP BY lower(email) HAVING count(*) > 1) THEN
          CREATE UNIQUE INDEX users_email_unique ON users (lower(email)) WHERE email IS NOT NULL;
        END IF;
      END $$;
    `,
  },
  {
    id: 7,
    name: 'dashboards per role',
    sql: `
      ALTER TABLE roles ADD COLUMN dashboards JSONB;
      ALTER TABLE roles ADD COLUMN landing TEXT;
      UPDATE roles SET dashboards = '["business","devops","developer","sre","security","appowner","itadmin","kubernetes"]', landing = 'itadmin' WHERE name = 'admin';
      UPDATE roles SET dashboards = '["business","devops","developer","sre","security","appowner","kubernetes"]', landing = 'devops' WHERE name = 'operator';
      UPDATE roles SET dashboards = '["business","developer","appowner"]', landing = 'business' WHERE name = 'viewer';
      -- custom roles: start from what their permissions allow
      UPDATE roles r SET dashboards = (
        SELECT jsonb_agg(id) FROM (VALUES
          ('business', TRUE), ('devops', r.permissions ? '*' OR r.permissions ? 'dashboards.edit'), ('developer', TRUE),
          ('sre', r.permissions ? '*' OR r.permissions ? 'incidents.manage'), ('security', r.permissions ? '*' OR r.permissions ? 'security.read'),
          ('appowner', TRUE), ('itadmin', r.permissions ? '*' OR r.permissions ? 'settings.manage'), ('kubernetes', TRUE)
        ) AS v(id, ok) WHERE ok)
      WHERE r.dashboards IS NULL;
    `,
  },
];
