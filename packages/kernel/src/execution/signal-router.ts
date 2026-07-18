import {
  EVENT_KIND, EventKind, MemoryWrittenPayload, PAYLOAD_SCHEMAS, RUN_OUTCOME, SplitResult, TASK_STATUS,
  type EventRecord, type TaskStatus,
} from '@orc/contracts'
import { EventLog } from '../eventlog'
import { fold, pendingSplitForChild, subtreeTaskIds, type SplitState } from '../projections'

const TERMINAL: Set<TaskStatus> = new Set([TASK_STATUS.done, TASK_STATUS.blocked, TASK_STATUS.cancelled, TASK_STATUS.failed])

// Everything split routing/composition needs — excludes the high-volume trace kinds
// (agent/tool calls, operations, artifacts) so the router never scans the whole log.
// Exhaustive over EventKind: adding a kind forces a decision here, so a new
// routing-relevant kind can never be silently missing from the router's fold input.
const ROUTER_RELEVANT: Record<EventKind, boolean> = {
  task_created: true, task_status_changed: true,
  plan_proposed: true, plan_edited: true, plan_approved: true,
  run_started: true, step_started: true, step_completed: true, step_failed: true,
  split_proposed: true, split_resolved: true,
  memory_written: true, // composeSplitResult collects subtree-authored notes
  skill_loaded: false, agent_call: false, tool_call: false, tool_result: false,
  signal_received: false, operation_started: false, operation_completed: false,
  operation_failed: false, artifact_produced: false, memory_deleted: false,
}
const ROUTER_KINDS = EventKind.options.filter(k => ROUTER_RELEVANT[k])

// Pure composition of the thin join payload from the log (spec D5). Deterministic for a
// fixed event set — but the set can differ between racing routers (late memory_written),
// so the append is idempotency-keyed and conflicts recover by sending the STORED result.
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
    const p = MemoryWrittenPayload.safeParse(e.payload)
    if (!p.success || !p.data.author.taskId || !subtree.has(p.data.author.taskId)) continue
    const key = `${p.data.note.scope}:${p.data.note.id}`
    if (!seen.has(key)) { seen.add(key); notes.push({ id: p.data.note.id, scope: p.data.note.scope }) }
  }
  return { splitId: split.splitId, childTaskId: split.childTaskId, outcome, summary, notes }
}

// the committed resolution for a split, if any — the payload the parent must receive
function storedResolution(events: EventRecord[], splitId: string): SplitResult | null {
  for (const e of events) {
    if (e.kind !== EVENT_KIND.split_resolved) continue
    const p = SplitResult.safeParse(e.payload)
    if (p.success && p.data.splitId === splitId) return p.data
  }
  return null
}

export function createSignalRouter(opts: {
  log: EventLog
  onChildApproved: (childTaskId: string) => Promise<void>
  send: (destinationId: string, result: SplitResult, topic: string, idempotencyKey: string) => Promise<void>
}): { start(): Promise<void>; close(): Promise<void> } {
  let unsub: (() => Promise<void>) | null = null

  const sendResult = async (split: SplitState, result: SplitResult): Promise<void> => {
    await opts.send(split.runToken, result, `split:${split.splitId}`, split.splitId)
  }

  // append split_resolved + send, CONTAINED: a poisoned event must not kill the pump mid-batch.
  // The append is idempotency-keyed (${splitId}:resolved); a racing router that composed a
  // different snapshot hits the conflict path and recovers by sending the FIRST committed
  // resolution — the parent always receives exactly the stored payload, never nothing.
  const resolveSplit = async (all: EventRecord[], split: SplitState): Promise<void> => {
    try {
      const result = composeSplitResult(all, split)
      try {
        await opts.log.append({
          taskId: split.taskId, stepId: split.stepId, runToken: split.runToken,
          kind: EVENT_KIND.split_resolved, payload: result,
          idempotencyKey: `${split.splitId}:resolved`,
        })
        await sendResult(split, result)
      } catch (err) {
        const committed = storedResolution(await opts.log.after(0, [EVENT_KIND.split_resolved]), split.splitId)
        if (!committed) throw err
        await sendResult(split, committed)
      }
    } catch (err) {
      console.warn(`signal router: resolve split ${split.splitId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    async start() {
      // catch-up sweep BEFORE subscribing: every unresolved split whose child is already terminal
      // gets resolved now — heals a handler throw AND a terminal event that landed while the router
      // was down (never redelivered, since the pump pre-advances its cursor).
      const seed = await opts.log.after(0, ROUTER_KINDS)
      const state = fold(seed)
      for (const split of state.splits.values()) {
        if (split.resolved) {
          // a crash between append and send leaves the parent waiting on a committed
          // resolution — re-send it (idempotent: keyed by splitId) while the parent still runs
          if (state.tasks.get(split.taskId)?.status === TASK_STATUS.running) {
            const committed = storedResolution(seed, split.splitId)
            if (committed) await sendResult(split, committed).catch(err =>
              console.warn(`signal router: re-send split ${split.splitId}: ${err instanceof Error ? err.message : String(err)}`))
          }
          continue
        }
        const status = state.tasks.get(split.childTaskId)?.status
        if (status && TERMINAL.has(status)) { await resolveSplit(seed, split); continue }
        // route 2 catch-up: an approved child whose run never started (plan_approved landed while
        // the router was down) still needs its run — same idempotent startChildRun as the live route.
        if (status === TASK_STATUS.approved && !state.runs.get(split.childTaskId)?.length)
          await opts.onChildApproved(split.childTaskId).catch(err =>
            console.warn(`signal router: startChildRun ${split.childTaskId}: ${err instanceof Error ? err.message : String(err)}`))
      }
      // resume the pump exactly where the sweep's seed ended (seq-exclusive), closing the gap for
      // events that landed between the sweep read and subscribe. Both routes are idempotent under replay.
      // ponytail: each routed event refetches+refolds router-kind history (O(tasks) per event) —
      // keep an incremental in-memory fold if task volume ever makes this hurt
      unsub = await opts.log.subscribe({ fromSeq: seed.at(-1)?.seq ?? 0 }, async e => {
        // route 2: an approved child with a pending split gets its run started (policy OR human)
        if (e.kind === EVENT_KIND.plan_approved && e.taskId) {
          if (pendingSplitForChild(fold(await opts.log.after(0, ROUTER_KINDS)), e.taskId))
            await opts.onChildApproved(e.taskId).catch(err =>
              console.warn(`signal router: startChildRun ${e.taskId}: ${err instanceof Error ? err.message : String(err)}`))
          return
        }
        // route 1: a terminal child resolves its split (guarded by pendingSplitForChild — a
        // redelivered terminal status finds the split already resolved and no-ops)
        if (e.kind !== EVENT_KIND.task_status_changed) return
        const p = PAYLOAD_SCHEMAS.task_status_changed.safeParse(e.payload)
        if (!p.success || !TERMINAL.has(p.data.to) || !e.taskId) return
        const all = await opts.log.after(0, ROUTER_KINDS)
        const split = pendingSplitForChild(fold(all), e.taskId)
        if (split) await resolveSplit(all, split)
      })
    },
    async close() { if (unsub) await unsub() },
  }
}
