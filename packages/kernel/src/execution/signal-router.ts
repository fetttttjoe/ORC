import {
  errorMessage,
  CommitRecordedPayload,
  Door,
  EVENT_KIND, EventKind, FeedbackProvidedPayload, PAYLOAD_SCHEMAS, REACTION, ReactionFailedPayload, RunOutcome, RunRequestedPayload, runOutcomeFor, SplitResult, TASK_STATUS, TERMINAL_TASK_STATUS,
  type EventRecord, type Reaction, type TaskStatus,
} from '@orc/contracts'
import { EventLog } from '../storage'
import { fold, pendingSplitForChild, subtreeTaskIds, type SplitState } from '../projections'
import { knowledgeWritesIn } from '../task-knowledge'

const TERMINAL: Set<TaskStatus> = new Set([TASK_STATUS.done, TASK_STATUS.blocked, TASK_STATUS.cancelled, TASK_STATUS.failed])

// Bounds the cancel catch-up sweep to the most recently cancelled tasks, not the whole history.
const CANCEL_SWEEP_LIMIT = 200

// Excludes the high-volume trace kinds; exhaustive over EventKind so a new kind forces a decision.
const ROUTER_RELEVANT: Record<EventKind, boolean> = {
  task_created: true, task_status_changed: true,
  plan_proposed: true, plan_edited: true, plan_approved: true,
  run_requested: true, run_started: true, step_started: true, step_completed: true, step_failed: true,
  split_proposed: true, split_resolved: true,
  skill_loaded: false, rate_limit_wait: false, agent_call: false, tool_call: false, tool_result: false,
  signal_received: false, operation_started: false, operation_completed: false,
  operation_failed: false, artifact_produced: false,
  knowledge_delivered: false,
  // fetched separately by composeSplitResult (resolveSplit), not on every routed event
  knowledge_written: false,
  knowledge_checked: false,
  feedback_requested: false, feedback_provided: true, plan_annotated: false, analysis_completed: false,
  plan_note_written: false, // the plan step's own authoring; nothing routes until finalize_plan
  models_discovered: false, // catalog metadata — nothing to route
  copilot_exchange: false, // conversation record — nothing to route
  reaction_failed: false, // the router's OWN diagnosis — routing it would react to itself
  // the auto-heal trigger: a commit moves the tree under the claims' anchors (onCommitRecorded)
  commit_recorded: true,
  // workspace lifecycle facts: no reactor reads these
  workspace_created: false, workspace_retitled: false, workspace_archived: false, workspace_merged: false,
  // a chat's opening is a correlation fact — nothing routes off it
  chat_opened: false,
  project_identified: false,
}
const ROUTER_KINDS = Object.values(EventKind).filter(k => ROUTER_RELEVANT[k])

// Racing routers may see different sets (late knowledge_written); conflicts send the STORED result.
export function composeSplitResult(events: EventRecord[], knowledgeEvents: EventRecord[], split: SplitState): SplitResult {
  const state = fold(events)
  const outcome = runOutcomeFor(state.tasks.get(split.childTaskId)?.status)
  const subtree = new Set(subtreeTaskIds(state, split.childTaskId))

  let summary = 'cancelled'
  if (outcome === RunOutcome.done) {
    const tp = state.plans.get(split.childTaskId)
    const plan = tp?.versions.find(v => v.version === tp.approvedVersion) ?? tp?.versions.at(-1)
    const dependedOn = new Set(plan?.steps.flatMap(s => s.dependsOn) ?? [])
    const terminals = (plan?.steps ?? []).filter(s => !dependedOn.has(s.id))
    summary = terminals
      .map(s => state.steps.get(split.childTaskId)?.get(s.id)?.output ?? '')
      .filter(Boolean).join('\n')
  } else if (outcome === RunOutcome.blocked) {
    const failing = [...(state.steps.get(split.childTaskId)?.values() ?? [])].find(s => s.failure)
    summary = failing?.failure?.message ?? 'blocked'
  }

  return { splitId: split.splitId, childTaskId: split.childTaskId, outcome, summary, claims: knowledgeWritesIn(knowledgeEvents, subtree).live }
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
  // The explicit ask, turned into a workflow; cwd and retry come straight off the recorded payload.
  onRunRequested: (taskId: string, opts: { cwd: string | null; retry: boolean }) => Promise<void>
  // The DBOS half of a cancel: kernel.cancelSubtree only appends the status.
  onCancelled: (taskId: string) => Promise<void>
  // The auto-heal reactor; absent, commits stay traceability records.
  onCommitRecorded?: (payload: CommitRecordedPayload) => Promise<void>
  send: (destinationId: string, result: SplitResult, topic: string, idempotencyKey: string) => Promise<void>
  sendFeedback: (destinationId: string, message: string, topic: string, idempotencyKey: string) => Promise<void>
}): { start(): Promise<void>; close(): Promise<void> } {
  let unsub: (() => Promise<void>) | null = null

  // A throwing reaction is recorded as data, keyed by cause so a retried sweep logs it once.
  const reactionFailed = async (
    reaction: Reaction,
    // chatId is the reacted-to event's: the diagnosis lands in that run's transcript
    cause: { taskId: string | null; seq: number | null; id: string; chatId: string | null },
    err: unknown,
  ): Promise<void> => {
    const message = errorMessage(err)
    console.warn(`signal router: ${reaction} ${cause.taskId ?? ''} (${cause.id}): ${message}`)
    await opts.log.append({
      chatId: cause.chatId, door: Door.supervisor,
      taskId: cause.taskId, stepId: null, runToken: null, kind: EVENT_KIND.reaction_failed,
      payload: ReactionFailedPayload.parse({ reaction, taskId: cause.taskId, message, causeSeq: cause.seq }),
      idempotencyKey: `${cause.id}:${reaction}:reaction_failed`,
    }).catch(() => {})
  }
  const ofEvent = (e: EventRecord) => ({ taskId: e.taskId, seq: e.seq, id: String(e.seq), chatId: e.chatId })
  // a split's reacted-to event is the split_proposed that opened it
  const ofSplit = (s: SplitState, events: EventRecord[]) =>
    ({ taskId: s.taskId, seq: null, id: s.splitId, chatId: splitProposedFor(events, s.splitId)?.chatId ?? null })

  const splitProposedFor = (events: EventRecord[], splitId: string): EventRecord | undefined =>
    events.find(e => e.kind === EVENT_KIND.split_proposed && PAYLOAD_SCHEMAS.split_proposed.safeParse(e.payload).data?.splitId === splitId)

  const sendResult = async (split: SplitState, result: SplitResult): Promise<void> => {
    await opts.send(split.runToken, result, `split:${split.splitId}`, split.splitId)
  }
  const sendFeedback = async (event: EventRecord): Promise<void> => {
    const payload = FeedbackProvidedPayload.parse(event.payload)
    if (!event.runToken) throw new Error(`feedback_provided seq ${event.seq} has no runToken`)
    await opts.sendFeedback(event.runToken, payload.text, `feedback:${payload.topic}`, `feedback:${event.seq}`)
  }

  // append split_resolved + send, CONTAINED: a poisoned event must not kill the pump mid-batch.
  const resolveSplit = async (all: EventRecord[], split: SplitState): Promise<void> => {
    try {
      const result = composeSplitResult(all, await opts.log.after(0, [EVENT_KIND.knowledge_written]), split)
      try {
        await opts.log.append({
          chatId: splitProposedFor(all, split.splitId)?.chatId ?? null, door: Door.supervisor,
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
      await reactionFailed(REACTION.splitResolve, ofSplit(split, all), err)
    }
  }

  return {
    async start() {
      // sweep BEFORE subscribing: a terminal event that landed while down is never redelivered
      const seed = await opts.log.after(0, ROUTER_KINDS)
      const state = fold(seed)
      for (const event of seed) {
        if (event.kind !== EVENT_KIND.feedback_provided || !event.taskId
          || state.tasks.get(event.taskId)?.status !== TASK_STATUS.running) continue
        await sendFeedback(event).catch(err => reactionFailed(REACTION.feedback, ofEvent(event), err))
      }
      // serve the LATEST run_requested with no later run_started (by seq, so retries are served)
      const lastRequested = new Map<string, EventRecord>()
      const lastStartedSeq = new Map<string, number>()
      for (const event of seed) {
        if (event.kind === EVENT_KIND.run_requested && event.taskId) lastRequested.set(event.taskId, event)
        else if (event.kind === EVENT_KIND.run_started && event.taskId) lastStartedSeq.set(event.taskId, event.seq)
      }
      for (const [taskId, event] of lastRequested) {
        if ((lastStartedSeq.get(taskId) ?? -1) > event.seq) continue // a run already answered this request
        // TERMINAL_TASK_STATUS, not the local TERMINAL: blocked is where a retry resumes from
        const status = state.tasks.get(taskId)?.status
        if (status !== undefined && TERMINAL_TASK_STATUS.has(status)) continue
        const p = RunRequestedPayload.safeParse(event.payload)
        if (p.success)
          await opts.onRunRequested(taskId, { cwd: p.data.cwd, retry: p.data.retry })
            .catch(err => reactionFailed(REACTION.runRequested, ofEvent(event), err))
      }
      // a cancel landed while down: DBOS recovery would resume that workflow and burn model calls
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
          reactionFailed(REACTION.cancelled, { taskId, seq: null, id: `sweep:${taskId}`, chatId: null }, err))
      // a commit landed while down: serve only the LATEST; the heal is corpus-wide and idempotent
      if (opts.onCommitRecorded) {
        const latest = [...seed].reverse().find(e => e.kind === EVENT_KIND.commit_recorded)
        if (latest) {
          const p = CommitRecordedPayload.safeParse(latest.payload)
          if (p.success)
            await opts.onCommitRecorded(p.data)
              .catch(err => reactionFailed(REACTION.commitRecorded, ofEvent(latest), err))
        }
      }
      for (const split of state.splits.values()) {
        if (split.resolved) {
          // crash between append and send: re-send the committed resolution (keyed by splitId)
          if (state.tasks.get(split.taskId)?.status === TASK_STATUS.running) {
            const committed = storedResolution(seed, split.splitId)
            if (committed) await sendResult(split, committed).catch(err =>
              reactionFailed(REACTION.splitResolve, ofSplit(split, seed), err))
          }
          continue
        }
        const status = state.tasks.get(split.childTaskId)?.status
        if (status && TERMINAL.has(status)) { await resolveSplit(seed, split); continue }
        // approved child whose run never started: same idempotent startChildRun as the live route
        if (status === TASK_STATUS.approved && !state.runs.get(split.childTaskId)?.length)
          await opts.onChildApproved(split.childTaskId).catch(err =>
            reactionFailed(REACTION.childApproved, ofSplit(split, seed), err))
      }
      // resume the pump where the seed ended (seq-exclusive); both routes are idempotent under replay
      unsub = await opts.log.subscribe({ fromSeq: seed.at(-1)?.seq ?? 0 }, async e => {
        if (e.kind === EVENT_KIND.feedback_provided) {
          await sendFeedback(e).catch(err => reactionFailed(REACTION.feedback, ofEvent(e), err))
          return
        }
        // The explicit ask: deterministic workflow ids make a redelivery an attach, not a second run.
        if (e.kind === EVENT_KIND.run_requested && e.taskId) {
          const p = RunRequestedPayload.safeParse(e.payload)
          if (p.success)
            await opts.onRunRequested(e.taskId, { cwd: p.data.cwd, retry: p.data.retry })
              .catch(err => reactionFailed(REACTION.runRequested, ofEvent(e), err))
          return
        }
        // the auto-heal reactor: a relay to the composition root, like run_requested
        if (e.kind === EVENT_KIND.commit_recorded) {
          if (opts.onCommitRecorded) {
            const p = CommitRecordedPayload.safeParse(e.payload)
            if (p.success)
              await opts.onCommitRecorded(p.data)
                .catch(err => reactionFailed(REACTION.commitRecorded, ofEvent(e), err))
          }
          return
        }
        // route 2: an approved child with a pending split gets its run started (policy OR human)
        if (e.kind === EVENT_KIND.plan_approved && e.taskId) {
          // each child approval refolds all router-kind history: O(tasks)
          if (pendingSplitForChild(fold(await opts.log.after(0, ROUTER_KINDS)), e.taskId))
            await opts.onChildApproved(e.taskId).catch(err =>
              reactionFailed(REACTION.childApproved, ofEvent(e), err))
          return
        }
        // route 1: a terminal child resolves its split (a redelivery finds it resolved and no-ops)
        if (e.kind !== EVENT_KIND.task_status_changed) return
        const p = PAYLOAD_SCHEMAS.task_status_changed.safeParse(e.payload)
        if (!p.success || !TERMINAL.has(p.data.to) || !e.taskId) return
        // the runtime half of cancel (kernel.cancelSubtree appended the status); idempotent
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
