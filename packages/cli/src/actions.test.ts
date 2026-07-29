import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EVENT_KIND, MemoryWrittenPayload, TASK_STATUS, type ExecutionPort } from '@orc/contracts'
import { Kernel, initializeProject, openStorage } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID, testConfig, type TestDb } from '@orc/kernel/test-helpers'
import { PROJECT_DIR_NOTE_ID } from '@orc/ui-core'
import { buildOrcActions, modelUniverse } from './actions'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { await Promise.all(dbs.map(d => d.drop())) }, 30_000)

// memory_written payload parsed through its owning schema at the read boundary — never a cast
const writtenNote = (payload: unknown): { id: string; title: string } => MemoryWrittenPayload.parse(payload).note

// The actions layer holds no execution port: it records asks and a supervisor executes them, so
// what a test injects is the promise that one exists — counted, to prove every write path asks.
function stubRuntime() {
  const ensured = { count: 0 }
  return { ensured, ensureRuntime: async () => { ensured.count++ } }
}

async function setup(listModels?: () => Promise<string[]>) {
  const db = await createTestDb()
  dbs.push(db)
  const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
  // registered, not returned as a close() the test must remember to await: a bare close as the
  // last statement is SKIPPED when an assertion above it throws, leaking the pool into every
  // later test file — the same failure main.test.ts's cleanup comment records.
  db.onClose(() => storage.close())
  const kernel = new Kernel(storage.events)
  const { ensured, ensureRuntime } = stubRuntime()
  const actions = buildOrcActions({
    kernel, ensureRuntime, listModels,
    // newProject/renameProject/purge need only urls + storage from the plugin context; the
    // bogus surreal url makes purge's memory rebuild report instead of hang, and the derived
    // system-db url points at a never-created database (the common pre-first-run state)
    plugin: {
      config: testConfig(db.url, {
        projectDbUrl: 'ws://127.0.0.1:1/rpc',
        // the driver pends on unreachable endpoints, so the connect guard IS the failure path —
        // at its 5000ms production default the designed failure cannot fit a 5s test budget
        projectDbConnectTimeoutMs: 300,
        vaultDir: mkdtempSync(path.join(tmpdir(), 'orc-vault-')),
        projectName: 'purge-me', dir: '/tmp/purge-me',
      }),
      log: storage.events, storage,
    },
  })
  return { kernel, actions, ensured, url: db.url, db }
}

describe('model validation at the action boundary', () => {
  it('an invented model ref dies at creation with guidance, never reaching a plan', async () => {
    const { actions } = await setup(async () => ['anthropic/claude-haiku-4-5', 'ollama/llama3.2:3b'])
    const { taskId } = await actions.newTask({ title: 'quick one' })
    await expect(actions.propose(taskId, { modelRef: 'anthropic/claude-3-5-sonnet-20241022' }))
      .rejects.toThrow(/unknown model .* valid refs include: anthropic\/claude-haiku-4-5/)
    // known ref passes
    expect((await actions.propose(taskId, { modelRef: 'anthropic/claude-haiku-4-5' })).version).toBe(1)
  })

  it('grounded creation validates too; no discovery = no blocking', async () => {
    const strict = await setup(async () => ['anthropic/claude-haiku-4-5'])
    await expect(strict.actions.newTask({ title: 'g', grounded: { modelRef: 'made/up', cwd: '/tmp' } }))
      .rejects.toThrow(/unknown model/)

    const offline = await setup(async () => { throw new Error('discovery down') })
    const t = await offline.actions.newTask({ title: 'q2' })
    expect((await offline.actions.propose(t.taskId, { modelRef: 'anything/goes-when-offline' })).version).toBe(1)
  })
})

describe('writeNote/deleteNote guards', () => {
  it('refuse without a project context and refuse reserved ui-metadata ids', async () => {
    const { kernel, actions } = await setup() // setup() wires a real plugin behind actions
    await expect(actions.writeNote({ id: 'ui-project-name', title: 'x' })).rejects.toThrow(/reserved/)
    await expect(actions.deleteNote('ui-project-dir')).rejects.toThrow(/reserved/)
    const bare = buildOrcActions({ kernel, ensureRuntime: stubRuntime().ensureRuntime }) // no plugin
    await expect(bare.writeNote({ id: 'x', title: 'x' })).rejects.toThrow(/project context/)
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
    const { kernel, actions, url, db } = await setup()
    const t = await kernel.createTask({ title: 'to be purged', spec: '' })
    // status transitions are executor-appended events, not kernel methods — append directly.
    // A task stuck 'running' (crashed run) is exactly what purge must clear without help.
    const storage = await openStorage(url, { projectId: TEST_PROJECT_ID })
    db.onClose(() => storage.close())
    await storage.events.append({
      taskId: t.id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
      payload: { taskId: t.id, from: TASK_STATUS.draft, to: TASK_STATUS.running },
    })

    const r = await actions.purgeProject()
    expect(r.events).toBeGreaterThan(0)
    // surreal is unreachable in this setup — reported as a warning, not thrown; the absent
    // dbos system db (never launched) produces NO warning
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('memory read model')
    expect(await kernel.listTasks()).toEqual([])

    // identity survives the wipe: name + dir notes are re-seeded, so the chat stays listed
    const identity = await openStorage(url, { projectId: TEST_PROJECT_ID })
    db.onClose(() => identity.close())
    const notes = (await identity.events.all()).filter(e => e.kind === EVENT_KIND.memory_written)
      .map(e => writtenNote(e.payload))
    expect(notes.map(n => [n.id, n.title])).toEqual([['ui-project-name', 'purge-me'], ['ui-project-dir', '/tmp/purge-me']])

    // the empty project is immediately usable again — the re-test loop
    const again = await actions.newTask({ title: 'fresh start' })
    expect((await kernel.getTask(again.taskId))?.title).toBe('fresh start')
  })
})

describe('cwd validation at the action boundary', () => {
  it('an invented cwd dies at creation/run — never 4 retries deep in the executor', async () => {
    const { kernel, actions, ensured } = await setup()
    await expect(actions.newTask({ title: 'g', spec: 'do it', grounded: { modelRef: 'any/model', cwd: '/workspace/orc-sim' } }))
      .rejects.toThrow(/cwd is not an existing directory: \/workspace\/orc-sim/)
    const t = await kernel.createTask({ title: 'q', spec: '' })
    await expect(actions.run(t.id, '/no/such/dir')).rejects.toThrow(/cwd is not an existing directory/)
    // and it died before anything was recorded or spawned — a bad cwd must not become an ask
    // every supervisor that boots picks up and fails on again
    expect([ensured.count, (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.run_requested)]).toEqual([0, false])
  })
})

// Move a freshly created task to approved: propose a single-step template, then approve it. This
// is the ONLY state actions.run() will now accept — a draft/unapproved task is refused at the door,
// exactly as the CLI `run` (main.ts requireDrivable) and startRunAt (dbos-port.ts) refuse it.
async function approvedTask(kernel: Kernel, actions: ReturnType<typeof buildOrcActions>, title = 'door') {
  const t = await kernel.createTask({ title, spec: 'do it' })
  const { version } = await actions.propose(t.id, { modelRef: 'any/model' })
  await actions.approve(t.id, version)
  return t
}

describe('the MCP and web doors record the ask; the supervisor executes it', () => {
  it('run guarantees a supervisor, then appends run_requested with the cwd it validated', async () => {
    const { kernel, actions, ensured } = await setup()
    const t = await approvedTask(kernel, actions)
    expect(await actions.run(t.id, process.cwd())).toEqual({ requested: true })
    expect(ensured.count).toBe(1)
    const requested = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.run_requested)
    expect(requested?.payload).toEqual({ taskId: t.id, cwd: process.cwd(), retry: false })
  })

  // Finding 1 of the Phase-1 audit: actions.run() (the web + MCP door) used to skip the
  // drivable-status admission the CLI `run` enforces, so a draft/unapproved/terminal task silently
  // became a run_requested nobody could serve — sat in the log, and every booting supervisor
  // failed on it again. run() now mirrors retry()'s refusal: reject at the door, with the exact
  // startRunAt message, before ensureRuntime or requestRun.
  it('run refuses a draft task (no approved plan) — same message as CLI run, no ask, no supervisor', async () => {
    const { kernel, actions, ensured } = await setup()
    const t = await kernel.createTask({ title: 'draft', spec: '' })
    await expect(actions.run(t.id, process.cwd()))
      .rejects.toThrow(`task is 'draft' — approve a plan first (orc approve ${t.id})`)
    // and it died before anything was recorded or a supervisor guaranteed — a request nobody can
    // serve must never reach the log
    expect([ensured.count, (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.run_requested)]).toEqual([0, false])
  })

  it('run refuses a proposed-but-unapproved task — no approvedVersion is not drivable', async () => {
    const { kernel, actions, ensured } = await setup()
    const t = await kernel.createTask({ title: 'proposed', spec: 'do it' })
    await actions.propose(t.id, { modelRef: 'any/model' }) // proposed, NOT approved
    await expect(actions.run(t.id, process.cwd())).rejects.toThrow(/approve a plan first/)
    expect([ensured.count, (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.run_requested)]).toEqual([0, false])
  })

  it('retry refuses a task that is not blocked, before recording or spawning anything', async () => {
    const { kernel, actions, ensured } = await setup()
    const t = await kernel.createTask({ title: 'door', spec: '' })
    await expect(actions.retry(t.id)).rejects.toThrow(/only a blocked task can be retried/)
    expect([ensured.count, (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.run_requested)]).toEqual([0, false])
  })
})

// The graph UI lists and streams EVERY project in the database, so a question it displays has to be
// answerable from it. Answering is not executing: the append only unblocks the parked step, and the
// supervisor's router carries it into the workflow off feedback_provided. Fencing it to the started
// directory made the UI show a question it then refused to let the user answer, sending them to a
// terminal for a row it already had the log to write.
describe('reply names the project it answers in', () => {
  const parkedQuestion = async (db: TestDb, projectId: string) => {
    const storage = await openStorage(db.url, { projectId })
    db.onClose(() => storage.close())
    const t = await new Kernel(storage.events).createTask({ title: 'parked on a question', spec: '' })
    await storage.events.append({
      taskId: t.id, stepId: 'plan', runToken: 'run-1', kind: EVENT_KIND.feedback_requested,
      payload: { topic: 'consent', question: 'go ahead?' },
    })
    return { storage, taskId: t.id }
  }
  const answers = async (storage: Awaited<ReturnType<typeof openStorage>>) =>
    (await storage.events.all()).filter(e => e.kind === EVENT_KIND.feedback_provided)

  it('answers a FOREIGN project in that project\'s own log, spawning no runtime here', async () => {
    const { actions, ensured, db } = await setup()
    const { storage, taskId } = await parkedQuestion(db, 'foreign-project')
    // supervised:false — nothing is live over there, and the human who typed it must be told
    expect(await actions.reply(taskId, 'yes', 'foreign-project')).toEqual({ answered: true, supervised: false })
    expect(await answers(storage)).toHaveLength(1)
    // execution stays bound to the directory orc was started in: answering guarantees nothing
    expect(ensured.count).toBe(0)
  })

  it('still guarantees a supervisor when the project is its own', async () => {
    const { actions, ensured, db } = await setup()
    const { storage, taskId } = await parkedQuestion(db, TEST_PROJECT_ID)
    expect(await actions.reply(taskId, 'yes')).toEqual({ answered: true, supervised: true })
    expect(await answers(storage)).toHaveLength(1)
    expect(ensured.count).toBe(1)
    // naming the home project explicitly (the web door always does) takes the same path
    await storage.events.append({
      taskId, stepId: 'plan', runToken: 'run-1', kind: EVENT_KIND.feedback_requested,
      payload: { topic: 'consent-2', question: 'again?' },
    })
    expect(await actions.reply(taskId, 'yes', TEST_PROJECT_ID)).toEqual({ answered: true, supervised: true })
    expect(ensured.count).toBe(2)
  })

  it('refuses a foreign project without a project context to resolve its database', async () => {
    const { kernel } = await setup()
    const bare = buildOrcActions({ kernel, ensureRuntime: stubRuntime().ensureRuntime }) // no plugin
    await expect(bare.reply('t1', 'yes', 'foreign-project')).rejects.toThrow(/project context/)
  })
})

describe('deleteProject', () => {
  it('wipes any project outright — foreign AND home — with no identity re-seed', async () => {
    const { kernel, actions, url, db } = await setup()
    // home: full wipe, resolves (purge remains the identity-preserving reset)
    await kernel.createTask({ title: 'home task', spec: '' })
    expect((await actions.deleteProject(TEST_PROJECT_ID)).events).toBeGreaterThan(0)
    expect(await kernel.listTasks()).toEqual([])

    // seed a foreign project, then delete it — no identity re-seed, so it is GONE
    const foreign = await openStorage(url, { projectId: 'doomed-project' })
    db.onClose(() => foreign.close())
    await foreign.events.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
      payload: { note: { id: 'n1', title: 'n1' }, author: { source: 'cli' } },
    })

    const r = await actions.deleteProject('doomed-project')
    expect(r.events).toBe(1)
    const check = await openStorage(url, { projectId: 'doomed-project' })
    db.onClose(() => check.close())
    expect(await check.events.all()).toEqual([])
  })

  // Deleting a chat has to take its knowledge with it — the read model lives in a project-derived
  // SurrealDB database that the home project's memory instance cannot reach. It used to be left
  // behind silently as "inert garbage", which it was not: those notes stayed live in `orc memory
  // ls`, in search and in agent recall, with no events behind them, until a later rebuild dropped
  // them. This setup points at an unreachable Surreal, so it pins the half that must never go
  // quiet again — when the wipe cannot happen, the caller is told.
  it('reports when the deleted chat\'s knowledge could not be wiped', async () => {
    const { kernel, actions } = await setup()
    await kernel.createTask({ title: 'home task', spec: '' })
    const r = await actions.deleteProject(TEST_PROJECT_ID)
    expect(r.warnings.some(w => w.includes('memory read model not cleared'))).toBe(true)
    expect(r.warnings.some(w => w.includes('vanish on the next rebuild'))).toBe(true)
  })
})

describe('newProject', () => {
  it('reuses an already-initialized directory instead of re-minting; fresh dirs mint', async () => {
    const { actions, url, db } = await setup()
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-chat-'))
    const { projectId: original } = initializeProject(dir, 'original')

    // same folder → same project, flagged as reused; the typed name becomes the display name
    const reopened = await actions.newProject(dir, 'renamed chat')
    expect(reopened).toEqual({ projectId: original, reused: true })

    // the dir note is appended so the chat is locatable (autocomplete, guidance)
    const target = await openStorage(url, { projectId: original })
    db.onClose(() => target.close())
    const notes = (await target.events.after(0, [EVENT_KIND.memory_written]))
      .map(e => writtenNote(e.payload))
    expect(notes.find(n => n.id === PROJECT_DIR_NOTE_ID)?.title).toBe(dir)

    // an untouched directory mints a fresh identity
    const fresh = await actions.newProject(mkdtempSync(path.join(tmpdir(), 'orc-chat-')), 'fresh')
    expect(fresh.reused).toBe(false)
    expect(fresh.projectId).not.toBe(original)
  })
})
