import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Kernel, openStorage } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { createVaultProjector } from './index'

const dbs: Array<{ drop: () => Promise<void> }> = []
const dirs: string[] = []
afterEach(async () => { for (const d of dbs.splice(0)) await d.drop(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('createVaultProjector.renderAll', () => {
  it('renders a task tree from the log', async () => {
    const db = await createTestDb(); dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vp-')); dirs.push(vaultDir)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const kernel = new Kernel(log)
    const t = await kernel.createTask({ title: 'demo', spec: 'do it' })
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ id: 's1', modelRef: 'anthropic/claude-sonnet-5' })]))

    const projector = createVaultProjector({ log, config: { vaultDir } })
    await projector.renderAll()
    await projector.close()

    expect(existsSync(path.join(vaultDir, 'index.md'))).toBe(true)
    expect(readFileSync(path.join(vaultDir, `tasks/${t.id}/index.md`), 'utf8')).toContain('type: task')
    expect(existsSync(path.join(vaultDir, `tasks/${t.id}/plan-v1.md`))).toBe(true)
    await log.close()
  })

  it('ignores project-scoped memory events (null taskId) — byTask is never called for the null taskId', async () => {
    const db = await createTestDb(); dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vp-')); dirs.push(vaultDir)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const kernel = new Kernel(log)
    const t = await kernel.createTask({ title: 'demo', spec: 'do it' })
    await log.append({
      taskId: null, stepId: null, runToken: null,
      kind: 'memory_written',
      payload: {
        note: { id: 'note-x', title: 'X', scope: 'project', categories: [], tags: [], links: [], paths: [], rules: [], summary: '', body: '' },
        author: { source: 'cli' },
      },
    })

    const projector = createVaultProjector({ log, config: { vaultDir } })
    const byTaskSpy = spyOn(log, 'byTask')
    await expect(projector.renderAll()).resolves.toBeUndefined()

    // load-bearing: the `.filter(e => e.taskId)` guard in renderAll means byTask is called
    // exactly once — for the real task — and never for the memory event's null taskId.
    // Without the guard, byTask(null) would also be called and these would fail.
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
    const t = await kernel.createTask({ title: 'scoped', spec: 'x' })
    const allSpy = spyOn(log, 'all')
    const projector = createVaultProjector({ log, config: { vaultDir } })
    await projector.renderAll()
    await projector.renderTask(t.id)
    await projector.close()
    expect(allSpy).not.toHaveBeenCalled()
    await log.close()
  })

  it('start() subscribes and skips memory events (null taskId) while still rendering real task updates', async () => {
    const db = await createTestDb(); dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vp-')); dirs.push(vaultDir)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const kernel = new Kernel(log)

    const projector = createVaultProjector({ log, config: { vaultDir } })
    await projector.start()
    const byTaskSpy = spyOn(log, 'byTask')

    const t = await kernel.createTask({ title: 'demo', spec: 'do it' })
    await log.append({
      taskId: null, stepId: null, runToken: null,
      kind: 'memory_written',
      payload: {
        note: { id: 'note-y', title: 'Y', scope: 'project', categories: [], tags: [], links: [], paths: [], rules: [], summary: '', body: '' },
        author: { source: 'cli' },
      },
    })

    await Bun.sleep(120) // flush the 50ms debounce for both appended events

    // load-bearing: the `if (!e.taskId) return` guard in the subscribe handler means
    // byTask is never called for the memory event's null taskId. Without the guard,
    // the debounced render for the null "task" would call byTask(null) and this would fail.
    for (const call of byTaskSpy.mock.calls) expect(call[0]).not.toBeNull()
    expect(byTaskSpy).toHaveBeenCalledWith(t.id)

    expect(existsSync(path.join(vaultDir, `tasks/${t.id}`))).toBe(true)
    expect(existsSync(path.join(vaultDir, 'tasks/null'))).toBe(false)

    await projector.close()
    await log.close()
  })
})
