# Database migrations & recovery

ObservaOne uses **PostgreSQL 17** (compose service `observa-db`, db/user `observa`).

## How migrations work (verified)
- Migrations are declared as `{ id, name, sql }` entries in `observa-ui/src/migrations.js`
  (`EXTRA_MIGRATIONS`) and applied by `migrate()` in `observa-ui/src/db.js`.
- The whole run executes **inside a single transaction**, guarded by
  `pg_advisory_xact_lock(724100)` (safe when several UI containers start together),
  and applied ids are recorded in the `schema_migrations` table.
- Because Postgres DDL is transactional, a failing migration **rolls back the entire
  batch** — you never get a half-applied schema.

## Rules (keep the model safe)
1. **Append only.** Add new entries at the end with the next `id`. **Never edit a
   migration that has shipped** — it's already recorded in `schema_migrations` and
   won't re-run.
2. **Make DDL idempotent** where possible (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
   `DROP ... IF EXISTS`) — matches the existing style.
3. **Parameterized SQL only** in application code (`pg` placeholders), never string-built.
4. **Test on a copy first** (see below) before applying against real data.

## Recovery model
There are **no down-migrations** by design — this is a forward-only system. Recovery is
**backup + restore**, so take a backup before applying new migrations.

```bash
# Backup (run on the machine hosting the stack; reads DB_PASSWORD from your shell/.env)
docker compose exec -T observa-db pg_dump -U observa -d observa > observa_backup_$(date +%Y%m%d_%H%M%S).sql

# Dry-run a new migration on a throwaway copy:
#   1) create a scratch db, 2) restore the backup into it, 3) point a disposable
#      observa instance (or psql) at it and apply, 4) inspect, then drop the scratch db.

# Restore (DESTRUCTIVE to the target db — only for deliberate recovery):
#   cat observa_backup_*.sql | docker compose exec -T observa-db psql -U observa -d observa
```

> The Claude Code guard (`.claude/hooks/guard.sh`) blocks `DROP TABLE/DATABASE` and
> `TRUNCATE` from the agent; run any such recovery step yourself, deliberately.
