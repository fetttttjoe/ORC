# packages/kernel/src/storage/event-log.ts

## Facts
- Every mutable fact in the system is an event appended to one Postgres-backed append-only log (packages/kernel/src/storage/event-log.ts's EventLog), and every other read surface — kernel State projections, the memory plugin's SurrealDB knowledge graph, vault-projector's markdown files, and ui-core/graph-ui's browser graph — is rebuilt by folding that log and holds no independent truth of its own. {51mrm28h @packages/kernel/src/storage/event-log.ts#EventLog @packages/kernel/src/projections.ts#foldInto @plugins/memory/src/projector.ts#createMemoryProjector @packages/vault-projector/src/index.ts#createVaultProjector @packages/ui-core/src/graph.ts#buildGraph #architecture-current}
- EventLog.subscribe() is a lossless catch-up pump: NOTIFY on 'orc_events' is only a wake-up, the authoritative source is a re-query of the events table by seq, and the cursor advances only after the handler for each row resolves so no event is lost across a handler failure or reconnect. {dnrj5w74 @packages/kernel/src/storage/event-log.ts#EventLog.subscribe #architecture-current}
- EventLog.append deduplicates on (projectId, idempotencyKey) via onConflictDoNothing, and on conflict re-fetches the existing row and throws KernelError('idempotency_conflict') if the COMPARED fields (chatId, door, taskId, stepId, runToken, kind, payload, usage) differ from the new attempt. {qyzi9pjr @packages/kernel/src/storage/event-log.ts#makeOps.append #architecture-current}

## Why
- EventLog.append validates each event's payload against PAYLOAD_SCHEMAS AFTER redaction, deliberately, so a zod validation error can never quote a raw secret. {f4cas2jz @packages/kernel/src/storage/event-log.ts#makeOps.append #architecture-current}
