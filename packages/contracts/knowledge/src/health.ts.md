# packages/contracts/src/health.ts

## Why
- SupervisorHealthState derives from the heartbeat row plus the pid file written only once the runtime is ready, and `client` exists because a missing heartbeat alone must not read as 'nothing will run' when a --no-daemon command or the graph server holds the runtime. {3eszyo5m @packages/contracts/src/health.ts#SupervisorHealthState}
