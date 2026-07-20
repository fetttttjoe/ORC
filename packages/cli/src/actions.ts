import { EVENT_KIND, ISOLATION_TIER, STRATEGY, type ExecutionPort, type PlanDraft } from '@orc/contracts'
import { subtreeTaskIds, type EventLog, type Kernel, type ProjectConfig } from '@orc/kernel'
import { createMemory, orphanedNotes } from '@orc/memory'
import type { OrcActions } from '@orc/ui-core'

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

// The ONE implementation of every mutating command — the CLI's commander actions and the web
// adapter both call through here, so they cannot drift.
export function buildOrcActions(deps: {
  kernel: Kernel
  needPort: () => Promise<ExecutionPort>
  plugin?: { config: ProjectConfig; log: EventLog }
}): OrcActions {
  const { kernel, needPort, plugin } = deps

  const requireTask = async (taskId: string) => {
    const task = await kernel.getTask(taskId)
    if (!task) throw new Error(`no task '${taskId}'`)
    return task
  }

  return {
    async newTask(input) {
      if (!input.grounded) {
        const t = await kernel.createTask({ title: input.title, spec: input.spec ?? '', parentId: input.parentId })
        return { taskId: t.id }
      }
      const t = await kernel.createGroundedTask({
        title: input.title, spec: input.spec ?? '',
        modelRef: input.grounded.modelRef, analyzerRef: input.grounded.analyzerRef ?? 'agent-analyzer',
      })
      // the grounded template is policy-approved — the analyze→plan conversation starts now;
      // callers watch progress over the event stream, nothing tails here
      await (await needPort()).startRun(t.id, { cwd: input.grounded.cwd })
      return { taskId: t.id }
    },

    async propose(taskId, opts) {
      const task = await requireTask(taskId)
      const plan = await kernel.proposePlan(taskId, singleStepDraft(task, opts.modelRef, opts.skillRefs ?? [], plugin?.config.maxIterations))
      return { version: plan.version, steps: plan.steps.length }
    },

    async edit(taskId, draft) {
      const plan = await kernel.editPlan(taskId, draft)
      return { version: plan.version }
    },

    async approve(taskId, version) {
      const plan = await kernel.approvePlan(taskId, version)
      return { version: plan.version }
    },

    async run(taskId, cwd) {
      const handle = await (await needPort()).startRun(taskId, { cwd })
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
        return { swept: [], sweepError: err instanceof Error ? err.message : String(err) }
      } finally {
        await memory?.close().catch(() => {})
      }
    },
  }
}
