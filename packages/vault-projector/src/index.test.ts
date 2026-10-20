import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Kernel, openStorage } from '@orc/kernel'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { authorFixture, draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { createVaultProjector } from './index'
import { Door, EVENT_KIND, NO_CHAT } from '@orc/contracts'

// this file's arrangement all comes from the terminal door
const CLI = NO_CHAT(Door.cli)

const dbs: Array<{ drop: () => Promise<void> }> = []
const dirs: string[] = []
afterEach(async () => { for (const d of dbs.splice(0)) await d.drop(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('createVaultProjector.renderAll', () => {
  it('renders a task tree from the log', async () => {
    const db = await createTestDb(); dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vp-')); dirs.push(vaultDir)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const kernel = new Kernel(log)
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'demo', spec: 'do it' }, CLI)
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ id: 's1', modelRef: 'anthropic/claude-sonnet-5' })]), CLI)

    const projector = createVaultProjector({ log, config: { vaultDir } })
    await projector.renderAll()
    await projector.close()

    expect(existsSync(path.join(vaultDir, 'index.md'))).toBe(true)
    expect(readFileSync(path.join(vaultDir, `tasks/${t.id}/index.md`), 'utf8')).toContain('type: task')
    expect(existsSync(path.join(vaultDir, `tasks/${t.id}/plan-v1.md`))).toBe(true)
    await log.close()
  })

  it('ignores project-scoped knowledge events (null taskId) — byTask is never called for the null taskId', async () => {
    const db = await createTestDb(); dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vp-')); dirs.push(vaultDir)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const kernel = new Kernel(log)
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'demo', spec: 'do it' }, CLI)
    await log.append({
      ...CLI, taskId: null, stepId: null, runToken: null,
      kind: EVENT_KIND.knowledge_written,
      payload: {
        added: [], changed: [], retired: [], files: [], why: null, decision: null, decisionsRecorded: [], decisionsSuperseded: [], asserted: [],
        author: authorFixture(),
      },
    })

    const projector = createVaultProjector({ log, config: { vaultDir } })
    const byTaskSpy = spyOn(log, 'byTask')
    await expect(projector.renderAll()).resolves.toBeUndefined()

    expect(byTaskSpy).toHaveBeenCalledTimes(1)
    expect(byTaskSpy).toHaveBeenCalledWith(t.id)

    await projector.close()

    expect(existsSync(path.join(vaultDir, `tasks/${t.id}`))).toBe(true)
    expect(existsSync(path.join(vaultDir, 'tasks/null'))).toBe(false)
    await log.close()
  })

  it('never scans the whole log — renderAll and live renders use scoped queries only', async () => {
    const db = await createTestDb(); dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vp-')); dirs.push(vaultDir)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const kernel = new Kernel(log)
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'scoped', spec: 'x' }, CLI)
    const allSpy = spyOn(log, 'all')
    const projector = createVaultProjector({ log, config: { vaultDir } })
    await projector.renderAll()
    await projector.renderTask(t.id)
    await projector.close()
    expect(allSpy).not.toHaveBeenCalled()
    await log.close()
  })

  it('start() subscribes and skips knowledge events (null taskId) while still rendering real task updates', async () => {
    const db = await createTestDb(); dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vp-')); dirs.push(vaultDir)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const kernel = new Kernel(log)
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)

    const projector = createVaultProjector({ log, config: { vaultDir } })
    await projector.start()
    const byTaskSpy = spyOn(log, 'byTask')

    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'demo', spec: 'do it' }, CLI)
    await log.append({
      ...CLI, taskId: null, stepId: null, runToken: null,
      kind: EVENT_KIND.knowledge_written,
      payload: {
        added: [], changed: [], retired: [], files: [], why: null, decision: null, decisionsRecorded: [], decisionsSuperseded: [], asserted: [],
        author: authorFixture(),
      },
    })

    await Bun.sleep(120) // flush the 50ms debounce for both appended events

    for (const call of byTaskSpy.mock.calls) expect(call[0]).not.toBeNull()
    expect(byTaskSpy).toHaveBeenCalledWith(t.id)

    expect(existsSync(path.join(vaultDir, `tasks/${t.id}`))).toBe(true)
    expect(existsSync(path.join(vaultDir, 'tasks/null'))).toBe(false)

    await projector.close()
    await log.close()
  })
})
