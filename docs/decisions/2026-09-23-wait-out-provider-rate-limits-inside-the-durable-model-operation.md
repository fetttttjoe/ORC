---
status: accepted
tags: executor-api-loop, rate-limit, dbos, resilience
---

# Wait out provider rate limits inside the durable model operation

## Context

A 429 killed a step in ~30 s — the retry policy backed off 1 s, 2 s, 4 s and gave up, the task blocked, and a retry restarted the step's conversation from scratch. Real rate limits clear in minutes, not seconds. The alternatives were to lengthen the DBOS step retry policy (which restarts the conversation and re-bills the iterations) or to fail fast and let a human re-run.

## Decision

The api-loop executor waits out provider rate limits inside ctx.operation. callModelWaitingOutRateLimits sleeps and re-issues the same model call within that durable operation, preserving the messages array. rate-limit.ts defines the wait schedule, honours retry-after when present and applies its total scheduling budget. Once no further 429 wait is allowed, the loop throws a terminal error so DBOS cannot repeat the spent budget. Waiting cooperatively polls the task's cancellation status in at-most-5-second slices.

## Consequences

A rate-limited operation retains its conversation while waiting instead of restarting the step through DBOS retries. The default schedule starts at 30 seconds, doubles to a 300-second cap and has a 20-minute scheduling budget; it is not a wall-clock deadline including provider calls. Exhaustion throws a terminal error rather than rethrowing a retryable 429.

ExecutorContext.isCancelled is supplied by dbos-port from the task status in the event-log fold. sleepUnlessCancelled checks it before each CANCEL_POLL_MS (5,000 ms) slice and after the wait. Observed cancellation throws terminal CANCELLED_WHILE_RATE_LIMITED and prevents re-issuing the model call. This gives approximately 5-second polling during waits, plus scheduling and status-read latency; it does not abort an already-running provider request.

Waits are reported through console.warn because the operation callback cannot yield a UnifiedEvent from its enclosing generator. Moving these retries back out to DBOS would reintroduce conversation loss.
