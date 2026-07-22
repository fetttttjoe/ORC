# Migration Guide: M2 Postgres Consolidation (SQLite → Postgres)

**ADR Reference:** ADR-004 (amended M2-D1)  
**Milestone:** M2 Execution  
**Date:** 2026-07-17  
**Status:** Foundation change — required before any M2 features

---

## Summary

The canonical event log consolidates from **SQLite** (`bun:sqlite`) to **Postgres** (compose-managed). This change is driven by DBOS Transact's TypeScript SDK, which requires Postgres for both durable workflow state and the canonical event log.

### What Changes

| Layer | Before (M1) | After (M2) | Breaking? |
|---|---|---|---|
| **Database** | Single SQLite file (`.orc/state.db`) | Postgres (docker-compose, separate `orc` + `orc_dbos_sys` databases) | ✓ YES |
| **Schema** | Drizzle on `bun:sqlite` | Drizzle on `pg` driver, two services | ✓ YES |
| **Storage API** | `openStorage()` returns sync facade | Returns async facade | ✓ YES |
| **CLI** | Runs offline, CLI calls are sync | Requires `docker compose up -d`, CLI calls are async | ✓ YES |
| **Connection** | File path (auto-created) | `ORC_DATABASE_URL` env var (must exist) | ✓ YES |
| **Backup/Recovery** | Copy `.orc/state.db` | Postgres dump/restore or volume snapshots | ✓ YES |

### Why This Changes

- **DBOS TS SDK is Postgres-only** — The SQLite support (PR #1288, unmerged) does not exist in the shipped version. Postgres is the only option for durable workflow execution.
- **Single source of truth** — Event log and DBOS system DB live in the same server, eliminating cross-store consistency worries.
- **Atomic transactions** — Reads and appends stay in one locked transaction, enforcing invariants like "approval and first append are atomic."

### Impact

**On developers:**
- Must run `docker compose up -d` before any `orc` command (clear error message if Postgres is down).
- All storage APIs become `async` — any code calling `EventLog`, `OperationJournal`, or `Kernel` must `await`.
- Custom code reading/writing events must use Postgres-compatible SQL (no SQLite-isms).

**On deployments:**
- New dependency: `docker` and `docker-compose` (or Postgres 16+ on the system).
- One-time setup: `docker compose up -d` to stand up the stack.
- Backup/restore changes: Use `pg_dump` or volume snapshots instead of file copy.

**On data:**
- M1 SQLite databases cannot be auto-migrated (incompatible schemas, different drivers).
- **Data loss risk if you skip the migration procedure** — Back up `.orc/state.db` before proceeding.

---

## Timeline

| Phase | Date | Action |
|---|---|---|
| **Deprecation notice** | 2026-06-20 | (hypothetical: would go in M1 release notes) |
| **Breaking change land** | 2026-07-17 | M2 released; SQLite support removed |
| **Support window** | 2026-07-17–2026-08-17 | Guides available; community help in issues |
| **No rollback** | 2026-08-18 | M2 is the minimum version; M1 no longer supported |

---

## Prerequisites

- ✓ Docker and docker-compose installed (`docker --version`, `docker-compose --version`)
- ✓ Postgres 16 compatible (compose stack uses `postgres:16-alpine`)
- ✓ Port 5433 available on `localhost` (configurable in `docker-compose.yml`)
- ✓ Backup of `.orc/` directory and `.orc/state.db` (if M1)
- ✓ Git access to the latest code with M2 (the docker-compose and schema migrations are committed)

---

## Migration Procedure

### Step 1: Backup Your Current State (M1)

```bash
# Back up the entire .orc directory
cp -r .orc .orc.backup

# Back up the SQLite database separately (extra safety)
cp .orc/state.db .orc/state.db.backup

# Note: If using vault/, back that up too
cp -r vault vault.backup
```

**Why:** If anything goes wrong, you can restore the entire project state and try again.

### Step 2: Check Out M2 Code

```bash
# Pull the latest code (M2 branch or release tag)
git fetch origin
git checkout m2-execution  # or git checkout v0.2.0 (or whatever the M2 tag is)

# Install new dependencies
bun install

# Update lockfile if needed
bun update
```

### Step 3: Verify Docker Stack

```bash
# Check that docker-compose.yml exists and is valid
docker-compose config

# Output should show:
#   services:
#     postgres:
#       image: postgres:16-alpine
#       ports: 5433:5432
```

**Expected output:** The compose config is valid, showing the postgres service on port 5433.

### Step 4: Start the Postgres Stack

```bash
# Bring up the Postgres container
docker-compose up -d

# Verify it's running
docker-compose ps

# Output should show:
#   NAME         STATUS     PORTS
#   postgres     Up ...     0.0.0.0:5433->5432/tcp
```

**Verification:** The postgres service is running and healthy. Check the healthcheck:

```bash
docker-compose exec postgres pg_isready -U postgres
# Output: accepting connections
```

### Step 5: Apply Database Migrations

The Drizzle schema for M2 is committed in the repo. Apply it:

```bash
# Run the migration
orc db migrate

# This creates the two databases (orc + orc_dbos_sys) and applies all schemas
# Output should show:
#   [✓] Applied migration 001_initial_schema.sql
#   [✓] Applied migration 002_events_table.sql
#   ...
```

**What happens:**
- Drizzle compares the current Postgres schema against committed migration files.
- It creates the `orc` database (if it doesn't exist).
- It creates the `orc_dbos_sys` database (auto-created by DBOS on first use).
- It applies all pending migrations.

**Error handling:**
- If a migration fails: `orc db rollback` (creates a reverse migration).
- If Postgres is down: You'll see `connection refused` — check `docker-compose logs postgres`.

### Step 6: Validate the Connection

```bash
# Test the connection explicitly
orc db status

# Output:
#   Connected to: postgresql://postgres:orc@localhost:5433/orc
#   Applied migrations: N
#   Pending migrations: 0
```

**Success criteria:**
- ✓ Connected message
- ✓ Pending migrations: 0
- ✓ Can describe tables: `orc db describe events`

### Step 7: Populate Initial Data (if needed)

If you were using M1 with existing data, you have two options:

**Option A: Start fresh (recommended for testing)**
- Your new M2 installation is empty — this is OK for testing.
- Simply create a new task and plan to verify execution works.

**Option B: Migrate M1 data (advanced)**
- **Data loss risk:** SQLite and Postgres schemas differ; automated migration is not guaranteed.
- If you have high-value event logs to preserve:
  1. Document the exact M1 schema (run `sqlite3 .orc/state.db ".schema"`)
  2. Export as CSV: `sqlite3 .orc/state.db ".mode csv" "SELECT * FROM events;" > events.csv`
  3. Manually validate CSV structure matches M2 schema.
  4. Load via SQL script into Postgres.
  5. Validate with `orc status`.

**Recommendation:** For production deployments, script this into your migration automation. For now, starting fresh is safest.

### Step 8: Run a Test Plan

Create a simple task and run it to verify everything works:

```bash
# Initialize a project (if not already done)
orc init

# Create a task
orc new "Test task: say hello"

# Approve the proposed plan
orc review  # (or edit the plan and approve via CLI)

# Run the task
orc run <task-id>

# Expected output:
#   [✓] run_started event
#   [✓] step_started event
#   [✓] agent_call event (with full response)
#   [✓] step_completed or step_failed
#   [✓] task status → done / blocked
```

**Verification:** The event log contains the full transcript. Check:

```bash
orc log <task-id>

# Output: List of events in order (newest first)
```

### Step 9: Verify Event Log Consistency

```bash
# Replay the task to ensure determinism
orc replay <task-id>

# Output:
#   [✓] Replayed N events
#   [✓] Final state matches recorded state
```

**What this does:** Re-interprets all events for the task and verifies the final state matches the recorded state. If there's a consistency bug, this catches it.

### Step 10: Clean Up Backups (if migration succeeded)

Once you've verified everything works:

```bash
# Keep backups for 30 days, then remove
# (Put this in your calendar or cron)

# For now, just rename them so they don't clutter the directory
mv .orc.backup .orc.backup.m2-verified-$(date +%s)
mv vault.backup vault.backup.m2-verified-$(date +%s)

# Don't delete yet — keep for a few days in case you need to rollback
```

---

## Rollback Procedure

If something goes wrong and you need to go back to M1:

### Option 1: Restore from Backup (Recommended)

```bash
# Stop M2
git checkout m1-or-your-previous-branch
bun install

# Tear down the Postgres stack
docker-compose down -v  # -v removes volumes (WARNING: data loss)

# Restore from backup
rm -rf .orc .orc/state.db
cp -r .orc.backup .orc
cp .orc/state.db.backup .orc/state.db

# Verify restoration
orc db status  # Should fail with "SQLite file not found" message... or work if M1 is running

# You're back at M1
```

### Option 2: Recover Postgres Data (if you want to stay on M2 but fix an issue)

```bash
# Don't restore backups; instead, investigate and fix

# Check Postgres logs
docker-compose logs postgres

# Restart Postgres (if it crashed)
docker-compose restart postgres

# Re-run migrations
orc db migrate

# Try the test plan again
orc run <task-id>
```

---

## Database Schema Reference (M2)

After migration, your Postgres schema includes:

### `orc` database

| Table | Purpose |
|---|---|
| `events` | Canonical append-only event log; `seq bigint PK`, `payload jsonb`, `ts timestamptz`, `usage jsonb` (nullable) |
| `operations` | Durable operation nodes (BEFORE/AFTER); journal structure |
| `migrations` | Drizzle migration history |
| `schema_info` | Drizzle schema version tracking |

**Key indices:**
- `events(task_id)` — scoped queries
- `events(seq)` — append order
- `operations(task_id)` — operation lookup

### `orc_dbos_sys` database (auto-created by DBOS)

| Table | Purpose |
|---|---|
| `dbos_workflow_execution` | DBOS workflow instances |
| `dbos_workflow_event` | DBOS workflow steps (checkpoints) |
| `dbos_scheduler` | DBOS scheduled events |

**Note:** You should never query `orc_dbos_sys` directly — DBOS owns it. The `orc` database is your data.

---

## Connection String Reference

### Environment Variable

```bash
# Default
ORC_DATABASE_URL=postgresql://postgres:orc@localhost:5433/orc

# Custom host
ORC_DATABASE_URL=postgresql://postgres:orc@db.example.com:5433/orc

# With SSL (production)
ORC_DATABASE_URL=postgresql://postgres:orc@db.example.com:5433/orc?sslmode=require

# Secrets from env
ORC_DATABASE_URL=postgresql://$(whoami):$(cat ~/.db-password)@localhost:5433/orc
```

### Docker Compose Defaults

```yaml
# docker-compose.yml
services:
  postgres:
    environment:
      POSTGRES_DB: orc
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: orc
    ports:
      - "5433:5432"
```

---

## Known Issues & Caveats

### 1. M1 Data is Not Auto-Migrated

**Issue:** You cannot automatically migrate M1 SQLite data to M2 Postgres.

**Reason:** The schemas are incompatible; tool_result shapes changed; audit fields differ.

**Workaround:**
- For test data: Start fresh with M2.
- For production data: Export events as JSON, validate against new schema, write a one-time import script.
- Consider storing backups of M1 SQLite files long-term for compliance.

### 2. Port 5433 Conflicts

**Issue:** If something else is already using port 5433, compose fails.

**Solution:**
```yaml
# Edit docker-compose.yml
ports:
  - "5434:5432"  # Changed from 5433 to 5434

# Update ORC_DATABASE_URL
export ORC_DATABASE_URL=postgresql://postgres:orc@localhost:5434/orc
```

### 3. Postgres Service Won't Start

**Issue:** `docker-compose up -d` exits immediately or logs show errors.

**Solutions:**
```bash
# Check logs
docker-compose logs postgres

# Common reasons:
# - Docker daemon not running: `sudo systemctl start docker`
# - Old container left behind: `docker-compose down -v && docker-compose up -d`
# - Permission errors: `sudo chown $(id -u):$(id -g) ~` (if docker is in your group)
# - Volume conflicts: `docker volume ls`, then `docker volume rm orc_postgres_data` (deletes data!)

# Nuclear option (warning: data loss)
docker system prune -a
docker-compose up -d
```

### 4. Async API Ripple

**Issue:** All `EventLog`, `Kernel`, and CLI methods are now `async`; code that doesn't `await` silently does nothing.

**Example:**
```typescript
// M1 (sync) — WRONG in M2
const storage = openStorage();
storage.events.append(event);  // Event never actually appends!

// M2 (async) — CORRECT
const storage = await openStorage();
await storage.events.append(event);
```

**Fix:** Search your codebase for `openStorage` calls and add `await` everywhere.

### 5. DBOS Version Pin

**Issue:** After Postgres is up, DBOS caches the application version. Upgrading orc across versions while a run is PENDING can break recovery.

**Policy:** Finish or `orc cancel` active runs before upgrading orc versions.

```bash
# Before upgrading:
orc status <task-id>  # If status is "running" or "blocked", resolve it first
orc cancel <task-id>  # If you can't wait

# Then upgrade
git pull origin m2-execution
bun install
orc db migrate
```

---

## Testing & Validation

### Unit Tests

The test suite runs against ephemeral Postgres databases (created per test, dropped after):

```bash
# Run migration-specific tests
bun test packages/kernel/src/storage/postgres.test.ts

# Run all tests (requires `docker-compose up -d`)
bun test

# Expected: All tests pass
```

### Integration Tests

```bash
# Full end-to-end test: create task, propose, approve, run
bun test --filter "integration"

# This test exercises:
# ✓ Task creation
# ✓ Plan proposal and validation
# ✓ Plan approval (atomicity)
# ✓ Execution via DBOS workflows
# ✓ Event append and consistency
# ✓ Replay determinism
```

### Manual Smoke Test

```bash
# 1. Create task
orc new "count to 3"

# 2. Approve it (use CLI review)
orc review

# 3. Run it
orc run <task-id>

# 4. Check status
orc status <task-id>

# 5. Replay
orc replay <task-id>

# Expected: All 5 commands succeed with consistent state
```

---

## Verification Checklist

Before considering the migration complete:

- [ ] `docker-compose ps` shows postgres service as "Up"
- [ ] `orc db status` reports "Connected" with 0 pending migrations
- [ ] `orc new "test"` creates a task
- [ ] `orc review` allows editing and approval
- [ ] `orc run <task-id>` completes without error
- [ ] `orc log <task-id>` shows events
- [ ] `orc replay <task-id>` succeeds and matches recorded state
- [ ] Test suite passes (`bun test`)
- [ ] No errors in `docker-compose logs postgres`
- [ ] Custom code using `EventLog` has been updated to use `await`

---

## Next Steps

After M2 migration completes:

1. **Read:** [Migration Guide: ExecutionPort API](002-m2-execution-port-api.md) — if you're building custom executors
2. **Read:** [Migration Guide: Deployment Infrastructure](006-m2-deployment-infrastructure.md) — for production setup
3. **Deploy:** Set up CI/CD to run migrations on each release
4. **Monitor:** Set up Postgres backups (e.g., `pg_dump` to S3 nightly)
5. **Extend:** Build custom providers, tools, or executors using the new APIs

---

## Related Documentation

- [ARCHITECTURE.md](../ARCHITECTURE.md) — Storage service architecture and tier separation
- [M2 Execution Design Spec](../superpowers/specs/2026-07-17-m2-execution-design.md) — Full design details
- [ADR-004](../superpowers/specs/2026-07-16-orchestrator-design.md#adr-004) — Original DBOS decision
- [Infrastructure Setup Guide](006-m2-deployment-infrastructure.md) — Docker, env vars, monitoring
- [ExecutionPort API Migration](002-m2-execution-port-api.md) — DBOS integration

---

*Last updated: 2026-07-17 (Phase 3.2)*
