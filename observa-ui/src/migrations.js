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
  {
    id: 8,
    name: 'agents: targets, layered settings, actions, diagnostics bundles, past names',
    sql: `
      CREATE SEQUENCE IF NOT EXISTS agent_config_seq;
      CREATE TABLE IF NOT EXISTS targets (
        id          TEXT PRIMARY KEY,                       -- tgt_...
        kind        TEXT NOT NULL DEFAULT 'linux',
        name        TEXT NOT NULL,
        env         TEXT NOT NULL DEFAULT '',
        role        TEXT NOT NULL DEFAULT '',
        labels      JSONB NOT NULL DEFAULT '{}'::jsonb,
        mode        TEXT NOT NULL DEFAULT 'push',
        token_id    BIGINT REFERENCES agent_tokens(id) ON DELETE SET NULL,
        created_by  TEXT NOT NULL DEFAULT '',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS target_id TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS target_id TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS config_applied BIGINT NOT NULL DEFAULT 0;   -- settings version the agent confirmed
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS config_error TEXT NOT NULL DEFAULT '';       -- why the agent refused the latest one
      CREATE INDEX IF NOT EXISTS agents_target_idx ON agents (target_id);
      -- settings layers: env -> target -> agent (later wins; host files on the agent win over all of them)
      CREATE TABLE IF NOT EXISTS agent_configuration (
        scope       TEXT NOT NULL,                          -- env | target | agent
        scope_id    TEXT NOT NULL,
        settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
        version     BIGINT NOT NULL,
        updated_by  TEXT NOT NULL DEFAULT '',
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (scope, scope_id)
      );
      -- fixed action list (never a command string)
      CREATE TABLE IF NOT EXISTS agent_actions (
        id            BIGSERIAL PRIMARY KEY,
        agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        action        TEXT NOT NULL CHECK (action IN ('diagnostics', 'restart', 'upgrade')),
        args          JSONB NOT NULL DEFAULT '{}'::jsonb,
        state         TEXT NOT NULL DEFAULT 'pending',      -- pending | sent | done | failed | expired
        requested_by  TEXT NOT NULL DEFAULT '',
        requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        sent_at       TIMESTAMPTZ,
        done_at       TIMESTAMPTZ,
        result        JSONB
      );
      CREATE INDEX IF NOT EXISTS agent_actions_agent_idx ON agent_actions (agent_id, state);
      CREATE TABLE IF NOT EXISTS agent_diagnostics (
        id          BIGSERIAL PRIMARY KEY,
        agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        action_id   BIGINT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        size        INT NOT NULL DEFAULT 0,
        bundle      JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_diagnostics_agent_idx ON agent_diagnostics (agent_id, created_at DESC);
      -- old names and addresses (search, history)
      CREATE TABLE IF NOT EXISTS agent_aliases (
        agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL,                          -- host | ip
        value       TEXT NOT NULL,
        seen_from   TIMESTAMPTZ,
        seen_to     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS agent_aliases_agent_idx ON agent_aliases (agent_id);
    `,
  },
  {
    id: 9,
    name: 'agents: credential rotation, tenants, site gateways',
    sql: `
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS credential_prev_hash TEXT;              -- still accepted until credential_prev_until
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS credential_prev_until TIMESTAMPTZ;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS credential_issued_at TIMESTAMPTZ;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS rotate_requested BOOLEAN NOT NULL DEFAULT FALSE;
      UPDATE agents SET credential_issued_at = COALESCE(enrolled_at, first_seen) WHERE credential_hash IS NOT NULL AND credential_issued_at IS NULL;
      CREATE TABLE IF NOT EXISTS tenants (
        id          TEXT PRIMARY KEY,                       -- t_...
        name        TEXT NOT NULL,
        created_by  TEXT NOT NULL DEFAULT '',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO tenants (id, name, created_by) VALUES ('t_default', 'Default', 'migration-9') ON CONFLICT DO NOTHING;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 't_default' REFERENCES tenants(id);
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 't_default' REFERENCES tenants(id);
      ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 't_default' REFERENCES tenants(id);
      ALTER TABLE targets ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 't_default' REFERENCES tenants(id);
      CREATE INDEX IF NOT EXISTS agents_tenant_idx ON agents (tenant_id, last_seen);
      -- site gateways: an ObservaOne Gateway in a site that cannot reach this server directly relays its agents
      CREATE TABLE IF NOT EXISTS gateways (
        id          TEXT PRIMARY KEY,                       -- gw_...
        name        TEXT NOT NULL,
        token_hash  TEXT NOT NULL UNIQUE,
        tenant_id   TEXT NOT NULL DEFAULT 't_default' REFERENCES tenants(id),
        created_by  TEXT NOT NULL DEFAULT '',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen   TIMESTAMPTZ,
        last_ip     TEXT NOT NULL DEFAULT '',
        version     TEXT NOT NULL DEFAULT '',
        stats       JSONB NOT NULL DEFAULT '{}'::jsonb,
        revoked     BOOLEAN NOT NULL DEFAULT FALSE
      );
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS gateway_id TEXT;                        -- set while it reports through a gateway
    `,
  },
  {
    id: 10,
    name: 'agents: removed agents are told so (stop, or uninstall themselves)',
    sql: `
      -- an agent removed on the Agents page (or with its target) still holds its credential; for 30 days its
      -- requests get 410 agent_removed (+ uninstall) instead of a bare 401, so it stops (or uninstalls) itself
      CREATE TABLE IF NOT EXISTS agents_removed (
        id                   TEXT PRIMARY KEY,
        host                 TEXT NOT NULL DEFAULT '',
        credential_hash      TEXT,
        credential_prev_hash TEXT,
        uninstall            BOOLEAN NOT NULL DEFAULT FALSE,
        removed_by           TEXT NOT NULL DEFAULT '',
        removed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        tenant_id            TEXT NOT NULL DEFAULT 't_default'
      );
      CREATE INDEX IF NOT EXISTS agents_removed_cred_idx ON agents_removed (credential_hash);
    `,
  },
  {
    id: 11,
    name: 'dashboards belong to a tenant',
    sql: `
      -- custom dashboards were shared by every tenant (list, view, edit, delete); existing ones stay with the platform
      ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 't_default' REFERENCES tenants(id);
      CREATE INDEX IF NOT EXISTS dashboards_tenant_idx ON dashboards (tenant_id);
    `,
  },
  {
    id: 12,
    name: 'alert history: one row per alert episode (pending -> firing -> resolved)',
    sql: `
      -- written by the alert state tracker (alerting.js) from Prometheus' rule evaluation; Prometheus and
      -- Alertmanager stay the alerting engine, this is ObservaOne's record of what happened and when
      CREATE TABLE IF NOT EXISTS alert_episodes (
        id           BIGSERIAL PRIMARY KEY,
        alert_key    TEXT NOT NULL,                  -- stable id of the alert: rule + its labels
        alertname    TEXT NOT NULL,
        severity     TEXT NOT NULL DEFAULT 'none',
        host         TEXT NOT NULL DEFAULT '',
        tenant_id    TEXT NOT NULL DEFAULT 't_default',
        labels       JSONB NOT NULL DEFAULT '{}'::jsonb,
        annotations  JSONB NOT NULL DEFAULT '{}'::jsonb,
        state        TEXT NOT NULL,                  -- pending | firing | resolved
        value        DOUBLE PRECISION,               -- last value of the rule's expression
        peak         DOUBLE PRECISION,               -- highest value while active
        active_at    TIMESTAMPTZ NOT NULL,           -- condition became true (start of "pending")
        fired_at     TIMESTAMPTZ,                    -- became "firing" (after the rule's "for")
        resolved_at  TIMESTAMPTZ,                    -- condition false again (NULL while active)
        last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
        rule_expr    TEXT NOT NULL DEFAULT '',
        rule_for     INT NOT NULL DEFAULT 0          -- seconds
      );
      CREATE UNIQUE INDEX IF NOT EXISTS alert_episodes_open_idx ON alert_episodes (alert_key) WHERE resolved_at IS NULL;
      CREATE INDEX IF NOT EXISTS alert_episodes_resolved_idx ON alert_episodes (resolved_at DESC);
      CREATE INDEX IF NOT EXISTS alert_episodes_key_idx ON alert_episodes (alert_key, active_at DESC);
      CREATE INDEX IF NOT EXISTS alert_episodes_tenant_idx ON alert_episodes (tenant_id, resolved_at DESC);
    `,
  },
  {
    id: 13,
    name: 'notification channels (email, Teams, Slack, webhook, PagerDuty) managed in ObservaOne',
    sql: `
      -- ObservaOne writes them into Alertmanager's configuration (notify.js); secrets are encrypted with the app secret
      CREATE TABLE IF NOT EXISTS notification_channels (
        id              BIGSERIAL PRIMARY KEY,
        name            TEXT NOT NULL,
        type            TEXT NOT NULL,                 -- email | teams | slack | webhook | pagerduty
        team            TEXT NOT NULL,                 -- alerts with team="<team>" (or the default team) go here
        settings        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- non-secret: email addresses, Slack channel
        secret          TEXT,                          -- encrypted JSON: webhook URL, token, routing key
        display         TEXT NOT NULL DEFAULT '',      -- what the UI shows as "sends to" (secrets masked)
        send_resolved   BOOLEAN NOT NULL DEFAULT TRUE,
        enabled         BOOLEAN NOT NULL DEFAULT TRUE,
        created_by      TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_test_at    TIMESTAMPTZ,
        last_test_ok    BOOLEAN,
        last_test_error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS notification_channels_name ON notification_channels (lower(name));
    `,
  },
];
