import {
  errorMessage,
  EVENT_KIND, EventKind, FeedbackProvidedPayload, MemoryWrittenPayload, PAYLOAD_SCHEMAS, REACTION, ReactionFailedPayload, RUN_OUTCOME, RunRequestedPayload, runOutcomeFor, SplitResult, TASK_STATUS,
  type EventRecord, type Reaction, type TaskStatus,
} from '@orc/contracts'
import { EventLog } from '../storage'
import { fold, pendingSplitForChild, subtreeTaskIds, type SplitState } from '../projections'

const TERMINAL: Set<TaskStatus> = new Set([TASK_STATUS.done, TASK_STATUS.blocked, TASK_STATUS.cancelled, TASK_STATUS.failed])

// ponytail: bounds the cancel catch-up sweep to the most-recently-cancelled tasks rather than a
// project's entire cancellation history — see the sweep below for why unbounded is wasteful
// (not unsafe). Raise it, or persist a per-project sweep watermark, if it ever proves too small.
const CANCEL_SWEEP_LIMIT = 200

// Everything split routing/composition needs — excludes the high-volume trace kinds
// (agent/tool calls, operations, artifacts) so the router never scans the whole log.
// Exhaustive over EventKind: adding a kind forces a decision here, so a new
// routing-relevant kind can never be silently missing from the router's fold input.
const ROUTER_RELEVANT: Record<EventKind, boolean> = {
  task_created: true, task_status_changed: true,
  plan_proposed: true, plan_edited: true, plan_approved: true,
  run_requested: true, run_started: true, step_started: true, step_completed: true, step_failed: true,
  split_proposed: true, split_resolved: true,
  // composeSplitResult needs these, but it runs once per split resolution — keeping note bodies out
  // of ROUTER_KINDS means the per-event fetch below does not carry them.
  memory_written: false,
  skill_loaded: false, agent_call: false, tool_call: false, tool_result: false,
  signal_received: false, operation_started: false, operation_completed: false,
  operation_failed: false, artifact_produced: false, memory_deleted: false, memory_accessed: false,
  // a topic access (list or fetch) reads DERIVED knowledge — it starts nothing, unblocks nothing,
  // and changes no task state, same as its sibling memory_accessed
  memory_topic_accessed: false,
  // a verification stamps a note; it starts nothing, unblocks nothing, and changes no task state
  memory_verified: false,
  feedback_requested: false, feedback_provided: true, plan_annotated: false, analysis_completed: false,
  models_discovered: false, // catalog metadata — nothing to route
  copilot_exchange: false, // conversation record — nothing to route
  reaction_failed: false, // the router's OWN diagnosis — routing it would react to itself
}
const ROUTER_KINDS = EventKind.options.filter(k => ROUTER_RELEVANT[k])

// Pure composition of the thin join payload from the log (spec D5). Deterministic for a
// fixed event set — but the set can differ between racing routers (late memory_written),
// so the append is idempotency-keyed and conflicts recover by sending the STORED result.
export function composeSplitResult(events: EventRecord[], noteEvents: EventRecord[], split: SplitState): SplitResult {
  const state = fold(events)
  const outcome = runOutcomeFor(state.tasks.get(split.childTaskId)?.status)
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
  for (const e of noteEvents) {
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
  // The explicit ask (Task 1), turned into a workflow. The router is a dumb relay here — cwd and
  // retry come straight off the recorded payload, no policy decisions made in this file.
  onRunRequested: (taskId: string, opts: { cwd: string | null; retry: boolean }) => Promise<void>
  // The DBOS half of a cancel, which a client with no execution port cannot do itself —
  // kernel.cancelSubtree only appends the status; the running supervisor finishes the job.
  onCancelled: (taskId: string) => Promise<void>
  send: (destinationId: string, result: SplitResult, topic: string, idempotencyKey: string) => Promise<void>
  sendFeedback: (destinationId: string, message: string, topic: string, idempotencyKey: string) => Promise<void>
}): { start(): Promise<void>; close(): Promise<void> } {
  let unsub: (() => Promise<void>) | null = null

  // A reaction that throws is the runtime failing at its whole job, and it used to leave nothing but
  // a line on the supervisor's stdout — the client had already been told its ask was recorded, and
  // `orc status` showed a task that simply never moved. Recorded here so the failure is DATA.
  // Keyed by the CAUSE's seq, so a catch-up sweep that retries the same event on every boot
  // diagnoses it once rather than growing the log. The append is itself contained: a diagnosis that
  // throws must never replace the failure it describes.
  // `cause.id` is the idempotency discriminator: an event's seq where one triggered the reaction, a
  // splitId where the trigger is a split's state rather than a single event.
  const reactionFailed = async (
    reaction: Reaction,
    cause: { taskId: string | null; seq: number | null; id: string },
    err: unknown,
  ): Promise<void> => {
    const message = errorMessage(err)
    console.warn(`signal router: ${reaction} ${cause.taskId ?? ''} (${cause.id}): ${message}`)
    await opts.log.append({
      taskId: cause.taskId, stepId: null, runToken: null, kind: EVENT_KIND.reaction_failed,
      payload: ReactionFailedPayload.parse({ reaction, taskId: cause.taskId, message, causeSeq: cause.seq }),
      idempotencyKey: `${cause.id}:${reaction}:reaction_failed`,
    }).catch(() => {})
  }
  const ofEvent = (e: EventRecord) => ({ taskId: e.taskId, seq: e.seq, id: String(e.seq) })
  const ofSplit = (s: SplitState) => ({ taskId: s.taskId, seq: null, id: s.splitId })

  const sendResult = async (split: SplitState, result: SplitResult): Promise<void> => {
    await opts.send(split.runToken, result, `split:${split.splitId}`, split.splitId)
  }
  const sendFeedback = async (event: EventRecord): Promise<void> => {
    const payload = FeedbackProvidedPayload.parse(event.payload)
    if (!event.runToken) throw new Error(`feedback_provided seq ${event.seq} has no runToken`)
    await opts.sendFeedback(event.runToken, payload.text, `feedback:${payload.topic}`, `feedback:${event.seq}`)
  }

  // append split_resolved + send, CONTAINED: a poisoned event must not kill the pump mid-batch.
  // The append is idempotency-keyed (${splitId}:resolved); a racing router that composed a
  // different snapshot hits the conflict path and recovers by sending the FIRST committed
  // resolution — the parent always receives exactly the stored payload, never nothing.
  const resolveSplit = async (all: EventRecord[], split: SplitState): Promise<void> => {
    try {
      const result = composeSplitResult(all, await opts.log.after(0, [EVENT_KIND.memory_written]), split)
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
      await reactionFailed(REACTION.splitResolve, ofSplit(split), err)
    }
  }

  return {
    async start() {
      // catch-up sweep BEFORE subscribing: every unresolved split whose child is already terminal
      // gets resolved now — heals a handler throw AND a terminal event that landed while the router
      // was down (never redelivered, since the pump pre-advances its cursor).
      const seed = await opts.log.after(0, ROUTER_KINDS)
      const state = fold(seed)
      for (const event of seed) {
        if (event.kind !== EVENT_KIND.feedback_provided || !event.taskId
          || state.tasks.get(event.taskId)?.status !== TASK_STATUS.running) continue
        await sendFeedback(event).catch(err => reactionFailed(REACTION.feedback, ofEvent(event), err))
      }
      // catch-up mirrors route 2's shape below: serve the LATEST run_requested per task that has
      // not yet been served — "served" means a run_started with a LATER seq exists. Comparing by
      // seq (not "does this task have any run at all") is what a plain retry needs: a task that
      // already ran once and is asking again must not be mistaken for one that was already served.
      const lastRequested = new Map<string, EventRecord>()
      const lastStartedSeq = new Map<string, number>()
      for (const event of seed) {
        if (event.kind === EVENT_KIND.run_requested && event.taskId) lastRequested.set(event.taskId, event)
        else if (event.kind === EVENT_KIND.run_started && event.taskId) lastStartedSeq.set(event.taskId, event.seq)
      }
      for (const [taskId, event] of lastRequested) {
        if ((lastStartedSeq.get(taskId) ?? -1) > event.seq) continue // a run already answered this request
        const p = RunRequestedPayload.safeParse(event.payload)
        if (p.success)
          await opts.onRunRequested(taskId, { cwd: p.data.cwd, retry: p.data.retry })
            .catch(err => reactionFailed(REACTION.runRequested, ofEvent(event), err))
      }
      // catch-up: a cancel that landed while no supervisor was up never got its DBOS half done —
      // left alone, DBOS's OWN recovery (running as part of this very boot) resumes that workflow
      // and runs it to completion, burning model calls, no matter what our event log says.
      // Idempotent per task (cancelWorkflowsFor is a no-op once DBOS has already terminated the
      // workflow), but capped (see CANCEL_SWEEP_LIMIT) to bound the cost of walking history.
      const recentlyCancelled: string[] = []
      const seenCancelled = new Set<string>()
      for (const event of [...seed].reverse()) {
        if (recentlyCancelled.length >= CANCEL_SWEEP_LIMIT) break
        if (event.kind !== EVENT_KIND.task_status_changed || !event.taskId || seenCancelled.has(event.taskId)) continue
        const p = PAYLOAD_SCHEMAS.task_status_changed.safeParse(event.payload)
        if (p.success && p.data.to === TASK_STATUS.cancelled) { seenCancelled.add(event.taskId); recentlyCancelled.push(event.taskId) }
      }
      for (const taskId of recentlyCancelled)
        await opts.onCancelled(taskId).catch(err =>
          reactionFailed(REACTION.cancelled, { taskId, seq: null, id: `sweep:${taskId}` }, err))
      for (const split of state.splits.values()) {
        if (split.resolved) {
          // a crash between append and send leaves the parent waiting on a committed
          // resolution — re-send it (idempotent: keyed by splitId) while the parent still runs
          if (state.tasks.get(split.taskId)?.status === TASK_STATUS.running) {
            const committed = storedResolution(seed, split.splitId)
            if (committed) await sendResult(split, committed).catch(err =>
              reactionFailed(REACTION.splitResolve, ofSplit(split), err))
          }
          continue
        }
        const status = state.tasks.get(split.childTaskId)?.status
        if (status && TERMINAL.has(status)) { await resolveSplit(seed, split); continue }
        // route 2 catch-up: an approved child whose run never started (plan_approved landed while
        // the router was down) still needs its run — same idempotent startChildRun as the live route.
        if (status === TASK_STATUS.approved && !state.runs.get(split.childTaskId)?.length)
          await opts.onChildApproved(split.childTaskId).catch(err =>
            reactionFailed(REACTION.childApproved, ofSplit(split), err))
      }
      // resume the pump exactly where the sweep's seed ended (seq-exclusive), closing the gap for
      // events that landed between the sweep read and subscribe. Both routes are idempotent under replay.
      // ponytail: each routed event refetches+refolds router-kind history (O(tasks) per event) —
      // keep an incremental in-memory fold if task volume ever makes this hurt
      unsub = await opts.log.subscribe({ fromSeq: seed.at(-1)?.seq ?? 0 }, async e => {
        if (e.kind === EVENT_KIND.feedback_provided) {
          await sendFeedback(e).catch(err => reactionFailed(REACTION.feedback, ofEvent(e), err))
          return
        }
        // The explicit ask (Task 1). Deterministic workflow ids make a redelivered request an
        // attach, not a second run, so at-least-once delivery is safe here.
        if (e.kind === EVENT_KIND.run_requested && e.taskId) {
          const p = RunRequestedPayload.safeParse(e.payload)
          if (p.success)
            await opts.onRunRequested(e.taskId, { cwd: p.data.cwd, retry: p.data.retry })
              .catch(err => reactionFailed(REACTION.runRequested, ofEvent(e), err))
          return
        }
        // route 2: an approved child with a pending split gets its run started (policy OR human)
        if (e.kind === EVENT_KIND.plan_approved && e.taskId) {
          if (pendingSplitForChild(fold(await opts.log.after(0, ROUTER_KINDS)), e.taskId))
            await opts.onChildApproved(e.taskId).catch(err =>
              reactionFailed(REACTION.childApproved, ofEvent(e), err))
          return
        }
        // route 1: a terminal child resolves its split (guarded by pendingSplitForChild — a
        // redelivered terminal status finds the split already resolved and no-ops)
        if (e.kind !== EVENT_KIND.task_status_changed) return
        const p = PAYLOAD_SCHEMAS.task_status_changed.safeParse(e.payload)
        if (!p.success || !TERMINAL.has(p.data.to) || !e.taskId) return
        // Cancelling the DBOS workflows is the half a client cannot do. kernel.cancelSubtree
        // appended the status; this is the runtime completing it. Idempotent: cancelling an
        // already-cancelled workflow is a no-op.
        if (p.data.to === TASK_STATUS.cancelled)
          await opts.onCancelled(e.taskId)
            .catch(err => reactionFailed(REACTION.cancelled, ofEvent(e), err))
        const all = await opts.log.after(0, ROUTER_KINDS)
        const split = pendingSplitForChild(fold(all), e.taskId)
        if (split) await resolveSplit(all, split)
      })
    },
    async close() { if (unsub) await unsub() },
  }
}
