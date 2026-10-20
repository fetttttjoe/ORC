# packages/cli/src/actions.ts

## Facts
- The three doors into the system — the `orc` CLI, `orc mcp serve`'s stdio MCP server, and the web/graph-ui adapter — all route every mutating action through the one buildOrcActions() layer in packages/cli/src/actions.ts, so the three cannot diverge in behavior. {49fc2slg @packages/cli/src/actions.ts#buildOrcActions @packages/cli/src/mcp-serve.ts @packages/cli/src/main.ts#buildProgram #architecture-current}

## Why
- assertDrivable refuses a task startRunAt could never serve before its run_requested is recorded, because a draft, unapproved or terminal task would sit in the log and every booting supervisor would fail on it again. {qhjld2c2 @packages/cli/src/actions.ts#assertDrivable}
- assertRetryable refuses a task blocked only on verdicts, because retry re-runs only what did not complete, so the rejecting step sees the same sibling outputs and reaches the same conclusion (measured: three identical passes). {vw56suim @packages/cli/src/actions.ts#assertRetryable}
- buildModelDiscovery bounds every provider fetch by providerTimeoutMs, because a daemon that naps answers no faster than one that is down and every door discovers, so the bound belongs at this seam and is injectable for tests. {q4fa2866 @packages/cli/src/actions.ts#buildModelDiscovery}
- buildOrcActions never drives an execution port itself — it records the ask through the kernel and relies on its ensureRuntime dependency (a live or freshly spawned supervisor, or an in-process runtime under --no-daemon) to actually execute it. {fbm5vxof @packages/cli/src/actions.ts#buildOrcActions #architecture-current}
- catalogAppends gates a models_discovered append on reachability, not emptiness, because an empty list is a provider's legitimate steady state and an emptiness guard would pin the served catalog to a stale event. {yrly0zbj @packages/cli/src/actions.ts#catalogAppends}
- The wipe guard refuses rather than warns while a supervisor is beating, because truncating the DBOS system database under a live runtime leaves its queue counting vanished workflows against concurrency slots, and the only symptom is a run that never starts. {c8ehd1oz @packages/cli/src/actions.ts#refuseWhileSupervised}
