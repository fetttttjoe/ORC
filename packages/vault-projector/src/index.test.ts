import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Kernel, EventLog } from '@orc/kernel'
import { createTestDb } from '@orc/kernel/test-helpers'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { createVaultProjector } from './index'

const dbs: Array<{ drop: () => Promise<void> }> = []
const dirs: string[] = []
afterEach(async () => { for (const d of dbs.splice(0)) await d.drop(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('createVaultProjector.renderAll', () => {
  it('renders a task tree from the log', async () => {
    const db = await createTestDb(); dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vp-')); dirs.push(vaultDir)
    const log = await EventLog.open(db.url)
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

  it('ignores project-scoped memory events (null taskId) — no throw, no stray task dir', async () => {
    const db = await createTestDb(); dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vp-')); dirs.push(vaultDir)
    const log = await EventLog.open(db.url)
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
    await expect(projector.renderAll()).resolves.toBeUndefined()
    await projector.close()

    expect(existsSync(path.join(vaultDir, `tasks/${t.id}`))).toBe(true)
    expect(existsSync(path.join(vaultDir, 'tasks/null'))).toBe(false)
    await log.close()
  })
})
