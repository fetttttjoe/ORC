import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AUTHOR_SOURCE, Brief, Door, EVENT_KIND, MemoryScope, NO_CHAT, NOTE_KIND, TASK_STATUS, WORKSPACE_KIND } from '@orc/contracts'
import { authorFixture, must } from '@orc/contracts/fixtures'

// this file drives the CLI door; every append it arranges entered the same way
const CLI = NO_CHAT(Door.cli)
import { loadConfig, requireProject, type ProjectConfig } from '@orc/kernel'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE, TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { ADR_SUBCOMMAND } from './adr-commands'
import { BRIEF_COMMAND } from './brief-commands'
import { gatherBrief } from './brief-gather'
import { openKernel } from './main'
import { buildPlugins } from './runtime'
import { cli, dropSurrealDb } from './test-helpers'

const dbs: Array<{ drop: () => Promise<void> }> = []
const surrealConfigs: ProjectConfig[] = []
// Unconditional teardown: a real plugin host and an MCP hub are process-scoped, and a bare
// shutdown after the assertions is SKIPPED when one throws — which leaks the host into every later
// test file in the process. Registered at creation, drained LIFO, before the databases go away.
const cleanup: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const c of cleanup.reverse()) await c()
  await Promise.all([...dbs.map(d => d.drop()), ...surrealConfigs.map(c => dropSurrealDb(c))])
}, 30_000)
afterEach(() => mock.restore())

// adr-commands.test.ts's scaffold, for its reason: a per-test Postgres log, a throwaway Surreal
// database, the real plugin wiring, and a workspace seeded AT this config's directory — the brief
// names "this checkout" by matching the directory it runs in.
async function makeBriefCli() {
  const db = await createTestDb()
  dbs.push(db)
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-brief-cli-'))
  const projectDbName = `t_${Math.random().toString(36).slice(2, 10)}`
  const config = requireProject({ ...loadConfig(dir), projectDbName, projectId: TEST_PROJECT_ID, projectName: 'brief-test' })
  surrealConfigs.push(config)
  const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
  await seedTestWorkspace(log, CLI, realpathSync(config.dir))
  const { host, hub } = await buildPlugins(config)
  cleanup.push(() => log.close(), () => hub.close(), () => host.shutdown())
  const { run } = cli(kernel, undefined, { host, hub, config, log })
  return { run, log, config, kernel }
}

describe('orc brief', () => {
  it('an untouched project: names it, describes this checkout, and says nothing is waiting', async () => {
    const { run } = await makeBriefCli()
    const out = await run(BRIEF_COMMAND)
    expect(out[0]).toBe('# orc — brief-test')
    expect(must(out.find(l => l.startsWith('workspace: ')), 'workspace line')).toStartWith(`workspace: ${TEST_WORKSPACE.title} (${TEST_WORKSPACE.kind}, ${TEST_WORKSPACE.branch}) — `)
    // A COUNT, not the word "unknown": the brief degrades softly when the read model cannot be
    // asked, so a defect in its own reads (three connections opened at once were refused with
    // "Transaction conflict" on a new database) reads as an outage unless the healthy path is pinned.
    expect(out.find(l => l.startsWith('workspace: '))).toContain('0 provisional notes')
    expect(out.some(l => l.startsWith('tasks: none'))).toBe(true)
    expect(out.join('\n')).not.toContain('decisions')
  }, 30_000)

  it('shows a plan awaiting approval and a recorded decision with its one line', async () => {
    const { run } = await makeBriefCli()
    const taskId = must((await run('new', 'Add ingredient search', '--spec', 'find by name'))[0], 'task id line')
    await run('propose', taskId)
    await run('adr', ADR_SUBCOMMAND.new, 'Event log is truth', '--context', 'two stores drifted', '--decision', 'the log is the only writer of facts\nsecond line', '--consequences', 'projections are disposable')

    const out = await run(BRIEF_COMMAND)
    const gate = out.indexOf(`tasks ${TASK_STATUS.awaiting_approval}:`)
    expect(gate).toBeGreaterThan(-1)
    expect(out[gate + 1]).toBe(`  ${taskId}  Add ingredient search`)
    expect(out).toContain(`decisions in force (1 of 1 — orc adr ${ADR_SUBCOMMAND.ls}):`)
    expect(out).toContain('  Event log is truth — the log is the only writer of facts')
  }, 30_000)

  it('--json prints one value the contract accepts, carrying the same facts', async () => {
    const { run } = await makeBriefCli()
    const taskId = must((await run('new', 'Add ingredient search'))[0], 'task id line')
    await run('propose', taskId)
    const brief = Brief.parse(JSON.parse((await run(BRIEF_COMMAND, '--json')).join('\n')))
    expect(brief.project).toBe('brief-test')
    expect(brief.workspace?.workspace.id).toBe(TEST_WORKSPACE_ID)
    expect(brief.tasks.map(t => [t.id, t.status])).toEqual([[taskId, TASK_STATUS.awaiting_approval]])
    expect(brief.decisions).toEqual({ shown: [], total: 0 })
  }, 30_000)

  // A task outlives the archiving of its workspace; the brief still has to say where it lives.
  // Pins the archived rows gatherBrief asks the listing for — without them the label is dropped
  // and the task reads as one of this checkout's own.
  it('a task waiting in an archived workspace is still labelled with it', async () => {
    const { run, kernel } = await makeBriefCli()
    const old = await kernel.createWorkspace({ title: 'Old import', cwd: '/old-import', branch: 'orc/old-import', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false }, CLI)
    const taskId = must((await run('new', 'Import CSV', '--workspace', old.id))[0], 'task id line')
    await run('propose', taskId)
    await kernel.setWorkspaceArchived(old.id, true, CLI)
    expect(await run(BRIEF_COMMAND)).toContain(`  ${taskId}  Import CSV  [Old import]`)
  }, 30_000)

  // The brief READS the read model, it never drains the projector into it. A drain prints progress
  // to stdout past 50 events (corrupting `--json` and, through the session hook, the model's
  // context) and on a wiped read model runs for as long as the embedder takes — about an hour was
  // measured for 376 events — which would hold every session's start to the hook's timeout.
  it('a read model that is behind is read as it stands: one JSON value on stdout, and the lag is stated', async () => {
    const { run, log } = await makeBriefCli()
    const BEHIND = 60
    for (let i = 0; i < BEHIND; i++)
      await log.append({
        ...CLI, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
        payload: {
          note: { id: `n${i}`, scope: MemoryScope.project, kind: NOTE_KIND.fact, sourceRevision: null, title: `T${i}`, categories: [], tags: [], links: [], paths: [], summary: '', body: '' },
          author: authorFixture({ source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID }),
        },
      })
    const brief = Brief.parse(JSON.parse((await run(BRIEF_COMMAND, '--json')).join('\n')))
    expect(brief.pendingKnowledge).toBe(BEHIND)
    expect((await run(BRIEF_COMMAND)).join('\n')).toContain(`decisions may be behind: ${BEHIND} knowledge events are not in the read model yet — orc adr ${ADR_SUBCOMMAND.ls} catches up`)
  }, 60_000)

  // The brief opens every session; a read model that is down must cost it the two facts that live
  // there and nothing else. Driven through gatherBrief rather than the CLI because the unreachable
  // endpoint is a config value, and buildPlugins would refuse to boot a memory plugin on it.
  it('an unreachable read model costs the decisions and the note count, not the brief', async () => {
    const { log, config } = await makeBriefCli()
    const brief = await gatherBrief({ log, config: { ...config, projectDbUrl: 'ws://127.0.0.1:59998/rpc' } })
    expect(brief.decisions).toBeNull()
    expect(brief.workspace?.health.provisionalNotes).toBeNull()
    expect(brief.project).toBe('brief-test')
  }, 30_000)
})
