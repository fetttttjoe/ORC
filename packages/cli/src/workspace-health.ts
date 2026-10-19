import { existsSync } from 'node:fs'
import type { WorkspaceWithHealth } from '@orc/contracts'
import { compareWorkspaceHealth, fold, isClean, workspaceHealth, type EventLog, type State } from '@orc/kernel'

/**
 * Every workspace of this project with its health — the ONE place the impure half of the verdict is
 * assembled, so `orc ws ls`, `workspace_list`, `project_status.workspaces` and `orc brief` describe a
 * checkout the same way.
 *
 * The split is deliberate: the STATE TABLE is pure (kernel's `workspaceHealth`) and this layer
 * supplies only what a pure function cannot see — whether the directory is still there and whether
 * git calls it clean. A probe inside the kernel module would make the table untestable without a
 * checkout on disk for every row.
 *
 * ONE log read for both the events and the fold, rather than `Kernel.state()` plus a second read:
 * `state()` folds `log.all()` internally, so asking it here would pay for the whole log twice.
 */
export async function projectHealth(opts: {
  log: EventLog
  includeArchived?: boolean
}): Promise<{ state: Pick<State, 'tasks' | 'workspaces'>; rows: WorkspaceWithHealth[] }> {
  const events = await opts.log.all()
  const state = fold(events)
  const rows = [...state.workspaces.values()]
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
      return { workspace: w, health: workspaceHealth(state, events, w, { dirExists, clean: dirExists ? isClean(w.cwd) : null }) }
    })
    .sort(compareWorkspaceHealth)
  return { state, rows }
}

// The rows alone — what every listing door wants. projectHealth also hands back the fold it derived
// them from, for the one caller (the session brief) that reads tasks beside the verdicts: a second
// `Kernel.state()` there would read the log again, and a task approved between the two reads would
// be listed as waiting under a workspace whose state says nothing is.
export const listWorkspaceHealth = async (opts: Parameters<typeof projectHealth>[0]): Promise<WorkspaceWithHealth[]> =>
  (await projectHealth(opts)).rows
