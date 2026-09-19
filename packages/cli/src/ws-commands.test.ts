import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Door, EVENT_KIND, NO_CHAT, WORKSPACE_KIND, WORKSPACE_STATE, errorMessage, type EventKind, type Workspace, type WorkspaceHealth, type WorkspaceWithHealth } from '@orc/contracts'
import { currentBranch, initializeProject, loadConfig, requireProject } from '@orc/kernel'
import { createTestDb, sh, TEST_PROJECT_ID, tmpGitRepo } from '@orc/kernel/test-helpers'
import { openKernel } from './main'
import { cli } from './test-helpers'
import { buildPlugins } from './runtime'
import { adoptCwd } from './workspace-adopt'

// every `orc ws` command and the boot adoption behind it entered through this door
const CLI = NO_CHAT(Door.cli)
import { listWorkspaceHealth, PROVISIONAL_UNKNOWN } from './workspace-health'
import { renderWorkspaceList, WS_NEEDS_PROJECT } from './ws-commands'
import { ARCHIVE_WITHOUT_REMOVE, WORKSPACE_BRANCH_PREFIX, WORKTREES_DIR } from './workspace-ops'

// What git itself says survived a rolled-back `ws new`. Real git, like the rest of this file and
// like git.test.ts — spelled again here rather than imported, per the no-cross-package-test-import
// convention.
const branches = (repo: string): string[] => {
  const r = Bun.spawnSync(['git', '-C', repo, 'branch', '--format=%(refname:short)'], { stdout: 'pipe', stderr: 'pipe' })
  return new TextDecoder().decode(r.stdout).split('\n').filter(l => l !== '')
}

const dbs: Array<{ drop: () => Promise<void> }> = []
// Unconditional teardown: a real plugin host and an MCP hub are process-scoped, and a bare
// shutdown after the assertions is SKIPPED when one throws — which leaks the host into every later
// test file in the process. Registered at creation, drained LIFO, before the databases go away.
const cleanup: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const c of cleanup.reverse()) await c()
  await Promise.all(dbs.map(d => d.drop()))
}, 30_000)
afterEach(() => mock.restore())

// `orc ws` needs a project context (a real checkout with a projectRoot to hang worktrees off), so
// this is makeCli from main.test.ts plus a throwaway git repo: a tmpGitRepo() main initialized with
// `orc init`, a per-test Postgres database, and the plugin buildProgram wants. host/hub come from
// buildPlugins — the production helper main.test.ts and runtime.test.ts already use for exactly
// this — rather than a stub object, which would need the casts this repo forbids.
async function makeWsCli() {
  const db = await createTestDb()
  dbs.push(db)
  const { main, worktree } = tmpGitRepo()
  initializeProject(main, 'ws-test')
  // A real project gitignores .orc/ — orc's identity file, its settings and the worktrees `ws new`
  // creates all live there. Without it every checkout that has ever run orc reads as dirty, and
  // `ws merge` (which refuses to merge into a dirty trunk) would fail on orc's own files instead of
  // on what the test is about.
  writeFileSync(path.join(main, '.gitignore'), '.orc/\n')
  sh(main, 'add', '.gitignore')
  sh(main, 'commit', '-q', '-m', 'ignore .orc')
  const config = requireProject({ ...loadConfig(main), databaseUrl: db.url, projectId: TEST_PROJECT_ID, projectName: 'ws-test' })
  const { kernel, log, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
  db.onClose(() => storage.close())
  const { host, hub } = await buildPlugins(config)
  cleanup.push(() => hub.close(), () => host.shutdown())
  // bin.ts adopts the checkout it boots in on EVERY command; these tests drive buildProgram
  // directly, so seed the same record here — `ws current` and a task bound to this directory both
  // read it, and without it they would report a project state no real invocation can produce.
  await adoptCwd(kernel, config, CLI)
  // `ws current`'s only check is that the output contains the workspace id, which the retitle and
  // restore lines printed earlier in the same test already did — so only the per-invocation lines
  // cli() hands back are returned, never the buffer.
  const { run } = cli(kernel, undefined, { host, hub, config, log })
  return { run, kernel, log, main, worktree, config }
}

describe('orc ws', () => {
  it('new creates a worktree off HEAD, records a managed workspace and a draft task titled by the request', async () => {
    const { run, kernel, main } = await makeWsCli()
    const lines = await run('ws', 'new', 'Add ingredient search', '--spec', 'find by name')
    const ws = (await kernel.listWorkspaces()).find(w => w.managed)
    expect(ws).toMatchObject({ title: 'Add ingredient search', branch: 'orc/add-ingredient-search', baseBranch: 'main', kind: WORKSPACE_KIND.worktree })
    expect(ws?.cwd).toBe(realpathSync(path.join(main, '.orc', 'worktrees', 'add-ingredient-search')))
    expect(currentBranch(ws?.cwd ?? '')).toBe('orc/add-ingredient-search')
    const task = (await kernel.listTasks()).find(t => t.workspaceId === ws?.id)
    expect(task).toMatchObject({ title: 'Add ingredient search', spec: 'find by name' })
    expect(lines.join('\n')).toContain(`cd ${ws?.cwd}`)
  }, 30_000)

  it('new --no-task creates only the workspace; --base picks the start point', async () => {
    const { run, kernel } = await makeWsCli()
    await run('ws', 'new', 'Spike', '--no-task', '--base', 'main')
    expect((await kernel.listTasks()).length).toBe(0)
    expect((await kernel.listWorkspaces()).find(w => w.managed)?.baseBranch).toBe('main')
    // The line above cannot tell --base from the default: this checkout is ON main, so both
    // readings answer 'main'. tmpGitRepo also leaves a `feature` branch, which only the flag can
    // reach — without this, dropping --base entirely would still pass.
    await run('ws', 'new', 'Off trunk', '--no-task', '--base', 'feature')
    expect((await kernel.listWorkspaces()).find(w => w.title === 'Off trunk')?.baseBranch).toBe('feature')
  }, 30_000)

  it('ls prints active workspaces with task counts; --all includes archived', async () => {
    const { run, kernel } = await makeWsCli()
    const w = await kernel.createWorkspace({ title: 'Old', cwd: '/old', branch: 'x', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false }, CLI)
    await kernel.setWorkspaceArchived(w.id, true, CLI)
    expect((await run('ws', 'ls')).join('\n')).not.toContain('Old')
    expect((await run('ws', 'ls', '--all')).join('\n')).toContain('Old')
  }, 30_000)

  // The health table reaches the terminal here. The STATES themselves are pinned in the kernel's
  // pure table test; what this checks is that `ls` renders the verdict rather than re-deriving one,
  // and that it leads with what needs a human.
  it('ls names each workspace\'s state and dates it, attention first and archived last', async () => {
    const { run, kernel } = await makeWsCli()
    await run('ws', 'new', 'Abandoned', '--no-task')
    await run('ws', 'new', 'Live', '--no-task')
    const abandoned = (await kernel.listWorkspaces()).find(w => w.title === 'Abandoned')
    if (!abandoned) throw new Error('no workspace')
    // the checkout removed behind orc's back — the exact shape of an abandoned request: a branch
    // that will never land and a directory that is not there
    rmSync(abandoned.cwd, { recursive: true, force: true })
    const old = await kernel.createWorkspace({ title: 'Old', cwd: '/old', branch: 'x', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false }, CLI)
    await kernel.setWorkspaceArchived(old.id, true, CLI)

    const lines = await run('ws', 'ls', '--all')
    expect(lines.find(l => l.includes('Abandoned'))).toContain('dangling')
    expect(lines.find(l => l.includes('Live'))).toContain('idle')
    // No threshold anywhere — every row dates itself and the human decides what is stale.
    for (const l of lines.filter(l => l.includes(abandoned.branch ?? '') || l.includes('Live'))) expect(l).toMatch(/\d+[dhm] ago/)
    const text = lines.join('\n')
    expect(text.indexOf('Abandoned')).toBeLessThan(text.indexOf('Live'))       // dangling before idle
    expect(text.indexOf('Live')).toBeLessThan(text.indexOf('[archived]'))      // archived last, whatever its state
  }, 30_000)

  it('archive --remove refuses a dirty managed worktree naming the file, removes a clean one, and never removes an unmanaged checkout', async () => {
    const { run, kernel, main } = await makeWsCli()
    await run('ws', 'new', 'Req', '--no-task')
    const ws = (await kernel.listWorkspaces()).find(w => w.managed)
    if (!ws) throw new Error('no workspace')
    writeFileSync(path.join(ws.cwd, 'wip.txt'), 'x')
    await expect(run('ws', 'archive', ws.id, '--remove')).rejects.toThrow(/wip\.txt/)
    expect((await kernel.listWorkspaces()).find(w => w.id === ws.id)?.archivedAt).toBeNull() // refused = nothing recorded
    rmSync(path.join(ws.cwd, 'wip.txt'))
    const removed = (await run('ws', 'archive', ws.id, '--remove')).join('\n')
    expect(existsSync(ws.cwd)).toBe(false)
    // `git worktree remove` deletes the tree and KEEPS the branch, and orc must not delete it — an
    // unmerged orc/<slug> is the only copy of whatever was committed in there. So the leftover is
    // named, with the command that drops it, and the operator decides. (Observed on a live probe:
    // the directory went, the branch stayed, and nothing said so.)
    expect(branches(main)).toContain(`${WORKSPACE_BRANCH_PREFIX}req`)
    expect(removed).toContain(`git branch -D ${WORKSPACE_BRANCH_PREFIX}req`)
    expect((await kernel.listWorkspaces({ includeArchived: true })).find(w => w.id === ws.id)?.archivedAt).not.toBeNull()
    // …and a --remove whose directory is already gone says what to do about it. git answers "is
    // not a git worktree", which names no way out; the way out is the unmanaged one.
    await expect(run('ws', 'archive', ws.id, '--remove')).rejects.toThrow(ARCHIVE_WITHOUT_REMOVE)
    const adopted = await kernel.ensureWorkspace({ cwd: realpathSync(main), branch: 'main', kind: WORKSPACE_KIND.checkout, onTrunk: true }, CLI)
    await expect(run('ws', 'archive', adopted.workspace.id, '--remove')).rejects.toThrow(/not managed by orc/)
  }, 30_000)

  // Act-then-record has a real window: git creates the tree before there is anything to record. A
  // record refused after that used to leave the worktree and its orc/<slug> branch behind with
  // nothing pointing at them, and the retry then died on "<dest> already exists — archive the old
  // workspace", naming a workspace that never existed. No mocks: a live record already sitting at
  // the destination cwd is what makes the kernel refuse.
  it('a refused record rolls back the worktree and the branch it created, so a retry is not blocked by git leftovers', async () => {
    const { run, kernel, main } = await makeWsCli()
    const slug = 'blocked'
    const branch = `${WORKSPACE_BRANCH_PREFIX}${slug}`
    const dest = path.join(realpathSync(main), ...WORKTREES_DIR, slug)
    await kernel.createWorkspace({ title: 'squatter', cwd: dest, branch: 'x', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false }, CLI)

    const failure = await run('ws', 'new', 'Blocked').catch((e: unknown) => errorMessage(e))
    // the ORIGINAL refusal is what the operator acts on; the rollback is one appended sentence
    expect(failure).toContain('a workspace already exists')
    expect(failure).toContain(`branch ${branch} were removed`)
    expect(existsSync(dest)).toBe(false)
    expect(branches(main)).not.toContain(branch)
  }, 30_000)

  it('merge lands the branch on trunk, records workspace_merged, archives the record and removes the managed worktree', async () => {
    const { run, kernel, main } = await makeWsCli()
    await run('ws', 'new', 'Req', '--spec', 's')
    const ws = (await kernel.listWorkspaces()).find(w => w.managed)
    if (!ws) throw new Error('no workspace')
    writeFileSync(path.join(ws.cwd, 'f.txt'), 'x')
    sh(ws.cwd, 'add', 'f.txt')
    sh(ws.cwd, 'commit', '-q', '-m', 'f')

    const lines = await run('ws', 'merge', ws.id)
    const state = await kernel.state()
    const merge = state.workspaceMerges.get(ws.id)
    expect(merge?.trunk).toBe('main')
    expect(merge?.mergeCommit).toBe(sh(main, 'rev-parse', 'HEAD')) // the commit git actually made
    expect(existsSync(path.join(main, 'f.txt'))).toBe(true)
    expect(state.workspaces.get(ws.id)?.archivedAt).not.toBeNull()
    expect(existsSync(ws.cwd)).toBe(false)
    expect(lines.join('\n')).toContain(merge?.mergeCommit ?? 'no merge recorded')
    // the task drafted in it stays in the log: a merged workspace is archived, never unwound
    expect((await kernel.listTasks()).some(t => t.workspaceId === ws.id)).toBe(true)
    // and the record is what refuses the second merge — before git is asked to do anything, since
    // git's own answer would be a silent "Already up to date" naming the FIRST merge's commit
    await expect(run('ws', 'merge', ws.id)).rejects.toThrow(/already merged/)
  }, 30_000)

  it('merge refuses a dirty workspace naming the file, and records nothing', async () => {
    const { run, kernel, main } = await makeWsCli()
    await run('ws', 'new', 'Req', '--no-task')
    const ws = (await kernel.listWorkspaces()).find(w => w.managed)
    if (!ws) throw new Error('no workspace')
    writeFileSync(path.join(ws.cwd, 'f.txt'), 'x')
    sh(ws.cwd, 'add', 'f.txt')
    sh(ws.cwd, 'commit', '-q', '-m', 'f')
    const trunkHead = sh(main, 'rev-parse', 'HEAD')
    writeFileSync(path.join(ws.cwd, 'wip.txt'), 'x')

    // the commit above is the point: the branch HAS something to land, so the refusal can only be
    // about the uncommitted file — and it names it, because that is the work that would be lost
    await expect(run('ws', 'merge', ws.id)).rejects.toThrow(/wip\.txt/)
    const state = await kernel.state()
    expect(state.workspaceMerges.has(ws.id)).toBe(false)
    expect(state.workspaces.get(ws.id)?.archivedAt).toBeNull()
    expect(existsSync(ws.cwd)).toBe(true)
    expect(sh(main, 'rev-parse', 'HEAD')).toBe(trunkHead) // git was never asked
  }, 30_000)

  // The order claim in the merge handler, and the only test that can falsify it: git fails LAST
  // here, after every refusal the command makes on its own, so a handler that recorded first would
  // leave a workspace_merged naming a merge that never happened — a fact no reader could disprove.
  it('merge records nothing when git itself refuses the merge, and leaves the conflict for the operator', async () => {
    const { run, kernel, main } = await makeWsCli()
    await run('ws', 'new', 'Req', '--no-task')
    const ws = (await kernel.listWorkspaces()).find(w => w.managed)
    if (!ws) throw new Error('no workspace')
    writeFileSync(path.join(ws.cwd, 'README'), 'theirs\n')
    sh(ws.cwd, 'commit', '-q', '-am', 'theirs')
    writeFileSync(path.join(main, 'README'), 'ours\n')
    sh(main, 'commit', '-q', '-am', 'ours')

    await expect(run('ws', 'merge', ws.id)).rejects.toThrow(/CONFLICT[\s\S]*merge --abort/)
    const state = await kernel.state()
    expect(state.workspaceMerges.has(ws.id)).toBe(false)
    expect(state.workspaces.get(ws.id)?.archivedAt).toBeNull()
    expect(existsSync(ws.cwd)).toBe(true)
    expect(existsSync(path.join(main, '.git', 'MERGE_HEAD'))).toBe(true) // git's tree, not orc's to undo
  }, 30_000)

  // The window between "git merged" and "the fact is recorded" is real: an append that fails after
  // a successful merge leaves the branch on trunk with nothing recorded. The retry then meets git's
  // "already contained — nothing to record", which is true and useless. This is that state, reached
  // the way an operator reaches it (a merge made by hand), and the point is that the refusal names
  // the door that DOES work — and that walking through it records the merge.
  it('merge sends an already-landed branch to finalize instead of dead-ending on "nothing to record"', async () => {
    const { run, kernel, main } = await makeWsCli()
    await run('ws', 'new', 'Req', '--no-task')
    const ws = (await kernel.listWorkspaces()).find(w => w.managed)
    if (!ws?.branch) throw new Error('no workspace')
    writeFileSync(path.join(ws.cwd, 'f.txt'), 'x')
    sh(ws.cwd, 'add', 'f.txt')
    sh(ws.cwd, 'commit', '-q', '-m', 'f')
    sh(main, 'merge', '--no-ff', '--no-edit', ws.branch)

    await expect(run('ws', 'merge', ws.id)).rejects.toThrow(/orc ws finalize/)
    expect((await kernel.state()).workspaceMerges.has(ws.id)).toBe(false)
    await run('ws', 'finalize', ws.id)
    expect((await kernel.state()).workspaceMerges.get(ws.id)?.mergeCommit).toBe(sh(ws.cwd, 'rev-parse', 'HEAD'))
  }, 30_000)

  it('finalize records a merge made outside orc, and only once the branch tip is an ancestor of trunk', async () => {
    const { run, kernel, main, worktree } = await makeWsCli()
    const { workspace } = await kernel.ensureWorkspace({ cwd: realpathSync(worktree), branch: 'feature', kind: WORKSPACE_KIND.worktree, onTrunk: false }, CLI)
    writeFileSync(path.join(worktree, 'g.txt'), 'x')
    sh(worktree, 'add', 'g.txt')
    sh(worktree, 'commit', '-q', '-m', 'g')

    // the REFUSAL, not just the branch name: the branch appears in half the messages this command
    // can print, so matching on it alone cannot tell "not merged yet" from "no such branch"
    await expect(run('ws', 'finalize', workspace.id)).rejects.toThrow(/not contained/)
    expect((await kernel.state()).workspaceMerges.has(workspace.id)).toBe(false)

    sh(main, 'merge', '--no-ff', '--no-edit', 'feature') // the merge orc did not make
    const tip = sh(worktree, 'rev-parse', 'HEAD')
    const lines = await run('ws', 'finalize', workspace.id)
    const state = await kernel.state()
    // the TIP is the commit that landed: once it is an ancestor of trunk, the merge-base of the
    // two IS the tip, so there is nothing else to compute
    expect(state.workspaceMerges.get(workspace.id)).toMatchObject({ mergeCommit: tip, trunk: 'main' })
    expect(state.workspaces.get(workspace.id)?.archivedAt).not.toBeNull()
    expect(lines.join('\n')).toContain(tip)
    // finalize RECORDS; removing the checkout stays the operator's call — orc never created it
    expect(existsSync(worktree)).toBe(true)
  }, 30_000)

  // The injection seam, at the door `ws ls` uses. The blanket catch below it is the reason it
  // exists: with the Surreal read hard-wired, "the read model is down" and "the count function threw
  // on a bug of ours" were the same untestable null, and no test could produce either one without a
  // live outage.
  it('ls honours an injected count function — null renders \'?\', a map renders the numbers', async () => {
    const { run, kernel, log, config } = await makeWsCli()
    await run('ws', 'new', 'Counted', '--no-task')
    const counted = (await kernel.listWorkspaces()).find(w => w.managed)
    if (!counted) throw new Error('no workspace')

    const down = await listWorkspaceHealth({ log, config, counts: () => Promise.resolve(null) })
    expect(down.length).toBeGreaterThan(0)
    expect(down.map(r => r.health.provisionalNotes)).toEqual(down.map(() => null))
    // …and the same listing with a real answer: 7 is not a count this project's empty corpus could
    // produce, so a lister that ignored the injection and asked Surreal would not match it
    const up = await listWorkspaceHealth({ log, config, counts: () => Promise.resolve(new Map([[counted.id, 7]])) })
    expect(up.find(r => r.workspace.id === counted.id)?.health.provisionalNotes).toBe(7)
    // absent from the map is a MEASURED zero, never the unknown — the whole point of the split
    const others = up.filter(r => r.workspace.id !== counted.id)
    expect(others.length).toBeGreaterThan(0)
    expect(others.map(r => r.health.provisionalNotes)).toEqual(others.map(() => 0))
  }, 30_000)

  it('retitle and restore append their event stamped with the terminal door and no chat', async () => {
    const { run, kernel, log, main } = await makeWsCli()
    const { workspace } = await kernel.ensureWorkspace({ cwd: realpathSync(main), branch: 'main', kind: WORKSPACE_KIND.checkout, onTrunk: true }, CLI)
    await run('ws', 'retitle', workspace.id, 'Renamed')
    await run('ws', 'archive', workspace.id)
    await run('ws', 'restore', workspace.id)

    const stamps = async (kind: EventKind) => (await log.after(0, [kind])).map(e => ({ chatId: e.chatId, door: e.door }))
    expect(await stamps(EVENT_KIND.workspace_retitled)).toEqual([{ chatId: null, door: Door.cli }])
    // archive, then restore: the SECOND row is the unarchive path, which writes the same event
    expect(await stamps(EVENT_KIND.workspace_archived)).toEqual([{ chatId: null, door: Door.cli }, { chatId: null, door: Door.cli }])
    // …and the events are the ones these commands MEANT to write, not any two of that kind
    expect((await kernel.listWorkspaces())[0]).toMatchObject({ title: 'Renamed', archivedAt: null })
  }, 30_000)

  it('refuses every subcommand that needs a checkout in one wording, and still archives a record without one', async () => {
    const { kernel, main } = await makeWsCli()
    const { workspace } = await kernel.ensureWorkspace({ cwd: realpathSync(main), branch: 'main', kind: WORKSPACE_KIND.checkout, onTrunk: true }, CLI)
    const { run } = cli(kernel)
    for (const args of [['ws', 'ls'], ['ws', 'current'], ['ws', 'new', 'Req'], ['ws', 'archive', workspace.id, '--remove']])
      await expect(run(...args)).rejects.toThrow(WS_NEEDS_PROJECT)
    await run('ws', 'archive', workspace.id)
    expect((await kernel.listWorkspaces({ includeArchived: true })).find(w => w.id === workspace.id)?.archivedAt).not.toBeNull()
  }, 30_000)

  it('retitle, restore and current round-trip', async () => {
    const { run, kernel, main } = await makeWsCli()
    const { workspace } = await kernel.ensureWorkspace({ cwd: realpathSync(main), branch: 'main', kind: WORKSPACE_KIND.checkout, onTrunk: true }, CLI)
    await run('ws', 'retitle', workspace.id, 'Main line')
    await run('ws', 'archive', workspace.id)
    // the adopted checkout was this project's only workspace, so the listing is now empty — and
    // says so, rather than printing nothing at all
    expect(await run('ws', 'ls')).toEqual(['_no workspaces_'])
    await run('ws', 'restore', workspace.id)
    expect((await kernel.listWorkspaces())[0]).toMatchObject({ title: 'Main line', archivedAt: null })
    // the RENDER, not just the id: the id alone is printed by half the commands in this file, so
    // an assertion on it cannot tell `current` apart from the lines above it
    const current = (await run('ws', 'current')).join('\n')
    expect(current).toContain(workspace.id)
    expect(current).toContain('Main line')
    expect(current).toContain(`(${WORKSPACE_KIND.checkout}, main)`)
  }, 30_000)

  // Re-adoption mints a record, and a mint knows only what it can DERIVE from the directory. Two
  // facts about an orc-created worktree are not derivable — `managed` (orc made this tree, so orc
  // may delete it) and `baseBranch` (what it was cut from) — and losing them silently DEMOTES the
  // workspace: `archive --remove` then refuses "not managed by orc" for a tree orc itself created,
  // and `ws merge` leaves it on disk. The prior record is the only source of both, which is exactly
  // why the caller that has one hands them back.
  it('a branch switch inside an orc-created worktree keeps it managed, so --remove still works', async () => {
    const { run, kernel, config } = await makeWsCli()
    await run('ws', 'new', 'Req', '--no-task')
    const before = (await kernel.listWorkspaces()).find(w => w.managed)
    if (!before) throw new Error('no managed workspace')
    expect(before).toMatchObject({ baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: true })

    // the switch happens INSIDE the worktree, so adoption runs against its config, not the root's
    sh(before.cwd, 'checkout', '-b', 'other', '--quiet')
    const after = await adoptCwd(kernel, { ...config, dir: before.cwd }, CLI)
    expect(after.id).not.toBe(before.id)
    expect(after).toMatchObject({
      branch: 'other', managed: true, baseBranch: 'main', kind: WORKSPACE_KIND.worktree, cwd: before.cwd,
    })
    expect((await kernel.listWorkspaces({ includeArchived: true })).find(w => w.id === before.id)?.archivedAt).not.toBeNull()

    // the acceptance: the licence to delete survived the switch
    await run('ws', 'archive', after.id, '--remove')
    expect(existsSync(after.cwd)).toBe(false)
  }, 30_000)

  // The terminal half of the branch-change re-adoption. `ws current` reads the ACTIVE record at this
  // cwd, so after a switch it must name the NEW one — the archived record is still at the same path
  // and a lookup that matched it would report the branch this checkout is no longer on.
  it('current names the record minted by a branch switch, not the archived one it replaced', async () => {
    const { run, kernel, main, config } = await makeWsCli()
    const before = (await run('ws', 'current')).join('\n')
    expect(before).toContain(`(${WORKSPACE_KIND.checkout}, main)`)
    sh(main, 'checkout', '-b', 'feature2', '--quiet')
    const after = await adoptCwd(kernel, config, CLI)

    const current = (await run('ws', 'current')).join('\n')
    expect(current).toContain(after.id)
    expect(current).toContain(`(${WORKSPACE_KIND.checkout}, feature2)`)
    expect(current).not.toContain('main')
  }, 30_000)
})

// The rendering on its own, against health values no checkout on this machine could produce: an
// unreachable note read model, and a merge whose state column says something else. Pure, so it needs
// none of the harness above.
describe('renderWorkspaceList', () => {
  const NOW = new Date('2026-09-14T12:00:00.000Z')
  const w = (extra: Partial<Workspace> = {}): Workspace => ({
    id: '11111111-1111-4111-8111-111111111111', title: 'Req', cwd: '/repo/.orc/worktrees/req',
    branch: 'orc/req', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: true, onTrunk: false,
    createdAt: '2026-09-14T00:00:00.000Z', archivedAt: null, ...extra,
  })
  const h = (extra: Partial<WorkspaceHealth> = {}): WorkspaceHealth => ({
    state: WORKSPACE_STATE.idle, lastActivityAt: '2026-09-14T11:00:00.000Z',
    taskCount: 1, openTaskCount: 0, merged: false, provisionalNotes: 0, dirExists: true, clean: true, ...extra,
  })
  const render = (rows: WorkspaceWithHealth[]): string => renderWorkspaceList(rows, NOW).join('\n')

  // The flag, not the state column: `ws merge` archives the record and every rung above `merged`
  // shadows the state, so `[merged]` is the only place "this work landed" survives to the terminal.
  it('flags a merged workspace beside archived and dirty, even when the state column says otherwise', () => {
    expect(render([{ workspace: w(), health: h({ merged: true, state: WORKSPACE_STATE.active }) }]))
      .toContain('[merged]')
    const all = render([{ workspace: w({ archivedAt: '2026-09-14T11:30:00.000Z' }), health: h({ merged: true, clean: false }) }])
    for (const flag of ['[archived]', '[dirty]', '[merged]']) expect(all).toContain(flag)
    // and an unmerged workspace carries no flag at all — otherwise the assertion above would pass
    // for a renderer that printed it unconditionally
    expect(render([{ workspace: w(), health: h() }])).not.toContain('[merged]')
  })

  it('renders an uncountable note corpus as the unknown marker and says it is not a zero', () => {
    const unknown = render([{ workspace: w(), health: h({ provisionalNotes: null }) }])
    expect(unknown).toContain(`${PROVISIONAL_UNKNOWN} prov`)
    expect(unknown).toContain('this is not a count of none')
    // a counted listing prints the number and drops the footnote — the sentence explains a marker
    // that is not on the page otherwise
    const counted = render([{ workspace: w(), health: h({ provisionalNotes: 4 }) }])
    expect(counted).toContain('4 prov')
    expect(counted).not.toContain('this is not a count of none')
  })
})
