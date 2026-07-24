import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EVENT_KIND, TASK_STATUS, isRecord, type ExecutionPort } from '@orc/contracts'
import { Kernel, initializeProject, openStorage } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID, testConfig } from '@orc/kernel/test-helpers'
import { PROJECT_DIR_NOTE_ID } from '@orc/ui-core'
import { buildOrcActions, modelUniverse } from './actions'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { await Promise.all(dbs.map(d => d.drop())) }, 30_000)

// memory_written payload carries the authored note; pin id + title at the read boundary
// (cli has no zod — narrow with isRecord instead of casting).
const writtenNote = (payload: unknown): { id: string; title: string } => {
  if (!isRecord(payload) || !isRecord(payload.note) || typeof payload.note.id !== 'string' || typeof payload.note.title !== 'string')
    throw new Error('event is not a memory_written note payload')
  return { id: payload.note.id, title: payload.note.title }
}

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
      config: testConfig(db.url, {
        projectDbUrl: 'ws://127.0.0.1:1/rpc',
        vaultDir: mkdtempSync(path.join(tmpdir(), 'orc-vault-')),
        projectName: 'purge-me', dir: '/tmp/purge-me',
      }),
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

describe('writeNote/deleteNote guards', () => {
  it('refuse without a project context and refuse reserved ui-metadata ids', async () => {
    const { kernel, actions, close } = await setup() // setup() wires a real plugin behind actions
    await expect(actions.writeNote({ id: 'ui-project-name', title: 'x' })).rejects.toThrow(/reserved/)
    await expect(actions.deleteNote('ui-project-dir')).rejects.toThrow(/reserved/)
    const bare = buildOrcActions({ kernel, needPort: async () => stubPort }) // no plugin
    await expect(bare.writeNote({ id: 'x', title: 'x' })).rejects.toThrow(/project context/)
    await close()
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

    // identity survives the wipe: name + dir notes are re-seeded, so the chat stays listed
    const identity = await openStorage(url, { projectId: TEST_PROJECT_ID })
    const notes = (await identity.events.all()).filter(e => e.kind === EVENT_KIND.memory_written)
      .map(e => writtenNote(e.payload))
    expect(notes.map(n => [n.id, n.title])).toEqual([['ui-project-name', 'purge-me'], ['ui-project-dir', '/tmp/purge-me']])
    await identity.close()

    // the empty project is immediately usable again — the re-test loop
    const again = await actions.newTask({ title: 'fresh start' })
    expect((await kernel.getTask(again.taskId))?.title).toBe('fresh start')
    await close()
  })
})

describe('cwd validation at the action boundary', () => {
  it('an invented cwd dies at creation/run — never 4 retries deep in the executor', async () => {
    const { kernel, actions, close } = await setup()
    await expect(actions.newTask({ title: 'g', spec: 'do it', grounded: { modelRef: 'any/model', cwd: '/workspace/orc-sim' } }))
      .rejects.toThrow(/cwd is not an existing directory: \/workspace\/orc-sim/)
    const t = await kernel.createTask({ title: 'q', spec: '' })
    await expect(actions.run(t.id, '/no/such/dir')).rejects.toThrow(/cwd is not an existing directory/)
    await close()
  })
})

describe('deleteProject', () => {
  it('wipes any project outright — foreign AND home — with no identity re-seed', async () => {
    const { kernel, actions, url, close } = await setup()
    // home: full wipe, resolves (purge remains the identity-preserving reset)
    await kernel.createTask({ title: 'home task', spec: '' })
    expect((await actions.deleteProject(TEST_PROJECT_ID)).events).toBeGreaterThan(0)
    expect(await kernel.listTasks()).toEqual([])

    // seed a foreign project, then delete it — no identity re-seed, so it is GONE
    const foreign = await openStorage(url, { projectId: 'doomed-project' })
    await foreign.events.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
      payload: { note: { id: 'n1', title: 'n1' }, author: { source: 'cli' } },
    })
    await foreign.close()

    const r = await actions.deleteProject('doomed-project')
    expect(r.events).toBe(1)
    const check = await openStorage(url, { projectId: 'doomed-project' })
    expect(await check.events.all()).toEqual([])
    await check.close()
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
      .map(e => writtenNote(e.payload))
    expect(notes.find(n => n.id === PROJECT_DIR_NOTE_ID)?.title).toBe(dir)
    await target.close()

    // an untouched directory mints a fresh identity
    const fresh = await actions.newProject(mkdtempSync(path.join(tmpdir(), 'orc-chat-')), 'fresh')
    expect(fresh.reused).toBe(false)
    expect(fresh.projectId).not.toBe(original)
    await close()
  })
})
