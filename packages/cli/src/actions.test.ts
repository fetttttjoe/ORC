import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AUTHOR_SOURCE, DECISION_STATUS, Door, EVENT_KIND, MemoryWrittenPayload, NOTE_KIND, PlanDraft, TASK_STATUS, WORKSPACE_KIND, WORKSPACE_STATE, type Origin } from '@orc/contracts'
import { KERNEL_ERROR_CODE, Kernel, KernelError, currentBranch, initializeProject, loadConfig, openStorage, requireProject, type ProjectConfig } from '@orc/kernel'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE, TEST_WORKSPACE_ID, testConfig, tmpGitRepo, type TestDb } from '@orc/kernel/test-helpers'
import { PROJECT_DIR_NOTE_ID } from '@orc/ui-core'
import { buildModelDiscovery, buildOrcActions, catalogAppends, modelUniverse } from './actions'
import { openMemory } from './memory-open'
import { dropSurrealDb } from './test-helpers'
import { archivedRefusal } from './workspace-ops'

const dbs: Array<{ drop: () => Promise<void> }> = []
// Only setupWithSurreal registers here — every other test in this file points at a dead Surreal
// port on purpose, and a config with no database behind it has nothing to drop.
const surrealConfigs: ProjectConfig[] = []
afterAll(async () => {
  await Promise.all([...dbs.map(d => d.drop()), ...surrealConfigs.map(c => dropSurrealDb(c))])
}, 30_000)

// memory_written payload parsed through its owning schema at the read boundary — never a cast
const writtenNote = (payload: unknown): { id: string; title: string } => MemoryWrittenPayload.parse(payload).note

// The actions layer holds no execution port: it records asks and a supervisor executes them, so
// what a test injects is the promise that one exists — counted, to prove every write path asks.
function stubRuntime() {
  const ensured = { count: 0 }
  return { ensured, ensureRuntime: async () => { ensured.count++ } }
}

// The wiring both setups share — a per-test Postgres log, one seeded workspace, and the actions
// layer over them. ONE spelling, because the two differ in exactly one thing (whether a real memory
// read model is behind them) and a second copy of this block would drift on the rest.
// The two doors this file drives, spelled once each. Not a default: every call below names the one
// it is exercising, and the assertions read the chatId and door back off the log.
const WEB: Origin = { chatId: 'chat-1', door: Door.web }
const MCP: Origin = { chatId: 'chat-1', door: Door.mcp }

async function openActions(opts: { listModels?: () => Promise<string[]>; config?: Partial<ProjectConfig> } = {}) {
  const db = await createTestDb()
  dbs.push(db)
  const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
  // registered, not returned as a close() the test must remember to await: a bare close as the
  // last statement is SKIPPED when an assertion above it throws, leaking the pool into every
  // later test file — the same failure main.test.ts's cleanup comment records.
  db.onClose(() => storage.close())
  const kernel = new Kernel(storage.events)
  // a task must name a workspace the fold has seen — one seeded record, then tasks as before
  await seedTestWorkspace(storage.events, WEB)
  const { ensured, ensureRuntime } = stubRuntime()
  const config = testConfig(db.url, {
    vaultDir: mkdtempSync(path.join(tmpdir(), 'orc-vault-')),
    // the project dir IS the seeded workspace's checkout: every memory write from this layer
    // names the workspace of the directory it runs in, so a dir no workspace claims would make
    // writeNote/deleteNote/recordDecision/cancel-sweep/purge refuse rather than exercise their
    // real paths
    projectName: 'purge-me', dir: TEST_WORKSPACE.cwd,
    ...opts.config,
  })
  const actions = buildOrcActions({
    kernel, ensureRuntime, ...(opts.listModels && { listModels: opts.listModels }),
    plugin: { config, log: storage.events, storage },
  })
  return { kernel, actions, ensured, url: db.url, db, storage, config }
}

// newProject/renameProject/purge need only urls + storage from the plugin context; the bogus
// surreal url makes purge's memory rebuild report instead of hang, and the derived system-db url
// points at a never-created database (the common pre-first-run state)
const setup = (listModels?: () => Promise<string[]>) => openActions({
  ...(listModels && { listModels }),
  config: {
    projectDbUrl: 'ws://127.0.0.1:1/rpc',
    // the driver pends on unreachable endpoints, so the connect guard IS the failure path —
    // at its 5000ms production default the designed failure cannot fit a 5s test budget
    projectDbConnectTimeoutMs: 300,
  },
})

// …and the sibling with a LIVE throwaway Surreal database (main.test.ts's `t_<random>` shape),
// for the one action whose behaviour is a read of the real read model: recordDecision refuses an
// id that already exists, which the dead-port setup above could never exercise.
async function setupWithSurreal() {
  const r = await openActions({ config: { projectDbName: `t_${Math.random().toString(36).slice(2, 10)}` } })
  surrealConfigs.push(r.config)
  return r
}

// `createdBy` is composed at the write (composeAuthor) and lands in the read model, never in the
// event payload, so reading the note back is the only way to assert what a door stamped. The
// actions layer closes its own memory, so this opens a second one over the SAME log and config.
async function storedNote(r: Awaited<ReturnType<typeof setupWithSurreal>>, id: string) {
  const memory = await openMemory({ log: r.storage.events, config: r.config })
  try {
    await memory.projector.catchUp()
    return await memory.store.get(id)
  } finally {
    await memory.close()
  }
}

// Test 1 of the origin work: identity travels with the CALL, so every event a mutation appends
// carries the chat and the door it came in by. Asserted on the LOG, never a spy — a spy would only
// prove the action was called with an origin, not that the append kept it.
describe('every mutation stamps the origin it was called with', () => {
  type Row = { name: string; call: (a: ReturnType<typeof buildOrcActions>, kernel: Kernel, taskId: string) => Promise<unknown> }
  // the door parses --file/--from-vault into a draft; every row here takes the other PlanSource arm
  const TEMPLATE = { template: { modelRef: 'any/model', skillRefs: [] } }
  const rows: Row[] = [
    { name: 'newTask', call: a => a.newTask({ workspaceId: TEST_WORKSPACE_ID, title: 'stamped', budgetUSD: null }, WEB) },
    { name: 'propose', call: (a, _k, t) => a.propose(t, TEMPLATE, WEB) },
    // the proposed plan handed back edited: a hand-built draft would only prove this file can
    // spell PlanDraft, and the kernel parses the whole shape
    { name: 'edit', call: async (a, k, t) => { await a.propose(t, TEMPLATE, WEB); const plan = await k.getPlan(t); return a.edit(t, { draft: { ...PlanDraft.parse(plan), costEstimateUSD: 2 } }, WEB) } },
    { name: 'approve', call: async (a, _k, t) => { const { version } = await a.propose(t, TEMPLATE, WEB); return a.approve(t, { version }, WEB) } },
    { name: 'run', call: async (a, k, t) => { const { version } = await a.propose(t, TEMPLATE, WEB); await a.approve(t, { version }, WEB); void k; return a.run(t, process.cwd(), WEB) } },
    { name: 'annotate', call: async (a, _k, t) => { await a.propose(t, TEMPLATE, WEB); return a.annotate(t, 'note-1', 'rethink this', [], WEB) } },
    { name: 'revise', call: async (a, _k, t) => { await a.propose(t, TEMPLATE, WEB); return a.revise(t, 'rethink this', ['note-1'], WEB) } },
    { name: 'cancel', call: (a, _k, t) => a.cancel(t, WEB) },
    { name: 'renameProject', call: a => a.renameProject('stamped name', WEB) },
  ]

  for (const row of rows) {
    it(`${row.name} appends only events carrying its chatId and door`, async () => {
      const { kernel, actions, storage } = await setup()
      const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: row.name, spec: 'do it' }, MCP)
      const before = (await storage.events.all()).length
      await row.call(actions, kernel, t.id)
      const appended = (await storage.events.all()).slice(before)
      expect(appended.length).toBeGreaterThan(0)
      expect(appended.map(e => [e.chatId, e.door])).toEqual(appended.map(() => [WEB.chatId, Door.web]))
    }, 30_000)
  }
})

describe('model validation at the action boundary', () => {
  it('an invented model ref dies at creation with guidance, never reaching a plan', async () => {
    const { actions } = await setup(async () => ['anthropic/claude-haiku-4-5', 'ollama/llama3.2:3b'])
    const { taskId } = await actions.newTask({ workspaceId: TEST_WORKSPACE_ID, title: 'quick one', budgetUSD: null }, WEB)
    await expect(actions.propose(taskId, { template: { modelRef: 'anthropic/claude-3-5-sonnet-20241022', skillRefs: [] } }, WEB))
      .rejects.toThrow(/unknown model .* valid refs include: anthropic\/claude-haiku-4-5/)
    // known ref passes
    expect((await actions.propose(taskId, { template: { modelRef: 'anthropic/claude-haiku-4-5', skillRefs: [] } }, WEB)).version).toBe(1)
  })

  it('grounded creation validates too; no discovery = no blocking', async () => {
    const strict = await setup(async () => ['anthropic/claude-haiku-4-5'])
    await expect(strict.actions.newTask({ workspaceId: TEST_WORKSPACE_ID, title: 'g', budgetUSD: null, grounded: { modelRef: 'made/up', cwd: '/tmp' } }, WEB))
      .rejects.toThrow(/unknown model/)

    const offline = await setup(async () => { throw new Error('discovery down') })
    const t = await offline.actions.newTask({ workspaceId: TEST_WORKSPACE_ID, title: 'q2', budgetUSD: null }, WEB)
    expect((await offline.actions.propose(t.taskId, { template: { modelRef: 'anything/goes-when-offline', skillRefs: [] } }, WEB)).version).toBe(1)
  })
})

describe('writeNote/deleteNote guards', () => {
  it('refuse without a project context and refuse reserved ui-metadata ids', async () => {
    const { kernel, actions } = await setup() // setup() wires a real plugin behind actions
    await expect(actions.writeNote({ id: 'ui-project-name', title: 'x' }, WEB)).rejects.toThrow(/reserved/)
    await expect(actions.deleteNote('ui-project-dir', undefined, WEB)).rejects.toThrow(/reserved/)
    const bare = buildOrcActions({ kernel, ensureRuntime: stubRuntime().ensureRuntime }) // no plugin
    await expect(bare.writeNote({ id: 'x', title: 'x' }, WEB)).rejects.toThrow(/project context/)
  })
})

// The second (and last) knowledge-authoring door: what a driver's session decided, recorded where
// it cannot evaporate. Attribution is the whole point of testing it HERE rather than only over the
// lifecycle op — the op takes an author, and this layer is what decides which door and which
// checkout that author names.
describe('the decision door', () => {
  it('recordDecision writes a decision attributed to the door it came through (mcp) in the serving checkout\'s workspace', async () => {
    const r = await setupWithSurreal()
    expect(await r.actions.recordDecision({ title: 'From Claude', context: 'c', decision: 'd', consequences: 'q', tags: [] }, MCP))
      .toEqual({ id: 'from-claude', status: DECISION_STATUS.accepted, superseded: null })
    // the log is the truth this asserts against: the read model is a projection of it
    const written = (await r.storage.events.all()).filter(e => e.kind === EVENT_KIND.memory_written).map(e => MemoryWrittenPayload.parse(e.payload))
    expect(written.at(-1)?.author).toMatchObject({ source: AUTHOR_SOURCE.mcp, workspaceId: TEST_WORKSPACE_ID })
    expect(written.at(-1)?.note).toMatchObject({ id: 'from-claude', kind: NOTE_KIND.decision, status: DECISION_STATUS.accepted })
    // …and the STORED attribution, which is the half a reader sees: composeAuthor renders a bare
    // door as itself. It read 'agent' until 2026-09-15, and createdBy is sticky across rewrites —
    // so a misattribution here is permanent, not a display bug.
    expect((await storedNote(r, 'from-claude'))?.createdBy).toBe(AUTHOR_SOURCE.mcp)
  }, 30_000)

  // The twin: the WEB door is a terminal-equivalent surface (authorSourceOf(Door.web) === cli).
  // Asserted alongside the mcp case because the two must not converge — a door that cannot be told
  // apart in the log is the attribution failure this source vocabulary exists to end.
  it('recordDecision from the web door records cli, in the log and in what a reader sees', async () => {
    const r = await setupWithSurreal()
    expect(await r.actions.recordDecision({ title: 'From the web', context: 'c', decision: 'd', consequences: 'q', tags: [] }, WEB))
      .toEqual({ id: 'from-the-web', status: DECISION_STATUS.accepted, superseded: null })
    const written = (await r.storage.events.all()).filter(e => e.kind === EVENT_KIND.memory_written).map(e => MemoryWrittenPayload.parse(e.payload))
    expect(written.at(-1)?.author).toMatchObject({ source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID })
    expect((await storedNote(r, 'from-the-web'))?.createdBy).toBe(AUTHOR_SOURCE.cli)
  }, 30_000)
})

// The stall worry belongs to the SEAM, not to one door: both doors discover now, so a napping
// provider daemon has to be BOUNDED here instead of answered with a flag at the call site.
describe('per-provider discovery timeout', () => {
  it('a provider whose listModels never resolves falls back to its cost universe, within the timeout', async () => {
    const napping = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    try {
      const config = testConfig('postgres://127.0.0.1:1/none', {
        ollamaBaseUrl: `http://localhost:${napping.port}`,
        costOverrides: { ollama: { 'llama3.2:3b': { inPerMTok: 0, outPerMTok: 0 } } },
      })
      const started = Date.now()
      const refs = await buildModelDiscovery(config, undefined, 50).listModels()
      expect(Date.now() - started).toBeLessThan(5000)
      expect(refs).toContain('ollama/llama3.2:3b') // unreachable is unreachable, however it fails
    } finally { await napping.stop(true) }
  }, 10_000)
})

describe('modelUniverse', () => {
  it('unions live ids with priced cost-table ids — aliases stay valid when the API lists dated ids', () => {
    expect(modelUniverse(['claude-haiku-4-5-20251001'], { 'claude-haiku-4-5': {}, '*': {} }))
      .toEqual(['claude-haiku-4-5', 'claude-haiku-4-5-20251001'])
    expect(modelUniverse([], { '*': {} })).toEqual([]) // wildcard-only providers discover nothing
  })
})

describe('catalogAppends', () => {
  const last = new Map([['ollama', JSON.stringify(['all-minilm:latest', 'nomic-embed-text:latest'])]])

  it('records an EMPTIED catalog from a reachable provider — the stale-encoder case', () => {
    // observed 2026-08-03: the embedding filter emptied ollama's live list, and the old
    // empty-list guard skipped the append, so the served catalog kept offering the encoders
    expect(catalogAppends([{ pid: 'ollama', ids: [], reachable: true }], last))
      .toEqual([{ providerId: 'ollama', models: [] }])
  })

  it('records nothing for an UNREACHABLE provider — silence is not a catalog', () => {
    expect(catalogAppends([{ pid: 'ollama', ids: [], reachable: false }], last)).toEqual([])
  })

  it('records nothing when the catalog is unchanged', () => {
    expect(catalogAppends([{ pid: 'ollama', ids: ['all-minilm:latest', 'nomic-embed-text:latest'], reachable: true }], last)).toEqual([])
  })

  it('records a first sighting for a provider with no prior event', () => {
    expect(catalogAppends([{ pid: 'anthropic', ids: ['claude-opus-5'], reachable: true }], last))
      .toEqual([{ providerId: 'anthropic', models: ['claude-opus-5'] }])
  })
})

describe('purgeProject', () => {
  it('wipes events + operations — stuck-running tasks included — and leaves the project usable', async () => {
    const { kernel, actions, url, db } = await setup()
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'to be purged', spec: '' }, WEB)
    // status transitions are executor-appended events, not kernel methods — append directly.
    // A task stuck 'running' (crashed run) is exactly what purge must clear without help.
    const storage = await openStorage(url, { projectId: TEST_PROJECT_ID })
    db.onClose(() => storage.close())
    await storage.events.append({
      taskId: t.id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
      payload: { taskId: t.id, from: TASK_STATUS.draft, to: TASK_STATUS.running }, ...WEB,
    })

    const r = await actions.purgeProject(WEB)
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
    expect(notes.map(n => [n.id, n.title])).toEqual([['ui-project-name', 'purge-me'], ['ui-project-dir', TEST_WORKSPACE.cwd]])

    // The project's own checkout SURVIVES the wipe, keeping its id. It is an event like any other
    // and the purge does delete it, but it is re-appended with the identity notes — because those
    // notes' author names it, and because a re-adopted checkout would come back under a NEW uuid,
    // silently orphaning every note written in the same breath.
    expect(await kernel.listWorkspaces()).toEqual([TEST_WORKSPACE])
    // so the empty project is immediately usable again — the re-test loop, with no re-seeding
    const again = await actions.newTask({ workspaceId: TEST_WORKSPACE_ID, title: 'fresh start', budgetUSD: null }, WEB)
    expect((await kernel.getTask(again.taskId))?.title).toBe('fresh start')
  })

  // The race purgeProject's own WHY names: a boot adoption lands in the window between the wipe and
  // the re-seat, so the cwd is occupied again by the time restoreWorkspace runs and the kernel
  // (correctly) refuses a second live record for one directory. The wipe is ALREADY COMMITTED at
  // that point — throwing would leave the project worse off than not re-seeding, which is why every
  // other post-wipe step here warns instead.
  //
  // The wipe is the only deterministic seam for that window, so the intruder is appended from inside
  // a wrapped `purge()`. A test may write to the log directly; production code may not.
  it('a workspace minted at that cwd between the wipe and the re-seat is reported, never thrown', async () => {
    const { kernel, actions, storage } = await setup()
    const intruderId = '99999999-9999-4999-8999-999999999999'
    const realPurge = storage.purge.bind(storage)
    storage.purge = async () => {
      const counts = await realPurge()
      await storage.events.append({
        taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.workspace_created,
        payload: { workspace: { ...TEST_WORKSPACE, id: intruderId } }, ...WEB,
      })
      return counts
    }

    const r = await actions.purgeProject(WEB) // must resolve: the history is already gone
    expect(r.warnings.some(w => w.includes('identity not re-seeded') && w.includes('already exists at'))).toBe(true)

    // the intruder stands alone — no second live record was forced in beside it
    expect((await kernel.listWorkspaces()).map(w => w.id)).toEqual([intruderId])
    // and no identity note was written, because there was no workspace this process could name as
    // its author — a note stamped with the intruder's id would be a guess
    expect((await storage.events.all()).filter(e => e.kind === EVENT_KIND.memory_written)).toEqual([])
  })
})

describe('workspace binding at the action boundary', () => {
  // Same rule as `orc new --parent`: a child of a task in workspace B belongs to B, never to
  // whatever checkout this process happens to be serving. Only a caller that names a workspace
  // outright may re-home it.
  it('newTask with a parentId inherits the parent\'s workspace, never this process\'s directory', async () => {
    const { kernel, actions } = await setup()
    const other = await kernel.createWorkspace({ title: 'Other', cwd: '/other', branch: 'b', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false }, WEB)
    const parent = await kernel.createTask({ workspaceId: other.id, title: 'parent', spec: '' }, WEB)
    const { taskId } = await actions.newTask({ title: 'child', parentId: parent.id, budgetUSD: null }, WEB)
    expect((await kernel.getTask(taskId))?.workspaceId).toBe(other.id)
    // an explicit workspaceId still wins over the parent
    const rehomed = await actions.newTask({ title: 'rehomed', parentId: parent.id, workspaceId: TEST_WORKSPACE_ID, budgetUSD: null }, WEB)
    expect((await kernel.getTask(rehomed.taskId))?.workspaceId).toBe(TEST_WORKSPACE_ID)
  })

  // The door refuses what the kernel accepts, and only for a caller that NAMED the workspace.
  // Archiving is not a fact about whether a record may be referenced — the kernel is right to let a
  // merged workspace's subtree keep growing — but an operator who archived a checkout on purpose and
  // then files a task there has filed work nobody will find again: the listing hides it by default,
  // and the directory may not even exist any more.
  it('refuses an explicitly named ARCHIVED workspace, while inheritance from one is untouched', async () => {
    const { kernel, actions } = await setup()
    const done = await kernel.createWorkspace({ title: 'Done', cwd: '/done', branch: 'b', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false }, WEB)
    const parent = await kernel.createTask({ workspaceId: done.id, title: 'parent', spec: '' }, WEB)
    await kernel.setWorkspaceArchived(done.id, true, WEB)

    await expect(actions.newTask({ title: 'filed in a finished checkout', workspaceId: done.id, budgetUSD: null }, WEB))
      .rejects.toThrow(archivedRefusal(done.id))
    // INHERITANCE is untouched: a subtree straddling two checkouts is worse than a task drafted in
    // a finished one, so a child still lands in its parent's workspace whatever its standing
    const child = await actions.newTask({ title: 'child', parentId: parent.id, budgetUSD: null }, WEB)
    expect((await kernel.getTask(child.taskId))?.workspaceId).toBe(done.id)
    // an UNKNOWN id keeps the kernel's own refusal — the CODE as well as the words, so a door that
    // checks first and one that does not are indistinguishable on a typo. A plain Error would carry
    // the same sentence and make every caller that switches on the code read a typo as an internal
    // failure, which is why the class is asserted and not just the message.
    const typo = await actions.newTask({ title: 'typo', workspaceId: 'no-such-workspace', budgetUSD: null }, WEB).catch((e: unknown) => e)
    expect(typo).toBeInstanceOf(KernelError)
    expect(typo instanceof KernelError && typo.code).toBe(KERNEL_ERROR_CODE.workspace_not_found)
  })
})

describe('cwd validation at the action boundary', () => {
  it('an invented cwd dies at creation/run — never 4 retries deep in the executor', async () => {
    const { kernel, actions, ensured } = await setup()
    await expect(actions.newTask({ workspaceId: TEST_WORKSPACE_ID, title: 'g', spec: 'do it', budgetUSD: null, grounded: { modelRef: 'any/model', cwd: '/workspace/orc-sim' } }, WEB))
      .rejects.toThrow(/cwd is not an existing directory: \/workspace\/orc-sim/)
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'q', spec: '' }, WEB)
    await expect(actions.run(t.id, '/no/such/dir', WEB)).rejects.toThrow(/cwd is not an existing directory/)
    // and it died before anything was recorded or spawned — a bad cwd must not become an ask
    // every supervisor that boots picks up and fails on again
    expect([ensured.count, (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.run_requested)]).toEqual([0, false])
  })
})

// Move a freshly created task to approved: propose a single-step template, then approve it. This
// is the ONLY state actions.run() will now accept — a draft/unapproved task is refused at the door,
// exactly as the CLI `run` (main.ts requireDrivable) and startRunAt (dbos-port.ts) refuse it.
async function approvedTask(kernel: Kernel, actions: ReturnType<typeof buildOrcActions>, title = 'door') {
  const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title, spec: 'do it' }, WEB)
  const { version } = await actions.propose(t.id, { template: { modelRef: 'any/model', skillRefs: [] } }, WEB)
  await actions.approve(t.id, { version }, WEB)
  return t
}

describe('the MCP and web doors record the ask; the supervisor executes it', () => {
  it('run guarantees a supervisor, then appends run_requested with the cwd it validated', async () => {
    const { kernel, actions, ensured } = await setup()
    const t = await approvedTask(kernel, actions)
    // `since` is the log position the CLI door watches the run from, so it is a number, not a shape
    const asked = await actions.run(t.id, process.cwd(), WEB)
    expect([asked.requested, typeof asked.since]).toEqual([true, 'number'])
    expect(ensured.count).toBe(1)
    const requested = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.run_requested)
    expect(requested?.payload).toEqual({ taskId: t.id, cwd: process.cwd(), retry: false })
  })

  // An omitted cwd is not "the directory this process happens to serve": the kernel resolves it
  // from the task's own workspace (requestRun), which is the only reading that keeps a task created
  // in one worktree running there. So the door must pass the absence through, not fill it in — and
  // must not validate a directory it was never given (TEST_WORKSPACE.cwd does not exist on disk,
  // and a door that resolved-then-checked would refuse a run the kernel accepts).
  it('run without a cwd records the task\'s WORKSPACE cwd, validating nothing at the door', async () => {
    const { kernel, actions, ensured } = await setup()
    const t = await approvedTask(kernel, actions, 'no cwd')
    const asked = await actions.run(t.id, null, WEB)
    expect([asked.requested, typeof asked.since]).toEqual([true, 'number'])
    expect(ensured.count).toBe(1)
    const requested = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.run_requested)
    expect(requested?.payload).toEqual({ taskId: t.id, cwd: TEST_WORKSPACE.cwd, retry: false })
  })

  // Finding 1 of the Phase-1 audit: actions.run() (the web + MCP door) used to skip the
  // drivable-status admission the CLI `run` enforces, so a draft/unapproved/terminal task silently
  // became a run_requested nobody could serve — sat in the log, and every booting supervisor
  // failed on it again. run() now mirrors retry()'s refusal: reject at the door, with the exact
  // startRunAt message, before ensureRuntime or requestRun.
  it('run refuses a draft task (no approved plan) — same message as CLI run, no ask, no supervisor', async () => {
    const { kernel, actions, ensured } = await setup()
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'draft', spec: '' }, WEB)
    await expect(actions.run(t.id, process.cwd(), WEB))
      .rejects.toThrow(`task is 'draft' — approve a plan first (orc approve ${t.id})`)
    // and it died before anything was recorded or a supervisor guaranteed — a request nobody can
    // serve must never reach the log
    expect([ensured.count, (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.run_requested)]).toEqual([0, false])
  })

  it('run refuses a proposed-but-unapproved task — no approvedVersion is not drivable', async () => {
    const { kernel, actions, ensured } = await setup()
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'proposed', spec: 'do it' }, WEB)
    await actions.propose(t.id, { template: { modelRef: 'any/model', skillRefs: [] } }, WEB) // proposed, NOT approved
    await expect(actions.run(t.id, process.cwd(), WEB)).rejects.toThrow(/approve a plan first/)
    expect([ensured.count, (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.run_requested)]).toEqual([0, false])
  })

  it('retry refuses a task that is not blocked, before recording or spawning anything', async () => {
    const { kernel, actions, ensured } = await setup()
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'door', spec: '' }, WEB)
    await expect(actions.retry(t.id, null, WEB)).rejects.toThrow(/only a blocked task can be retried/)
    expect([ensured.count, (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.run_requested)]).toEqual([0, false])
  })
})

// `orc ws new` and the MCP door's workspace_new are ONE implementation (createRequestWorkspace in
// workspace-ops.ts, which both doors call): a second one would be a second answer to "where does a
// request's checkout come from", and the two doors would drift on the branch name, the base or the
// drafted task.
describe('the workspace door', () => {
  it('newWorkspace creates the worktree, records it and drafts the request as its first task', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { main } = tmpGitRepo()
    initializeProject(main, 'ws-door')
    const config = requireProject({ ...loadConfig(main), databaseUrl: db.url, projectId: TEST_PROJECT_ID, projectName: 'ws-door' })
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    db.onClose(() => storage.close())
    const kernel = new Kernel(storage.events)
    const actions = buildOrcActions({ kernel, ensureRuntime: stubRuntime().ensureRuntime, plugin: { config, log: storage.events, storage } })

    const { workspace, taskId } = await actions.newWorkspace({ title: 'Add search', spec: 'find by name' }, WEB)
    expect(workspace).toMatchObject({ title: 'Add search', branch: 'orc/add-search', kind: WORKSPACE_KIND.worktree, managed: true })
    expect(workspace.cwd).toBe(realpathSync(path.join(main, '.orc', 'worktrees', 'add-search')))
    // base defaults to this checkout's HEAD, stored as the resolved branch NAME
    expect(workspace.baseBranch).toBe(currentBranch(main))
    // this door ALWAYS drafts the task: --no-task is a terminal affordance for a human who is about
    // to work in the tree themselves, and a driver asking for a workspace is asking for a request
    const task = (await kernel.listTasks()).find(t => t.workspaceId === workspace.id)
    expect(task).toMatchObject({ title: 'Add search', spec: 'find by name' })
    expect(taskId).toBe(task?.id ?? null)
    expect((await actions.listWorkspaces()).map(r => r.workspace.id)).toContain(workspace.id)
  }, 30_000)

  it('listWorkspaces answers the ACTIVE records only — an archived one is finished business', async () => {
    const { kernel, actions } = await setup()
    const old = await kernel.createWorkspace({ title: 'Old', cwd: '/old', branch: 'x', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false }, WEB)
    await kernel.setWorkspaceArchived(old.id, true, WEB)
    expect((await actions.listWorkspaces()).map(r => r.workspace.id)).toEqual([TEST_WORKSPACE_ID])
  })

  // The door hands back the RECORD AND THE VERDICT, from the same derivation `orc ws ls` prints:
  // a driver asking "which checkout" and an operator reading the terminal must not be given two
  // different readings of one workspace.
  it('listWorkspaces carries each record\'s health, and reports an uncountable note corpus as unknown rather than zero', async () => {
    const { actions } = await setup()
    const [row] = await actions.listWorkspaces()
    // this fixture's workspace names /test/workspace, which is not on disk — unmerged with no
    // checkout behind it is exactly what `dangling` is for
    expect(row?.health).toMatchObject({ state: WORKSPACE_STATE.dangling, dirExists: false, taskCount: 0 })
    // …and its project db url points at nothing, so the count comes back UNKNOWN. Never 0: a
    // zero here is a measured "nothing pending", which is what decides `dangling` vs `idle`.
    expect(row?.health.provisionalNotes).toBeNull()
    expect(row?.health.lastActivityAt).not.toBeNull() // the workspace_created event dates it
  })

  it('newWorkspace refuses without a project context — there is no checkout to hang a worktree off', async () => {
    const { kernel } = await setup()
    const bare = buildOrcActions({ kernel, ensureRuntime: stubRuntime().ensureRuntime }) // no plugin
    await expect(bare.newWorkspace({ title: 'nowhere' }, WEB)).rejects.toThrow(/project context/)
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
    // the log is scoped PER PROJECT, so the foreign project needs its own workspace record —
    // setup()'s seed lives in the home project's log and is invisible from here
    await seedTestWorkspace(storage.events, WEB)
    const t = await new Kernel(storage.events).createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'parked on a question', spec: '' }, WEB)
    await storage.events.append({
      taskId: t.id, stepId: 'plan', runToken: 'run-1', kind: EVENT_KIND.feedback_requested,
      payload: { topic: 'consent', question: 'go ahead?' }, ...WEB,
    })
    return { storage, taskId: t.id }
  }
  const answers = async (storage: Awaited<ReturnType<typeof openStorage>>) =>
    (await storage.events.all()).filter(e => e.kind === EVENT_KIND.feedback_provided)

  it('answers a FOREIGN project in that project\'s own log, spawning no runtime here', async () => {
    const { actions, ensured, db } = await setup()
    const { storage, taskId } = await parkedQuestion(db, 'foreign-project')
    // supervised:false — nothing is live over there, and the human who typed it must be told
    expect(await actions.reply(taskId, 'yes', 'foreign-project', WEB)).toEqual({ answered: true, supervised: false })
    expect(await answers(storage)).toHaveLength(1)
    // execution stays bound to the directory orc was started in: answering guarantees nothing
    expect(ensured.count).toBe(0)
  })

  it('still guarantees a supervisor when the project is its own', async () => {
    const { actions, ensured, db } = await setup()
    const { storage, taskId } = await parkedQuestion(db, TEST_PROJECT_ID)
    expect(await actions.reply(taskId, 'yes', undefined, WEB)).toEqual({ answered: true, supervised: true })
    expect(await answers(storage)).toHaveLength(1)
    expect(ensured.count).toBe(1)
    // naming the home project explicitly (the web door always does) takes the same path
    await storage.events.append({
      taskId, stepId: 'plan', runToken: 'run-1', kind: EVENT_KIND.feedback_requested,
      payload: { topic: 'consent-2', question: 'again?' }, ...WEB,
    })
    expect(await actions.reply(taskId, 'yes', TEST_PROJECT_ID, WEB)).toEqual({ answered: true, supervised: true })
    expect(ensured.count).toBe(2)
  })

  it('refuses a foreign project without a project context to resolve its database', async () => {
    const { kernel } = await setup()
    const bare = buildOrcActions({ kernel, ensureRuntime: stubRuntime().ensureRuntime }) // no plugin
    await expect(bare.reply('t1', 'yes', 'foreign-project', WEB)).rejects.toThrow(/project context/)
  })
})

describe('deleteProject', () => {
  it('wipes any project outright — foreign AND home — with no identity re-seed', async () => {
    const { kernel, actions, url, db } = await setup()
    // home: full wipe, resolves (purge remains the identity-preserving reset)
    await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'home task', spec: '' }, WEB)
    expect((await actions.deleteProject(TEST_PROJECT_ID, WEB)).events).toBeGreaterThan(0)
    expect(await kernel.listTasks()).toEqual([])

    // seed a foreign project, then delete it — no identity re-seed, so it is GONE
    const foreign = await openStorage(url, { projectId: 'doomed-project' })
    db.onClose(() => foreign.close())
    await foreign.events.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
      payload: { note: { id: 'n1', title: 'n1' }, author: { source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID, origin: WEB } }, ...WEB,
    })

    const r = await actions.deleteProject('doomed-project', WEB)
    expect(r.events).toBe(1)
    const check = await openStorage(url, { projectId: 'doomed-project' })
    db.onClose(() => check.close())
    expect(await check.events.all()).toEqual([])
  })

  // Deleting a chat must delete its knowledge — the read model lives in a project-derived SurrealDB
  // database that the home project's memory instance cannot reach (orphaned notes stay live until
  // a rebuild drops them). When the wipe fails, the caller is told.
  it('reports when the deleted chat\'s knowledge could not be wiped', async () => {
    const { kernel, actions } = await setup()
    await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'home task', spec: '' }, WEB)
    const r = await actions.deleteProject(TEST_PROJECT_ID, WEB)
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
    const reopened = await actions.newProject(dir, 'renamed chat', WEB)
    expect(reopened).toEqual({ projectId: original, reused: true })

    // the dir note is appended so the chat is locatable (autocomplete, guidance)
    const target = await openStorage(url, { projectId: original })
    db.onClose(() => target.close())
    const notes = (await target.events.after(0, [EVENT_KIND.memory_written]))
      .map(e => writtenNote(e.payload))
    expect(notes.find(n => n.id === PROJECT_DIR_NOTE_ID)?.title).toBe(dir)

    // an untouched directory mints a fresh identity
    const fresh = await actions.newProject(mkdtempSync(path.join(tmpdir(), 'orc-chat-')), 'fresh', WEB)
    expect(fresh.reused).toBe(false)
    expect(fresh.projectId).not.toBe(original)
  })

  it('a subdirectory of a worktree (no .orc of its own) reuses the repo project instead of throwing', async () => {
    // the old `existsSync(.orc) ? loadConfig(...) : null` check fell straight through to
    // initializeProject for a dir with no .orc/ of its own. A subdirectory of a linked worktree
    // resolves (via resolveProjectRoot) to the MAIN checkout's identity, so initializeProject now
    // throws "already initialized" instead of reusing it — measured directly: a subdirectory of
    // the MAIN checkout does NOT reproduce this (main-checkout subdirectories are deliberately
    // NOT re-rooted, so they'd just mint their own fresh identity, no throw); only a worktree
    // subdirectory re-roots to an already-initialized ancestor and hits the throw.
    const { actions } = await setup()
    const { main, worktree } = tmpGitRepo()
    const { projectId: original } = initializeProject(main, 'repo project')
    const nested = path.join(worktree, 'apps', 'x')
    mkdirSync(nested, { recursive: true })

    const reopened = await actions.newProject(nested, 'renamed chat', WEB)
    expect(reopened).toEqual({ projectId: original, reused: true })
  })
})
