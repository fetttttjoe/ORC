import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { WORKSPACE_KIND, errorMessage, slugId, type Origin, type Workspace } from '@orc/contracts'
import { KERNEL_ERROR_CODE, KernelError, branchDelete, currentBranch, dirtyPaths, isAncestor, MERGE_REFUSAL, mergeBranch, revParse, worktreeAdd, worktreeRemove, type Kernel, type OrcConfig } from '@orc/kernel'
import { resolveTrunk } from './workspace-adopt'

// The OrcConfig slice `orc ws new` (ws-commands.ts) and adoptCwd (workspace-adopt.ts) both need — the
// union of what each narrows to. One export so a Pick spelled twice can't drift when one call site
// starts needing a field the other doesn't.
export type WorkspaceConfig = Pick<OrcConfig, 'dir' | 'projectRoot' | 'trunkBranch' | 'workspaceSetup'>

// The workspace lifecycle operations — create-with-worktree, merge, finalize, archive — as plain
// async functions returning result values.
//
// Nothing here prints. The terminal (ws-commands.ts) and the MCP/web door (actions.ts) render these
// results their own way, and a console.log in the middle of an operation is how the two doors end up
// describing one lifecycle differently. It also keeps the terminal's argument parser out of
// actions.ts's import graph: the door that serves the web and MCP surfaces has no business pulling a
// command-line library in behind it, and before this split it did — through ws-commands.ts, which is
// where these operations used to live.
//
// Every function takes the NARROWEST kernel surface it uses rather than a whole `Kernel`. A real
// kernel satisfies each structurally, and the seam is what makes the failure windows below testable:
// the only way to exercise "git merged and then the append failed" is to substitute the ONE method
// that appends, and a mock library (or a cast) would be a worse answer to that than a type that
// already says which methods an operation is allowed to reach for.

// Under .orc/ (gitignored) of the PROJECT root — distinct from .orc/workspaces/, which is the
// per-step scratch fallback (config.workspaceRoot). Same word, different thing; different path.
export const WORKTREES_DIR = ['.orc', 'worktrees'] as const
export const WORKSPACE_BRANCH_PREFIX = 'orc/'
// git's own spelling of "whatever this checkout is on", used as the --base default and as the
// sentinel that means "resolve it to a branch name". Spelled once: the record stores the resolved
// name, and a second literal here would let the default and the test for it drift apart. Exported
// because the MCP door defaults `base` too (actions.ts) — the two doors share the sentinel or they
// disagree about what "no base given" means.
export const HEAD_REF = 'HEAD'

// The way out of every `--remove` this module refuses, spelled ONCE: an unmanaged checkout and a
// directory that is already gone reach the same dead end from opposite directions, and two copies of
// the sentence would let one of them keep naming an option the other had since renamed.
export const ARCHIVE_WITHOUT_REMOVE = 'archive without --remove, or remove the checkout yourself'

// The refusal an id nobody recorded gets, in the kernel's OWN spelling — same code, same words as
// `Kernel.requireWorkspace`, because these operations refuse a typo BEFORE the kernel would have and
// the operator must not be able to tell which layer answered. A plain Error would carry the sentence
// without the `code`, and every caller that switches on KERNEL_ERROR_CODE (the MCP door's error
// mapping above all) would read a typo as an unknown internal failure. One factory, because this
// module refuses an unknown id at three doors and three literals would drift from the kernel's.
const noSuchWorkspace = (id: string): KernelError =>
  new KernelError(KERNEL_ERROR_CODE.workspace_not_found, `no workspace '${id}'`)

// The refusal an ARCHIVED workspace gets at every door that needs a live one — `orc ws merge`, `orc
// new --workspace`, the MCP `new_request`. One sentence, because the operator's next command is the
// same in all three and a per-door spelling would name `orc ws restore` in some of them only.
// Exported so the tests assert the sentence the doors actually print rather than a second copy of
// it: a re-spelled literal in a test passes for as long as it happens to match, and then pins the
// wrong words the moment the real one is reworded.
export const archivedRefusal = (id: string): string => `workspace ${id} is archived — restore it first with: orc ws restore ${id}`

/**
 * Quote one argument for a shell command a human is about to copy.
 *
 * POSIX single quotes, ALWAYS applied: the recovery sentence below used to interpolate a title
 * between hand-written quotes, so a request called `Don't lose this` produced a command that broke
 * at the apostrophe — at the exact moment the operator is recovering from a half-finished create.
 */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

// Undo git's half of a `ws new` whose record was refused, in the only order git allows: the branch
// is checked out in the worktree, so the tree goes first (pinned in kernel git.test.ts). Returns
// the sentence describing what happened — a cleanup that itself failed is REPORTED, never
// swallowed, because what it left behind is state the operator now has to remove by hand.
// The configured argv, run once in the new tree; the empty argv is "no setup". stderr is what a
// failed install says, so it travels with the exit code.
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

function rollbackWorktree(projectRoot: string, dest: string, branch: string): string {
  const removed = worktreeRemove(projectRoot, dest)
  if (!removed.ok)
    return `the worktree at ${dest} (branch ${branch}) could not be removed (${removed.error}) — remove it with: git worktree remove ${dest} && git branch -D ${branch}`
  const deleted = branchDelete(projectRoot, branch)
  if (!deleted.ok)
    return `the worktree at ${dest} was removed but branch ${branch} was left behind (${deleted.error}) — delete it with: git branch -D ${branch}`
  return `the worktree at ${dest} and branch ${branch} were removed`
}

// The ORIGINAL failure is the one the operator has to act on, so it is rethrown as the SAME
// instance — a KernelError keeps its code — with one sentence appended. Wrapping it in a fresh
// Error would bury the cause one `.cause` deep at the exact moment a human is reading the message.
function withNote(err: unknown, note: string): Error {
  if (err instanceof Error) {
    err.message = `${err.message} — ${note}`
    return err
  }
  return new Error(`${errorMessage(err)} — ${note}`)
}

/**
 * The workspace an explicitly-named id must resolve to: it exists AND it is not archived.
 *
 * Only for a caller that NAMED one. Inheritance is untouched — a child task still lands in its
 * parent's workspace whatever its standing, because a subtree straddling two checkouts is worse than
 * a task drafted in a finished one. What this refuses is `orc new --workspace <archived-id>` and the
 * MCP door's explicit `workspaceId`: the operator archived that path on purpose, so a task filed
 * there is work nobody will find again, and the kernel accepts it because archiving is not a fact
 * about whether a record may be referenced.
 *
 * An UNKNOWN id raises the kernel's OWN refusal — the same `KernelError` with the same code and the
 * same words the kernel would have thrown one call later — so a door that checks here first and a
 * door that does not are indistinguishable on a typo. A plain Error here would have been: same
 * sentence, no `code`, and every caller that switches on `KERNEL_ERROR_CODE.workspace_not_found`
 * (the MCP door's error mapping above all) would classify a typo as an unknown internal failure.
 *
 * ONE fold, through `state()`, not `listWorkspaces()`: the map is keyed by id, so the lookup is a
 * get rather than a scan of a materialized array, and `state.workspaces` already carries archived
 * records — `listWorkspaces({ includeArchived: true })` was building the whole list to find one row.
 */
export async function requireLiveWorkspace(kernel: Pick<Kernel, 'state'>, id: string): Promise<Workspace> {
  const found = (await kernel.state()).workspaces.get(id)
  if (!found) throw noSuchWorkspace(id)
  if (found.archivedAt !== null) throw new Error(archivedRefusal(id))
  return found
}

/**
 * Create the worktree + branch one request is worked in, record it as a managed workspace, and
 * (unless `task` is false) draft the request as that workspace's first task.
 *
 * The core behind `orc ws new`, exported because the MCP `workspace_new` door needs the SAME
 * implementation — a second copy would be a second answer to "where does a request's checkout come
 * from". The command above it only prints.
 */
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
  // The base is stored on the record, so resolve HEAD to the branch NAME here: 'HEAD' means
  // something different in every checkout, and the workspace is read from elsewhere later.
  const base = input.base === HEAD_REF ? (currentBranch(cfg.dir) ?? HEAD_REF) : input.base
  // The worktree lives under the project's own .orc/, so `cd`-ing into it keeps loadConfig's
  // upward walk inside this repository. That walk stops at the worktree only because a tracked
  // .orc/config.json materializes there: a project that does NOT track one leaves the worktree
  // with no .orc at all, the walk then finds the MAIN checkout's identity one level up, and a
  // command run inside the worktree would adopt — and bind its tasks to — the main checkout's
  // workspace. Left as a note rather than a guard: which way that should fail is a later decision.
  const added = worktreeAdd(cfg.projectRoot, dest, branch, base)
  if (!added.ok) throw new Error(`git worktree add failed: ${added.error}`)
  // Setup before the record, so a tree the operator's own setup rejects is never a workspace.
  const setup = runWorkspaceSetup(dest, cfg.workspaceSetup)
  if (!setup.ok) throw withNote(new Error(`workspaceSetup ${JSON.stringify(cfg.workspaceSetup)} failed in ${dest}: ${setup.error}`), rollbackWorktree(cfg.projectRoot, dest, branch))
  // Act-then-record is the only order available here: git has to create the tree before there is
  // anything to record. So the window between the two is real, and a record refused inside it used
  // to leave the worktree and the orc/<slug> branch behind with nothing pointing at them — the
  // retry then died on "<dest> already exists — archive the old workspace", naming a workspace that
  // never existed. Compensate git's half, then rethrow the refusal itself.
  const workspace = await kernel.createWorkspace({
    title: input.title,
    // realpath, because the fold matches a workspace's cwd EXACTLY and adoption from inside this
    // worktree asks with the resolved path — a symlinked spelling here would mint a duplicate.
    cwd: realpathSync(dest),
    branch,
    baseBranch: base,
    kind: WORKSPACE_KIND.worktree,
    managed: true,
    // A freshly minted orc/<slug> branch is by construction not the trunk, so the notes written
    // here stay provisional until this workspace merges.
    onTrunk: false,
  }, origin).catch((err: unknown) => { throw withNote(err, rollbackWorktree(cfg.projectRoot, dest, branch)) })
  if (!input.task) return { workspace, taskId: null, branch, base }
  // Past this line the directory is REFERENCED, so the rollback stops here: deleting a recorded
  // workspace's worktree would leave an active record pointing at nothing, which is worse than the
  // draft task that failed to be written — and a workspace without a task is a state --no-task
  // produces on purpose. So this window compensates with an instruction instead of a deletion.
  //
  // The recovery command carries the SPEC as well as the title, and shell-quotes both: the request
  // itself is what an agent reads, and a sentence that silently dropped it told the operator to
  // re-create the task with an empty one.
  const recover = `orc new ${shellQuote(input.title)} --workspace ${workspace.id}`
    + (input.spec === '' ? '' : ` --spec ${shellQuote(input.spec)}`)
  const task = await kernel.createTask({ title: input.title, spec: input.spec, workspaceId: workspace.id }, origin)
    .catch((err: unknown) => { throw withNote(err, `the workspace is recorded (${workspace.id}, ${workspace.cwd}) — draft the task with: ${recover}`) })
  return { workspace, taskId: task.id, branch, base }
}

/**
 * The facts `merge` and `finalize` both need, from ONE fold of the log: the workspace, the branch
 * that would land, and the trunk it lands on.
 *
 * Shared so the two commands refuse the same things in the same words — a second spelling of
 * "already merged" would let them disagree about what is still recordable. That check lives here
 * as well as in the kernel (which refuses a second `workspace_merged` of its own) because of what
 * git does in between: `merge --no-ff` of an already-contained branch prints "Already up to date",
 * exits 0 and commits nothing, so a command that asked git first would run a merge for nothing and
 * only then hear that the fact was already written.
 */
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
  // The project ROOT owns trunk — that is the checkout the branch lands in, and it is not
  // necessarily the directory this command was run from.
  return { workspace, branch: workspace.branch, trunk: resolveTrunk(cfg, cfg.projectRoot) }
}

/**
 * The record half of both doors: the merge fact, then the archive that follows from it.
 *
 * Both appends can fail, and what the operator should do about it depends entirely on what already
 * happened — which is why `unrecorded` is the CALLER's sentence. After `orc ws merge` the branch is
 * on trunk and nothing here can undo that, so the way out is `orc ws finalize`; after `orc ws
 * finalize` nothing has happened at all and the way out is to run it again. The archive note is
 * shared, because by then the two histories are identical: the merge is recorded either way.
 */
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

// What `orc ws merge` did, in the order it did it. `warnings` is what happened AFTER the merge was
// recorded and could not be undone — reported, never thrown, because by then the branch is on trunk
// and an exception would tell the operator the merge had not happened.
export interface MergeWorkspaceResult {
  workspaceId: string
  branch: string
  trunk: string
  mergeCommit: string
  // the worktree orc removed, or null when there was none to remove (an unmanaged checkout is the
  // operator's own directory and orc deletes only what it created)
  removedWorktree: string | null
  warnings: string[]
}

// What `orc ws finalize` recorded. No removal and no warnings: finalize only reads git, so the one
// thing that can go wrong is the append, and that is an error rather than a note.
export interface FinalizeWorkspaceResult {
  workspaceId: string
  branch: string
  trunk: string
  mergeCommit: string
}

// What `orc ws archive` did. `leftoverBranch` is the branch a removed worktree had checked out: git
// keeps it, and it is NOT deleted here — an unmerged branch is the only copy of that work — so the
// caller names it and the operator decides.
export interface ArchiveWorkspaceResult {
  workspaceId: string
  removedWorktree: string | null
  leftoverBranch: string | null
}

/**
 * Merge the workspace's branch into trunk, record it, archive the record and remove the worktree
 * orc created for it.
 */
export async function mergeWorkspaceOp(
  kernel: Pick<Kernel, 'state' | 'mergeWorkspace' | 'setWorkspaceArchived'>,
  cfg: Pick<OrcConfig, 'projectRoot' | 'trunkBranch'>,
  id: string,
  origin: Origin,
): Promise<MergeWorkspaceResult> {
  const { workspace, branch, trunk } = await mergeTarget(kernel, cfg, id)
  if (workspace.archivedAt !== null) throw new Error(archivedRefusal(id))
  // Refuse BEFORE git: a merge carries only what is COMMITTED, so uncommitted work in the
  // workspace would silently not land, and the operator would find out from the diff.
  const dirty = dirtyPaths(workspace.cwd)
  if (dirty === null)
    throw new Error(`the checkout at ${workspace.cwd} is gone — if ${branch} was merged elsewhere, record it with: orc ws finalize ${id}`)
  if (dirty !== '')
    throw new Error(`workspace ${id} has uncommitted changes:\n${dirty}\ncommit or discard them in ${workspace.cwd}, then merge`)
  // The order IS the design. Nothing is recorded until git has merged: a workspace_merged
  // naming a commit that does not exist is a fact no reader could ever falsify. And once it is
  // recorded, nothing below can un-merge it — so every failure past that line is REPORTED with
  // the way out, never thrown as though the merge had not happened.
  const merged = mergeBranch(cfg.projectRoot, branch, trunk)
  // One refusal has a different door. `alreadyContained` means git has nothing left to do —
  // someone merged the branch by hand, or an earlier `ws merge` merged and then failed to
  // record — and git's own "nothing to record" is true but names no next command, which is
  // exactly the dead end this branch removes: recording a merge that already happened is what
  // finalize is for.
  if (!merged.ok)
    throw new Error(merged.reason === MERGE_REFUSAL.alreadyContained
      ? `${branch} is already contained in ${trunk}, but workspace ${id} has no recorded merge — record it with: orc ws finalize ${id}`
      : merged.error)
  // Past this line git HAS merged and nothing can take it back, so the compensation stops
  // being "retry the merge" and becomes "record what is already true".
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

/**
 * Record a merge that happened outside orc — the workspace's branch must already be contained in
 * trunk.
 */
export async function finalizeWorkspaceOp(
  kernel: Pick<Kernel, 'state' | 'mergeWorkspace' | 'setWorkspaceArchived'>,
  cfg: Pick<OrcConfig, 'projectRoot' | 'trunkBranch'>,
  id: string,
  origin: Origin,
): Promise<FinalizeWorkspaceResult> {
  // An ARCHIVED workspace is accepted here, unlike merge: finalize records what has already
  // happened, and "merged by hand, archived, recorded only later" is the exact history this
  // operation exists to repair.
  const { branch, trunk } = await mergeTarget(kernel, cfg, id)
  const tip = revParse(cfg.projectRoot, branch)
  if (tip === null) throw new Error(`branch ${branch} does not exist in ${cfg.projectRoot} — nothing to finalize for workspace ${id}`)
  const landed = isAncestor(cfg.projectRoot, tip, trunk)
  // Three answers, not two: null is git declining to answer (a missing trunk ref), and
  // reporting that as "not merged" would send the operator off to merge something that is.
  if (landed !== true)
    throw new Error(landed === false
      ? `${branch} (${tip}) is not contained in ${trunk} — merge it first, or run: orc ws merge ${id}`
      : `git could not tell whether ${branch} is contained in ${trunk} in ${cfg.projectRoot} — check that both refs exist there`)
  // The tip IS the commit that landed: once it is an ancestor of trunk, the merge-base of the
  // two is the tip itself, so there is no separate landing commit to look up.
  // Nothing irreversible precedes this one: finalize only reads git, so a failed append leaves
  // the world exactly as it was and rerunning the same command is the whole recovery.
  await recordMerge(kernel, id, { mergeCommit: tip, trunk }, `nothing was recorded and nothing was changed — rerun: orc ws finalize ${id}`, origin)
  // No worktree removal: finalize records a merge orc did not make, in a checkout orc may not
  // have created. Deleting it is the operator's call — `orc ws archive <id> --remove`.
  return { workspaceId: id, branch, trunk, mergeCommit: tip }
}

/**
 * Archive a workspace record, and — only with `remove`, and only for a worktree orc created — the
 * checkout behind it.
 *
 * `projectRoot` travels with `remove` rather than being a parameter of its own: archiving the RECORD
 * needs no project context at all, and a signature that asked for one anyway would make `orc ws
 * archive <id>` refuse in a directory where it works today.
 */
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
    // Refuse BEFORE recording: an archive whose removal failed would leave a live directory
    // the tree no longer shows. Only what orc created may be deleted by orc.
    if (!w.managed) throw new Error(`workspace ${id} is not managed by orc (${w.cwd}) — ${ARCHIVE_WITHOUT_REMOVE}`)
    const removed = worktreeRemove(opts.projectRoot, w.cwd)
    // A directory that is already gone gets git's `is not a git worktree`, which names no way
    // out; the way out is the unmanaged one — archive the record alone. A DIRTY tree keeps
    // git's message unchanged: there the answer is the operator's own uncommitted work, and
    // this hint would read as "throw it away".
    if (!removed.ok) throw new Error(existsSync(w.cwd) ? removed.error : `${removed.error} — ${ARCHIVE_WITHOUT_REMOVE}`)
    removedWorktree = w.cwd
  }
  // The mirror of createRequestWorkspace's window, and the one case that does NOT compensate:
  // if this append fails the worktree is already gone and an active record points at a deleted
  // directory. Nothing can undo a `git worktree remove`, so the way out is forward — `orc ws
  // archive <id>` without --remove records what is already true.
  await kernel.setWorkspaceArchived(id, true, origin)
  // `git worktree remove` deletes the tree and leaves the BRANCH — and orc must not delete that: an
  // unmerged orc/<slug> is the only copy of whatever was committed in there, and an archive is not
  // a statement that the work is unwanted. So the branch is named, not removed, and the operator
  // decides. (Observed on a live probe: the directory went, the branch stayed, and nothing said so.)
  return { workspaceId: id, removedWorktree, leftoverBranch: removedWorktree === null ? null : w.branch }
}

// Every workspace mutation requires its caller's origin. Giving a door these verbs instead of the
// kernel keeps retitle and restore from bypassing the same boundary as the other lifecycle writes.
export interface WorkspaceOps {
  create(input: { title: string; spec: string; base: string; task: boolean }, origin: Origin): Promise<{ workspace: Workspace; taskId: string | null; branch: string; base: string }>
  merge(id: string, origin: Origin): Promise<MergeWorkspaceResult>
  finalize(id: string, origin: Origin): Promise<FinalizeWorkspaceResult>
  archive(id: string, opts: { remove: false } | { remove: true; projectRoot: string }, origin: Origin): Promise<ArchiveWorkspaceResult>
  retitle(id: string, title: string, origin: Origin): Promise<Workspace>
  restore(id: string, origin: Origin): Promise<Workspace>
}

// `config` is resolved PER CALL rather than captured: archiving or restoring a RECORD needs no
// project context at all, and a door built where there is none must still serve those.
export function buildWorkspaceOps(deps: { kernel: Kernel; config: () => WorkspaceConfig }): WorkspaceOps {
  const { kernel, config } = deps
  return {
    create: (input, origin) => createRequestWorkspace(kernel, config(), input, origin),
    merge: (id, origin) => mergeWorkspaceOp(kernel, config(), id, origin),
    finalize: (id, origin) => finalizeWorkspaceOp(kernel, config(), id, origin),
    archive: (id, opts, origin) => archiveWorkspaceOp(kernel, id, opts, origin),
    retitle: (id, title, origin) => kernel.retitleWorkspace(id, title, origin),
    // The archive SETTER, not `restoreWorkspace` — that one re-seats a purged record under its old
    // id. Un-archiving is the same event archiving writes, with `archived: false`.
    restore: (id, origin) => kernel.setWorkspaceArchived(id, false, origin),
  }
}
