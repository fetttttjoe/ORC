import { EVENT_KIND, RUN_OUTCOME, TASK_STATUS, type EventRecord, type SplitResult, type TaskStatus } from '@orc/contracts'
import { EventLog } from '../eventlog'
import { fold, pendingSplitForChild, subtreeTaskIds, type SplitState } from '../projections'

const TERMINAL: Set<TaskStatus> = new Set([TASK_STATUS.done, TASK_STATUS.blocked, TASK_STATUS.cancelled, TASK_STATUS.failed])

// Pure composition of the thin join payload from the log (spec D5). Deterministic:
// same events → same result, so at-least-once routing appends identical split_resolved payloads.
export function composeSplitResult(events: EventRecord[], split: SplitState): SplitResult {
  const state = fold(events)
  const status = state.tasks.get(split.childTaskId)?.status
  const outcome =
    status === TASK_STATUS.done ? RUN_OUTCOME.done
    : status === TASK_STATUS.cancelled ? RUN_OUTCOME.cancelled
    : RUN_OUTCOME.blocked // blocked and failed both surface as blocked (RunOutcome has no 'failed')
  const subtree = new Set(subtreeTaskIds(state, split.childTaskId))

  let summary = 'cancelled'
  if (outcome === RUN_OUTCOME.done) {
    const plan = state.plans.get(split.childTaskId)?.versions.at(-1)
    const dependedOn = new Set(plan?.steps.flatMap(s => s.dependsOn) ?? [])
    const terminals = (plan?.steps ?? []).filter(s => !dependedOn.has(s.id))
    summary = terminals
      .map(s => state.steps.get(split.childTaskId)?.get(s.id)?.output ?? '')
      .filter(Boolean).join('\n')
  } else if (outcome === RUN_OUTCOME.blocked) {
    const failing = [...(state.steps.get(split.childTaskId)?.values() ?? [])].find(s => s.failure)
    summary = failing?.failure?.message ?? 'blocked'
  }

  const notes: { id: string; scope: string }[] = []
  const seen = new Set<string>()
  for (const e of events) {
    if (e.kind !== EVENT_KIND.memory_written) continue
    const p = e.payload as { note: { id: string; scope: string }; author: { taskId?: string | null } }
    if (!p.author.taskId || !subtree.has(p.author.taskId)) continue
    const key = `${p.note.scope}:${p.note.id}`
    if (!seen.has(key)) { seen.add(key); notes.push({ id: p.note.id, scope: p.note.scope }) }
  }
  return { splitId: split.splitId, childTaskId: split.childTaskId, outcome, summary, notes }
}

export function createSignalRouter(opts: {
  log: EventLog
  onChildApproved: (childTaskId: string) => Promise<void>
  send: (destinationId: string, result: SplitResult, topic: string, idempotencyKey: string) => Promise<void>
}): { start(): Promise<void>; close(): Promise<void> } {
  let unsub: (() => Promise<void>) | null = null
  return {
    async start() {
      unsub = await opts.log.subscribe({}, async e => {
        // route 2: an approved child with a pending split gets its run started (policy OR human)
        if (e.kind === EVENT_KIND.plan_approved && e.taskId) {
          const state = fold(await opts.log.all())
          if (pendingSplitForChild(state, e.taskId))
            await opts.onChildApproved(e.taskId).catch(err =>
              console.warn(`signal router: startChildRun ${e.taskId}: ${err instanceof Error ? err.message : String(err)}`))
          return
        }
        // route 1: a terminal child resolves its split
        if (e.kind !== EVENT_KIND.task_status_changed) return
        const to = (e.payload as { to: TaskStatus }).to
        if (!TERMINAL.has(to) || !e.taskId) return
        const all = await opts.log.all()
        const split = pendingSplitForChild(fold(all), e.taskId)
        if (!split) return
        const result = composeSplitResult(all, split)
        await opts.log.append({ taskId: split.taskId, stepId: split.stepId, runToken: split.runToken, kind: EVENT_KIND.split_resolved, payload: result })
        await opts.send(split.runToken, result, `split:${split.splitId}`, split.splitId)
      })
    },
    async close() { if (unsub) await unsub() },
  }
}
