import { existsSync } from 'node:fs'
import type { WorkspaceWithHealth } from '@orc/contracts'
import { compareWorkspaceHealth, fold, isClean, workspaceHealth, type EventLog, type State } from '@orc/kernel'

/** Every workspace with its health, assembled once so every door describes a checkout alike. */
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
      // one git status per workspace; project_status lists all, so N spawns add up
      return { workspace: w, health: workspaceHealth(state, events, w, { dirExists, clean: dirExists ? isClean(w.cwd) : null }) }
    })
    .sort(compareWorkspaceHealth)
  return { state, rows }
}

// the rows alone; projectHealth also returns its fold so the brief reads tasks from the same read
export const listWorkspaceHealth = async (opts: Parameters<typeof projectHealth>[0]): Promise<WorkspaceWithHealth[]> =>
  (await projectHealth(opts)).rows
