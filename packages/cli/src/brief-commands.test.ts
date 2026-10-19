import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Brief, Door, KNOWLEDGE_REFUSAL, NO_CHAT, TASK_STATUS, WORKSPACE_KIND } from '@orc/contracts'
import { must } from '@orc/contracts/fixtures'

// this file drives the CLI door; every append it arranges entered the same way
const CLI = NO_CHAT(Door.cli)
import { loadConfig, requireProject } from '@orc/kernel'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE, TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { ADR_SUBCOMMAND } from './adr-commands'
import { BRIEF_COMMAND } from './brief-commands'
import { gatherBrief } from './brief-gather'
import { openKernel } from './main'
import { buildPlugins } from './runtime'
import { cli } from './test-helpers'

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

// A per-test Postgres log, a git checkout, the real plugin wiring, and a workspace seeded AT this
// config's directory — the brief names "this checkout" by matching the directory it runs in.
async function makeBriefCli() {
  const db = await createTestDb()
  dbs.push(db)
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-brief-cli-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', dir])
  const config = requireProject({ ...loadConfig(dir), projectId: TEST_PROJECT_ID, projectName: 'brief-test' })
  const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config })
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
    expect(out.some(l => l.startsWith('tasks: none'))).toBe(true)
    expect(out.join('\n')).not.toContain('decisions')
  }, 30_000)

  it('shows a plan awaiting approval and a recorded decision with its one line', async () => {
    const { run } = await makeBriefCli()
    const taskId = must((await run('new', 'Add ingredient search', '--spec', 'find by name'))[0], 'task id line')
    await run('propose', taskId)
    await run('adr', ADR_SUBCOMMAND.new, 'Event log is truth', '--context', 'two stores drifted', '--decision', 'the log is the only writer of facts\nsecond line', '--consequences', 'projections are disposable')
    await run('adr', ADR_SUBCOMMAND.new, 'Open question', '--context', 'c', '--decision', 'd', '--consequences', 'q', '--status', 'proposed')

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

  it('decisions that cannot be read cost the decisions only, and stderr says why', async () => {
    const { log, config } = await makeBriefCli()
    const stderr = spyOn(console, 'error').mockImplementation(() => {})
    const brief = await gatherBrief({ log, config: { ...config, knowledge: null } })
    expect(brief.decisions).toBeNull()
    expect(brief.project).toBe('brief-test')
    expect(stderr).toHaveBeenCalledWith(`decisions could not be listed: ${KNOWLEDGE_REFUSAL.off()}`)
  }, 30_000)
})
