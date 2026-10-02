import { cwdWorkspaceId, type WorkspaceFold } from './cwd-workspace'
import { requireLiveWorkspace } from './workspace-ops'

export interface HealTarget { id: string; dir: string }

export function createHealTarget(deps: { kernel: WorkspaceFold; dir: string }): (workspaceId: string | null) => Promise<HealTarget> {
  return async workspaceId => {
    if (workspaceId === null) return { id: await cwdWorkspaceId(deps.kernel, deps.dir), dir: deps.dir }
    const found = await requireLiveWorkspace(deps.kernel, workspaceId)
    return { id: found.id, dir: found.cwd }
  }
}
