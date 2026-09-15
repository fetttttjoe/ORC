import { realpathSync } from 'node:fs'
import { WORKSPACE_KIND, type Workspace } from '@orc/contracts'
import { currentBranch, defaultBranch, gitDirs, type Kernel, type OrcConfig } from '@orc/kernel'

// The trunk name assumed when neither the operator (`trunkBranch`) nor git (origin/HEAD) names one —
// a fresh repository with no remote answers nothing at all. A constant, not a literal at the call
// site: the same fallback has to be quotable by whatever later explains why a workspace is onTrunk.
export const DEFAULT_TRUNK = 'main'

/**
 * Which branch this project treats as trunk, resolved operator → git → constant: only the
 * operator's `trunkBranch` can be right for a repo whose origin/HEAD is unset or names a branch
 * they do not treat as trunk, and the constant answers a fresh repository that has no remote to ask.
 *
 * `dir` is a PARAMETER, not `config.dir`, because the callers ask about different directories on
 * purpose: adoption asks about the checkout the command is standing in, while `orc ws merge` asks
 * about the project root that owns trunk. One function so the three rungs cannot drift — spelled
 * twice, an operator's `develop` would be honoured at adoption and silently become `main` at merge.
 */
export function resolveTrunk(config: Pick<OrcConfig, 'trunkBranch'>, dir: string): string {
  return config.trunkBranch ?? defaultBranch(dir) ?? DEFAULT_TRUNK
}

// "cd into any checkout and orc works": the checkout this command runs in is recorded as a
// workspace on first use. A read-only command appending an event is deliberate — "this checkout is
// being worked in" is a fact worth one event per checkout lifetime, and it is what lets a Paseo
// worktree show up in the tree without anyone registering it. Realpath, because the fold matches
// on the exact string and a symlinked path would mint a duplicate on every alias.
//
// `onTrunk` is captured HERE, at adoption, rather than derived later: it is a fact about the
// checkout at that moment, and notes written on trunk are final by construction while everywhere
// else they stay provisional until the workspace merges. Deriving it at read time would re-answer
// the question against a branch that has since moved. Which branch counts as trunk is resolveTrunk's
// question, asked here about the checkout this command is standing in.
//
// "No branch" splits into two OPPOSITE answers, which is why gitDirs is probed rather than reading
// `branch === null` alone. Outside git there are no branches at all, so there is nothing this
// directory could be behind and no merge that could ever arrive: read as off-trunk, a non-git
// project's knowledge would stay provisional forever, with no reachable event that could finalise
// it. A detached HEAD is the other case — the repository HAS a trunk, this checkout is simply not
// on it, and a merge is exactly what would settle that — so it stays off-trunk.
export async function adoptCwd(
  kernel: Pick<Kernel, 'ensureWorkspace' | 'setWorkspaceArchived'>,
  config: Pick<OrcConfig, 'dir' | 'projectRoot' | 'trunkBranch'>,
): Promise<Workspace> {
  const cwd = realpathSync(config.dir)
  const kind = config.dir === config.projectRoot ? WORKSPACE_KIND.checkout : WORKSPACE_KIND.worktree
  // ponytail: three git spawns per adoption — currentBranch, defaultBranch (inside resolveTrunk) and
  // gitDirs — on EVERY orc command, since adoption runs at boot before any handler. Unmeasured, and
  // three ~5ms spawns is not what anyone will notice first. The upgrade is ONE combined
  // `git rev-parse --abbrev-ref HEAD --git-dir --git-common-dir`, whose three output lines answer
  // all three questions; resolveTrunk's `defaultBranch` rung is the only one that would still need
  // its own call, and only in a repo the operator has not given a `trunkBranch`.
  const branch = currentBranch(config.dir)
  const trunk = resolveTrunk(config, config.dir)
  const onTrunk = gitDirs(config.dir) === null || (branch !== null && branch === trunk)
  const first = await kernel.ensureWorkspace({ cwd, branch, kind, onTrunk })
  const prior = first.workspace
  if (first.created || prior.branch === branch) return prior
  // A CHECKOUT THAT MOVED IS A DIFFERENT WORKSPACE. `ensureWorkspace` keys on cwd alone and keeps
  // the record it finds, branch and onTrunk included — correctly, since it cannot know whether a
  // difference means "re-adopt" or "an adoption racing a branch switch". The caller decides, and
  // here the decision is forced: a main checkout switched to a feature branch would otherwise keep
  // `onTrunk: true`, so every note written from it would read as settled trunk knowledge while
  // sitting on an unmerged branch — and no merge could ever clear it, because the workspace those
  // notes name is the trunk record itself.
  //
  // Archive-then-mint, not mutate: the old record is what the tasks and notes written before the
  // switch belong to, and rewriting its branch would retroactively relabel their standing.
  //
  // Three fields are CARRIED OVER, because a mint can only derive what the directory shows and these
  // are not on the directory. `managed` is the licence to `git worktree remove` — dropped, a worktree
  // `orc ws new` created comes back unmanaged and `archive --remove` refuses to delete orc's own
  // tree. `baseBranch` is what it was cut from, which nothing can re-derive once the branch moved.
  // `kind` is passed from the prior record rather than the `kind` derived above so the two can never
  // disagree: the derivation reads config.projectRoot, which resolves differently depending on
  // whether the worktree tracks its own .orc/config.json, and a checkout must not change kind by
  // switching branch. Everything else is adoption's to answer afresh — the TITLE included, which
  // re-derives from the new branch: carrying it would freeze the OLD branch name onto a record that
  // is no longer on it, and `orc ws retitle` is the one command that fixes a label.
  await kernel.setWorkspaceArchived(prior.id, true)
  return (await kernel.ensureWorkspace({
    cwd, branch, onTrunk, kind: prior.kind, managed: prior.managed, baseBranch: prior.baseBranch,
  })).workspace
}
