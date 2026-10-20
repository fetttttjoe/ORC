# packages/kernel/src/projections.ts

## Facts
- projections.crashDedupKey suppresses crash-boundary duplicate event appends, keyed by runToken+kind plus a per-kind discriminator (iteration/toolCallId/name/splitId/path), excluding task_status_changed, rate_limit_wait, and operation transition kinds. {wrk7tsj2 @packages/kernel/src/projections.ts#crashDedupKey #architecture-current}
- projections.foldInto mutates a FoldAcc {state, seen} per EventRecord to rebuild in-memory State (tasks, plans, steps, runs, usage, stepUsage, splits, operations, artifacts, reactionFailures, workspaces, workspaceMerges, project) from the append-only event log. {lanoszor @packages/kernel/src/projections.ts#foldInto #architecture-current}

## Why
- canRetry is the single admission rule behind the retry offer and both refusals, derived from status rather than event order, because event order calls a verdict-blocked or cancelled-from-blocked task retryable forever. {dh3t6pyl @packages/kernel/src/projections.ts#canRetry}
- nextAttempts gives a fresh attempt to every step of a settled task because a step folded running after settling died before step_failed, and reusing its number re-attaches to a dead DBOS workflow that replays its stored error on every retry. {ivkvrgby @packages/kernel/src/projections.ts#nextAttempts}
- remainingBudget takes the tightest remaining envelope over the whole ancestor chain and is enforced at the spend point, so N sibling splits each granted the full remaining budget cannot together overspend the parent. {eevqrbjp @packages/kernel/src/projections.ts#remainingBudget}
- Cancel targets startedAttempts, not nextAttempts, because cancelSubtree settles the task first and nextAttempts then returns attempt+1, an id DBOS does not have, so the live step kept running. {pgs1oarb @packages/kernel/src/projections.ts#startedAttempts}
- taskChangedPaths is a membership projection for the scope-cleanliness check only: a floor, since exec-driven writes are uncaptured, that never substitutes for the full test and typecheck gate. {upb4n16i @packages/kernel/src/projections.ts#taskChangedPaths}
