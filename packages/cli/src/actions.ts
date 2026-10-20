import { authorSourceOf, decisionSummaryOf, errorMessage, EVENT_KIND, ModelsDiscoveredPayload, TASK_STATUS, costUSDFor, parseModelRef, type ModelOption, type Origin, type TaskStatus } from '@orc/contracts'
import { Kernel, blockingVerdicts, canRetry, deriveSystemUrl, dropSystemDatabase, initializeProject, liveSupervisors, loadConfig, openStorage, resetSystemDatabase, type EventLog, type ProjectConfig, type Storage } from '@orc/kernel'
import { cwdAuthor, cwdWorkspace, cwdWorkspaceId } from './cwd-workspace'
import { adoptCwd } from './workspace-adopt'
import { createRequestWorkspace, HEAD_REF, requireLiveWorkspace } from './workspace-ops'
import { listWorkspaceHealth } from './workspace-health'
import { seedRegistries } from './runtime'
import { singleStepDraft } from './plan-template'
import { knowledgeAccess, openKnowledge } from './knowledge-open'
import type { OrcActions, PlanSource } from '@orc/ui-core'
import type { PlanDraft } from '@orc/contracts'
import type { Author, Workspace } from '@orc/contracts'
import { createVaultProjector, VAULT_TASKS_DIR } from '@orc/vault-projector'
import { existsSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

// the statuses startRunAt admits; one set so every door agrees on "can this be driven"
export const DRIVABLE_TASK_STATUS: ReadonlySet<TaskStatus> =
  new Set([TASK_STATUS.approved, TASK_STATUS.running, TASK_STATUS.blocked])

export async function assertDrivable(kernel: Kernel, taskId: string): Promise<void> {
  const task = await kernel.getTask(taskId)
  if (!task) throw new Error(`no task '${taskId}'`)
  const approved = (await kernel.state()).plans.get(taskId)?.approvedVersion
  if (!approved || !DRIVABLE_TASK_STATUS.has(task.status))
    throw new Error(`task is '${task.status}' — approve a plan first (orc approve ${taskId})`)
}

export async function assertRetryable(kernel: Kernel, taskId: string): Promise<void> {
  const task = await kernel.getTask(taskId)
  if (!task) throw new Error(`no task '${taskId}'`)
  const state = await kernel.state()
  // canRetry is the decision: a UI offering retry makes the same call and cannot throw
  if (canRetry(state, taskId)) return
  if (task.status !== TASK_STATUS.blocked)
    throw new Error(`task is '${task.status}' — only a blocked task can be retried`)
  // a task blocked only on verdicts cannot be moved by repeating itself: name the action that works
  const verdicts = blockingVerdicts(state, taskId)
  throw new Error(
    `this run was REJECTED, not broken — ${verdicts.map(v => `'${v.stepId}'`).join(', ')} judged the work unacceptable, `
    + `and a retry re-runs only that step against the same completed siblings, so it would reach the same verdict. `
    + `Revise the plan instead (orc revise ${taskId}), then approve the new version. Verdict: ${verdicts[0]?.message ?? ''}`,
  )
}

// live-discovered UNION cost-table: the API list omits aliases the provider still serves
export const modelUniverse = (live: string[], costs: Record<string, unknown>): string[] =>
  [...new Set([...live, ...Object.keys(costs).filter(k => k !== '*')])].sort()

// rejecting turns a provider that never answers into the unreachable case
const bounded = async <T>(work: Promise<T>, ms: number, pid: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`provider '${pid}' did not list models within ${ms}ms`)), ms)
  })
  try { return await Promise.race([work, expiry]) } finally { clearTimeout(timer) }
}

// reachable = the provider ANSWERED; an answer with no ids differs from silence
export interface DiscoveredProvider { pid: string; ids: string[]; reachable: boolean }

// gated on reachability, not emptiness: an answered empty catalog is a fact worth recording
export const catalogAppends = (perProvider: readonly DiscoveredProvider[], last: ReadonlyMap<string, string>): { providerId: string; models: string[] }[] =>
  perProvider
    .filter(({ ids, reachable, pid }) => reachable && JSON.stringify(ids) !== last.get(pid))
    .map(({ pid, ids }) => ({ providerId: pid, models: ids }))

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
      // a throwing or timed-out provider is unreachable, isolated so one cannot reject the whole fetch
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
  // no flag: every door discovers, since an agent handed { refs: [] } cannot name a model
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

// refuses under a live supervisor: wiping the DBOS system db under it wedges its queue silently
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

// nothing in this import graph may reach the terminal's argument parser (web and MCP load it)
export function buildOrcActions(deps: {
  kernel: Kernel
  ensureRuntime: () => Promise<unknown>
  plugin?: { config: ProjectConfig; log: EventLog; storage?: Storage }
  listModels?: () => Promise<string[]>
  listModelOptions?: () => Promise<ModelOption[]>
}): OrcActions {
  const { kernel, ensureRuntime, plugin, listModels, listModelOptions } = deps

  // folded per call, not captured: `orc ws new` can mint a workspace mid-session
  const doorAuthor = (origin: Origin): Promise<Author> =>
    cwdAuthor(kernel, plugin?.config.dir, authorSourceOf(origin.door), origin)

  const decisionPort = async () => {
    if (!plugin) throw new Error('decisions need a project context')
    const access = knowledgeAccess(openKnowledge(plugin.config), plugin.log, plugin.config.dir)
    if ('unavailable' in access) throw new Error(access.unavailable)
    return access.port
  }

  const requireTask = async (taskId: string) => {
    const task = await kernel.getTask(taskId)
    if (!task) throw new Error(`no task '${taskId}'`)
    return task
  }

  // fail at the boundary: an invented cwd is a deterministic ENOENT retries deep in the executor
  const assertRunnableCwd = (cwd: string): string => {
    const abs = path.resolve(cwd)
    if (!existsSync(abs) || !statSync(abs).isDirectory())
      throw new Error(`cwd is not an existing directory: ${abs}${plugin ? ` — the project's directory is ${plugin.config.dir}` : ''}`)
    return abs
  }

  // best-effort: with no discovery available nothing is blocked
  const assertKnownModel = async (ref: string): Promise<void> => {
    if (!listModels) return
    const refs = await listModels().catch(() => null)
    if (!refs || refs.length === 0 || refs.includes(ref)) return
    throw new Error(`unknown model '${ref}' — valid refs include: ${refs.slice(0, 8).join(', ')}${refs.length > 8 ? ', …' : ''}. Call available_models (copilot) or check orc's providers.`)
  }

  const draftFrom = async (taskId: string, plan: PlanSource): Promise<PlanDraft> => {
    const draft = 'draft' in plan
      ? plan.draft
      : singleStepDraft(await requireTask(taskId), plan.template.modelRef, plan.template.skillRefs, plugin?.config.maxIterations)
    for (const step of draft.steps) await assertKnownModel(step.modelRef)
    return draft
  }

  return {
    async newTask(input, origin) {
      // a root lands in the served checkout, a child inherits its parent's; an explicit id wins
      if (input.workspaceId !== undefined) await requireLiveWorkspace(kernel, input.workspaceId)
      const workspaceId = input.workspaceId
        ?? (input.parentId === undefined ? await cwdWorkspaceId(kernel, plugin?.config.dir) : undefined)
      if (!input.grounded) {
        const t = await kernel.createTask({ title: input.title, spec: input.spec ?? '', parentId: input.parentId, budgetUSD: input.budgetUSD, workspaceId }, origin)
        return { taskId: t.id }
      }
      await assertKnownModel(input.grounded.modelRef)
      // a null cwd stays null: requestRun resolves the task's own workspace
      const cwd = input.grounded.cwd === null ? null : assertRunnableCwd(input.grounded.cwd)
      const t = await kernel.createGroundedTask({
        title: input.title, spec: input.spec ?? '', parentId: input.parentId, budgetUSD: input.budgetUSD, workspaceId,
        modelRef: input.grounded.modelRef, analyzerRef: input.grounded.analyzerRef ?? 'agent-analyzer',
        modelCatalog: await listModelOptions?.().catch(() => []) ?? [],
        ...(plugin ? { maxIterations: plugin.config.maxIterations } : {}),
      }, origin)
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
      // ensure the supervisor before the event it must react to: approval only unblocks a child
      if ((await kernel.getTask(taskId))?.parentId) await ensureRuntime()
      const plan = await kernel.approvePlan(taskId, opts.version, opts.approvedBy ? { approvedBy: opts.approvedBy } : undefined, origin)
      return { version: plan.version }
    },

    async listModels() {
      return listModels ? listModels() : []
    },

    async run(taskId, cwd, origin) {
      // validate cwd BEFORE recording: an unrunnable directory would fail on every booting supervisor
      const resolved = cwd === null ? null : assertRunnableCwd(cwd)
      await assertDrivable(kernel, taskId)
      await ensureRuntime()
      // conditional spread: the idiom stays correct if requestRun's option becomes a presence check
      const since = await kernel.requestRun(taskId, { ...(resolved !== null && { cwd: resolved }) }, origin)
      return { requested: true, since }
    },

    async listWorkspaces() {
      if (!plugin) throw new Error('listing workspaces needs a project context')
      return listWorkspaceHealth(plugin)
    },

    async newWorkspace(input, origin) {
      // the worktree is created under the project root, which only a project context knows
      if (!plugin) throw new Error('creating a workspace needs a project context')
      // one implementation with `orc ws new`; `task: true` because a driver asks for the request
      const { workspace, taskId } = await createRequestWorkspace(kernel, plugin.config, {
        title: input.title, spec: input.spec ?? '', base: input.base ?? HEAD_REF, task: true,
      }, origin)
      return { workspace, taskId }
    },

    async reply(taskId, text, projectId, origin) {
      // the answer only unblocks the step; a supervisor carries it into the parked workflow
      if (!projectId || projectId === plugin?.config.projectId) {
        await ensureRuntime()
        const topic = await kernel.replyFeedback(taskId, text, origin)
        return { answered: topic !== null, supervised: true }
      }
      // a foreign project: append only and spawn nothing; execution stays bound to the started directory
      if (!plugin) throw new Error('answering another project needs a project context')
      // one short-lived pool per answered question: a human-rate action
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

    async renameProject(name, origin) {
      if (!plugin) throw new Error('renaming needs a project context')
      await kernel.identifyProject({ name, dir: plugin.config.dir }, origin)
      return { name }
    },

    async newProject(dir, name, origin) {
      if (!plugin) throw new Error('creating projects needs a project context')
      const abs = path.resolve(dir)
      if (!existsSync(abs)) throw new Error(`directory does not exist: ${abs}`)
      // loadConfig answers null for an uninitialized dir; existsSync(.orc) misses worktree subdirectories
      const existing = loadConfig(abs).projectId
      const projectId = existing ?? initializeProject(abs, name).projectId
      // first events = the checkout and the identity: listable, named, and locatable immediately
      const storage = await openStorage(plugin.config.databaseUrl, { projectId })
      try {
        // adopt into the new project's OWN log, not doorAuthor()'s workspace, which is another project's
        const created = loadConfig(abs)
        const projectKernel = new Kernel(storage.events)
        await adoptCwd(projectKernel, created, origin)
        await projectKernel.identifyProject({ name, dir: abs }, origin)
      } finally {
        await storage.close()
      }
      return { projectId, reused: existing !== null }
    },

    async purgeProject(origin) {
      if (!plugin?.storage) throw new Error('purging needs a project context')
      await refuseWhileSupervised(plugin.storage, 'purge')
      const warnings: string[] = []
      // read before the wipe removes workspace_created; the miss carries its reason, not one sentence
      interface HomeWorkspace { workspace: Workspace | null; reason: string | null }
      const home: HomeWorkspace = await cwdWorkspace(kernel, plugin.config.dir)
        .then((workspace): HomeWorkspace => ({ workspace, reason: null }))
        .catch((err: unknown): HomeWorkspace => ({ workspace: null, reason: errorMessage(err) }))
      const loggedName = await kernel.state().then(s => s.project?.name, () => undefined)
      // stop the engine first: a DBOS launch would start recovering the workflows being deleted
      try {
        await resetSystemDatabase(plugin.config.systemDatabaseUrl)
      } catch (err) {
        warnings.push(`durable-execution state not reset (${errorMessage(err)}) — restart orc before the next run`)
      }
      // the history: every event + journal row, one locked transaction
      const counts = await plugin.storage.purge()
      if (home.workspace === null) {
        warnings.push(`workspace not restored (${home.reason}) — run any orc command from the project checkout to restore it`)
      } else {
        try {
          await kernel.restoreWorkspace(home.workspace, origin)
        } catch (err) {
          warnings.push(`workspace not restored (${errorMessage(err)}) — another workspace now holds ${plugin.config.dir}`)
        }
      }
      try {
        await kernel.identifyProject({ name: loggedName ?? plugin.config.projectName, dir: plugin.config.dir }, origin)
      } catch (err) {
        warnings.push(`project identity not re-seeded (${errorMessage(err)})`)
      }
      // vault task traces: dead task folders would linger — drop them, re-render the index
      try {
        rmSync(path.join(plugin.config.vaultDir, VAULT_TASKS_DIR), { recursive: true, force: true })
        await createVaultProjector({ log: plugin.log, config: plugin.config }).renderAll()
      } catch (err) {
        warnings.push(`vault trace not cleared (${errorMessage(err)})`)
      }
      return { ...counts, warnings }
    },

    async deleteProject(projectId, origin) {
      if (!plugin) throw new Error('deleting projects needs a project context')
      // only the HOME project's supervisor is visible from here; a foreign runtime cannot be checked
      if (plugin.storage && projectId === plugin.config.projectId) await refuseWhileSupervised(plugin.storage, 'delete')
      const warnings: string[] = []
      // DROP, not truncate: a deleted project has no runtime left to hold the schema
      try {
        await dropSystemDatabase(deriveSystemUrl(plugin.config.databaseUrl, projectId))
      } catch (err) {
        warnings.push(`durable-execution state not dropped (${errorMessage(err)})`)
      }
      const storage = await openStorage(plugin.config.databaseUrl, { projectId })
      try {
        const counts = await storage.purge()
        // only the HOME project's rendered trace goes: a foreign vault lives in its own directory
        if (projectId === plugin.config.projectId) {
          try {
            rmSync(path.join(plugin.config.vaultDir, VAULT_TASKS_DIR), { recursive: true, force: true })
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
      // append half only: with no supervisor up nothing runs to cancel and the next boot sweeps it
      return { cancelled: await kernel.cancelSubtree(taskId, origin) }
    },
  }
}
