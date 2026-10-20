# Idea bin

Deferred work with the reasoning intact. Nothing here is scheduled. An entry
graduates when a **trigger** fires — an observation from real use, not a
hunch. Entries that never trigger are the point: this file exists so a good
idea can wait without being rebuilt from scratch or shipped too early.

Format: what, why it was deferred, what would make it worth building, and any
design fixes already known so the eventual build starts from the corrected
version rather than the original sketch.

---

## 1. MCP grants bind the process, not the tool surface

**Source:** repo-wide audit 2026-07-20, split out of a broader system-hardening plan.

`mcpFingerprint` (`plugins/trust.ts`) covers `command`, `args`, and env
names, with `$NAME` references hashed as written and literal values folded to a constant — the *invocation*, not what the server exposes. `refValidator`
checks only that the server is declared and trusted; it never checks that the
referenced tool existed when consent was given, and the MCP client plugin (`plugins/mcp-client/src/index.ts`)
honours `list_changed` by clearing the cache, so a newly advertised tool is
usable immediately. A user who trusts `npx -y notes-mcp` has pinned nothing:
`npx` re-resolves the latest release on every spawn.

**Why deferred:** `ApprovalPolicy.default` is `'manual'` (`ApprovalPolicy` in `packages/contracts/src/approval.ts`), so
a human reviews the plan containing any new tool ref before it executes. The gap
between the stated boundary and the code is real, but not silently exploitable
under default policy. Closing it properly (~30 lines plus a CLI flow change)
means `orc mcp trust` spawns the server, calls `listTools`, and folds the sorted
tool names and schemas into the fingerprint — which makes granting trust require
a working server, a real UX cost.

**Trigger:** anyone runs with an `auto` approval rule that can match a
`task_split` (which self-approves in `Kernel.proposeSplit`), or a first
non-developer user installs a third-party MCP server. Either removes the human
review that currently carries this.
