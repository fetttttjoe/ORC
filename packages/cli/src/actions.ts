import { authorSourceOf, decisionSummaryOf, errorMessage, EVENT_KIND, ModelsDiscoveredPayload, NOTE_KIND, TASK_STATUS, costUSDFor, parseModelRef, type EventInput, type ModelOption, type Origin, type TaskStatus } from '@orc/contracts'
import { Kernel, blockingVerdicts, canRetry, deriveSystemUrl, dropSystemDatabase, initializeProject, liveSupervisors, loadConfig, openStorage, resetSystemDatabase, subtreeTaskIds, type EventLog, type ProjectConfig, type Storage } from '@orc/kernel'
import { cwdAuthor, cwdWorkspace, cwdWorkspaceId, type AuthorExtras } from './cwd-workspace'
import { adoptCwd } from './workspace-adopt'
import { createRequestWorkspace, HEAD_REF, requireLiveWorkspace } from './workspace-ops'
import { listWorkspaceHealth } from './workspace-health'
import { seedRegistries } from './runtime'
import { singleStepDraft } from './plan-template'
import { createMemory, openKnowledge, orphanedNotes } from '@orc/memory'
import { knowledgeAccess, openKnowledge as openKnowledgeBackend } from './knowledge-open'
import { openMemory, withMemory } from './memory-open'
import { PROJECT_DIR_NOTE_ID, PROJECT_NAME_NOTE_ID, type OrcActions, type PlanSource } from '@orc/ui-core'
import type { PlanDraft } from '@orc/contracts'
import type { MemoryAuthor, Workspace } from '@orc/contracts'
import { createVaultProjector } from '@orc/vault-projector'
import { existsSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

// ui metadata notes are plain memory events — appended directly so they work even when the
// Surreal read model is down (the projector catches up on its own)
// The author is a PARAMETER even here, where the note is project metadata rather than knowledge:
// MemoryAuthor is ONE shape, and the workspace has to be the checkout the append actually lands in
// — which for newProject/purgeProject is NOT the fold this process booted against.
const uiNote = (id: string, title: string, summary: string, author: MemoryAuthor, origin: Origin): EventInput => ({
  ...origin, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
  payload: { note: { id, title, kind: NOTE_KIND.fact, summary }, author },
})
const nameNote = (name: string, author: MemoryAuthor, origin: Origin) => uiNote(PROJECT_NAME_NOTE_ID, name, 'display name for the project chat', author, origin)
const dirNote = (dir: string, author: MemoryAuthor, origin: Origin) => uiNote(PROJECT_DIR_NOTE_ID, dir, 'working directory of the project', author, origin)


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
  const state = await kernel.state()
  // canRetry is the DECISION; everything below only picks which refusal to explain. Split that way
  // because a read model has to make the same call to decide whether to offer the retry at all, and
  // it cannot throw — a second `status === blocked && !retryIsFutile` spelled here is the drift.
  if (canRetry(state, taskId)) return
  if (task.status !== TASK_STATUS.blocked)
    throw new Error(`task is '${task.status}' — only a blocked task can be retried`)
  // A task blocked purely on VERDICTS cannot be moved by repeating itself: retry re-runs only what
  // did not complete, so the rejecting step would see the same sibling outputs and reach the same
  // conclusion. Refuse here, at the door, and name the action that does work — otherwise the
  // operator is handed a button that provably cannot succeed (measured: three identical passes).
  const verdicts = blockingVerdicts(state, taskId)
  throw new Error(
    `this run was REJECTED, not broken — ${verdicts.map(v => `'${v.stepId}'`).join(', ')} judged the work unacceptable, `
    + `and a retry re-runs only that step against the same completed siblings, so it would reach the same verdict. `
    + `Revise the plan instead (orc revise ${taskId}), then approve the new version. Verdict: ${verdicts[0]?.message ?? ''}`,
  )
}

// A provider's valid model ids: live-discovered UNION cost-table. The API list omits aliases
// the provider still serves (claude-haiku-4-5 vs …-20251001), and the cost table is exactly
// the set we can price. Sorted for stable append-on-change comparison.
export const modelUniverse = (live: string[], costs: Record<string, unknown>): string[] =>
  [...new Set([...live, ...Object.keys(costs).filter(k => k !== '*')])].sort()

// A provider that never answers would hang every door that discovers; rejecting turns "no answer"
// into the unreachable case discovery already handles. The loser's rejection is handled by the race.
const bounded = async <T>(work: Promise<T>, ms: number, pid: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`provider '${pid}' did not list models within ${ms}ms`)), ms)
  })
  try { return await Promise.race([work, expiry]) } finally { clearTimeout(timer) }
}

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
// `persist` pairs the log with the ORIGIN its models_discovered appends carry: a catalog is a fact
// about the serving process, not about an interaction, so the composition root names its door once
// instead of every discovery call carrying one.
// A provider daemon that naps answers no faster than one that is down, and BOTH doors discover —
// so the bound lives at this seam, injectable because a test cannot wait out the production value.
export const PROVIDER_DISCOVERY_TIMEOUT_MS = 10_000

export function buildModelDiscovery(config: ProjectConfig, persist?: { log: EventLog; origin: Origin }, providerTimeoutMs: number = PROVIDER_DISCOVERY_TIMEOUT_MS) {
  const { providers } = seedRegistries(config)
  const log = persist?.log
  const providerFor = (ref: string) => {
    const { providerId, modelId } = parseModelRef(ref)
    const p = providers.get(providerId)
    if (!p) throw new Error(`unknown provider '${providerId}'`)
    return { p, modelId }
  }
  // The catalog as the LOG states it: the latest models_discovered per provider. One fold, read by
  // the door that must not fetch and by append-on-change alike.
  const catalogs = async (): Promise<Map<string, string[]>> => {
    const last = new Map<string, string[]>()
    if (!log) return last
    for (const e of await log.after(0, [EVENT_KIND.models_discovered])) {
      const p = ModelsDiscoveredPayload.safeParse(e.payload)
      if (p.success) last.set(p.data.providerId, p.data.models)
    }
    return last
  }
  const refsOf = (byProvider: ReadonlyMap<string, string[]>): string[] =>
    [...byProvider].flatMap(([pid, ids]) => ids.map(id => `${pid}/${id}`)).sort()
  let cache: { at: number; refs: string[] } | null = null
  const discoverModels = async (): Promise<string[]> => {
    if (cache && Date.now() - cache.at < 300_000) return cache.refs
    const perProvider: DiscoveredProvider[] = await Promise.all([...providers.entries()].map(async ([pid, p]) => {
      // a throwing OR timed-out provider is UNREACHABLE, isolated here so one napping daemon
      // neither rejects the whole fetch nor masquerades as "this provider serves nothing"
      try {
        const live = p.listModels ? await bounded(p.listModels(), providerTimeoutMs, pid) : []
        return { pid, ids: modelUniverse(live, p.costs), reachable: true }
      } catch {
        return { pid, ids: modelUniverse([], p.costs), reachable: false }
      }
    }))
    if (persist) {
      // append-on-change: the latest event per provider IS the catalog
      const last = new Map([...await catalogs()].map(([pid, ids]) => [pid, JSON.stringify(ids)]))
      for (const payload of catalogAppends(perProvider, last)) {
        await persist.log.append({
          ...persist.origin, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.models_discovered,
          payload,
        }).catch(() => {}) // catalog persistence is best-effort, discovery still returns live data
      }
    }
    const refs = refsOf(new Map(perProvider.map(({ pid, ids }) => [pid, ids])))
    cache = { at: Date.now(), refs }
    return refs
  }
  // ONE core, no flag: every door discovers. A door that folded the log answered [] for a project
  // with no models_discovered yet, and an agent handed { refs: [] } cannot name a model at all.
  const listModels = discoverModels
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
  plugin?: { config: ProjectConfig; log: EventLog; storage?: Storage }
  // The ONE model core (buildModelDiscovery), flagless: it discovers for every door, bounded
  // per provider, so no call site chooses between a fetch and a fold.
  listModels?: () => Promise<string[]>
  listModelOptions?: () => Promise<ModelOption[]>
}): OrcActions {
  const { kernel, ensureRuntime, plugin, listModels, listModelOptions } = deps

  // Every memory write this layer makes names the checkout the process is serving — ONE spelling,
  // so the web and MCP doors agree with the terminal instead of each growing their own lookup.
  // Folded per call, not captured: `orc ws new` can mint a workspace mid-session.
  // The SOURCE is derived from the door the call came in by — there is no `via` dep to disagree
  // with the origin the same call stamps on its events.
  const doorAuthor = (origin: Origin, extra: AuthorExtras = {}): Promise<MemoryAuthor> =>
    cwdAuthor(kernel, plugin?.config.dir, authorSourceOf(origin.door), origin, extra)

  const decisionPort = async () => {
    if (!plugin) throw new Error('decisions need a project context')
    const access = knowledgeAccess(openKnowledgeBackend(plugin.config), plugin.log, plugin.config.dir)
    if ('unavailable' in access) throw new Error(access.unavailable)
    return access.port
  }

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

  // A door parses an authored draft; building the TEMPLATE and validating either source is this
  // layer's — an authored draft used to reach proposePlan unchecked from the terminal.
  const draftFrom = async (taskId: string, plan: PlanSource): Promise<PlanDraft> => {
    const draft = 'draft' in plan
      ? plan.draft
      : singleStepDraft(await requireTask(taskId), plan.template.modelRef, plan.template.skillRefs, plugin?.config.maxIterations)
    for (const step of draft.steps) await assertKnownModel(step.modelRef)
    return draft
  }

  return {
    async newTask(input, origin) {
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
        const t = await kernel.createTask({ title: input.title, spec: input.spec ?? '', parentId: input.parentId, budgetUSD: input.budgetUSD, workspaceId }, origin)
        return { taskId: t.id }
      }
      await assertKnownModel(input.grounded.modelRef)
      // a null cwd stays null: requestRun then resolves the task's OWN workspace, so a task created
      // in one worktree is never dragged into the directory this process happens to serve
      const cwd = input.grounded.cwd === null ? null : assertRunnableCwd(input.grounded.cwd)
      const t = await kernel.createGroundedTask({
        title: input.title, spec: input.spec ?? '', parentId: input.parentId, budgetUSD: input.budgetUSD, workspaceId,
        modelRef: input.grounded.modelRef, analyzerRef: input.grounded.analyzerRef ?? 'agent-analyzer',
        modelCatalog: await listModelOptions?.().catch(() => []) ?? [],
        ...(plugin ? { maxIterations: plugin.config.maxIterations } : {}),
      }, origin)
      // the grounded template is policy-approved — the analyze→plan conversation starts now;
      // callers watch progress over the event stream, nothing tails here
      await ensureRuntime()
      await kernel.requestRun(t.id, { ...(cwd !== null && { cwd }) }, origin)
      return { taskId: t.id }
    },

    async propose(taskId, plan, origin) {
      const proposed = await kernel.proposePlan(taskId, await draftFrom(taskId, plan), origin)
      return { version: proposed.version, steps: proposed.steps.length }
    },

    async edit(taskId, plan, origin) {
      const edited = await kernel.editPlan(taskId, await draftFrom(taskId, plan), origin)
      return { version: edited.version }
    },

    async approve(taskId, opts, origin) {
      // Approving only UNBLOCKS a split child — something still has to execute it, and a bare
      // approval used to leave the parent parked inside join_splits while the child never started.
      // Same rule as reply: guarantee the supervisor BEFORE the event it has to react to.
      if ((await kernel.getTask(taskId))?.parentId) await ensureRuntime()
      const plan = await kernel.approvePlan(taskId, opts.version, opts.approvedBy ? { approvedBy: opts.approvedBy } : undefined, origin)
      return { version: plan.version }
    },

    async listModels() {
      // No discovery configured answers []: nothing is blocked, the same best-effort posture
      // assertKnownModel holds.
      return listModels ? listModels() : []
    },

    async run(taskId, cwd, origin) {
      // cwd is validated BEFORE the ask is recorded: an unrunnable directory must not become a
      // request every supervisor that boots picks up and fails on again. An OMITTED cwd is passed
      // on as omitted — the kernel resolves it from the task's workspace record, and substituting
      // this process's directory here would run a task created in one worktree in another checkout.
      const resolved = cwd === null ? null : assertRunnableCwd(cwd)
      // …and the SAME drivable-status admission the CLI `run` enforces (main.ts) and startRunAt
      // (dbos-port.ts) enforces: a draft/unapproved/terminal task can never be served, so the web
      // and MCP doors must refuse it here too rather than silently logging a run nobody can run.
      await assertDrivable(kernel, taskId)
      await ensureRuntime()
      // conditional spread, not `{ cwd: resolved }`: requestRun reads `opts.cwd ?? the workspace's`,
      // and an explicitly-undefined key is the same thing today — but the idiom keeps it that way
      // if the option ever becomes a presence check.
      const since = await kernel.requestRun(taskId, { ...(resolved !== null && { cwd: resolved }) }, origin)
      return { requested: true, since }
    },

    // Needs the plugin context, unlike the kernel call it replaces: a workspace's health is derived
    // from the log AND counted out of the note read model, and a door that answered without them
    // would hand back records with a health nobody measured.
    async listWorkspaces() {
      if (!plugin) throw new Error('listing workspaces needs a project context')
      return listWorkspaceHealth(plugin)
    },

    async newWorkspace(input, origin) {
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
      }, origin)
      return { workspace, taskId }
    },

    async reply(taskId, text, projectId, origin) {
      // this door's own project: the answer only unblocks the step; a supervisor is what carries it
      // into the parked workflow (its router reacts to feedback_provided) and keeps executing, so
      // guaranteeing one is what makes the answer's promise true.
      if (!projectId || projectId === plugin?.config.projectId) {
        await ensureRuntime()
        const topic = await kernel.replyFeedback(taskId, text, origin)
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
        const topic = await new Kernel(storage.events).replyFeedback(taskId, text, origin)
        return { answered: topic !== null, supervised: (await liveSupervisors(storage, new Date())).length > 0 }
      } finally {
        await storage.close()
      }
    },

    async retry(taskId, cwd, origin) {
      const resolved = cwd === null ? null : assertRunnableCwd(cwd)
      await assertRetryable(kernel, taskId)
      await ensureRuntime()
      const since = await kernel.requestRun(taskId, { retry: true, ...(resolved !== null && { cwd: resolved }) }, origin)
      return { requested: true, since }
    },

    async annotate(taskId, noteId, text, refs, origin) {
      await kernel.annotatePlan(taskId, { targetNote: noteId, refs, text }, origin)
      return { noteId }
    },

    async revise(taskId, text, scope, origin) {
      await ensureRuntime() // resuming the gate needs a supervisor, exactly like reply
      for (const noteId of scope) await kernel.annotatePlan(taskId, { targetNote: noteId, refs: [], text }, origin)
      const topic = await kernel.replyFeedback(taskId, text, origin)
      return { topic }
    },

    async writeNote(note, origin) {
      if (!plugin) throw new Error('writing notes needs a project context')
      if (note.id === PROJECT_NAME_NOTE_ID || note.id === PROJECT_DIR_NOTE_ID)
        throw new Error(`'${note.id}' is a reserved ui-metadata note id`)
      return withMemory({ log: plugin.log, config: plugin.config }, async memory => {
        const written = await memory.store.write(note, await doorAuthor(origin))
        // event committed — the read model heals on the next drain if this catch-up fails
        await memory.projector.catchUp().catch(() => {})
        return { id: written.id, scope: written.scope }
      })
    },

    async listDecisions(filter, origin) {
      const port = await decisionPort()
      return (await port.decisions({ author: await doorAuthor(origin), idempotencyKey: null }, filter)).map(decisionSummaryOf)
    },

    async readDecision(id, origin) {
      return (await decisionPort()).decision({ author: await doorAuthor(origin), idempotencyKey: null }, id)
    },

    async recordDecision(input, origin) {
      const port = await decisionPort()
      const r = await port.recordDecision({ author: await doorAuthor(origin), idempotencyKey: null }, input)
      return { id: r.recorded.id, status: r.status, superseded: r.superseded?.id ?? null }
    },

    async deleteNote(id, scope, origin) {
      if (!plugin) throw new Error('deleting notes needs a project context')
      if (id === PROJECT_NAME_NOTE_ID || id === PROJECT_DIR_NOTE_ID)
        throw new Error(`'${id}' is a reserved ui-metadata note id`)
      return withMemory({ log: plugin.log, config: plugin.config }, async memory => {
        await memory.store.remove(id, scope, await doorAuthor(origin))
        await memory.projector.catchUp().catch(() => {})
        return { id }
      })
    },

    async renameProject(name, origin) {
      if (!plugin) throw new Error('renaming needs a project context')
      await plugin.log.append(nameNote(name, await doorAuthor(origin), origin))
      return { name }
    },

    async newProject(dir, name, origin) {
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
        const workspace = await adoptCwd(new Kernel(storage.events), created, origin)
        const author: MemoryAuthor = { source: authorSourceOf(origin.door), workspaceId: workspace.id, origin }
        await storage.events.append(nameNote(name, author, origin))
        await storage.events.append(dirNote(abs, author, origin))
      } finally {
        await storage.close()
      }
      return { projectId, reused: existing !== null }
    },

    async purgeProject(origin) {
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
          const seated = await kernel.restoreWorkspace(home.workspace, origin)
          const reseedAuthor: MemoryAuthor = { source: authorSourceOf(origin.door), workspaceId: seated.id, origin }
          if (plugin.config.projectName) await plugin.log.append(nameNote(plugin.config.projectName, reseedAuthor, origin))
          if (plugin.config.dir) await plugin.log.append(dirNote(plugin.config.dir, reseedAuthor, origin))
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

    async deleteProject(projectId, origin) {
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
        // database, so the home project's memory instance cannot reach it. Leaving it is not inert
        // garbage: a deleted project's notes stay live in `orc memory ls`, memory_search and the graph
        // UI, with no events behind them, until a later rebuild silently drops them.
        // Deleting a chat means the data goes too.
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

    async cancel(taskId, origin) {
      // The append half only: stamping the subtree cancelled is what a client can do without a
      // runtime, and the supervisor's router does the DBOS half off each cancelled status. With no
      // supervisor up there is nothing running to cancel, and the next one to boot sweeps it.
      await kernel.cancelSubtree(taskId, origin)
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
        const author = await doorAuthor(origin, { taskId })
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
