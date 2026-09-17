import { AUTHOR_SOURCE, errorMessage, EVENT_KIND, ModelsDiscoveredPayload, NOTE_KIND, TASK_STATUS, costUSDFor, parseModelRef, type ExecutionPort, type ModelOption, type TaskStatus } from '@orc/contracts'
import { Kernel, blockingVerdicts, retryIsFutile, deriveSystemUrl, dropSystemDatabase, initializeProject, liveSupervisors, loadConfig, openStorage, resetSystemDatabase, subtreeTaskIds, type EventLog, type ProjectConfig, type Storage } from '@orc/kernel'
import { cwdAuthor, cwdWorkspace, cwdWorkspaceId, type AuthorExtras } from './cwd-workspace'
import { adoptCwd } from './workspace-adopt'
import { createRequestWorkspace, HEAD_REF, requireLiveWorkspace } from './workspace-ops'
import { listWorkspaceHealth } from './workspace-health'
import { seedRegistries } from './runtime'
import { singleStepDraft } from './plan-template'
// aliased: the local method below is named for the capability, the import for the lifecycle op it
// delegates to — one file cannot hold two bindings of one name
import { createMemory, decisionDoor, openKnowledge, orphanedNotes, recordDecision as recordDecisionOp } from '@orc/memory'
import { openMemory, withMemory } from './memory-open'
import { PROJECT_DIR_NOTE_ID, PROJECT_NAME_NOTE_ID, type OrcActions } from '@orc/ui-core'
import type { MemoryAuthor, Workspace } from '@orc/contracts'
import { createVaultProjector } from '@orc/vault-projector'
import { existsSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

// ui metadata notes are plain memory events — appended directly so they work even when the
// Surreal read model is down (the projector catches up on its own)
// The author is a PARAMETER even here, where the note is project metadata rather than knowledge:
// MemoryAuthor is ONE shape, and the workspace has to be the checkout the append actually lands in
// — which for newProject/purgeProject is NOT the fold this process booted against.
const uiNote = (id: string, title: string, summary: string, author: MemoryAuthor) => ({
  taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
  payload: { note: { id, title, kind: NOTE_KIND.fact, summary }, author },
})
const nameNote = (name: string, author: MemoryAuthor) => uiNote(PROJECT_NAME_NOTE_ID, name, 'display name for the project chat', author)
const dirNote = (dir: string, author: MemoryAuthor) => uiNote(PROJECT_DIR_NOTE_ID, dir, 'working directory of the project', author)


// The statuses startRunAt (dbos-port.ts) admits — anything else is terminal or waiting on a human,
// so a run_requested naming it could never be served. ONE set, so "can this be driven?" means the
// same thing at every door: the CLI `run`/`retry` guard (main.ts), the dbos port, and this actions
// layer that the web + MCP doors call through.
export const DRIVABLE_TASK_STATUS: ReadonlySet<TaskStatus> =
  new Set([TASK_STATUS.approved, TASK_STATUS.running, TASK_STATUS.blocked])

// The admission startRunAt enforces, checked at the boundary so a request that could never be
// served is refused BEFORE it is recorded: a run_requested naming a draft/unapproved/terminal task
// would sit in the log forever, and every supervisor that boots would pick it up and fail on it
// again. This is the ONE implementation — main.ts's `requireDrivable` and actions.ts's `run()` both
// call it, so the CLI door and the web/MCP doors cannot drift on the check or its message.
export async function assertDrivable(kernel: Kernel, taskId: string): Promise<void> {
  const task = await kernel.getTask(taskId)
  if (!task) throw new Error(`no task '${taskId}'`)
  const approved = (await kernel.state()).plans.get(taskId)?.approvedVersion
  if (!approved || !DRIVABLE_TASK_STATUS.has(task.status))
    throw new Error(`task is '${task.status}' — approve a plan first (orc approve ${taskId})`)
}

// Same boundary rule for retry, and the same ONE-implementation reason: the CLI `retry` and this
// actions layer (web + MCP doors) both refuse a non-blocked task BEFORE the ask is recorded — the
// refusal port.retry makes, kept client-side so an ask nobody can serve never reaches the log.
export async function assertRetryable(kernel: Kernel, taskId: string): Promise<void> {
  const task = await kernel.getTask(taskId)
  if (!task) throw new Error(`no task '${taskId}'`)
  if (task.status !== TASK_STATUS.blocked)
    throw new Error(`task is '${task.status}' — only a blocked task can be retried`)
  // A task blocked purely on VERDICTS cannot be moved by repeating itself: retry re-runs only what
  // did not complete, so the rejecting step would see the same sibling outputs and reach the same
  // conclusion. Refuse here, at the door, and name the action that does work — otherwise the
  // operator is handed a button that provably cannot succeed (measured: three identical passes).
  const state = await kernel.state()
  if (retryIsFutile(state, taskId)) {
    const verdicts = blockingVerdicts(state, taskId)
    throw new Error(
      `this run was REJECTED, not broken — ${verdicts.map(v => `'${v.stepId}'`).join(', ')} judged the work unacceptable, `
      + `and a retry re-runs only that step against the same completed siblings, so it would reach the same verdict. `
      + `Revise the plan instead (orc revise ${taskId}), then approve the new version. Verdict: ${verdicts[0]?.message ?? ''}`,
    )
  }
}

// A provider's valid model ids: live-discovered UNION cost-table. The API list omits aliases
// the provider still serves (claude-haiku-4-5 vs …-20251001), and the cost table is exactly
// the set we can price. Sorted for stable append-on-change comparison.
export const modelUniverse = (live: string[], costs: Record<string, unknown>): string[] =>
  [...new Set([...live, ...Object.keys(costs).filter(k => k !== '*')])].sort()

// One fetch attempt per provider: `reachable` is whether it ANSWERED — a provider that answered
// with nothing usable carries ids: [] and reachable: true, which are different facts.
export interface DiscoveredProvider { pid: string; ids: string[]; reachable: boolean }

// Which catalogs deserve a models_discovered event this fetch — pure, so the rule is testable
// without providers or a log. Gated on REACHABILITY, not emptiness: an empty catalog from a
// provider that answered is a fact worth recording (the embedding filter made [] ollama's
// legitimate steady state, and the old `ids.length === 0` guard pinned the served catalog to
// the pre-filter event — observed 2026-08-03); silence from one that did not answer is not.
export const catalogAppends = (perProvider: readonly DiscoveredProvider[], last: ReadonlyMap<string, string>): { providerId: string; models: string[] }[] =>
  perProvider
    .filter(({ ids, reachable, pid }) => reachable && JSON.stringify(ids) !== last.get(pid))
    .map(({ pid, ids }) => ({ providerId: pid, models: ids }))

// Model discovery + resolution + pricing over the provider registry — shared by the actions
// layer (validation), the copilot (available_models), and the web model picker. Cached briefly.
// With a log, each fetch persists changed catalogs as models_discovered events (append-on-
// change), making the catalog a projection: linkable to tasks and served without provider APIs.
export function buildModelDiscovery(config: ProjectConfig, log?: EventLog) {
  const { providers } = seedRegistries(config)
  const providerFor = (ref: string) => {
    const { providerId, modelId } = parseModelRef(ref)
    const p = providers.get(providerId)
    if (!p) throw new Error(`unknown provider '${providerId}'`)
    return { p, modelId }
  }
  let cache: { at: number; refs: string[] } | null = null
  const listModels = async (): Promise<string[]> => {
    if (cache && Date.now() - cache.at < 300_000) return cache.refs
    const perProvider: DiscoveredProvider[] = await Promise.all([...providers.entries()].map(async ([pid, p]) => {
      // a throwing provider is UNREACHABLE, isolated here so one napping daemon neither
      // rejects the whole fetch nor masquerades as "this provider serves nothing"
      try {
        const live = p.listModels ? await p.listModels() : []
        return { pid, ids: modelUniverse(live, p.costs), reachable: true }
      } catch {
        return { pid, ids: modelUniverse([], p.costs), reachable: false }
      }
    }))
    if (log) {
      // append-on-change: the latest event per provider IS the catalog
      const last = new Map<string, string>()
      for (const e of await log.after(0, [EVENT_KIND.models_discovered])) {
        const p = ModelsDiscoveredPayload.safeParse(e.payload)
        if (p.success) last.set(p.data.providerId, JSON.stringify(p.data.models))
      }
      for (const payload of catalogAppends(perProvider, last)) {
        await log.append({
          taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.models_discovered,
          payload,
        }).catch(() => {}) // catalog persistence is best-effort, discovery still returns live data
      }
    }
    const refs = perProvider.flatMap(({ pid, ids }) => ids.map(id => `${pid}/${id}`)).sort()
    cache = { at: Date.now(), refs }
    return refs
  }
  // discovery already knows both halves; pairing them here keeps every consumer off `p.costs`
  const listModelOptions = async (): Promise<ModelOption[]> =>
    (await listModels()).map(ref => {
      try {
        const { p, modelId } = providerFor(ref)
        return { ref, cost: p.costs[modelId] ?? p.costs['*'] ?? null }
      } catch { return { ref, cost: null } }
    })
  return {
    listModels,
    listModelOptions,
    providerFor,
    price: (ref: string, usage: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } }) => {
      const { p, modelId } = providerFor(ref)
      return costUSDFor(p.costs, modelId, usage.inputTokens ?? 0, usage.outputTokens ?? 0,
        { readTokens: usage.inputTokenDetails?.cacheReadTokens, writeTokens: usage.inputTokenDetails?.cacheWriteTokens })
    },
  }
}

// Wiping durable state under a LIVE runtime wedges it, silently. Both destructive paths truncate
// the DBOS system database; a supervisor holding that database keeps in-memory accounting derived
// from rows that no longer exist, so its queue believes the vanished workflows still occupy their
// concurrency slots and never releases them. Observed: after a purge, four step workflows sat at
// ENQUEUED with an empty `dbos.workflow_queue` while the supervisor heartbeat stayed healthy — no
// error, no failed run, just a request that never started.
//
// So this REFUSES rather than warning. A warning in a return value is the wrong shape for a fault
// whose symptom is silence: by the time the operator notices nothing is running, the cause is
// fifteen minutes upstream. It clears itself — a supervisor that is genuinely gone stops beating and
// its row falls outside the stale window within SUPERVISOR_STALE_MS, so the guard only blocks while
// a runtime is actually alive to be broken.
async function refuseWhileSupervised(storage: Storage, verb: string): Promise<void> {
  const live = await liveSupervisors(storage, new Date())
  if (live.length === 0) return
  const who = live.map(s => `${s.executorId} (pid ${s.pid} on ${s.host})`).join(', ')
  throw new Error(
    `cannot ${verb} while a supervisor holds this project: ${who}. ` +
    `Stop it first — ${verb === 'purge' ? 'purging' : 'deleting'} truncates the durable-execution ` +
    'state it is running against, which leaves it live but wedged: new runs enqueue and never start. ' +
    `Stop the supervisor, ${verb}, then let the next command start a fresh one.`,
  )
}

// The ONE implementation of every mutating command — the terminal's subcommand handlers and the web
// adapter both call through here, so they cannot drift. Nothing in this file's import graph reaches
// the terminal's argument parser: this is the door the web and MCP surfaces are served through, and
// it has no business pulling a command-line library in behind it.
export function buildOrcActions(deps: {
  kernel: Kernel
  // Guarantee something will drive what we are about to record — a live supervisor, one spawned
  // for us, or (under --no-daemon) a runtime this process holds. This layer never touches an
  // execution port itself: every door records the ask and lets the supervisor execute it.
  ensureRuntime: () => Promise<unknown>
  // Which DOOR these actions belong to. Recorded on a feedback answer, because for a grounded task
  // the conversational 'approve' IS the human gate: mcpApproveTool refuses under --autonomy gated
  // and buildCopilotTools omits `approve` entirely "by design: the human gate is structural", but
  // BOTH still ship `reply` and `revise`, which reach the same gate by a different name. Defaults
  // to the terminal, so the CLI is unchanged and only a door that knows it is not a human says so.
  via?: MemoryAuthor['source']
  plugin?: { config: ProjectConfig; log: EventLog; storage?: Storage }
  listModels?: () => Promise<string[]>
  listModelOptions?: () => Promise<ModelOption[]>
}): OrcActions {
  const { kernel, ensureRuntime, plugin, listModels, listModelOptions } = deps

  // Every memory write this layer makes names the checkout the process is serving — ONE spelling,
  // so the web and MCP doors agree with the terminal instead of each growing their own lookup.
  // Folded per call, not captured: `orc ws new` can mint a workspace mid-session.
  const cliAuthor = (extra: AuthorExtras = {}): Promise<MemoryAuthor> =>
    cwdAuthor(kernel, plugin?.config.dir, AUTHOR_SOURCE.cli, extra)

  const requireTask = async (taskId: string) => {
    const task = await kernel.getTask(taskId)
    if (!task) throw new Error(`no task '${taskId}'`)
    return task
  }

  // fail at the BOUNDARY, not 4 retries deep in the executor: a cwd that does not exist is
  // a deterministic EACCES/ENOENT later (models love inventing /workspace/… paths)
  const assertRunnableCwd = (cwd: string): string => {
    const abs = path.resolve(cwd)
    if (!existsSync(abs) || !statSync(abs).isDirectory())
      throw new Error(`cwd is not an existing directory: ${abs}${plugin ? ` — the project's directory is ${plugin.config.dir}` : ''}`)
    return abs
  }

  // fail at CREATION, not mid-run: an invented model ref must never reach a frozen plan.
  // Best-effort — when discovery is unavailable (offline, no listModels) nothing is blocked.
  const assertKnownModel = async (ref: string): Promise<void> => {
    if (!listModels) return
    const refs = await listModels().catch(() => null)
    if (!refs || refs.length === 0 || refs.includes(ref)) return
    throw new Error(`unknown model '${ref}' — valid refs include: ${refs.slice(0, 8).join(', ')}${refs.length > 8 ? ', …' : ''}. Call available_models (copilot) or check orc's providers.`)
  }

  return {
    async newTask(input) {
      // Same rule as `orc new`: a ROOT task lands in the checkout this process is serving, so the
      // web and MCP doors agree with the terminal; a CHILD is left to the kernel's inheritance
      // (createTaskIn), because a child of a task in another workspace must not be re-homed to
      // whatever directory this process happens to serve — one subtree, one working directory.
      // An explicit input.workspaceId wins over both.
      // Named outright, so it is checked outright — the same rule `orc new --workspace` applies at
      // the terminal. The kernel accepts an archived workspace by design (a merged workspace's
      // subtree keeps growing); what this refuses is a caller filing NEW work into a checkout the
      // operator finished with, which the default listing hides and the disk may no longer hold.
      if (input.workspaceId !== undefined) await requireLiveWorkspace(kernel, input.workspaceId)
      const workspaceId = input.workspaceId
        ?? (input.parentId === undefined ? await cwdWorkspaceId(kernel, plugin?.config.dir) : undefined)
      if (!input.grounded) {
        const t = await kernel.createTask({ title: input.title, spec: input.spec ?? '', parentId: input.parentId, workspaceId })
        return { taskId: t.id }
      }
      await assertKnownModel(input.grounded.modelRef)
      const cwd = assertRunnableCwd(input.grounded.cwd)
      const t = await kernel.createGroundedTask({
        title: input.title, spec: input.spec ?? '', parentId: input.parentId, workspaceId,
        modelRef: input.grounded.modelRef, analyzerRef: input.grounded.analyzerRef ?? 'agent-analyzer',
        modelCatalog: await listModelOptions?.().catch(() => []) ?? [],
        ...(plugin ? { maxIterations: plugin.config.maxIterations } : {}),
      })
      // the grounded template is policy-approved — the analyze→plan conversation starts now;
      // callers watch progress over the event stream, nothing tails here
      await ensureRuntime()
      await kernel.requestRun(t.id, { cwd })
      return { taskId: t.id }
    },

    async propose(taskId, opts) {
      await assertKnownModel(opts.modelRef)
      const task = await requireTask(taskId)
      const plan = await kernel.proposePlan(taskId, singleStepDraft(task, opts.modelRef, opts.skillRefs ?? [], plugin?.config.maxIterations))
      return { version: plan.version, steps: plan.steps.length }
    },

    async edit(taskId, draft) {
      for (const step of draft.steps) await assertKnownModel(step.modelRef)
      const plan = await kernel.editPlan(taskId, draft)
      return { version: plan.version }
    },

    async approve(taskId, version, approvedBy) {
      const plan = await kernel.approvePlan(taskId, version, approvedBy ? { approvedBy } : undefined)
      return { version: plan.version }
    },

    async run(taskId, cwd) {
      // cwd is validated BEFORE the ask is recorded: an unrunnable directory must not become a
      // request every supervisor that boots picks up and fails on again. An OMITTED cwd is passed
      // on as omitted — the kernel resolves it from the task's workspace record, and substituting
      // this process's directory here would run a task created in one worktree in another checkout.
      const resolved = cwd === undefined ? undefined : assertRunnableCwd(cwd)
      // …and the SAME drivable-status admission the CLI `run` enforces (main.ts) and startRunAt
      // (dbos-port.ts) enforces: a draft/unapproved/terminal task can never be served, so the web
      // and MCP doors must refuse it here too rather than silently logging a run nobody can run.
      await assertDrivable(kernel, taskId)
      await ensureRuntime()
      // conditional spread, not `{ cwd: resolved }`: requestRun reads `opts.cwd ?? the workspace's`,
      // and an explicitly-undefined key is the same thing today — but the idiom keeps it that way
      // if the option ever becomes a presence check.
      await kernel.requestRun(taskId, { ...(resolved !== undefined && { cwd: resolved }) })
      return { requested: true }
    },

    // Needs the plugin context, unlike the kernel call it replaces: a workspace's health is derived
    // from the log AND counted out of the note read model, and a door that answered without them
    // would hand back records with a health nobody measured.
    async listWorkspaces() {
      if (!plugin) throw new Error('listing workspaces needs a project context')
      return listWorkspaceHealth(plugin)
    },

    async newWorkspace(input) {
      // The worktree is created under the PROJECT ROOT, which only a project context knows — the
      // same refusal `orc ws` makes, at the same boundary, before git is touched.
      if (!plugin) throw new Error('creating a workspace needs a project context')
      // ONE implementation with `orc ws new` (createRequestWorkspace, workspace-ops.ts — the lifecycle
      // operations both doors call): a second copy here would be a second
      // answer to where a request's checkout comes from, and the doors would drift on the branch
      // name, the base or the rollback. `task: true` is not a default this door hides — a driver
      // asking for a workspace is asking for the request; --no-task is a terminal affordance.
      const { workspace, taskId } = await createRequestWorkspace(kernel, plugin.config, {
        title: input.title, spec: input.spec ?? '', base: input.base ?? HEAD_REF, task: true,
      })
      return { workspace, taskId }
    },

    async reply(taskId, text, projectId) {
      // this door's own project: the answer only unblocks the step; a supervisor is what carries it
      // into the parked workflow (its router reacts to feedback_provided) and keeps executing, so
      // guaranteeing one is what makes the answer's promise true.
      if (!projectId || projectId === plugin?.config.projectId) {
        await ensureRuntime()
        const topic = await kernel.replyFeedback(taskId, text, deps.via)
        return { answered: topic !== null, supervised: true }
      }
      // A FOREIGN project — the graph UI's chat switcher can see one, and a question it displays has
      // to be answerable. This is an append into that project's own log and nothing else: no runtime
      // is spawned, because EXECUTION is what stays bound to the directory orc was started in
      // (ensureRuntime's spawn, the DBOS port, the in-process zone write-fence), and answering is
      // not execution. Whether anything is live over there is reported, never assumed: with no
      // supervisor the row simply waits, exactly as `orc reply` from a fresh terminal always did.
      if (!plugin) throw new Error('answering another project needs a project context')
      // ponytail: one short-lived pool per answered question (the newProject/deleteProject shape) —
      // a human-rate action, so it is not worth reaching into the graph server's cached per-project
      // sessions for. Doing that would also make the read-side session store a writer, and would
      // only serve the web door; this serves every door that holds a project context.
      const storage = await openStorage(plugin.config.databaseUrl, { projectId })
      try {
        const topic = await new Kernel(storage.events).replyFeedback(taskId, text, deps.via)
        return { answered: topic !== null, supervised: (await liveSupervisors(storage, new Date())).length > 0 }
      } finally {
        await storage.close()
      }
    },

    async retry(taskId) {
      await assertRetryable(kernel, taskId)
      await ensureRuntime()
      await kernel.requestRun(taskId, { retry: true })
      return { requested: true }
    },

    async annotate(taskId, noteId, text, refs) {
      await kernel.annotatePlan(taskId, { targetNote: noteId, refs: refs ?? [], text })
      return { noteId }
    },

    async revise(taskId, text, scope) {
      await ensureRuntime() // resuming the gate needs a supervisor, exactly like reply
      for (const noteId of scope) await kernel.annotatePlan(taskId, { targetNote: noteId, refs: [], text })
      const topic = await kernel.replyFeedback(taskId, text, deps.via)
      return { topic }
    },

    async writeNote(note) {
      if (!plugin) throw new Error('writing notes needs a project context')
      if (note.id === PROJECT_NAME_NOTE_ID || note.id === PROJECT_DIR_NOTE_ID)
        throw new Error(`'${note.id}' is a reserved ui-metadata note id`)
      return withMemory({ log: plugin.log, config: plugin.config }, async memory => {
        const written = await memory.store.write(note, await cliAuthor())
        // event committed — the read model heals on the next drain if this catch-up fails
        await memory.projector.catchUp().catch(() => {})
        return { id: written.id, scope: written.scope }
      })
    },

    // The decision door. The LIFECYCLE is not here: decisions.ts owns the refusals, the slugged id
    // and the supersession link, and `orc adr` calls the same op — a second implementation would be
    // a second answer to what recording a decision means. What this layer owns is the author.
    async recordDecision(input) {
      if (!plugin) throw new Error('recording a decision needs a project context')
      return withMemory({ log: plugin.log, config: plugin.config }, async memory => {
        // `via` is the door: mcp for the MCP server, absent (→ cli) for the web. Never 'human' here
        // — an agent drove this call, whoever is behind the agent; `orc adr new` is the door where a
        // person typed it, and that one writes 'human'.
        const author = await cwdAuthor(kernel, plugin.config.dir, deps.via ?? AUTHOR_SOURCE.cli)
        const r = await recordDecisionOp(decisionDoor(memory), author, input)
        return { id: r.note.id, status: r.status, superseded: r.superseded }
      })
    },

    async deleteNote(id, scope) {
      if (!plugin) throw new Error('deleting notes needs a project context')
      if (id === PROJECT_NAME_NOTE_ID || id === PROJECT_DIR_NOTE_ID)
        throw new Error(`'${id}' is a reserved ui-metadata note id`)
      return withMemory({ log: plugin.log, config: plugin.config }, async memory => {
        await memory.store.remove(id, scope, await cliAuthor())
        await memory.projector.catchUp().catch(() => {})
        return { id }
      })
    },

    async renameProject(name) {
      if (!plugin) throw new Error('renaming needs a project context')
      await plugin.log.append(nameNote(name, await cliAuthor()))
      return { name }
    },

    async newProject(dir, name) {
      if (!plugin) throw new Error('creating projects needs a project context')
      const abs = path.resolve(dir)
      if (!existsSync(abs)) throw new Error(`directory does not exist: ${abs}`)
      // a directory that already holds (or resolves, via resolveProjectRoot, to) an orc project
      // is REUSED, never re-minted — "new chat" on a known folder means "open that project", the
      // name becomes its display name. `existsSync(.orc)` used to gate this, but a directory can
      // resolve to an ALREADY-initialized project without holding `.orc` itself (a subdirectory
      // of a linked worktree resolves to the main checkout's identity) — that fell through to
      // initializeProject, which now throws "already initialized" instead of reusing. loadConfig
      // already answers `null` for a plain, uninitialized directory, so it alone is the check.
      const existing = loadConfig(abs).projectId
      const projectId = existing ?? initializeProject(abs, name).projectId
      // first events = name + dir notes: listable, named, and locatable immediately
      const storage = await openStorage(plugin.config.databaseUrl, { projectId })
      try {
        // Adopt the new project's own checkout into its OWN log before writing into it. Not
        // `cliAuthor()`: that names the workspace of the directory THIS process serves, which is a
        // different project entirely — its id means nothing in the log being seeded here. Adoption
        // is idempotent (ensureWorkspace keys on cwd), so reusing an existing project re-finds the
        // record instead of minting a second one.
        const created = loadConfig(abs)
        const workspace = await adoptCwd(new Kernel(storage.events), created)
        const author: MemoryAuthor = { source: AUTHOR_SOURCE.cli, workspaceId: workspace.id }
        await storage.events.append(nameNote(name, author))
        await storage.events.append(dirNote(abs, author))
      } finally {
        await storage.close()
      }
      return { projectId, reused: existing !== null }
    },

    async purgeProject() {
      if (!plugin?.storage) throw new Error('purging needs a project context')
      await refuseWhileSupervised(plugin.storage, 'purge')
      const warnings: string[] = []
      // Read BEFORE the wipe, because the wipe takes workspace_created with everything else. The
      // whole RECORD, not the id: it is re-appended below so the identity notes' author names a
      // workspace the log still carries, and so this checkout keeps the id it already had — boot
      // adoption would otherwise mint a fresh uuid for the same directory on the next command and
      // orphan the notes we are about to write.
      // the REASON travels with the miss: "no workspace is recorded" is only one of the ways this
      // can fail (an unreadable log, a fold that threw), and reporting that sentence for all of them
      // sends an operator to re-adopt a checkout that was never the problem
      interface HomeWorkspace { workspace: Workspace | null; reason: string | null }
      const home: HomeWorkspace = await cwdWorkspace(kernel, plugin.config.dir)
        .then((workspace): HomeWorkspace => ({ workspace, reason: null }))
        .catch((err: unknown): HomeWorkspace => ({ workspace: null, reason: errorMessage(err) }))
      // 1. stop the engine: truncating the DBOS system db erases pending workflows (crashed
      //    runs included) WITHOUT launching the runtime — a launch would start recovering
      //    exactly the workflows we are deleting. Statuses need no stamping: the log goes next.
      try {
        await resetSystemDatabase(plugin.config.systemDatabaseUrl)
      } catch (err) {
        warnings.push(`durable-execution state not reset (${errorMessage(err)}) — restart orc before the next run`)
      }
      // 2. the history: every event + journal row, one locked transaction
      const counts = await plugin.storage.purge()
      // re-seed identity FIRST: "the empty chat stays" — without these notes the project has
      // zero events, drops off the chats list, and the UI strands the user in a foreign chat.
      // The workspace record leads, because the notes' author names it.
      //
      // A WARNING rather than a throw when this checkout was never adopted: the wipe above is
      // already committed, so failing here would leave the project worse off than not re-seeding —
      // the same posture the system-db and vault steps take. Nothing is invented: with no workspace
      // to name there is no author, so no note is written, and the next command in the checkout
      // adopts it and restores the chat.
      if (home.workspace === null) {
        warnings.push(`project identity not re-seeded (${home.reason}) — run any orc command from the project checkout to restore it`)
      } else {
        // GUARDED as a whole — the restore and the two notes are one re-seed, and the wipe above is
        // already committed, so a throw here would leave the project worse off than a skipped
        // re-seed. The refusal this catches is real and is the race the comment above names: a boot
        // adoption landing between the pre-wipe read and this restore re-occupies the cwd, and the
        // kernel then correctly refuses a second live record for one directory.
        try {
          // through the KERNEL, never a raw append: it is the one writer of workspace records, and
          // the "one active record per cwd" rule only holds when the check and the append share a
          // transaction — that racing adoption would otherwise get a duplicate forced in beside it.
          const seated = await kernel.restoreWorkspace(home.workspace)
          const reseedAuthor: MemoryAuthor = { source: AUTHOR_SOURCE.cli, workspaceId: seated.id }
          if (plugin.config.projectName) await plugin.log.append(nameNote(plugin.config.projectName, reseedAuthor))
          if (plugin.config.dir) await plugin.log.append(dirNote(plugin.config.dir, reseedAuthor))
        } catch (err) {
          warnings.push(`project identity not re-seeded (${errorMessage(err)}) — another workspace now holds ${plugin.config.dir}, so this project's name and directory notes were not rewritten`)
        }
      }
      // 3. vault task traces: dead task folders would linger — drop them, re-render the index
      try {
        rmSync(path.join(plugin.config.vaultDir, 'tasks'), { recursive: true, force: true })
        await createVaultProjector({ log: plugin.log, config: plugin.config }).renderAll()
      } catch (err) {
        warnings.push(`vault trace not cleared (${errorMessage(err)})`)
      }
      // 4. read model + memory vault files: rebuild over the now-empty log clears both. Best-effort —
      //    the log purge is committed; a down Surreal heals on the next projector run.
      let memory: Awaited<ReturnType<typeof createMemory>> | undefined
      try {
        memory = await openMemory({ log: plugin.log, config: plugin.config })
        const { degraded } = await memory.projector.rebuild()
        if (degraded) {
          warnings.push('memory read model rebuilt after purge but is degraded — some notes did not reproject')
        }
      } catch (err) {
        warnings.push(`memory read model not cleared (${errorMessage(err)}) — run 'orc memory rebuild' once it is reachable`)
      } finally {
        await memory?.close().catch(() => {})
      }
      return { ...counts, warnings }
    },

    async deleteProject(projectId) {
      if (!plugin) throw new Error('deleting projects needs a project context')
      // only the HOME project's supervisor is visible from here — deleting a foreign project cannot
      // check its runtime, and does not need to: this guard exists for the tree you are sitting in
      if (plugin.storage && projectId === plugin.config.projectId) await refuseWhileSupervised(plugin.storage, 'delete')
      const warnings: string[] = []
      // stop-then-wipe, same order as purge; no identity re-seed — deletion IS the point.
      // Deleting the HOME project is allowed too: full wipe, though it stays listed (empty)
      // while this server runs from it.
      // DROP, not truncate: purge keeps the chat and so needs the schema, but a deleted project has
      // no runtime left to hold one. Truncating left an empty database object per deleted project
      // that nothing ever collected.
      try {
        await dropSystemDatabase(deriveSystemUrl(plugin.config.databaseUrl, projectId))
      } catch (err) {
        warnings.push(`durable-execution state not dropped (${errorMessage(err)})`)
      }
      const storage = await openStorage(plugin.config.databaseUrl, { projectId })
      try {
        const counts = await storage.purge()
        // The knowledge goes with the chat. This read model lives in a PROJECT-DERIVED SurrealDB
        // database, so the home project's memory instance cannot reach it — and leaving it was not
        // the harmless "inert garbage" this comment used to claim: a deleted project's notes stayed
        // live in `orc memory ls`, in memory_search, in agent recall and in the graph UI, with no
        // events behind them, until some later rebuild silently dropped them. Deleting a chat has
        // to mean the data goes too, which is what anyone clicking delete already assumes.
        try {
          const knowledge = await openKnowledge({ ...plugin.config, projectId })
          // drop, not clear: the database object goes with the project. Clearing rows left one
          // empty Surreal database per deleted project that nothing ever collected — the exact
          // litter dropSystemDatabase above avoids on the Postgres side.
          try { await knowledge.drop() } finally { await knowledge.close() }
        } catch (err) {
          warnings.push(`memory read model not cleared (${errorMessage(err)}) — its notes will vanish on the next rebuild`)
        }
        // …and its rendered trace. Only for the HOME project: its vault path comes from config and
        // is trusted, while a foreign project's vault lives in ITS directory, which this server has
        // no business deleting from — so that case is reported rather than guessed at.
        if (projectId === plugin.config.projectId) {
          try {
            for (const dir of ['memory', 'tasks']) rmSync(path.join(plugin.config.vaultDir, dir), { recursive: true, force: true })
          } catch (err) {
            warnings.push(`vault trace not cleared (${errorMessage(err)})`)
          }
        } else {
          warnings.push(`vault files under that project's own directory are left in place — delete them there if you want them gone`)
        }
        return { ...counts, warnings }
      } finally {
        await storage.close()
      }
    },

    async cancel(taskId) {
      // The append half only: stamping the subtree cancelled is what a client can do without a
      // runtime, and the supervisor's router does the DBOS half off each cancelled status. With no
      // supervisor up there is nothing running to cancel, and the next one to boot sweeps it.
      await kernel.cancelSubtree(taskId)
      // Cancel is terminal — nothing will resume this subtree, so its still-owned, unreferenced
      // notes are garbage. Deterministic sweep (no agent): fold the memory log, keep adopted or
      // still-referenced ids. Each delete appends memory_deleted with the cancelled task as
      // provenance — the note's full content stays in the immutable log (orc log / replay).
      if (!plugin) return { swept: [], sweepError: null }
      // best-effort: the cancel is already committed, so a sweep failure reports instead of
      // failing the command
      let memory: Awaited<ReturnType<typeof createMemory>> | undefined
      try {
        const cancelled = new Set(subtreeTaskIds(await kernel.state(), taskId))
        const goes = orphanedNotes(await plugin.log.after(0, [EVENT_KIND.memory_written, EVENT_KIND.memory_deleted]), cancelled)
        if (goes.length === 0) return { swept: [], sweepError: null }
        memory = await openMemory({ log: plugin.log, config: plugin.config })
        // one author for the whole sweep — the cancelled task is the provenance, the workspace is
        // this checkout, and folding it once per note would re-read the log N times
        const author = await cliAuthor({ taskId })
        for (const n of goes) await memory.store.remove(n.id, n.scope, author)
        // deletes are committed (event-first) — the read-model catch-up is best-effort; the
        // projector self-heals on the next invocation
        await memory.projector.catchUp().catch(() => {})
        return { swept: goes.map(({ id, scope, title }) => ({ id, scope, title })), sweepError: null }
      } catch (err) {
        return { swept: [], sweepError: errorMessage(err) }
      } finally {
        await memory?.close().catch(() => {})
      }
    },
  }
}
