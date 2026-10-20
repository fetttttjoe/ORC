# packages/kernel/src/storage/runtime-lock.ts

## Why
- One execution runtime per project is enforced by a session-scoped advisory lock because DBOS recovery re-executes pending steps in a second runtime and the journal then fences the loser into a step_failed that blocks a healthy task. {7ojvrqod @packages/kernel/src/storage/runtime-lock.ts#acquireRuntimeLock}
- runtimeLockHeld answers whether something is driving (a supervisor, a --no-daemon command or the graph server), a different question from the supervisor heartbeat's whether a supervisor is beating. {c9l7naoj @packages/kernel/src/storage/runtime-lock.ts#runtimeLockHeld}
