import { realpathSync } from 'node:fs'
import { WORKSPACE_KIND, type Origin, type Workspace } from '@orc/contracts'
import { currentBranch, defaultBranch, gitDirs, type Kernel, type OrcConfig } from '@orc/kernel'
import type { WorkspaceConfig } from './workspace-ops'

// the trunk assumed when neither the operator nor git names one
export const DEFAULT_TRUNK = 'main'

/** Trunk resolves operator, then git, then constant; `dir` is a parameter since callers differ. */
export function resolveTrunk(config: Pick<OrcConfig, 'trunkBranch'>, dir: string): string {
  return config.trunkBranch ?? defaultBranch(dir) ?? DEFAULT_TRUNK
}

// onTrunk is captured here, at adoption: a read-time answer would ask a branch that has moved
export async function adoptCwd(
  kernel: Pick<Kernel, 'ensureWorkspace' | 'setWorkspaceArchived'>,
  config: WorkspaceConfig,
  origin: Origin,
): Promise<Workspace> {
  const cwd = realpathSync(config.dir)
  const kind = config.dir === config.projectRoot ? WORKSPACE_KIND.checkout : WORKSPACE_KIND.worktree
  // three git spawns per adoption on every command; one combined rev-parse could answer all
  const branch = currentBranch(config.dir)
  const trunk = resolveTrunk(config, config.dir)
  const onTrunk = gitDirs(config.dir) === null || (branch !== null && branch === trunk)
  const first = await kernel.ensureWorkspace({ cwd, branch, kind, onTrunk }, origin)
  const prior = first.workspace
  if (first.created || prior.branch === branch) return prior
  // kind comes from the prior record (a branch switch must not change it); title re-derives
  await kernel.setWorkspaceArchived(prior.id, true, origin)
  return (await kernel.ensureWorkspace({
    cwd, branch, onTrunk, kind: prior.kind, managed: prior.managed, baseBranch: prior.baseBranch,
  }, origin)).workspace
}
