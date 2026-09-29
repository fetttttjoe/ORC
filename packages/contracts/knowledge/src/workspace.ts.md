# packages/contracts/src/workspace.ts

## Facts
- assertInZone and pathInZone in packages/contracts/src/workspace.ts are the one shared implementation of the zone write-fence: a plan step declares `zone` as an array of workspace-relative glob patterns matched with Bun.Glob, and an empty or undefined zone means unrestricted. {3i2qx2ny @packages/contracts/src/workspace.ts#assertInZone @packages/contracts/src/workspace.ts#pathInZone #fact}
- assertInZone refuses any write whose resolved path contains a '.git' path segment unconditionally, before checking the zone at all — the repository's own metadata is never writable in any zone. {j0ddwqop @packages/contracts/src/workspace.ts#assertInZone #fact}

## Why
- The per-step zone write-fence is defined once in packages/contracts/src/workspace.ts but enforced twice by design: the executor blocks an out-of-zone write at the moment it happens, and the kernel separately re-classifies every already-committed artifact path against the same declared zone after the fact — a step's own executor is not trusted as the sole judge of its own writes. {lw2pbd6g @packages/contracts/src/workspace.ts#assertInZone @plugins/executor-api-loop/src/tools.ts @packages/kernel/src/execution/scoped-changes-tool.ts#taskChangedPaths #architecture-current}
