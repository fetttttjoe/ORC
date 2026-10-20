import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { WORKSPACE_KIND, errorMessage, slugId, type Origin, type Workspace } from '@orc/contracts'
import { KERNEL_ERROR_CODE, KernelError, branchDelete, currentBranch, dirtyPaths, isAncestor, MERGE_REFUSAL, mergeBranch, revParse, worktreeAdd, worktreeRemove, type Kernel, type OrcConfig } from '@orc/kernel'
import type { WorkspaceFold } from './cwd-workspace'
import { resolveTrunk } from './workspace-adopt'

// the OrcConfig slice `orc ws new` and adoptCwd both need: one export, so a Pick cannot drift
export type WorkspaceConfig = Pick<OrcConfig, 'dir' | 'projectRoot' | 'trunkBranch' | 'workspaceSetup'>

// nothing here prints: the terminal and the web/MCP door render the results their own way

// under the PROJECT root's .orc/, distinct from .orc/workspaces/, the per-step scratch fallback
export const WORKTREES_DIR = ['.orc', 'worktrees'] as const
export const WORKSPACE_BRANCH_PREFIX = 'orc/'
// git's spelling of 'whatever this checkout is on': the default --base, resolved to a branch name
export const HEAD_REF = 'HEAD'

// the way out of every refused `--remove`, spelled once so no copy names a renamed option
export const ARCHIVE_WITHOUT_REMOVE = 'archive without --remove, or remove the checkout yourself'

// the kernel's OWN refusal for an unknown id, code included: callers switch on KERNEL_ERROR_CODE
const noSuchWorkspace = (id: string): KernelError =>
  new KernelError(KERNEL_ERROR_CODE.workspace_not_found, `no workspace '${id}'`)

// the refusal for an archived workspace at every door needing a live one: one sentence, exported
export const archivedRefusal = (id: string): string => `workspace ${id} is archived — restore it first with: orc ws restore ${id}`

/** Quote one argument for a shell command a human will copy: POSIX single quotes, always. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

// stderr is what a failed install says, so it travels with the exit code
function runWorkspaceSetup(dir: string, argv: readonly string[]): { ok: true } | { ok: false; error: string } {
  if (argv.length === 0) return { ok: true }
  try {
    const r = Bun.spawnSync([...argv], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode === 0) return { ok: true }
    return { ok: false, error: `exit ${r.exitCode}: ${new TextDecoder().decode(r.stderr).trim()}` }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

// worktree first: the branch is checked out in it, so git refuses to delete the branch otherwise
function rollbackWorktree(projectRoot: string, dest: string, branch: string): string {
  const removed = worktreeRemove(projectRoot, dest)
  if (!removed.ok)
    return `the worktree at ${dest} (branch ${branch}) could not be removed (${removed.error}) — remove it with: git worktree remove ${dest} && git branch -D ${branch}`
  const deleted = branchDelete(projectRoot, branch)
  if (!deleted.ok)
    return `the worktree at ${dest} was removed but branch ${branch} was left behind (${deleted.error}) — delete it with: git branch -D ${branch}`
  return `the worktree at ${dest} and branch ${branch} were removed`
}

// rethrow the ORIGINAL instance (a KernelError keeps its code) with one sentence appended
function withNote(err: unknown, note: string): Error {
  if (err instanceof Error) {
    err.message = `${err.message} — ${note}`
    return err
  }
  return new Error(`${errorMessage(err)} — ${note}`)
}

// a named id must exist and not be archived (the kernel accepts archived ones); inheritance untouched
export async function requireLiveWorkspace(kernel: WorkspaceFold, id: string): Promise<Workspace> {
  const found = (await kernel.state()).workspaces.get(id)
  if (!found) throw noSuchWorkspace(id)
  if (found.archivedAt !== null) throw new Error(archivedRefusal(id))
  return found
}

/** The core behind `orc ws new` and the MCP `workspace_new`: one answer for a request's tree. */
export async function createRequestWorkspace(
  kernel: Pick<Kernel, 'createWorkspace' | 'createTask'>,
  cfg: Pick<OrcConfig, 'dir' | 'projectRoot' | 'workspaceSetup'>,
  input: { title: string; spec: string; base: string; task: boolean },
  origin: Origin,
): Promise<{ workspace: Workspace; taskId: string | null; branch: string; base: string }> {
  const slug = slugId(input.title)
  const dest = path.join(cfg.projectRoot, ...WORKTREES_DIR, slug)
  if (existsSync(dest)) throw new Error(`${dest} already exists — pick another title or archive the old workspace`)
  const branch = `${WORKSPACE_BRANCH_PREFIX}${slug}`
  // store the base as a branch NAME: 'HEAD' means something different in every checkout
  const base = input.base === HEAD_REF ? (currentBranch(cfg.dir) ?? HEAD_REF) : input.base
  // the worktree lives under the project's .orc/ so loadConfig's upward walk stays in this repository
  const added = worktreeAdd(cfg.projectRoot, dest, branch, base)
  if (!added.ok) throw new Error(`git worktree add failed: ${added.error}`)
  // Setup before the record, so a tree the operator's own setup rejects is never a workspace.
  const setup = runWorkspaceSetup(dest, cfg.workspaceSetup)
  if (!setup.ok) throw withNote(new Error(`workspaceSetup ${JSON.stringify(cfg.workspaceSetup)} failed in ${dest}: ${setup.error}`), rollbackWorktree(cfg.projectRoot, dest, branch))
  // act-then-record: git creates the tree first, so compensate git's half when the record is refused
  const workspace = await kernel.createWorkspace({
    title: input.title,
    // realpath: the fold matches a workspace's cwd EXACTLY, a symlinked spelling would mint a duplicate
    cwd: realpathSync(dest),
    branch,
    baseBranch: base,
    kind: WORKSPACE_KIND.worktree,
    managed: true,
    // a freshly minted orc/<slug> branch is by construction not the trunk
    onTrunk: false,
  }, origin).catch((err: unknown) => { throw withNote(err, rollbackWorktree(cfg.projectRoot, dest, branch)) })
  if (!input.task) return { workspace, taskId: null, branch, base }
  // past here the directory is REFERENCED: rollback stops, the failure gets a copyable instruction
  const recover = `orc new ${shellQuote(input.title)} --workspace ${workspace.id}`
    + (input.spec === '' ? '' : ` --spec ${shellQuote(input.spec)}`)
  const task = await kernel.createTask({ title: input.title, spec: input.spec, workspaceId: workspace.id }, origin)
    .catch((err: unknown) => { throw withNote(err, `the workspace is recorded (${workspace.id}, ${workspace.cwd}) — draft the task with: ${recover}`) })
  return { workspace, taskId: task.id, branch, base }
}

/** The facts `merge` and `finalize` share from ONE fold: workspace, landing branch, trunk. */
async function mergeTarget(
  kernel: Pick<Kernel, 'state'>,
  cfg: Pick<OrcConfig, 'projectRoot' | 'trunkBranch'>,
  id: string,
): Promise<{ workspace: Workspace; branch: string; trunk: string }> {
  const state = await kernel.state()
  const workspace = state.workspaces.get(id)
  if (!workspace) throw noSuchWorkspace(id)
  const merged = state.workspaceMerges.get(id)
  if (merged) throw new Error(`workspace ${id} is already merged into ${merged.trunk} at ${merged.mergeCommit}`)
  if (workspace.branch === null) throw new Error(`workspace ${id} (${workspace.cwd}) is on no branch — there is nothing to merge`)
  // the project ROOT owns trunk: the branch lands there, not necessarily where the command ran
  return { workspace, branch: workspace.branch, trunk: resolveTrunk(cfg, cfg.projectRoot) }
}

/** The record half of both doors; `unrecorded` is the CALLER's sentence, as the way out differs. */
async function recordMerge(
  kernel: Pick<Kernel, 'mergeWorkspace' | 'setWorkspaceArchived'>,
  id: string,
  input: { mergeCommit: string; trunk: string },
  unrecorded: string,
  origin: Origin,
): Promise<void> {
  await kernel.mergeWorkspace(id, input, origin).catch((err: unknown) => { throw withNote(err, unrecorded) })
  await kernel.setWorkspaceArchived(id, true, origin)
    .catch((err: unknown) => { throw withNote(err, `the merge IS recorded (${input.mergeCommit}) — archive the record with: orc ws archive ${id}`) })
}

// `warnings` is what happened AFTER the merge was recorded: reported, never thrown
export interface MergeWorkspaceResult {
  workspaceId: string
  branch: string
  trunk: string
  mergeCommit: string
  // null when there was nothing to remove: orc deletes only the worktrees it created
  removedWorktree: string | null
  warnings: string[]
}

// finalize only reads git, so the one thing that can go wrong is the append: an error
export interface FinalizeWorkspaceResult {
  workspaceId: string
  branch: string
  trunk: string
  mergeCommit: string
}

// `leftoverBranch` is kept, never deleted: an unmerged branch is the only copy of that work
export interface ArchiveWorkspaceResult {
  workspaceId: string
  removedWorktree: string | null
  leftoverBranch: string | null
}

/** Merge the branch into trunk, record it, archive the record, remove orc's own worktree. */
export async function mergeWorkspaceOp(
  kernel: Pick<Kernel, 'state' | 'mergeWorkspace' | 'setWorkspaceArchived'>,
  cfg: Pick<OrcConfig, 'projectRoot' | 'trunkBranch'>,
  id: string,
  origin: Origin,
): Promise<MergeWorkspaceResult> {
  const { workspace, branch, trunk } = await mergeTarget(kernel, cfg, id)
  if (workspace.archivedAt !== null) throw new Error(archivedRefusal(id))
  // refuse BEFORE git: a merge carries only what is COMMITTED, so uncommitted work would not land
  const dirty = dirtyPaths(workspace.cwd)
  if (dirty === null)
    throw new Error(`the checkout at ${workspace.cwd} is gone — if ${branch} was merged elsewhere, record it with: orc ws finalize ${id}`)
  if (dirty !== '')
    throw new Error(`workspace ${id} has uncommitted changes:\n${dirty}\ncommit or discard them in ${workspace.cwd}, then merge`)
  // the order IS the design: nothing is recorded until git merged; failures past that are reported
  const merged = mergeBranch(cfg.projectRoot, branch, trunk)
  // `alreadyContained` points at finalize: git's own 'nothing to record' names no next command
  if (!merged.ok)
    throw new Error(merged.reason === MERGE_REFUSAL.alreadyContained
      ? `${branch} is already contained in ${trunk}, but workspace ${id} has no recorded merge — record it with: orc ws finalize ${id}`
      : merged.error)
  // past here git HAS merged: compensation becomes 'record what is already true'
  await recordMerge(kernel, id, { mergeCommit: merged.mergeCommit, trunk },
    `git HAS merged ${branch} into ${trunk} as ${merged.mergeCommit} and nothing can undo that — record it with: orc ws finalize ${id}`, origin)
  const warnings: string[] = []
  let removedWorktree: string | null = null
  // Only what orc created may be deleted by orc — the same rule `archive --remove` follows.
  if (workspace.managed) {
    const removed = worktreeRemove(cfg.projectRoot, workspace.cwd)
    if (removed.ok) removedWorktree = workspace.cwd
    else warnings.push(`the merge stands, but the worktree at ${workspace.cwd} could not be removed (${removed.error}) — remove it with: git worktree remove ${workspace.cwd}`)
  }
  return { workspaceId: id, branch, trunk, mergeCommit: merged.mergeCommit, removedWorktree, warnings }
}

/** Record a merge made outside orc: the branch must already be contained in trunk. */
export async function finalizeWorkspaceOp(
  kernel: Pick<Kernel, 'state' | 'mergeWorkspace' | 'setWorkspaceArchived'>,
  cfg: Pick<OrcConfig, 'projectRoot' | 'trunkBranch'>,
  id: string,
  origin: Origin,
): Promise<FinalizeWorkspaceResult> {
  // an ARCHIVED workspace is accepted: finalize repairs 'merged by hand, archived, recorded later'
  const { branch, trunk } = await mergeTarget(kernel, cfg, id)
  const tip = revParse(cfg.projectRoot, branch)
  if (tip === null) throw new Error(`branch ${branch} does not exist in ${cfg.projectRoot} — nothing to finalize for workspace ${id}`)
  const landed = isAncestor(cfg.projectRoot, tip, trunk)
  // null is git declining to answer: reporting it as 'not merged' would send the operator astray
  if (landed !== true)
    throw new Error(landed === false
      ? `${branch} (${tip}) is not contained in ${trunk} — merge it first, or run: orc ws merge ${id}`
      : `git could not tell whether ${branch} is contained in ${trunk} in ${cfg.projectRoot} — check that both refs exist there`)
  // the tip IS the landing commit: once an ancestor of trunk, merge-base of the two is the tip
  await recordMerge(kernel, id, { mergeCommit: tip, trunk }, `nothing was recorded and nothing was changed — rerun: orc ws finalize ${id}`, origin)
  // no removal: orc did not make this merge; `orc ws archive <id> --remove` is the operator's call
  return { workspaceId: id, branch, trunk, mergeCommit: tip }
}

/** Archive a record; with `remove`, also the checkout behind it, only if orc created it. */
export async function archiveWorkspaceOp(
  kernel: Pick<Kernel, 'listWorkspaces' | 'setWorkspaceArchived'>,
  id: string,
  opts: { remove: false } | { remove: true; projectRoot: string },
  origin: Origin,
): Promise<ArchiveWorkspaceResult> {
  const w = (await kernel.listWorkspaces({ includeArchived: true })).find(x => x.id === id)
  if (!w) throw noSuchWorkspace(id)
  let removedWorktree: string | null = null
  if (opts.remove) {
    // refuse BEFORE recording: a failed removal would leave a live directory the tree no longer shows
    if (!w.managed) throw new Error(`workspace ${id} is not managed by orc (${w.cwd}) — ${ARCHIVE_WITHOUT_REMOVE}`)
    const removed = worktreeRemove(opts.projectRoot, w.cwd)
    // a vanished directory gets the unmanaged way out; a DIRTY tree keeps git's message unchanged
    if (!removed.ok) throw new Error(existsSync(w.cwd) ? removed.error : `${removed.error} — ${ARCHIVE_WITHOUT_REMOVE}`)
    removedWorktree = w.cwd
  }
  // the one window that does NOT compensate: the worktree is gone, so the way out is forward
  await kernel.setWorkspaceArchived(id, true, origin)
  // `git worktree remove` leaves the BRANCH, and orc must not delete the only copy: name it
  return { workspaceId: id, removedWorktree, leftoverBranch: removedWorktree === null ? null : w.branch }
}

// every workspace mutation requires its caller's origin: retitle and restore cannot bypass it
export interface WorkspaceOps {
  create(input: { title: string; spec: string; base: string; task: boolean }, origin: Origin): Promise<{ workspace: Workspace; taskId: string | null; branch: string; base: string }>
  merge(id: string, origin: Origin): Promise<MergeWorkspaceResult>
  finalize(id: string, origin: Origin): Promise<FinalizeWorkspaceResult>
  archive(id: string, opts: { remove: false } | { remove: true; projectRoot: string }, origin: Origin): Promise<ArchiveWorkspaceResult>
  retitle(id: string, title: string, origin: Origin): Promise<Workspace>
  restore(id: string, origin: Origin): Promise<Workspace>
}

// `config` is resolved per call: archiving or restoring a record needs no project context
export function buildWorkspaceOps(deps: { kernel: Kernel; config: () => WorkspaceConfig }): WorkspaceOps {
  const { kernel, config } = deps
  return {
    create: (input, origin) => createRequestWorkspace(kernel, config(), input, origin),
    merge: (id, origin) => mergeWorkspaceOp(kernel, config(), id, origin),
    finalize: (id, origin) => finalizeWorkspaceOp(kernel, config(), id, origin),
    archive: (id, opts, origin) => archiveWorkspaceOp(kernel, id, opts, origin),
    retitle: (id, title, origin) => kernel.retitleWorkspace(id, title, origin),
    // the archive SETTER, not restoreWorkspace, which re-seats a purged record under its old id
    restore: (id, origin) => kernel.setWorkspaceArchived(id, false, origin),
  }
}
