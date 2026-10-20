# packages/kernel/src/storage/index.ts

## Why
- Storage exposes redact because DBOS persists step return values into its own system-database table, outside EventLog.append's redaction boundary. {odjwmaoa @packages/kernel/src/storage/index.ts#Storage}
