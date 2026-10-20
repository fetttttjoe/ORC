import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AUTHOR_SOURCE, DecisionStatus, Door, EVENT_KIND, KNOWLEDGE_REFUSAL, KnowledgeWrittenPayload, PlanDraft, TASK_STATUS, WORKSPACE_KIND, type Origin } from '@orc/contracts'
import { KERNEL_ERROR_CODE, Kernel, KernelError, currentBranch, initializeProject, loadConfig, openStorage, requireProject, type ProjectConfig } from '@orc/kernel'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE, TEST_WORKSPACE_ID, testConfig, tmpGitRepo, type TestDb } from '@orc/kernel/test-helpers'
import { buildModelDiscovery, buildOrcActions, catalogAppends, modelUniverse } from './actions'
import { archivedRefusal } from './workspace-ops'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => {
  await Promise.all(dbs.map(d => d.drop()))
}, 30_000)

// the actions layer holds no execution port: tests count the asks a supervisor would execute
function stubRuntime() {
  const ensured = { count: 0 }
  return { ensured, ensureRuntime: async () => { ensured.count++ } }
}

const WEB: Origin = { chatId: 'chat-1', door: Door.web }
const MCP: Origin = { chatId: 'chat-1', door: Door.mcp }

async function openActions(opts: { listModels?: () => Promise<string[]>; config?: Partial<ProjectConfig> } = {}) {
  const db = await createTestDb()
  dbs.push(db)
  const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
  // teardown is registered, not returned: a bare close() is skipped when an assertion throws
  db.onClose(() => storage.close())
  const kernel = new Kernel(storage.events)
  // a task must name a workspace the fold has seen — one seeded record, then tasks as before
  await seedTestWorkspace(storage.events, WEB, opts.config?.dir)
  const { ensured, ensureRuntime } = stubRuntime()
  const config = testConfig(db.url, {
    vaultDir: mkdtempSync(path.join(tmpdir(), 'orc-vault-')),
    projectName: 'purge-me', dir: TEST_WORKSPACE.cwd,
    ...opts.config,
  })
  const actions = buildOrcActions({
    kernel, ensureRuntime, ...(opts.listModels && { listModels: opts.listModels }),
    plugin: { config, log: storage.events, storage },
  })
  return { kernel, actions, ensured, url: db.url, db, storage, config }
}

// the derived system-db url points at a never-created database (the common pre-first-run state)
const setup = (listModels?: () => Promise<string[]>) => openActions({ ...(listModels && { listModels }) })

describe('every mutation stamps the origin it was called with', () => {
  type Row = { name: string; call: (a: ReturnType<typeof buildOrcActions>, kernel: Kernel, taskId: string) => Promise<unknown> }
  // the door parses --file/--from-vault into a draft; every row here takes the other PlanSource arm
  const TEMPLATE = { template: { modelRef: 'any/model', skillRefs: [] } }
  const rows: Row[] = [
    { name: 'newTask', call: a => a.newTask({ workspaceId: TEST_WORKSPACE_ID, title: 'stamped', budgetUSD: null }, WEB) },
    { name: 'propose', call: (a, _k, t) => a.propose(t, TEMPLATE, WEB) },
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

describe('cancel', () => {
  it('answers the task ids it stamped, and none for a task already terminal', async () => {
    const { kernel, actions } = await setup()
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'cancel me', spec: '' }, MCP)
    expect(await actions.cancel(t.id, WEB)).toEqual({ cancelled: [t.id] })
    expect(await actions.cancel(t.id, WEB)).toEqual({ cancelled: [] })
  })
})

const DECISION = { title: 'From Claude', context: 'c', decision: 'd', consequences: 'q', considered: [], tags: [] }

async function setupWithCheckout(knowledge?: Partial<ProjectConfig>) {
  const { main } = tmpGitRepo()
  const r = await openActions({ config: { dir: realpathSync(main), ...knowledge } })
  return { ...r, main: realpathSync(main) }
}

const knowledgeWritten = async (r: Awaited<ReturnType<typeof setupWithCheckout>>) =>
  (await r.storage.events.all()).filter(e => e.kind === EVENT_KIND.knowledge_written).map(e => KnowledgeWrittenPayload.parse(e.payload))

describe('the decision door', () => {
  it('records, lists and reads a decision through the knowledge port, attributed to the door it came through', async () => {
    const r = await setupWithCheckout()
    expect(await r.actions.recordDecision(DECISION, MCP)).toEqual({ id: 'from-claude', status: DecisionStatus.accepted, superseded: null })
    expect(await r.actions.listDecisions({}, MCP)).toMatchObject([{ id: 'from-claude', title: 'From Claude', status: DecisionStatus.accepted, summary: 'd', supersedes: null, supersededBy: null }])
    expect(await r.actions.readDecision('from-claude', WEB)).toMatchObject({ id: 'from-claude', context: 'c', decision: 'd', consequences: 'q' })
    expect(existsSync(path.join(r.main, 'docs', 'decisions'))).toBe(true)
    const [written] = await knowledgeWritten(r)
    expect(written?.author).toMatchObject({ source: AUTHOR_SOURCE.mcp, workspaceId: TEST_WORKSPACE_ID })
    expect(written?.decisionsRecorded.map(d => d.id)).toEqual(['from-claude'])
  }, 30_000)

  it('recordDecision from the web door records cli', async () => {
    const r = await setupWithCheckout()
    await r.actions.recordDecision({ ...DECISION, title: 'From the web' }, WEB)
    expect((await knowledgeWritten(r)).at(-1)?.author).toMatchObject({ source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID })
  }, 30_000)

  it('a supersession reports the decision it replaced, and the list shows both links', async () => {
    const r = await setupWithCheckout()
    await r.actions.recordDecision(DECISION, MCP)
    expect(await r.actions.recordDecision({ ...DECISION, title: 'Second thoughts', supersedes: 'from-claude' }, MCP))
      .toEqual({ id: 'second-thoughts', status: DecisionStatus.accepted, superseded: 'from-claude' })
    const rows = await r.actions.listDecisions({}, MCP)
    expect(rows.map(d => [d.id, d.status, d.supersedes, d.supersededBy])).toEqual([
      ['second-thoughts', DecisionStatus.accepted, 'from-claude', null],
      ['from-claude', DecisionStatus.superseded, null, 'second-thoughts'],
    ])
    expect(await r.actions.listDecisions({ status: DecisionStatus.superseded }, MCP)).toHaveLength(1)
  }, 30_000)

  it('reading an unrecorded decision is refused by name', async () => {
    const r = await setupWithCheckout()
    await expect(r.actions.readDecision('nope', MCP)).rejects.toThrow(/no decision 'nope'/)
  }, 30_000)

  it('with knowledge switched off every decision action refuses with the reason', async () => {
    const r = await setupWithCheckout({ knowledge: null })
    const off = KNOWLEDGE_REFUSAL.off()
    await expect(r.actions.recordDecision(DECISION, MCP)).rejects.toThrow(off)
    await expect(r.actions.listDecisions({}, MCP)).rejects.toThrow(off)
    await expect(r.actions.readDecision('x', MCP)).rejects.toThrow(off)
  }, 30_000)
})

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

describe('renameProject', () => {
  it('appends the new name with this project\'s directory', async () => {
    const { actions, storage } = await setup()
    await actions.renameProject('renamed', WEB)
    const identified = (await storage.events.all()).filter(e => e.kind === EVENT_KIND.project_identified)
    expect(identified.map(e => e.payload)).toEqual([{ name: 'renamed', dir: TEST_WORKSPACE.cwd }])
  })
})

describe('purgeProject', () => {
  it('a renamed project keeps its new name after a purge', async () => {
    const { actions, storage } = await setup()
    await actions.renameProject('renamed', WEB)
    await actions.purgeProject(WEB)
    const identified = (await storage.events.all()).filter(e => e.kind === EVENT_KIND.project_identified)
    expect(identified.at(-1)?.payload).toEqual({ name: 'renamed', dir: TEST_WORKSPACE.cwd })
  })

  it('a purge falls back to the config name, without a warning, when the state read fails', async () => {
    const { kernel, actions, storage } = await setup()
    const spy = spyOn(kernel, 'state').mockRejectedValue(new Error('fold failed'))
    try {
      const r = await actions.purgeProject(WEB)
      expect(r.warnings.some(w => w.includes('project identity not re-seeded'))).toBe(false)
    } finally {
      spy.mockRestore()
    }
    const identified = (await storage.events.all()).filter(e => e.kind === EVENT_KIND.project_identified)
    expect(identified.at(-1)?.payload).toEqual({ name: 'purge-me', dir: TEST_WORKSPACE.cwd })
  })

  it('wipes events + operations — stuck-running tasks included — and leaves the project usable', async () => {
    const { kernel, actions, url, db } = await setup()
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'to be purged', spec: '' }, WEB)
    // a task stuck 'running' (crashed run) is exactly what purge must clear
    const storage = await openStorage(url, { projectId: TEST_PROJECT_ID })
    db.onClose(() => storage.close())
    await storage.events.append({
      taskId: t.id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
      payload: { taskId: t.id, from: TASK_STATUS.draft, to: TASK_STATUS.running }, ...WEB,
    })

    const r = await actions.purgeProject(WEB)
    expect(r.events).toBeGreaterThan(0)
    // the absent dbos system db (never launched) produces NO warning
    expect(r.warnings).toEqual([])
    expect(await kernel.listTasks()).toEqual([])

    // identity survives the wipe: the identity event is re-seeded, so the chat stays listed
    const identity = await openStorage(url, { projectId: TEST_PROJECT_ID })
    db.onClose(() => identity.close())
    const identified = (await identity.events.all()).filter(e => e.kind === EVENT_KIND.project_identified)
    expect(identified.map(e => e.payload)).toEqual([{ name: 'purge-me', dir: TEST_WORKSPACE.cwd }])

    // the project's own checkout survives the wipe with its id; a re-adopted one would get a new uuid
    expect(await kernel.listWorkspaces()).toEqual([TEST_WORKSPACE])
    // so the empty project is immediately usable again — the re-test loop, with no re-seeding
    const again = await actions.newTask({ workspaceId: TEST_WORKSPACE_ID, title: 'fresh start', budgetUSD: null }, WEB)
    expect((await kernel.getTask(again.taskId))?.title).toBe('fresh start')
  })

  it('leaves the knowledge files in the checkout byte-identical, and warns about no memory', async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-purge-knowledge-')))
    try {
      const bucket = path.join(dir, 'packages', 'x', 'knowledge', 'README.md')
      const text = '# packages/x\n\n## Facts\n- The x package is a purge fixture. {pxfix234 @packages/x}\n'
      mkdirSync(path.dirname(bucket), { recursive: true })
      writeFileSync(bucket, text)
      const { actions } = await openActions({ config: { dir } })

      const r = await actions.purgeProject(WEB)
      expect(existsSync(bucket) ? readFileSync(bucket, 'utf8') : 'the bucket is gone').toBe(text)
      expect(r.warnings.filter(w => w.toLowerCase().includes('memory'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // a boot adoption lands between the wipe and the re-seat; the wipe is the only seam for it
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
    expect(r.warnings.some(w => w.includes('workspace not restored') && w.includes('already exists at'))).toBe(true)

    // the intruder stands alone — no second live record was forced in beside it
    expect((await kernel.listWorkspaces()).map(w => w.id)).toEqual([intruderId])
    expect((await storage.events.all()).filter(e => e.kind === EVENT_KIND.project_identified).map(e => e.payload))
      .toEqual([{ name: 'purge-me', dir: TEST_WORKSPACE.cwd }])
  })
})

describe('workspace binding at the action boundary', () => {
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

  it('refuses an explicitly named ARCHIVED workspace, while inheritance from one is untouched', async () => {
    const { kernel, actions } = await setup()
    const done = await kernel.createWorkspace({ title: 'Done', cwd: '/done', branch: 'b', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false }, WEB)
    const parent = await kernel.createTask({ workspaceId: done.id, title: 'parent', spec: '' }, WEB)
    await kernel.setWorkspaceArchived(done.id, true, WEB)

    await expect(actions.newTask({ title: 'filed in a finished checkout', workspaceId: done.id, budgetUSD: null }, WEB))
      .rejects.toThrow(archivedRefusal(done.id))
    // inheritance is untouched: a child lands in its parent's workspace whatever its standing
    const child = await actions.newTask({ title: 'child', parentId: parent.id, budgetUSD: null }, WEB)
    expect((await kernel.getTask(child.taskId))?.workspaceId).toBe(done.id)
    // an unknown id keeps the kernel's refusal, code included, for callers that switch on it
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
    expect([ensured.count, (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.run_requested)]).toEqual([0, false])
  })
})

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

  // an omitted cwd is passed through: the kernel resolves it from the task's own workspace
  it('run without a cwd records the task\'s WORKSPACE cwd, validating nothing at the door', async () => {
    const { kernel, actions, ensured } = await setup()
    const t = await approvedTask(kernel, actions, 'no cwd')
    const asked = await actions.run(t.id, null, WEB)
    expect([asked.requested, typeof asked.since]).toEqual([true, 'number'])
    expect(ensured.count).toBe(1)
    const requested = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.run_requested)
    expect(requested?.payload).toEqual({ taskId: t.id, cwd: TEST_WORKSPACE.cwd, retry: false })
  })

  it('run refuses a draft task (no approved plan) — same message as CLI run, no ask, no supervisor', async () => {
    const { kernel, actions, ensured } = await setup()
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'draft', spec: '' }, WEB)
    await expect(actions.run(t.id, process.cwd(), WEB))
      .rejects.toThrow(`task is 'draft' — approve a plan first (orc approve ${t.id})`)
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

  it('newWorkspace refuses without a project context — there is no checkout to hang a worktree off', async () => {
    const { kernel } = await setup()
    const bare = buildOrcActions({ kernel, ensureRuntime: stubRuntime().ensureRuntime }) // no plugin
    await expect(bare.newWorkspace({ title: 'nowhere' }, WEB)).rejects.toThrow(/project context/)
  })
})

describe('reply names the project it answers in', () => {
  const parkedQuestion = async (db: TestDb, projectId: string) => {
    const storage = await openStorage(db.url, { projectId })
    db.onClose(() => storage.close())
    // the log is scoped per project, so the foreign project needs its own workspace record
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
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.project_identified,
      payload: { name: 'doomed', dir: '/doomed' }, ...WEB,
    })

    const r = await actions.deleteProject('doomed-project', WEB)
    expect(r.events).toBe(1)
    const check = await openStorage(url, { projectId: 'doomed-project' })
    db.onClose(() => check.close())
    expect(await check.events.all()).toEqual([])
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

    const target = await openStorage(url, { projectId: original })
    db.onClose(() => target.close())
    const identified = (await target.events.after(0, [EVENT_KIND.project_identified])).map(e => e.payload)
    expect(identified).toEqual([{ name: 'renamed chat', dir }])

    // an untouched directory mints a fresh identity
    const fresh = await actions.newProject(mkdtempSync(path.join(tmpdir(), 'orc-chat-')), 'fresh', WEB)
    expect(fresh.reused).toBe(false)
    expect(fresh.projectId).not.toBe(original)
  })

  it('a subdirectory of a worktree (no .orc of its own) reuses the repo project instead of throwing', async () => {
    // a worktree subdirectory resolves to the main checkout's identity, which initializeProject refuses
    const { actions } = await setup()
    const { main, worktree } = tmpGitRepo()
    const { projectId: original } = initializeProject(main, 'repo project')
    const nested = path.join(worktree, 'apps', 'x')
    mkdirSync(nested, { recursive: true })

    const reopened = await actions.newProject(nested, 'renamed chat', WEB)
    expect(reopened).toEqual({ projectId: original, reused: true })
  })
})
