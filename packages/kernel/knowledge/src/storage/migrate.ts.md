# packages/kernel/src/storage/migrate.ts

## Facts
- migrate.ts's assertMigrated compares the count of rows in drizzle.__drizzle_migrations against the number of entries in drizzle/meta/_journal.json and throws an error telling the operator to run 'orc db migrate' if the database is behind; it treats a missing migrations table (42P01/3F000) as zero applied rather than an error. {6k9iwefj @packages/kernel/src/storage/migrate.ts#assertMigrated #architecture-current}
