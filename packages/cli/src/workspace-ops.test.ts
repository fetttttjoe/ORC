import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Door, WORKSPACE_KIND, errorMessage, type Origin, type Workspace } from '@orc/contracts'
import { initializeProject, loadConfig, requireProject, type Kernel, type ProjectConfig } from '@orc/kernel'
import { createTestDb, sh, TEST_PROJECT_ID, tmpGitRepo } from '@orc/kernel/test-helpers'
import { openKernel } from './main'
import { createRequestWorkspace, finalizeWorkspaceOp, HEAD_REF, mergeWorkspaceOp, shellQuote } from './workspace-ops'

// the windows a command line cannot reach: the append failing after git merged, the record refused

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { await Promise.all(dbs.map(d => d.drop())) }, 30_000)

// real kernel, log and git: the failures are about the order real appends and merges happen in
async function makeOps(): Promise<{ kernel: Kernel; config: ProjectConfig; main: string; worktree: string }> {
  const db = await createTestDb()
  dbs.push(db)
  const { main, worktree } = tmpGitRepo()
  initializeProject(main, 'ws-ops-test')
  // a real project gitignores .orc/, or orc's own files make every checkout read as dirty
  writeFileSync(path.join(main, '.gitignore'), '.orc/\n')
  sh(main, 'add', '.gitignore')
  sh(main, 'commit', '-q', '-m', 'ignore .orc')
  const config = requireProject({ ...loadConfig(main), databaseUrl: db.url, projectId: TEST_PROJECT_ID, projectName: 'ws-ops-test' })
  const { kernel, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config })
  db.onClose(() => storage.close())
  return { kernel, config, main, worktree }
}

// ONE method replaced on a real kernel: everything else must behave as in production
const withFailingMerge = (kernel: Kernel, error: string): Pick<Kernel, 'state' | 'mergeWorkspace' | 'setWorkspaceArchived'> => ({
  state: () => kernel.state(),
  mergeWorkspace: () => Promise.reject(new Error(error)),
  setWorkspaceArchived: (id: string, archived: boolean, origin: Origin) => kernel.setWorkspaceArchived(id, archived, origin),
})

const CLI: Origin = { chatId: 'chat-ws', door: Door.cli }

async function seedBranchWorkspace(kernel: Kernel, worktree: string): Promise<Workspace> {
  writeFileSync(path.join(worktree, 'f.txt'), 'x')
  sh(worktree, 'add', 'f.txt')
  sh(worktree, 'commit', '-q', '-m', 'f')
  // managed: false, so no removal is attempted and the failure under test stays the append's
  return kernel.createWorkspace({
    title: 'Req', cwd: sh(worktree, 'rev-parse', '--show-toplevel'), branch: 'feature',
    baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false,
  }, CLI)
}

describe('the window between git merging and the log recording it', () => {
  // git merges, THEN the append fails: the error names the commit on trunk and the recording command
  it('mergeWorkspaceOp reports the commit git already made and sends the operator to finalize', async () => {
    const { kernel, config, main, worktree } = await makeOps()
    const ws = await seedBranchWorkspace(kernel, worktree)

    const failure = await mergeWorkspaceOp(withFailingMerge(kernel, 'the log refused the append'), config, ws.id, CLI)
      .then(() => 'no error', (e: unknown) => errorMessage(e))
    // the ORIGINAL failure survives with one sentence appended, not buried one .cause deep
    expect(failure).toContain('the log refused the append')
    const mergeCommit = sh(main, 'rev-parse', 'HEAD')
    expect(failure).toContain(mergeCommit)
    expect(failure).toContain(`orc ws finalize ${ws.id}`)

    // git really did merge, and nothing recorded it — the exact state the sentence describes
    expect(existsSync(path.join(main, 'f.txt'))).toBe(true)
    const state = await kernel.state()
    expect(state.workspaceMerges.has(ws.id)).toBe(false)
    expect(state.workspaces.get(ws.id)?.archivedAt).toBeNull()

    // and the door it names is a door: finalize records the merge that is already on trunk
    const recorded = await finalizeWorkspaceOp(kernel, config, ws.id, CLI)
    expect(recorded.mergeCommit).toBe(sh(worktree, 'rev-parse', 'HEAD'))
    expect((await kernel.state()).workspaces.get(ws.id)?.archivedAt).not.toBeNull()
  }, 30_000)

  // finalize only reads git, so a failed append changed nothing: the sentence is the caller's
  it('finalizeWorkspaceOp says nothing was recorded and nothing changed — rerun it', async () => {
    const { kernel, config, main, worktree } = await makeOps()
    const ws = await seedBranchWorkspace(kernel, worktree)
    sh(main, 'merge', '--no-ff', '--no-edit', 'feature') // the merge orc did not make

    const failure = await finalizeWorkspaceOp(withFailingMerge(kernel, 'the log refused the append'), config, ws.id, CLI)
      .then(() => 'no error', (e: unknown) => errorMessage(e))
    expect(failure).toContain('nothing was recorded and nothing was changed')
    expect(failure).toContain(`rerun: orc ws finalize ${ws.id}`)
    const state = await kernel.state()
    expect(state.workspaceMerges.has(ws.id)).toBe(false)
    expect(state.workspaces.get(ws.id)?.archivedAt).toBeNull()
  }, 30_000)
})

describe('the window between git creating a worktree and the log recording it', () => {
  // past the workspace record the rollback STOPS: this window compensates with a copyable command
  it('the recovery command carries the spec and survives a title with an apostrophe', async () => {
    const { kernel, config } = await makeOps()
    const failing = {
      createWorkspace: (input: Parameters<Kernel['createWorkspace']>[0], origin: Origin) => kernel.createWorkspace(input, origin),
      createTask: () => Promise.reject(new Error('the log refused the task')),
    }
    const title = "Don't lose this"
    const spec = "find by name, don't guess"
    const failure = await createRequestWorkspace(failing, config, { title, spec, base: HEAD_REF, task: true }, CLI)
      .then(() => 'no error', (e: unknown) => errorMessage(e))

    const ws = (await kernel.listWorkspaces()).find(w => w.title === title)
    if (!ws) throw new Error('the workspace should have been recorded before the task was attempted')
    // the workspace IS recorded, so the sentence must not offer to delete anything
    expect(failure).toContain(`the workspace is recorded (${ws.id}`)
    // the SPEC is the request itself: a recovery command that dropped it recreated an empty task
    expect(failure).toContain(`--spec ${shellQuote(spec)}`)
    // the apostrophe does not end the quoting: the command breaks when a human is recovering
    expect(failure).toContain(`orc new ${shellQuote(title)} --workspace ${ws.id}`)
    expect(failure).toContain(`'Don'\\''t lose this'`)
  }, 30_000)

  // --no-task and an empty --spec are both ordinary, and neither should produce `--spec ''`
  it('omits --spec entirely when the request has none', async () => {
    const { kernel, config } = await makeOps()
    const failing = {
      createWorkspace: (input: Parameters<Kernel['createWorkspace']>[0], origin: Origin) => kernel.createWorkspace(input, origin),
      createTask: () => Promise.reject(new Error('the log refused the task')),
    }
    const failure = await createRequestWorkspace(failing, config, { title: 'Spike', spec: '', base: HEAD_REF, task: true }, CLI)
      .then(() => 'no error', (e: unknown) => errorMessage(e))
    expect(failure).toContain('orc new ')
    expect(failure).not.toContain('--spec')
  }, 30_000)
})

describe('the setup step between git creating the worktree and the log recording it', () => {
  it('runs the configured argv inside the new worktree', async () => {
    const { kernel, config } = await makeOps()
    const cfg = { ...config, workspaceSetup: ['sh', '-c', 'echo ready > setup.marker'] }
    const r = await createRequestWorkspace(kernel, cfg, { title: 'Setup', spec: '', base: HEAD_REF, task: false }, CLI)
    expect(existsSync(path.join(r.workspace.cwd, 'setup.marker'))).toBe(true)
  }, 30_000)

  it('a failing setup names the command and its stderr, and leaves neither worktree nor record', async () => {
    const { kernel, config } = await makeOps()
    const cfg = { ...config, workspaceSetup: ['sh', '-c', 'echo no lockfile >&2; exit 3'] }
    const failure = await createRequestWorkspace(kernel, cfg, { title: 'Broken setup', spec: '', base: HEAD_REF, task: true }, CLI)
      .then(() => 'no error', (e: unknown) => errorMessage(e))
    expect(failure).toContain('workspaceSetup')
    expect(failure).toContain('no lockfile')
    expect(failure).toContain('exit 3')
    expect(existsSync(path.join(config.projectRoot, '.orc', 'worktrees', 'broken-setup'))).toBe(false)
    expect((await kernel.listWorkspaces()).some(w => w.title === 'Broken setup')).toBe(false)
  }, 30_000)
})

// POSIX single quotes, always: the caller cannot see the value, so no 'only when dangerous' arm
describe('shellQuote', () => {
  it('quotes every argument and closes-escapes-reopens around an embedded quote', () => {
    expect(shellQuote('plain')).toBe("'plain'")
    expect(shellQuote('two words')).toBe("'two words'")
    expect(shellQuote("Don't")).toBe(`'Don'\\''t'`)
    expect(shellQuote('')).toBe("''") // an empty argument still has to BE an argument
    // the shell's own reading is the assertion: echo of the quoted form returns the original
    const value = "a'b c$d \"e\""
    expect(Bun.spawnSync(['sh', '-c', `printf %s ${shellQuote(value)}`], { stdout: 'pipe' }).stdout.toString()).toBe(value)
  })
})
