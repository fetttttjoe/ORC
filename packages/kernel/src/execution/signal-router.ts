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
    const tp = state.plans.get(split.childTaskId)
    const plan = tp?.versions.find(v => v.version === tp.approvedVersion) ?? tp?.versions.at(-1)
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

  // append split_resolved + send, CONTAINED: a poisoned event must not kill the pump mid-batch
  // (the pump pre-advances its cursor, so a throw would strand the terminal event forever — the
  // waiting parent's recv has no gate timeout in v1). A throw here is healed by the next start()
  // sweep. Idempotent by construction: fold dedups split_resolved by splitId, send carries
  // idempotencyKey=splitId, so re-running is a no-op end to end.
  const resolveSplit = async (all: EventRecord[], split: SplitState): Promise<void> => {
    try {
      const result = composeSplitResult(all, split)
      await opts.log.append({
        taskId: split.taskId, stepId: split.stepId, runToken: split.runToken,
        kind: EVENT_KIND.split_resolved, payload: result,
        idempotencyKey: `${split.splitId}:resolved`,
      })
      await opts.send(split.runToken, result, `split:${split.splitId}`, split.splitId)
    } catch (err) {
      console.warn(`signal router: resolve split ${split.splitId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    async start() {
      // catch-up sweep BEFORE subscribing: every unresolved split whose child is already terminal
      // gets resolved now — heals a handler throw AND a terminal event that landed while the router
      // was down (never redelivered, since the pump pre-advances its cursor).
      const seed = await opts.log.all()
      const state = fold(seed)
      for (const split of state.splits.values()) {
        if (split.resolved) continue
        const status = state.tasks.get(split.childTaskId)?.status
        if (status && TERMINAL.has(status)) { await resolveSplit(seed, split); continue }
        // route 2 catch-up: an approved child whose run never started (plan_approved landed while
        // the router was down) still needs its run — same idempotent startChildRun as the live route.
        if (status === TASK_STATUS.approved && !state.runs.get(split.childTaskId)?.length)
          await opts.onChildApproved(split.childTaskId).catch(err =>
            console.warn(`signal router: startChildRun ${split.childTaskId}: ${err instanceof Error ? err.message : String(err)}`))
      }
      // resume the pump exactly where the sweep's seed ended (seq-exclusive), closing the gap for
      // events that landed between all() and subscribe. Both routes are idempotent under replay.
      unsub = await opts.log.subscribe({ fromSeq: seed.at(-1)?.seq ?? 0 }, async e => {
        // route 2: an approved child with a pending split gets its run started (policy OR human)
        if (e.kind === EVENT_KIND.plan_approved && e.taskId) {
          if (pendingSplitForChild(fold(await opts.log.all()), e.taskId))
            await opts.onChildApproved(e.taskId).catch(err =>
              console.warn(`signal router: startChildRun ${e.taskId}: ${err instanceof Error ? err.message : String(err)}`))
          return
        }
        // route 1: a terminal child resolves its split (guarded by pendingSplitForChild — a
        // redelivered terminal status finds the split already resolved and no-ops)
        if (e.kind !== EVENT_KIND.task_status_changed) return
        const to = (e.payload as { to: TaskStatus }).to
        if (!TERMINAL.has(to) || !e.taskId) return
        const all = await opts.log.all()
        const split = pendingSplitForChild(fold(all), e.taskId)
        if (split) await resolveSplit(all, split)
      })
    },
    async close() { if (unsub) await unsub() },
  }
}
