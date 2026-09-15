import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WORKSPACE_KIND } from '@orc/contracts'
import { initializeProject, loadConfig, requireProject, type Kernel } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID, tmpGitRepo } from '@orc/kernel/test-helpers'
import { openKernel } from './main'
import { adoptCwd, DEFAULT_TRUNK, resolveTrunk } from './workspace-adopt'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { await Promise.all(dbs.map(d => d.drop())) }, 30_000)

// A kernel per case, not one for the file: the first case counts the workspaces in the whole
// project, which only answers honestly against a log nothing else appends to.
async function freshKernel(): Promise<Kernel> {
  const db = await createTestDb()
  dbs.push(db)
  const { kernel, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
  db.onClose(() => storage.close())
  return kernel
}

// real git against a throwaway repo (the same choice git.test.ts makes) — these cases are about
// what git actually answers, so a stub would only pin our idea of it
function git(dir: string, ...args: string[]): void {
  const r = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr))
}

// git.test.ts's recipe: `symbolic-ref` resolves a target that need not exist, so a repo with no
// remote at all can still answer `defaultBranch` — which is what makes the git rung testable.
function setOriginHead(repo: string, branch: string): void {
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`)
}

describe('resolveTrunk', () => {
  // The one answer to "which branch is trunk", asked by adoption (about the checkout you stand in)
  // and by `orc ws merge` (about the project root that owns trunk). Three rungs, and each has to be
  // reachable on its own — a fallback that silently answered 'main' for a `develop` repo is exactly
  // the failure the operator rung exists to prevent.
  it('answers operator → git → default, for the directory it is asked about', () => {
    const { main } = tmpGitRepo()
    expect(resolveTrunk({}, main)).toBe(DEFAULT_TRUNK) // no origin at all in a throwaway repo
    setOriginHead(main, 'develop')
    expect(resolveTrunk({}, main)).toBe('develop')
    expect(resolveTrunk({ trunkBranch: 'release' }, main)).toBe('release')
    // outside git there is no rung below the operator's own setting
    expect(resolveTrunk({}, mkdtempSync(path.join(tmpdir(), 'orc-nogit-')))).toBe(DEFAULT_TRUNK)
  })
})

describe('adoptCwd', () => {
  it('the main checkout adopts as `checkout`, a worktree as `worktree`, each exactly once', async () => {
    const kernel = await freshKernel()
    const { main, worktree } = tmpGitRepo()
    initializeProject(main, 'p')
    const mainWs = await adoptCwd(kernel, requireProject(loadConfig(main)))
    const wtWs = await adoptCwd(kernel, requireProject(loadConfig(worktree)))
    // no origin in a throwaway repo, so defaultBranch is null and the trunk falls back to
    // DEFAULT_TRUNK — the main checkout is on it, the worktree's `feature` is not
    expect(mainWs).toMatchObject({ kind: WORKSPACE_KIND.checkout, branch: 'main', cwd: realpathSync(main), managed: false, onTrunk: true })
    expect(wtWs).toMatchObject({ kind: WORKSPACE_KIND.worktree, branch: 'feature', title: 'feature', managed: false, onTrunk: false })
    expect((await adoptCwd(kernel, requireProject(loadConfig(worktree)))).id).toBe(wtWs.id)
    expect((await kernel.listWorkspaces()).length).toBe(2)
  }, 30_000)

  it('git\'s origin/HEAD names the trunk when the operator has not: a repo whose trunk is not `main`', async () => {
    const kernel = await freshKernel()
    const { main, worktree } = tmpGitRepo()
    initializeProject(main, 'p')
    // the discriminating shape: this repo's trunk is `feature`, which is NOT DEFAULT_TRUNK, so only
    // the git rung can answer — drop it and the worktree reads as off-trunk
    setOriginHead(main, 'feature')
    const wtWs = await adoptCwd(kernel, requireProject(loadConfig(worktree)))
    expect(wtWs).toMatchObject({ branch: 'feature', onTrunk: true })
    // and the main checkout, on `main`, is off-trunk in such a repo
    expect((await adoptCwd(kernel, requireProject(loadConfig(main)))).onTrunk).toBe(false)
  }, 30_000)

  it('the operator\'s trunkBranch wins over git\'s origin/HEAD', async () => {
    const kernel = await freshKernel()
    const { main, worktree } = tmpGitRepo()
    initializeProject(main, 'p')
    // git says the trunk is `feature`; the operator says it is `main`. The operator decides, so the
    // worktree sitting on `feature` is NOT trunk and its notes stay provisional until it merges.
    setOriginHead(main, 'feature')
    const wtWs = await adoptCwd(kernel, { ...requireProject(loadConfig(worktree)), trunkBranch: 'main' })
    expect(wtWs).toMatchObject({ branch: 'feature', onTrunk: false })
  }, 30_000)

  it('a project directory outside git adopts as trunk — there is no branch it could be behind', async () => {
    const kernel = await freshKernel()
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-nogit-'))
    initializeProject(dir, 'p')
    const ws = await adoptCwd(kernel, requireProject(loadConfig(dir)))
    expect(ws).toMatchObject({ kind: WORKSPACE_KIND.checkout, branch: null, onTrunk: true })
  }, 30_000)

  // `onTrunk` is captured at adoption and never re-derived, which is what makes a BRANCH SWITCH a
  // re-adoption rather than a no-op. Without this, a main checkout moved to a feature branch kept
  // the record it was adopted with: `onTrunk: true`, branch `main`. Every note written from there
  // would read as final project knowledge while it sat on an unmerged branch — and no merge of that
  // branch could ever clear it, because the workspace the notes name is the trunk record.
  it('a checkout that switched branches is re-adopted: the old record is archived, a new one carries the new branch', async () => {
    const kernel = await freshKernel()
    const { main } = tmpGitRepo()
    initializeProject(main, 'p')
    const config = requireProject(loadConfig(main))
    const before = await adoptCwd(kernel, config)
    expect(before).toMatchObject({ branch: 'main', onTrunk: true })

    git(main, 'checkout', '-b', 'feature2', '--quiet')
    const after = await adoptCwd(kernel, config)
    expect(after.id).not.toBe(before.id)
    expect(after).toMatchObject({ branch: 'feature2', onTrunk: false, cwd: realpathSync(main) })
    // the old record is FINISHED BUSINESS, not a second live record for one directory —
    // workspaceByCwd answers whichever active record it finds first, so two would be a coin flip
    const all = await kernel.listWorkspaces({ includeArchived: true })
    expect(all.find(w => w.id === before.id)?.archivedAt).not.toBeNull()
    expect((await kernel.listWorkspaces()).map(w => w.id)).toEqual([after.id])

    // …and adoption is still idempotent when nothing moved: a third command on `feature2` must not
    // archive-and-mint on every invocation, which would be one workspace record per orc command
    expect((await adoptCwd(kernel, config)).id).toBe(after.id)
    expect((await kernel.listWorkspaces()).map(w => w.id)).toEqual([after.id])
  }, 30_000)

  it('a detached HEAD inside a repo is never trunk — there IS a trunk, this checkout is just not on it', async () => {
    const kernel = await freshKernel()
    const { main } = tmpGitRepo()
    initializeProject(main, 'p')
    git(main, 'checkout', '--detach', '--quiet')
    const ws = await adoptCwd(kernel, requireProject(loadConfig(main)))
    expect(ws).toMatchObject({ kind: WORKSPACE_KIND.checkout, branch: null, onTrunk: false })
  }, 30_000)
})
