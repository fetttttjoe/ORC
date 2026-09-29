# packages/kernel/src/projections.ts

## Facts
- projections.crashDedupKey suppresses crash-boundary duplicate event appends, keyed by runToken+kind plus a per-kind discriminator (iteration/toolCallId/name/splitId/path), excluding task_status_changed, rate_limit_wait, and operation transition kinds. {wrk7tsj2 @packages/kernel/src/projections.ts#crashDedupKey #architecture-current}
- projections.foldInto mutates a FoldAcc {state, seen} per EventRecord to rebuild in-memory State (tasks, plans, steps, runs, usage, splits, operations, artifacts, workspaces) from the append-only event log. {lanoszor @packages/kernel/src/projections.ts#foldInto #architecture-current}
