import { existsSync } from 'node:fs'
import { errorMessage, type WorkspaceWithHealth } from '@orc/contracts'
import { compareWorkspaceHealth, fold, isClean, workspaceHealth, type EventLog, type ProjectConfig, type State } from '@orc/kernel'
import { provisionalNoteCounts } from '@orc/memory'
import { withMemory } from './memory-open'

// What a provisional-note count that could not be MADE renders as. Its own constant because two
// surfaces print it — the cell and the sentence under the table that explains it is not a zero — and
// a table whose footnote quoted a different character than its own column would explain nothing.
export const PROVISIONAL_UNKNOWN = '?'

/**
 * Every workspace of this project with its health — the ONE place the impure half of the verdict is
 * assembled, so `orc ws ls`, `workspace_list` and `project_status.workspaces` describe a checkout
 * the same way.
 *
 * The split is deliberate: the STATE TABLE is pure (kernel's `workspaceHealth`) and this layer
 * supplies only what a pure function cannot see — whether the directory is still there, whether git
 * calls it clean, and how much knowledge is still pending in it. A probe inside the kernel module
 * would make the table untestable without a checkout on disk for every row.
 *
 * ONE log read for both the events and the fold, rather than `Kernel.state()` plus a second read:
 * `state()` folds `log.all()` internally, so asking it here would pay for the whole log twice.
 */
export async function listWorkspaceHealth(opts: {
  log: EventLog
  config: ProjectConfig
  includeArchived?: boolean
  // How many notes are still pending per workspace, or null when they could not be counted.
  // Injectable because the default reaches Surreal: the null arm decides whether a workspace reads
  // `dangling` or `idle`, and with the read hard-wired the ONLY way to exercise it was to take the
  // read model down. A caller that supplies this owns the whole answer, absent/zero split included.
  counts?: () => Promise<Map<string, number> | null>
}): Promise<WorkspaceWithHealth[]> {
  const events = await opts.log.all()
  const state = fold(events)
  const notes = await (opts.counts ?? (() => provisionalCounts(opts, state)))()
  return [...state.workspaces.values()]
    .filter(w => opts.includeArchived === true || w.archivedAt === null)
    .map(w => {
      const dirExists = existsSync(w.cwd)
      // Not asked when the directory is gone: git would answer null anyway, and this is a process
      // spawn per workspace. ponytail: one `git status` per listed workspace is fine for a handful
      // of checkouts and unmeasured beyond that. The caller to watch is NOT the terminal's `ws ls`
      // (a human types that) but the copilot's `project_status`, which lists every workspace on the
      // tool call a driver is told to start from — that is where N spawns sit on a model's latency.
      // The upgrade is to answer `clean` for the whole project from one `git status` per repository
      // rather than one per checkout.
      return { workspace: w, health: workspaceHealth(state, events, notes, w, { dirExists, clean: dirExists ? isClean(w.cwd) : null }) }
    })
    .sort(compareWorkspaceHealth)
}

/**
 * Still-provisional notes per workspace, or null when the read model could not be asked.
 *
 * NULL, NEVER AN EMPTY MAP. The count is one of the two things that make a workspace `dangling`, so
 * a Surreal outage reported as zero would quietly relabel every abandoned checkout `idle` — the
 * exact failure the absent/zero split exists to prevent (`measureDrift` holds the same line). The
 * caller renders null as PROVISIONAL_UNKNOWN.
 *
 * The workspace view is THIS LISTING'S OWN FOLD, not a second `createWorkspaceView(log)` probe. Not
 * for the cost — that probe is a kind-scoped read of four workspace event kinds, which is cheap —
 * but because it is a SECOND READ: a merge or an archive committed between the two would put one
 * row's `provisional` count and the state printed beside it on different views of the log, and the
 * row would contradict itself. One fold, one listing.
 *
 * Opened and closed per call, the bracket every one-shot `orc memory` command uses: a standing
 * connection would have to be owned by something with a lifecycle, and this read happens once per
 * listing.
 */
async function provisionalCounts(
  opts: { log: EventLog; config: ProjectConfig },
  state: Pick<State, 'workspaces' | 'workspaceMerges'>,
): Promise<Map<string, number> | null> {
  return withMemory(opts, m => provisionalNoteCounts(m.store, () =>
    Promise.resolve({ workspaces: state.workspaces, merged: new Set(state.workspaceMerges.keys()) })))
    // REPORTED, then swallowed. The catch has to be blanket — every rung under it (Surreal
    // unreachable, a schema the projector has not migrated, a defect in the counting itself) has to
    // end in a listing rather than a failed command. But silent, it reported OUR OWN bug to the
    // operator as an outage: '?' and "the read model could not be reached" while the read model was
    // up. stderr, not stdout, so the table on stdout is still pipeable.
    .catch((err: unknown) => {
      console.error(`provisional note counts could not be made: ${errorMessage(err)}`)
      return null
    })
}
