import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { AUTHOR_SOURCE, DECISION_STATUS, Door, EVENT_KIND, MemoryWrittenPayload, NO_CHAT } from '@orc/contracts'
import { loadConfig, requireProject, type ProjectConfig } from '@orc/kernel'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { ADR_SECTION, DECISION_REFUSAL } from '@orc/memory'
import { renderDecisionList } from './adr-commands'
import { openKernel } from './main'
import { buildPlugins } from './runtime'
import { cli, dropSurrealDb, testSurrealDbName } from './test-helpers'

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

// makeCli from main.test.ts's "memory add … isolated throwaway SurrealDB db" test: a per-test
// Postgres log, a throwaway Surreal database, and the real plugin wiring `orc adr` reads through.
async function makeAdrCli() {
  const db = await createTestDb()
  dbs.push(db)
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-adr-cli-'))
  const projectDbName = testSurrealDbName()
  const config = requireProject({ ...loadConfig(dir), projectDbName, projectId: TEST_PROJECT_ID, projectName: 'test' })
  surrealConfigs.push(config)
  const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config })
  // the workspace must sit at THIS config's dir: `orc adr` resolves its author's workspace by
  // matching the process's directory (cwdAuthor), and refuses when nothing claims it
  await seedTestWorkspace(log, NO_CHAT(Door.cli), realpathSync(config.dir))
  const { host, hub } = await buildPlugins(config) // real plugin wiring — no stub casts
  cleanup.push(() => log.close(), () => hub.close(), () => host.shutdown())
  const { run } = cli(kernel, undefined, { host, hub, config, log })
  return { run, log, config, kernel }
}

describe('orc adr', () => {
  it('new records a human-authored decision in the cwd workspace and reads it back with show', async () => {
    const { run, log } = await makeAdrCli()
    const out = await run('adr', 'new', 'Event log is truth', '--context', 'two stores drifted', '--decision', 'the log is the only writer of facts', '--consequences', 'projections are disposable', '--tags', 'architecture')
    expect(out.join('\n')).toContain("recorded decision 'event-log-is-truth' (accepted)")
    // the log is the truth this test trusts: author source human, workspace = the seeded one
    const written = (await log.all()).filter(e => e.kind === EVENT_KIND.memory_written).map(e => MemoryWrittenPayload.parse(e.payload))
    expect(written.at(-1)?.author).toMatchObject({ source: AUTHOR_SOURCE.human, workspaceId: TEST_WORKSPACE_ID })
    const shown = (await run('adr', 'show', 'event-log-is-truth')).join('\n')
    expect(shown).toContain('status: accepted')
    expect(shown).toContain(`## ${ADR_SECTION.decision}`)
    expect(shown).toContain('the log is the only writer of facts')
  }, 30_000)

  it('supersede links the new decision to the old and ls shows both, the old as superseded', async () => {
    const { run } = await makeAdrCli()
    await run('adr', 'new', 'Identity per checkout', '--context', 'c', '--decision', 'd', '--consequences', 'q')
    const out = await run('adr', 'supersede', 'identity-per-checkout', 'Identity per repository', '--context', 'worktrees are strangers', '--decision', 'resolve to the common dir', '--consequences', 'one project per repo')
    expect(out.join('\n')).toContain("superseded 'identity-per-checkout'")
    const ls = await run('adr', 'ls')
    expect(ls.find(l => l.includes('identity-per-repository'))).toContain('accepted')
    expect(ls.find(l => l.includes('identity-per-checkout'))).toContain('superseded')
    expect(ls.find(l => l.includes('identity-per-checkout'))).toContain('identity-per-repository') // supersededBy is printed
    const json = z.array(z.object({ id: z.string(), status: z.string() })).parse(JSON.parse((await run('adr', 'ls', '--json', '--status', 'superseded')).join('\n')))
    expect(json.map(r => [r.id, r.status])).toEqual([['identity-per-checkout', 'superseded']])
  }, 30_000)

  it('refuses an unknown --status at parse time and an existing id with the lifecycle\'s own sentence', async () => {
    const { run } = await makeAdrCli()
    await expect(run('adr', 'new', 'X', '--context', 'c', '--decision', 'd', '--consequences', 'q', '--status', 'final')).rejects.toThrow(/unknown status 'final'/)
    await run('adr', 'new', 'Twice', '--context', 'c', '--decision', 'd', '--consequences', 'q')
    await expect(run('adr', 'new', 'Twice', '--context', 'c', '--decision', 'd', '--consequences', 'q')).rejects.toThrow(DECISION_REFUSAL.exists('twice'))
  }, 30_000)

  it('memory ls --kind decision lists only decisions', async () => {
    const { run } = await makeAdrCli()
    await run('adr', 'new', 'Only me', '--context', 'c', '--decision', 'd', '--consequences', 'q')
    await run('memory', 'add', '--id', 'a-fact', '--title', 'A fact')
    const rows = await run('memory', 'ls', '--kind', 'decision')
    expect(rows.join('\n')).toContain('only-me')
    expect(rows.join('\n')).not.toContain('a-fact')
    await expect(run('memory', 'ls', '--kind', 'adr')).rejects.toThrow(/unknown kind 'adr'/)
  }, 30_000)
})

describe('renderDecisionList', () => {
  it('renders one row per decision with status, age column and the superseding id', () => {
    const rows = renderDecisionList([{ id: 'a', title: 'A', summary: 'what A decided', status: DECISION_STATUS.superseded, updatedAt: '2026-01-01T00:00:00.000Z', createdBy: 'human', supersededBy: 'b' }])
    expect(rows[0]).toContain('a')
    expect(rows[0]).toContain('superseded')
    expect(rows[0]).toContain('→ b')
    expect(renderDecisionList([])).toEqual(['_no decisions_'])
  })
})
