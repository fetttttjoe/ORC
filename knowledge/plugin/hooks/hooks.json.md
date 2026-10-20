# plugin/hooks/hooks.json

## Facts
- The plugin SessionStart hook in plugin/hooks/hooks.json has timeout 5 (seconds), and session-start.sh keeps one-line comments only, with a single budget line stating the 5 s timeout, the ~1.6 s healthy brief and the ~3.3 s give-up on an unreachable database. {mj962msv @plugin/hooks/hooks.json @plugin/hooks/session-start.sh #postgres-connect-timeout-and-unreachable}

## Why
- The SessionStart hook timeout is 5 s because a healthy orc brief takes about 1.6 s and an unreachable database gives up after about 3.3 s (CONNECT_TIMEOUT_MS), so the hook's fail-open message can print before Claude Code kills it. {qk0rjbx6 @plugin/hooks/hooks.json @plugin/hooks/session-start.sh @packages/kernel/src/storage/postgres.ts#CONNECT_TIMEOUT_MS #postgres-connect-timeout-and-unreachable}
