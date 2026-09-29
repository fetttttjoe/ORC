# packages/kernel/src/storage/postgres.ts

## Facts
- PostgresStore.open() calls assertMigrated instead of running migrations itself, so schema migration is a separate explicit step (migrate.ts's migrateDatabase / the 'orc db migrate' CLI), never a side effect of opening a store. {b0dfgw6e @packages/kernel/src/storage/postgres.ts#PostgresStore.open @packages/kernel/src/storage/migrate.ts#assertMigrated #architecture-current}
- Every write against a project's Postgres store is serialized through one per-project advisory lock (pg_advisory_xact_lock(hashtextextended(projectId,0))) taken in withProjectLock, so writes to different projects proceed concurrently but writes within one project never interleave. {bnwa8d2q @packages/kernel/src/storage/postgres.ts#PostgresStore.withProjectLock #architecture-current}
