import { EVENT_KIND, type EventKind } from '@orc/contracts'
import { fold, type EventLog } from '@orc/kernel'
import type { WorkspaceView, WorkspaceViewProbe } from './provisional'

// The workspace standing every memory read surface derives `provisional` from, read from the LOG —
// the source of truth — through the kernel's own fold. Never a second set of rules about what a
// workspace is: `state.workspaces` and `state.workspaceMerges` are what `Kernel.state()` itself
// returns, so a change to how a merge or an archive folds reaches this with no edit here.
//
// The peer of drift.ts's createDriftProbe, and wired in the same places: a factory the composition
// root binds once and the tools call per read. Nothing here is cached, on purpose — the whole value
// of deriving the flag is that `orc ws merge` clears it corpus-wide on the very next read.
//
// ponytail: that costs ONE scoped log query per memory read (a step's search, an MCP call) — small,
// since a project holds a handful of workspace events, and unmeasured. If it ever shows up, the
// upgrade is a cache keyed on the log's head seq, the same exact-invalidation shape probeMemory's
// drift cache uses (cursor + tree fingerprint) — never a TTL, which would hold a stale flag past a
// merge for a window nobody can reason about.

// Only the kinds the fold's workspace cases actually read. Named *_EVENT_KINDS rather than
// WORKSPACE_KINDS, which contracts already exports for the two workspace KINDS ('checkout' |
// 'worktree'): one word meaning two things in the same import graph is how a reader reaches for the
// wrong set. Scoped like the vault projector's
// `renderRoot` ("the root index must never scan the whole log"): `Kernel.state()` folds every event
// in the project, and this runs on the memory read path — a step's search, an MCP call — where
// paying for the whole log per read is the difference between a flag and a cost.
const WORKSPACE_EVENT_KINDS: EventKind[] = [
  EVENT_KIND.workspace_created, EVENT_KIND.workspace_retitled,
  EVENT_KIND.workspace_archived, EVENT_KIND.workspace_merged,
]

export function createWorkspaceView(log: EventLog): WorkspaceViewProbe {
  return async (): Promise<WorkspaceView> => {
    const state = fold(await log.after(0, WORKSPACE_EVENT_KINDS))
    return {
      workspaces: state.workspaces,
      // the ids alone: whether the transaction committed is the whole question, and the merge
      // commit / trunk it committed to is the merge RECORD's business, not the flag's
      merged: new Set(state.workspaceMerges.keys()),
    }
  }
}
