# packages/kernel/src/storage/postgres.ts

## Facts
- PostgresStore.open() calls assertMigrated instead of running migrations itself, so schema migration is a separate explicit step (migrate.ts's migrateDatabase / the 'orc db migrate' CLI), never a side effect of opening a store. {b0dfgw6e @packages/kernel/src/storage/postgres.ts#PostgresStore.open @packages/kernel/src/storage/migrate.ts#assertMigrated #architecture-current}
- Every write against a project's Postgres store is serialized through one per-project advisory lock (pg_advisory_xact_lock(hashtextextended(projectId,0))) taken in withProjectLock, so writes to different projects proceed concurrently but writes within one project never interleave. {bnwa8d2q @packages/kernel/src/storage/postgres.ts#PostgresStore.withProjectLock #architecture-current}

## Why
- The pool is capped at 4 connections with a 2 s idle timeout because every writer serializes on one per-project advisory lock, and default idle pools stacked across test files exhausted Postgres' 100 connections. {y8zpargq @packages/kernel/src/storage/postgres.ts#PostgresStore.open}
- TERMINAL_PG_CODES lists failures a retry cannot fix (3D000 database gone, 28P01/28000 bad credentials) because a reconnect loop left running spins at the backoff ceiling and logs into later test files' output. {v5dkna2p @packages/kernel/src/storage/postgres.ts#TERMINAL_PG_CODES}
- watchProjectIds emits the fresh id list on every wake and leaves change detection to subscribers, because names resolve above this layer and a rename wakes without changing membership; row-deleting operations send no NOTIFY. {h1sk8o8b @packages/kernel/src/storage/postgres.ts#watchProjectIds}
