# Migration Guide: M2 ExecutionPort API and DBOS Integration

**ADR Reference:** ADR-004 (amended M2-D2)  
**Milestone:** M2 Execution  
**Date:** 2026-07-17  
**Dependencies:** Migration 001 (Postgres consolidation) completed  
**Status:** Core API change — required for custom executors and durable execution

---

## Summary

The **ExecutionPort** is the seam isolating DBOS Transact from the kernel. In M2, it shifts from a sketch to a full implementation handling:
- **Durable workflows** (run + step workflows via DBOS)
- **Checkpoints** (model calls, tool execution, state appends)
- **Retry logic** and backoff (DBOS queues)
- **Deterministic recovery** (replay from the event log)

### What Changes

| Component | Before (M1 sketch) | After (M2 implementation) | Breaking? |
|---|---|---|---|
| **ExecutionPort** | Sketch in contracts; never called | Full DBOS implementation in kernel | ✓ YES |
| **Run/Step lifecycle** | Manual plan interpretation | DBOS workflows (deterministic, checkpointed) | ✓ YES |
| **Checkpoint capability** | Not implemented | `checkpoint<T>(name, fn) → Promise<T>` provided to executors | ✓ YES |
| **Executor context** | Partial (`role`, `instructions`, `workspace`) | Full context with checkpoint capability, resolved model | ✓ YES |
| **Event append** | Anywhere in code | Only inside durable checkpoint steps (to prevent duplication) | ✓ YES |
| **Signal validation** | Tokens not enforced | Per-run `runToken` validated on every signal | ✓ YES |

### Why This Changes

- **DBOS determinism requirement:** Workflow functions must be deterministic. Side effects (like `EventLog.append`) cannot run every time the function is re-executed after a crash — only the first time. Solution: wrap side effects in `checkpoint()` calls.
- **At-least-once semantics:** A step may execute multiple times across crash boundaries. DBOS prevents duplicate charges by keying to a deterministic `workflowID`, but duplicate events can still appear in the log. Solution: `fold()` deduplicates by `(runToken, iteration, kind)`.
- **Security:** Any agent can emit signals; without validation, a malicious executor could flip another run's outcome. Solution: each signal includes a per-run `runToken`, validated server-side.

### Impact

**On executors:**
- Must accept `checkpoint` capability in context.
- Must wrap model calls and tool execution in `checkpoint()`.
- Must emit `Signal` with correct `runToken`.
- Error handling changes: provider/agent/budget failures are now failure classes, not exceptions.

**On kernel:**
- `Kernel.run()` returns a `WorkflowID` and registers DBOS workflows.
- Plan interpretation is deterministic (pure function of plan + ready-set).
- Event appends are transactional within checkpoints.

**On CLI:**
- `orc run` foreground process stays attached via event log polling.
- `orc retry` starts a new run workflow, inheriting completed steps from the event log.
- `orc cancel` cascades to all child step workflows (DBOS does not cascade by default).

---

## Prerequisites

- ✓ Migration 001 (Postgres consolidation) completed
- ✓ DBOS 4.23.6+ installed and on Bun (spike-verified, see M2 design spec)
- ✓ Your executors compiled and tested against old ExecutionPort (for before/after comparison)
- ✓ Backup of `.orc/` (migration procedure modifies Postgres schema)

---

## Migration Procedure

### Step 1: Update the ExecutionPort Contract

The contract lives in `packages/contracts/src/execution.ts`. Review the new shape:

```typescript
// OLD (M1 sketch, never fully implemented)
export interface ExecutionPort {
  runStep(stepId, fn): Promise<void>;
  waitForSignal(stepId): Promise<Signal>;
  enqueue(stepId): void;
  sleep(ms): Promise<void>;
}

// NEW (M2 implementation)
export interface ExecutionPort {
  startRun(taskId: string, planVersion: number): Promise<{ workflowId: string }>;
  retry(taskId: string, planVersion: number): Promise<{ workflowId: string }>;
  cancelRun(taskId: string): Promise<void>;
}

// Plus, per-step: a checkpoint capability passed via ExecutorContext
export interface ExecutorContext {
  role: string;
  instructions: string;
  workspace: Workspace;
  model: LanguageModel;
  skills: LoadedSkill[];
  extraTools: ResolvedTool[];
  runToken: string;  // NEW: unique per step attempt
  checkpoint<T>(name: string, fn: () => Promise<T>): Promise<T>;  // NEW
}
```

**What's new:**
- `startRun` / `retry` / `cancelRun` replace sketch methods (kernel's job, not executor's).
- `checkpoint` is the key innovation — wraps any async function to make it durable.
- `runToken` identifies the current step attempt (used to validate signals and dedup events).

### Step 2: Understand Checkpoint Semantics

The checkpoint capability is **crucial** for understanding M2:

```typescript
// ✓ CORRECT: Model calls inside checkpoint
await checkpoint('model-call', async () => {
  const response = await model.generateText({ ... });
  return response;
});

// ✓ CORRECT: Tool execution inside checkpoint
await checkpoint('tool-execution', async () => {
  const results = [];
  for (const call of toolCalls) {
    const result = await executeTool(call);
    results.push(result);
  }
  return results;
});

// ✓ CORRECT: Event append inside checkpoint
await checkpoint('append-events', async () => {
  await log.append({ kind: 'tool_result', ... });
  return true;
});

// ✗ WRONG: Event append outside checkpoint (will duplicate on crash)
const result = await model.generateText({ ... });
await log.append({ kind: 'agent_call', ... });  // DUPLICATES if workflow restarts!

// ✗ WRONG: No checkpoint for side effects (lost on crash)
const answer = await externalAPI.query({ ... });  // External call may not be idempotent
return answer;
```

### Step 3: Update Your Executor Implementation

Example: Update the `api-loop` executor to use checkpoints.

**Before (M1 sketch):**
```typescript
export async function* startTurn(ctx: ExecutorContext): AsyncIterable<UnifiedEvent> {
  for (let i = 0; i < ctx.maxIterations; i++) {
    const response = await ctx.model.generateText({
      system: ctx.instructions,
      tools: [...buildTools(ctx)],
    });
    
    // Event append (WRONG in M2 — will duplicate)
    yield { kind: 'agent_call', response };
    
    // Tool execution and append (WRONG in M2)
    const toolResults = [];
    for (const call of response.toolCalls || []) {
      const result = await executeTool(call, ctx);
      toolResults.push(result);
      yield { kind: 'tool_result', result };
    }
  }
}
```

**After (M2):**
```typescript
export async function* startTurn(ctx: ExecutorContext): AsyncIterable<UnifiedEvent> {
  for (let i = 0; i < ctx.maxIterations; i++) {
    // 1. Model call inside checkpoint
    const response = await ctx.checkpoint(`iteration-${i}-model`, async () => {
      return await ctx.model.generateText({
        system: ctx.instructions,
        tools: [...buildTools(ctx)],
      });
    });
    
    // 2. Yield the model response (executor is log-agnostic)
    yield { kind: 'agent_call', response };
    
    // 3. Tool execution inside checkpoint
    const toolResults = await ctx.checkpoint(`iteration-${i}-tools`, async () => {
      const results = [];
      for (const call of response.toolCalls || []) {
        const result = await executeTool(call, ctx);
        results.push(result);
      }
      return results;
    });
    
    // 4. Yield tool results (executor is still log-agnostic)
    for (const result of toolResults) {
      yield { kind: 'tool_result', result };
    }
    
    // 5. Check for signal (ends the iteration)
    const signalCall = response.toolCalls?.find(c => c.name === 'signal');
    if (signalCall) {
      const { outcome, summary } = signalCall.arguments;
      yield { kind: 'signal', outcome, summary };  // runToken added by port
      break;
    }
  }
}
```

**Key difference:** The executor yields events, but never appends to the log directly. The step workflow (managed by DBOS in the port) consumes the yielded events and appends them transactionally inside a checkpoint.

### Step 4: Update Signal Validation

Signals now include per-run tokens. When your executor emits a signal, the port adds the token automatically:

```typescript
// Executor code (no token; port adds it)
yield {
  kind: 'signal',
  outcome: 'success',
  summary: 'Task complete',
  // runToken is added by DBOS port before appending
};

// In the event log, the signal event looks like:
{
  kind: 'signal_received',
  payload: {
    runToken: 'step:<task-id>:<step-id>:a1',  // Added by port
    outcome: 'success',
    summary: 'Task complete',
  }
}
```

### Step 5: Handle Failure Classes

M2 introduces a failure taxonomy. Your executor must emit appropriate failure signals:

```typescript
// Provider error (transient) — DBOS will retry
throw new Error('Provider 429: rate limited');  // Caught at step level, triggers DBOS backoff

// Provider error (terminal) — step fails immediately
throw new Error('Provider 401: unauthorized');  // Caught, not retried, step → step_failed

// Agent error — iteration exhausted
yield { kind: 'signal', outcome: 'failure', summary: 'Agent refused all attempts' };

// Budget exceeded — checked between iterations
const costSoFar = await ctx.checkpoint('check-budget', async () => {
  return await log.query('cost', { taskId: ctx.taskId });
});
if (costSoFar > ctx.budget) {
  yield { kind: 'signal', outcome: 'failure', summary: 'Budget exhausted' };
  break;
}
```

### Step 6: Update ExecutionPort Implementation

The kernel's DBOS port now lives in `packages/kernel/src/execution/dbos-port.ts`:

```typescript
// packages/kernel/src/execution/dbos-port.ts

export function createDbosPort(opts: {
  db: Database;
  log: EventLog;
  journal: OperationJournal;
  appVersion: string;
  concurrency: number;  // DBOS global concurrency limit
}): ExecutionPort {
  // DBOS launches once and manages durable workflows
  const dbos = new DBOS({ ...opts });
  
  return {
    async startRun(taskId, planVersion) {
      const workflowId = `run:${taskId}:v${planVersion}`;
      const handle = await dbos.start(workflowId, runWorkflow, taskId, planVersion);
      return { workflowId: handle.id };
    },
    
    async retry(taskId, planVersion) {
      const retryIndex = await log.countAfter('run_started', { taskId, planVersion });
      const workflowId = `run:${taskId}:v${planVersion}:r${retryIndex}`;
      // Re-run with updated workflow ID; DBOS sees it as new
      const handle = await dbos.start(workflowId, runWorkflow, taskId, planVersion);
      return { workflowId: handle.id };
    },
    
    async cancelRun(taskId) {
      const latest = await log.latest('run_started', { taskId });
      if (!latest) return;  // No active run
      
      // Cancel the run workflow and all its child step workflows
      await dbos.cancel(latest.payload.workflowId);
      // Note: DBOS cancel does NOT cascade; we cascade manually
      const stepWorkflows = await log.query('run_started', { runToken: latest.workflowId });
      for (const step of stepWorkflows) {
        await dbos.cancel(step.workflowId);
      }
    }
  };
}
```

**Details:**
- `workflowId` format ensures idempotency (same task+plan = same workflow).
- `retry()` increments a suffix to create a new workflow ID (DBOS caches per ID).
- `cancelRun()` cascades because DBOS doesn't.

### Step 7: Update the Step Workflow

The step workflow (a DBOS child workflow) is where checkpoints happen. This is kernel code, but understanding it helps:

```typescript
// Simplified step workflow (kernel code)
async function stepWorkflow(dbos: DBOS, taskId: string, stepId: string) {
  const runToken = `step:${taskId}:${stepId}:a1`;  // Unique per attempt
  
  // 1. Load the plan step
  const step = await dbos.step('load', async () => {
    return await kernel.loadStep(taskId, stepId);
  });
  
  // 2. Emit step_started
  await dbos.step('step-started', async () => {
    await log.append({ kind: 'step_started', stepId, runToken });
  });
  
  // 3. Run the executor (it yields events)
  const executor = createExecutor(step.executorRef);
  const ctx = {
    ...step,
    runToken,
    checkpoint: (name, fn) => dbos.step(name, fn),  // DBOS step = checkpoint
  };
  
  for await (const event of executor.startTurn(ctx)) {
    // 4. Executor yields events; step appends them
    if (event.kind === 'agent_call') {
      await dbos.step(`iteration-${i}-append`, async () => {
        await log.append({ ...event, stepId, runToken });
      });
    }
    // ... and so on for each event type
    
    // 5. Check for signal
    if (event.kind === 'signal') {
      // Validate runToken
      if (event.runToken !== runToken) {
        throw new Error(`Invalid signal token: expected ${runToken}, got ${event.runToken}`);
      }
      
      if (event.outcome === 'success') {
        await dbos.step('complete', async () => {
          await log.append({ kind: 'step_completed', stepId, runToken });
        });
        return;  // Step succeeded
      } else {
        await dbos.step('fail', async () => {
          await log.append({ kind: 'step_failed', stepId, runToken, reason: event.summary });
        });
        throw new Error(`Step failed: ${event.summary}`);  // Triggers retry (if configured)
      }
    }
  }
}
```

---

## Code Examples

### Example 1: Migrating a Custom Executor

**Before:**
```typescript
// myexecutor.ts (M1-style)
export async function* startTurn(ctx: ExecutorContext) {
  const response = await model.call(ctx.instructions);
  // Directly append (WRONG in M2)
  await ctx.storage.events.append({ kind: 'agent_call', response });
  yield { kind: 'agent_call', response };
}
```

**After:**
```typescript
// myexecutor.ts (M2-style)
export async function* startTurn(ctx: ExecutorContext) {
  const response = await ctx.checkpoint('model-call', async () => {
    return await model.call(ctx.instructions);
  });
  // Don't append; just yield (step workflow appends)
  yield { kind: 'agent_call', response };
}
```

### Example 2: Handling Transient Failures

```typescript
// With checkpoints, DBOS handles retries automatically
export async function* startTurn(ctx: ExecutorContext) {
  const response = await ctx.checkpoint('call-with-retry', async () => {
    // DBOS retries the whole checkpoint on transient errors (429, 5xx, timeout)
    try {
      return await model.generateText({ ... });
    } catch (e) {
      if (e.status === 429 || e.status >= 500) {
        throw e;  // Transient — DBOS retries
      } else if (e.status === 401) {
        throw new NonRetriableError(e);  // Terminal — fail immediately
      }
    }
  });
  
  yield { kind: 'agent_call', response };
}
```

### Example 3: Custom Tool with Checkpoints

```typescript
// builtin-tools.ts
export function createBuiltins(ctx: ExecutorContext) {
  return {
    signal: {
      description: 'End the step',
      inputSchema: z.object({ outcome: z.enum(['success', 'failure']), summary: z.string() }),
      execute: async (input) => {
        // Port adds runToken; executor emits signal
        return {
          kind: 'signal',
          outcome: input.outcome,
          summary: input.summary,
        };
      }
    },
    
    fs_read: {
      description: 'Read a file from the workspace',
      inputSchema: z.object({ path: z.string() }),
      execute: async (input) => {
        // Checkpoint around external I/O to prevent duplicates
        return await ctx.checkpoint('fs-read', async () => {
          const content = await fs.readFile(`${ctx.workspace}/${input.path}`);
          return { output: content };
        });
      }
    }
  };
}
```

---

## Database Schema Changes

No new tables in the event log; only new event kinds. Check `packages/kernel/src/storage/postgres.ts` for schema:

```typescript
export const eventsTable = pgTable('events', {
  seq: bigserial({ mode: 'bigint' }).primaryKey(),
  taskId: text('task_id').notNull().index(),
  stepId: text('step_id'),  // NEW in M2: step granularity
  runToken: text('run_token'),  // NEW in M2: per-run token
  kind: text('kind').notNull(),  // e.g., 'agent_call', 'tool_result', 'step_completed'
  payload: jsonb('payload').notNull(),
  usage: jsonb('usage'),  // Normalized usage per M2-D5
  ts: timestamp('ts').defaultNow(),
  // No indexes on (runToken, kind) yet; add if query performance degrades
});
```

---

## Testing & Validation

### Unit Tests

```typescript
// packages/kernel/src/execution/dbos-port.test.ts
describe('ExecutionPort', () => {
  it('wraps model calls in checkpoints', async () => {
    const port = createDbosPort({ ... });
    const ctx = { checkpoint: (name, fn) => fn(), ... };
    
    let called = false;
    await ctx.checkpoint('test', async () => {
      called = true;
    });
    
    expect(called).toBe(true);
  });
  
  it('re-executes checkpoint on crash boundary', async () => {
    // Simulate DBOS re-executing a workflow
    let callCount = 0;
    await dbos.step('test', async () => {
      callCount++;
      return callCount;
    });
    
    // First execution
    const result1 = dbos.runWorkflow(...);
    
    // Simulate crash and restart
    const result2 = dbos.runWorkflow(...);  // Re-runs, calls checkpoint again
    
    // Both should have callCount = 1 (DBOS dedups checkpoints by name)
    expect(result1).toEqual(result2);
  });
});
```

### Integration Test: Resume After Kill

```bash
# This is the crown jewel test — validates the entire M2 story

# 1. Start a run
orc run <task-id> &
RUNPID=$!

# 2. Wait for it to start (check event log)
sleep 2

# 3. Kill it mid-execution
kill -9 $RUNPID

# 4. Restart the run
orc run <task-id>

# 5. Verify:
#    - No duplicate events (fold correctly dedups)
#    - Model calls not re-billed (checkpoint prevented re-execution)
#    - Final state matches original run
#    - Replay produces identical result

orc log <task-id> | grep agent_call | wc -l  # Should be N, not 2N
orc replay <task-id>  # Should match recorded state
```

### Manual Validation

```bash
# 1. Create and run a task with tool calls
orc new "Use a tool to calculate something"
orc run <task-id>

# 2. Verify events in the log
orc log <task-id>

# Expected event sequence:
# - run_started
# - step_started
# - agent_call (iteration 1)
# - tool_call (for each tool invocation)
# - tool_result (for each tool result)
# - agent_call (iteration 2, if loop continued)
# - signal_received
# - step_completed
# - task_status_changed (to 'done')

# 3. Verify event structure
curl -s "postgresql://localhost:5433/orc" \
  -c "SELECT seq, kind, runToken, payload->'summary' FROM events WHERE taskId = '<task-id>' ORDER BY seq"

# All non-null runToken values should be identical for the step
# All (runToken, kind) pairs should be unique (no duplicates)
```

---

## Rollback Procedure

If a custom executor fails after migration:

### Option 1: Revert to Pre-Checkpoint Code

If your executor is simple, revert the checkpoint wrapping temporarily:

```typescript
// Temporarily unwrap checkpoints (CAUTION: risk of duplicate events on crash)
const response = await model.generateText({ ... });
yield { kind: 'agent_call', response };

// This works for single-iteration agents, but crashes mid-execution will duplicate events
```

**Not recommended for production.** Use only for testing.

### Option 2: Use Previous Checkpoint Implementation

If DBOS crashes are a problem, the kernel has a fallback `LocalCheckpoint` (slower, less fault-tolerant):

```typescript
// packages/kernel/src/execution/local-checkpoint.ts
export function createLocalCheckpoint(opts: { log: EventLog }) {
  return {
    async checkpoint<T>(name: string, fn: () => Promise<T>): Promise<T> {
      // Check if this checkpoint already completed
      const completed = await opts.log.query('checkpoint_completed', { name });
      if (completed) {
        return completed.result;
      }
      
      // Run the function
      const result = await fn();
      
      // Log completion
      await opts.log.append({ kind: 'checkpoint_completed', name, result });
      return result;
    }
  };
}
```

Switch to it:
```typescript
// kernel.ts
const port = opts.useLocal
  ? createLocalCheckpoint({ log })
  : createDbosPort({ dbos, log });
```

### Option 3: Rollback to M1

```bash
# Restore from backup (see 001-m2-postgres-consolidation.md)
git checkout m1
bun install
docker-compose down
cp -r .orc.backup .orc
```

---

## Known Issues & Caveats

### 1. Checkpoint Names Must Be Deterministic

**Issue:** If checkpoint names change across restarts, DBOS treats them as new checkpoints.

**Wrong:**
```typescript
for (let i = 0; i < 10; i++) {
  const name = Math.random().toString();  // Changes every restart!
  await ctx.checkpoint(name, async () => { ... });
}
```

**Right:**
```typescript
for (let i = 0; i < 10; i++) {
  const name = `iteration-${i}`;  // Deterministic
  await ctx.checkpoint(name, async () => { ... });
}
```

### 2. Checkpoint Functions Must Be Deterministic

**Issue:** Side effects inside a checkpoint can happen multiple times across retries.

**Wrong:**
```typescript
await ctx.checkpoint('call', async () => {
  const result = await model.generateText({ ... });
  sendNotification(result);  // May fire multiple times!
  return result;
});
```

**Right:**
```typescript
const result = await ctx.checkpoint('call', async () => {
  return await model.generateText({ ... });
});
// Notify outside checkpoint (or wrap notify in a separate checkpoint)
await sendNotification(result);
```

### 3. DBOS App Version Pinning

**Issue:** If your app version changes, DBOS won't recover workflows from the old version.

**Solution:** The kernel pins the app version to the orc package version. Finishing or canceling active runs before upgrading avoids this:

```bash
orc cancel <task-id>  # Before git pull && bun install
git pull origin m2
bun install
```

### 4. Executor Yield Order Matters

**Issue:** Events must be yielded in the order they occurred (no reordering, no skipping).

**Wrong:**
```typescript
const response = await model.generateText({ ... });
if (response.toolCalls?.length > 0) {
  yield { kind: 'tool_call', ... };  // Tool call before agent call!
}
yield { kind: 'agent_call', response };
```

**Right:**
```typescript
const response = await model.generateText({ ... });
yield { kind: 'agent_call', response };
for (const call of response.toolCalls || []) {
  yield { kind: 'tool_call', call };
  const result = await executeTool(call);
  yield { kind: 'tool_result', result };
}
```

---

## Verification Checklist

- [ ] ExecutionPort shape updated (`startRun`, `retry`, `cancelRun`)
- [ ] Your executor uses `ctx.checkpoint` for model calls and tool execution
- [ ] Executor yields events instead of appending to log directly
- [ ] Signals include `runToken` (added by port)
- [ ] All checkpoint names are deterministic
- [ ] Test suite passes: `bun test` (especially `packages/kernel/src/execution/`)
- [ ] Resume test passes: kill -9 and restart an active run
- [ ] Replay determinism verified: `orc replay` matches recorded state
- [ ] Custom code not calling `log.append` directly (all appends should be in step workflow)

---

## Next Steps

1. **Read:** [Migration Guide: Plan Execution Model](003-m2-plan-execution-model.md) — understand DAG interpreter
2. **Read:** [Migration Guide: Provider Registration](004-m2-provider-registration.md) — add new model providers
3. **Implement:** Update your executors to use checkpoints
4. **Test:** Run the resume test to validate crash recovery
5. **Deploy:** Follow [Migration Guide: Deployment Infrastructure](006-m2-deployment-infrastructure.md)

---

## Related Documentation

- [M2 Execution Design Spec](../superpowers/specs/2026-07-17-m2-execution-design.md) — §6 Execution Architecture
- [ARCHITECTURE.md § Execution Flow](../ARCHITECTURE.md#execution-flow--one-step-durably) — Sequence diagram
- [ADR-004 § ExecutionPort](../superpowers/specs/2026-07-16-orchestrator-design.md#adr-004) — Original decision
- [DBOS Transact Docs](https://docs.dbos.dev) — Workflow, queue, recovery semantics

---

*Last updated: 2026-07-17 (Phase 3.2)*
