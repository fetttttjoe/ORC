import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EVENT_KIND, TASK_STATUS, type ExecutionPort } from '@orc/contracts'
import { Kernel, deriveSystemUrl, initializeProject, openStorage, type ProjectConfig } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { PROJECT_DIR_NOTE_ID } from '@orc/ui-core'
import { buildOrcActions, modelUniverse } from './actions'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { await Promise.all(dbs.map(d => d.drop())) }, 30_000)

const stubPort: ExecutionPort = {
  startRun: async () => ({ workflowId: 'w1', wait: async () => 'done' as const }),
  retry: async () => { throw new Error('unused') },
  cancelRun: async () => {},
}

async function setup(listModels?: () => Promise<string[]>) {
  const db = await createTestDb()
  dbs.push(db)
  const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
  const kernel = new Kernel(storage.events)
  const actions = buildOrcActions({
    kernel, needPort: async () => stubPort, listModels,
    // newProject/renameProject/purge need only urls + storage from the plugin context; the
    // bogus surreal url makes purge's memory rebuild report instead of hang, and the derived
    // system-db url points at a never-created database (the common pre-first-run state)
    plugin: {
      config: {
        databaseUrl: db.url, projectDbUrl: 'ws://127.0.0.1:1/rpc',
        systemDatabaseUrl: deriveSystemUrl(db.url, TEST_PROJECT_ID),
        vaultDir: mkdtempSync(path.join(tmpdir(), 'orc-vault-')),
      } as ProjectConfig,
      log: storage.events, storage,
    },
  })
  return { kernel, actions, url: db.url, close: () => storage.close() }
}

describe('model validation at the action boundary', () => {
  it('an invented model ref dies at creation with guidance, never reaching a plan', async () => {
    const { actions, close } = await setup(async () => ['anthropic/claude-haiku-4-5', 'ollama/llama3.2:3b'])
    const { taskId } = await actions.newTask({ title: 'quick one' })
    await expect(actions.propose(taskId, { modelRef: 'anthropic/claude-3-5-sonnet-20241022' }))
      .rejects.toThrow(/unknown model .* valid refs include: anthropic\/claude-haiku-4-5/)
    // known ref passes
    expect((await actions.propose(taskId, { modelRef: 'anthropic/claude-haiku-4-5' })).version).toBe(1)
    await close()
  })

  it('grounded creation validates too; no discovery = no blocking', async () => {
    const strict = await setup(async () => ['anthropic/claude-haiku-4-5'])
    await expect(strict.actions.newTask({ title: 'g', grounded: { modelRef: 'made/up', cwd: '/tmp' } }))
      .rejects.toThrow(/unknown model/)
    await strict.close()

    const offline = await setup(async () => { throw new Error('discovery down') })
    const t = await offline.actions.newTask({ title: 'q2' })
    expect((await offline.actions.propose(t.taskId, { modelRef: 'anything/goes-when-offline' })).version).toBe(1)
    await offline.close()
  })
})

describe('modelUniverse', () => {
  it('unions live ids with priced cost-table ids — aliases stay valid when the API lists dated ids', () => {
    expect(modelUniverse(['claude-haiku-4-5-20251001'], { 'claude-haiku-4-5': {}, '*': {} }))
      .toEqual(['claude-haiku-4-5', 'claude-haiku-4-5-20251001'])
    expect(modelUniverse([], { '*': {} })).toEqual([]) // wildcard-only providers discover nothing
  })
})

describe('purgeProject', () => {
  it('wipes events + operations — stuck-running tasks included — and leaves the project usable', async () => {
    const { kernel, actions, url, close } = await setup()
    const t = await kernel.createTask({ title: 'to be purged', spec: '' })
    // status transitions are executor-appended events, not kernel methods — append directly.
    // A task stuck 'running' (crashed run) is exactly what purge must clear without help.
    const storage = await openStorage(url, { projectId: TEST_PROJECT_ID })
    await storage.events.append({
      taskId: t.id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
      payload: { taskId: t.id, from: TASK_STATUS.draft, to: TASK_STATUS.running },
    })
    await storage.close()

    const r = await actions.purgeProject()
    expect(r.events).toBeGreaterThan(0)
    // surreal is unreachable in this setup — reported as a warning, not thrown; the absent
    // dbos system db (never launched) produces NO warning
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('memory read model')
    expect(await kernel.listTasks()).toEqual([])

    // the empty project is immediately usable again — the re-test loop
    const again = await actions.newTask({ title: 'fresh start' })
    expect((await kernel.getTask(again.taskId))?.title).toBe('fresh start')
    await close()
  })
})

describe('newProject', () => {
  it('reuses an already-initialized directory instead of re-minting; fresh dirs mint', async () => {
    const { actions, url, close } = await setup()
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-chat-'))
    const { projectId: original } = initializeProject(dir, 'original')

    // same folder → same project, flagged as reused; the typed name becomes the display name
    const reopened = await actions.newProject(dir, 'renamed chat')
    expect(reopened).toEqual({ projectId: original, reused: true })

    // the dir note is appended so the chat is locatable (autocomplete, guidance)
    const target = await openStorage(url, { projectId: original })
    const notes = (await target.events.after(0, [EVENT_KIND.memory_written]))
      .map(e => (e.payload as { note: { id: string; title: string } }).note)
    expect(notes.find(n => n.id === PROJECT_DIR_NOTE_ID)?.title).toBe(dir)
    await target.close()

    // an untouched directory mints a fresh identity
    const fresh = await actions.newProject(mkdtempSync(path.join(tmpdir(), 'orc-chat-')), 'fresh')
    expect(fresh.reused).toBe(false)
    expect(fresh.projectId).not.toBe(original)
    await close()
  })
})
