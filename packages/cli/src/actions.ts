import { errorMessage, EVENT_KIND, ISOLATION_TIER, STRATEGY, TASK_STATUS, costUSDFor, parseModelRef, type ExecutionPort, type PlanDraft } from '@orc/contracts'
import { deriveSystemUrl, initializeProject, loadConfig, openStorage, resetSystemDatabase, subtreeTaskIds, type EventLog, type Kernel, type ProjectConfig, type Storage } from '@orc/kernel'
import { seedRegistries } from './runtime'
import { createMemory, orphanedNotes } from '@orc/memory'
import { PROJECT_DIR_NOTE_ID, PROJECT_NAME_NOTE_ID, type OrcActions } from '@orc/ui-core'
import { createVaultProjector } from '@orc/vault-projector'
import { existsSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

// ui metadata notes are plain memory events — appended directly so they work even when the
// Surreal read model is down (the projector catches up on its own)
const uiNote = (id: string, title: string, summary: string) => ({
  taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
  payload: { note: { id, title, kind: 'fact', summary }, author: { source: 'cli' as const } },
})
const nameNote = (name: string) => uiNote(PROJECT_NAME_NOTE_ID, name, 'display name for the project chat')
const dirNote = (dir: string) => uiNote(PROJECT_DIR_NOTE_ID, dir, 'working directory of the project')

export function singleStepDraft(task: { title: string; spec: string }, modelRef: string, skillRefs: string[] = [], maxIterations = 30): PlanDraft {
  return {
    strategyRef: STRATEGY.single,
    costEstimateUSD: null,
    steps: [{
      id: 's1',
      role: 'worker',
      title: task.title,
      instructions: task.spec === '' ? task.title : task.spec,
      executorRef: 'api-loop',
      modelRef,
      skillRefs,
      toolRefs: [],
      isolation: ISOLATION_TIER.local, // the only implemented tier — worktree/docker come with sandbox plugins
      zone: [],
      maxIterations,
      dependsOn: [],
    }],
  }
}

// A provider's valid model ids: live-discovered UNION cost-table. The API list omits aliases
// the provider still serves (claude-haiku-4-5 vs …-20251001), and the cost table is exactly
// the set we can price. Sorted for stable append-on-change comparison.
export const modelUniverse = (live: string[], costs: Record<string, unknown>): string[] =>
  [...new Set([...live, ...Object.keys(costs).filter(k => k !== '*')])].sort()

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
    const perProvider = await Promise.all([...providers.entries()].map(async ([pid, p]) => {
      const live = p.listModels ? await p.listModels() : []
      return { pid, ids: modelUniverse(live, p.costs) }
    }))
    if (log) {
      // append-on-change: the latest event per provider IS the catalog
      const last = new Map<string, string>()
      for (const e of await log.after(0, [EVENT_KIND.models_discovered])) {
        const p = e.payload as { providerId?: string; models?: string[] }
        if (p.providerId) last.set(p.providerId, JSON.stringify(p.models ?? []))
      }
      for (const { pid, ids } of perProvider) {
        if (ids.length === 0 || JSON.stringify(ids) === last.get(pid)) continue
        await log.append({
          taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.models_discovered,
          payload: { providerId: pid, models: ids },
        }).catch(() => {}) // catalog persistence is best-effort, discovery still returns live data
      }
    }
    const refs = perProvider.flatMap(({ pid, ids }) => ids.map(id => `${pid}/${id}`)).sort()
    cache = { at: Date.now(), refs }
    return refs
  }
  return {
    listModels,
    providerFor,
    price: (ref: string, usage: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } }) => {
      const { p, modelId } = providerFor(ref)
      return costUSDFor(p.costs, modelId, usage.inputTokens ?? 0, usage.outputTokens ?? 0,
        { readTokens: usage.inputTokenDetails?.cacheReadTokens, writeTokens: usage.inputTokenDetails?.cacheWriteTokens })
    },
  }
}

// The ONE implementation of every mutating command — the CLI's commander actions and the web
// adapter both call through here, so they cannot drift.
export function buildOrcActions(deps: {
  kernel: Kernel
  needPort: () => Promise<ExecutionPort>
  plugin?: { config: ProjectConfig; log: EventLog; storage?: Storage }
  listModels?: () => Promise<string[]>
}): OrcActions {
  const { kernel, needPort, plugin, listModels } = deps

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
      if (!input.grounded) {
        const t = await kernel.createTask({ title: input.title, spec: input.spec ?? '', parentId: input.parentId })
        return { taskId: t.id }
      }
      await assertKnownModel(input.grounded.modelRef)
      const cwd = assertRunnableCwd(input.grounded.cwd)
      const t = await kernel.createGroundedTask({
        title: input.title, spec: input.spec ?? '',
        modelRef: input.grounded.modelRef, analyzerRef: input.grounded.analyzerRef ?? 'agent-analyzer',
      })
      // the grounded template is policy-approved — the analyze→plan conversation starts now;
      // callers watch progress over the event stream, nothing tails here
      await (await needPort()).startRun(t.id, { cwd })
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
      const handle = await (await needPort()).startRun(taskId, { cwd: assertRunnableCwd(cwd) })
      return { workflowId: handle.workflowId }
    },

    async reply(taskId, text) {
      await needPort() // DBOS.send (behind kernel.send) requires DBOS launched in THIS process
      const topic = await kernel.replyFeedback(taskId, text)
      return { answered: topic !== null }
    },

    async retry(taskId) {
      const handle = await (await needPort()).retry(taskId)
      return { workflowId: handle.workflowId }
    },

    async annotate(taskId, noteId, text, refs) {
      await kernel.annotatePlan(taskId, { targetNote: noteId, refs: refs ?? [], text })
      return { noteId }
    },

    async revise(taskId, text, scope) {
      await needPort() // resuming the gate needs DBOS launched here, exactly like reply
      for (const noteId of scope) await kernel.annotatePlan(taskId, { targetNote: noteId, refs: [], text })
      const topic = await kernel.replyFeedback(taskId, text)
      return { topic }
    },

    async renameProject(name) {
      if (!plugin) throw new Error('renaming needs a project context')
      await plugin.log.append(nameNote(name))
      return { name }
    },

    async newProject(dir, name) {
      if (!plugin) throw new Error('creating projects needs a project context')
      const abs = path.resolve(dir)
      if (!existsSync(abs)) throw new Error(`directory does not exist: ${abs}`)
      // a directory that already holds an orc project is REUSED, never re-minted — "new chat"
      // on a known folder means "open that project", the name becomes its display name
      const existing = existsSync(path.join(abs, '.orc', 'config.json')) ? loadConfig(abs).projectId : null
      const projectId = existing ?? initializeProject(abs, name).projectId
      // first events = name + dir notes: listable, named, and locatable immediately
      const storage = await openStorage(plugin.config.databaseUrl, { projectId })
      try {
        await storage.events.append(nameNote(name))
        await storage.events.append(dirNote(abs))
      } finally {
        await storage.close()
      }
      return { projectId, reused: existing !== null }
    },

    async purgeProject() {
      if (!plugin?.storage) throw new Error('purging needs a project context')
      const warnings: string[] = []
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
      // zero events, drops off the chats list, and the UI strands the user in a foreign chat
      if (plugin.config.projectName) await plugin.log.append(nameNote(plugin.config.projectName))
      if (plugin.config.dir) await plugin.log.append(dirNote(plugin.config.dir))
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
        memory = await createMemory({ log: plugin.log, config: plugin.config })
        await memory.projector.rebuild()
      } catch (err) {
        warnings.push(`memory read model not cleared (${errorMessage(err)}) — run 'orc memory rebuild' once it is reachable`)
      } finally {
        await memory?.close().catch(() => {})
      }
      return { ...counts, warnings }
    },

    async deleteProject(projectId) {
      if (!plugin) throw new Error('deleting projects needs a project context')
      const warnings: string[] = []
      // stop-then-wipe, same order as purge; no identity re-seed — deletion IS the point.
      // Deleting the HOME project is allowed too: full wipe, though it stays listed (empty)
      // while this server runs from it. Surreal read-model garbage is inert — not cleaned.
      try {
        await resetSystemDatabase(deriveSystemUrl(plugin.config.databaseUrl, projectId))
      } catch (err) {
        warnings.push(`durable-execution state not reset (${errorMessage(err)})`)
      }
      const storage = await openStorage(plugin.config.databaseUrl, { projectId })
      try {
        const counts = await storage.purge()
        return { ...counts, warnings }
      } finally {
        await storage.close()
      }
    },

    async cancel(taskId) {
      await (await needPort()).cancelRun(taskId)
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
        memory = await createMemory({ log: plugin.log, config: plugin.config })
        for (const n of goes) await memory.store.remove(n.id, n.scope, { source: 'cli', taskId })
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
