import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Door, NO_CHAT, WORKSPACE_KIND } from '@orc/contracts'
import { initializeProject, loadConfig, requireProject, type Kernel } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID, testOrcConfig, tmpGitRepo } from '@orc/kernel/test-helpers'
import { openKernel } from './main'
import { adoptCwd, DEFAULT_TRUNK, resolveTrunk } from './workspace-adopt'

// adoption runs at boot of every CLI command — that is the door these tests stand in for
const CLI = NO_CHAT(Door.cli)

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { await Promise.all(dbs.map(d => d.drop())) }, 30_000)

// a kernel per case: the first case counts the project's workspaces, which needs a private log
async function freshKernel(): Promise<Kernel> {
  const db = await createTestDb()
  dbs.push(db)
  const { kernel, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
  db.onClose(() => storage.close())
  return kernel
}

// real git on a throwaway repo: a stub would only pin our idea of what git answers
function git(dir: string, ...args: string[]): void {
  const r = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr))
}

// `symbolic-ref` resolves a target that need not exist, so a remote-less repo answers defaultBranch
function setOriginHead(repo: string, branch: string): void {
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`)
}

describe('resolveTrunk', () => {
  // each rung reachable on its own: a silent 'main' for a `develop` repo is the failure to prevent
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
    const mainWs = await adoptCwd(kernel, requireProject(loadConfig(main)), CLI)
    const wtWs = await adoptCwd(kernel, requireProject(loadConfig(worktree)), CLI)
    expect(mainWs).toMatchObject({ kind: WORKSPACE_KIND.checkout, branch: 'main', cwd: realpathSync(main), managed: false, onTrunk: true })
    expect(wtWs).toMatchObject({ kind: WORKSPACE_KIND.worktree, branch: 'feature', title: 'feature', managed: false, onTrunk: false })
    expect((await adoptCwd(kernel, requireProject(loadConfig(worktree)), CLI)).id).toBe(wtWs.id)
    expect((await kernel.listWorkspaces()).length).toBe(2)
  }, 30_000)

  it('git\'s origin/HEAD names the trunk when the operator has not: a repo whose trunk is not `main`', async () => {
    const kernel = await freshKernel()
    const { main, worktree } = tmpGitRepo()
    initializeProject(main, 'p')
    // the discriminating shape: trunk is `feature`, not DEFAULT_TRUNK, so only the git rung can answer
    setOriginHead(main, 'feature')
    const wtWs = await adoptCwd(kernel, requireProject(loadConfig(worktree)), CLI)
    expect(wtWs).toMatchObject({ branch: 'feature', onTrunk: true })
    // and the main checkout, on `main`, is off-trunk in such a repo
    expect((await adoptCwd(kernel, requireProject(loadConfig(main)), CLI)).onTrunk).toBe(false)
  }, 30_000)

  it('the operator\'s trunkBranch wins over git\'s origin/HEAD', async () => {
    const kernel = await freshKernel()
    const { main, worktree } = tmpGitRepo()
    initializeProject(main, 'p')
    // git says trunk is `feature`, the operator says `main`: the operator decides
    setOriginHead(main, 'feature')
    const wtWs = await adoptCwd(kernel, { ...requireProject(loadConfig(worktree)), trunkBranch: 'main' }, CLI)
    expect(wtWs).toMatchObject({ branch: 'feature', onTrunk: false })
  }, 30_000)

  it('a project directory outside git adopts as trunk — there is no branch it could be behind', async () => {
    const kernel = await freshKernel()
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-nogit-'))
    initializeProject(dir, 'p')
    const ws = await adoptCwd(kernel, requireProject(loadConfig(dir)), CLI)
    expect(ws).toMatchObject({ kind: WORKSPACE_KIND.checkout, branch: null, onTrunk: true })
  }, 30_000)

  // onTrunk is captured at adoption: a branch switch is a re-adoption, not a no-op
  it('a checkout that switched branches is re-adopted: the old record is archived, a new one carries the new branch', async () => {
    const kernel = await freshKernel()
    const { main } = tmpGitRepo()
    initializeProject(main, 'p')
    const config = requireProject(loadConfig(main))
    const before = await adoptCwd(kernel, config, CLI)
    expect(before).toMatchObject({ branch: 'main', onTrunk: true })

    git(main, 'checkout', '-b', 'feature2', '--quiet')
    const after = await adoptCwd(kernel, config, CLI)
    expect(after.id).not.toBe(before.id)
    expect(after).toMatchObject({ branch: 'feature2', onTrunk: false, cwd: realpathSync(main) })
    // the old record is finished business: two live records for one directory would be a coin flip
    const all = await kernel.listWorkspaces({ includeArchived: true })
    expect(all.find(w => w.id === before.id)?.archivedAt).not.toBeNull()
    expect((await kernel.listWorkspaces()).map(w => w.id)).toEqual([after.id])

    // adoption is idempotent when nothing moved: no archive-and-mint on every invocation
    expect((await adoptCwd(kernel, config, CLI)).id).toBe(after.id)
    expect((await kernel.listWorkspaces()).map(w => w.id)).toEqual([after.id])
  }, 30_000)

  it('a detached HEAD inside a repo is never trunk — there IS a trunk, this checkout is just not on it', async () => {
    const kernel = await freshKernel()
    const { main } = tmpGitRepo()
    initializeProject(main, 'p')
    git(main, 'checkout', '--detach', '--quiet')
    const ws = await adoptCwd(kernel, requireProject(loadConfig(main)), CLI)
    expect(ws).toMatchObject({ kind: WORKSPACE_KIND.checkout, branch: null, onTrunk: false })
  }, 30_000)
})
