# packages/cli/src/actions.ts

## Facts
- The three doors into the system — the `orc` CLI, `orc mcp serve`'s stdio MCP server, and the web/graph-ui adapter — all route every mutating action through the one buildOrcActions() layer in packages/cli/src/actions.ts, so the three cannot diverge in behavior. {49fc2slg @packages/cli/src/actions.ts#buildOrcActions @packages/cli/src/mcp-serve.ts @packages/cli/src/main.ts#buildProgram #architecture-current}
- buildOrcActions in packages/cli/src/actions.ts is the single implementation of every mutating orc action (new, propose, edit, approve, run, retry, cancel, purge, delete, reply, revise, annotate); the CLI, the web adapter and the MCP door all call through it so the three doors cannot diverge in behavior. {6vfpdt3u @packages/cli/src/actions.ts#buildOrcActions #architecture-current}

## Why
- buildOrcActions never drives an execution port itself — it records the ask through the kernel and relies on its ensureRuntime dependency (a live or freshly spawned supervisor, or an in-process runtime under --no-daemon) to actually execute it. {fbm5vxof @packages/cli/src/actions.ts#buildOrcActions #architecture-current}
