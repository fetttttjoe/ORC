# plugins/executor-api-loop/src/rate-limit.ts

## Facts
- rate-limit.ts implements exponential backoff for 429s via scheduledWaitMs (FIRST_WAIT_MS=30000 doubling to MAX_WAIT_MS=300000) capped by TOTAL_WAIT_BUDGET_MS=1200000ms, honoring a Retry-After response header when present, and callModelWaitingOutRateLimits in loop.ts waits out the limit inside the operation rather than throwing so the conversation history is preserved. {x0tzrntl @plugins/executor-api-loop/src/rate-limit.ts @plugins/executor-api-loop/src/loop.ts#callModelWaitingOutRateLimits #architecture-current}
