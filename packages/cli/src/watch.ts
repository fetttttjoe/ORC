// Park-detection/tail behavior for watching a run to its next stopping point — reusable across
// every driving command (`new --strategy grounded-plan`, `run`, `retry`, `reply`, `approve`),
// which is why it lives apart from the command wiring in main.ts.
import { EVENT_KIND, TASK_STATUS, type EventRecord, type RunOutcome, type TaskStatus } from '@orc/contracts'
import { Kernel, subtreeOutcome, subtreeTaskIds } from '@orc/kernel'

// A tail ends one of two ways: the run reaches a terminal outcome, or it PARKS on a human gate and
// cannot move again until someone answers. Parking is not an outcome — the run is alive, durable and
// resumable — so it is its own case rather than a fake outcome. Before this existed, every driver
// (`run`, `retry`, `new --strategy grounded-plan`) waited forever on a result that could not arrive,
// which is indistinguishable at the terminal from a hang.
export type TailResult =
  | { parked: false; outcome: RunOutcome }
  | { parked: true; taskId: string; question: string }

// An open question means the run MIGHT be parked — not that it is. A step retry can be running
// concurrently (the operation journal's stale-attempt fence produces exactly that: attempt 1 asks,
// attempt 2 works on), and returning then tears the runtime down under live work. So the park is
// declared only once the stream goes QUIET: any event for this task cancels the pending decision
// and the tail keeps waiting. A run that is genuinely suspended emits nothing, so it settles fast.
const PARK_QUIET_MS = 750

// The statuses that mean somebody is still expected to move this task: a run is under way, or a
// supervisor is about to start one. Every other status is a stopping point — terminal, blocked
// awaiting a retry, or gated on a human — so a subtree with none of these has stopped.
// Deliberately NOT DRIVABLE_TASK_STATUS: `blocked` is drivable by `orc retry`, but nothing drives
// it unasked, and waiting for it to move would hang until the terminal is closed.
const ACTIVE_TASK_STATUS: ReadonlySet<TaskStatus> =
  new Set([TASK_STATUS.approved, TASK_STATUS.running])

// Observe a run to its next stopping point: stream-driven, no polling — LISTEN/NOTIFY
// pushes each event as it commits. The CLI holds no handle to wait on any more, because the
// supervisor owns the workflow, so "finished" is re-derived from the log instead: nothing anywhere
// in the subtree is still expected to move. Subtree-wide, because a parent inside join_splits
// emits nothing while its children work, and its own terminal status says nothing about theirs.
//
// `since` is the seq of the run_requested this watch belongs to, 0 when the caller asked for no
// run. Without it `orc retry` settles instantly on the very status it is asking to leave: the
// supervisor has not reacted yet, so the tree still looks stopped. Requiring one event later than
// the ask closes that window — while a run that finished before the subscription opened still
// settles at once, since its events are already later than the ask.
export async function watchSubtree(kernel: Kernel, taskId: string, since = 0): Promise<TailResult> {
  const print = (e: EventRecord) => console.log(`${String(e.seq).padStart(4)}  ${e.kind}${e.stepId ? `  ${e.stepId}` : ''}`)
  let lastSeen = Math.max(0, ...(await kernel.eventsFor(taskId)).map(e => e.seq))
  let quiet: ReturnType<typeof setTimeout> | undefined
  // both assigned synchronously by the Promise executor below, before any subscriber can call them
  let confirmPark: () => void = () => {}
  let settle: (result: TailResult) => void = () => {}
  const stopped = new Promise<TailResult>(resolve => {
    settle = resolve
    // openFeedbackInSubtree is the one derivation the reply side resolves against too, so "open"
    // can never mean two things — and re-reading it when the timer fires means an answer that
    // arrived meanwhile wins. Subtree-wide, because a step that joins its splits waits on a child
    // whose question lands on the CHILD's stream: the parent emits nothing while it is blocked.
    confirmPark = () => {
      quiet = setTimeout(() => {
        void kernel.openFeedbackInSubtree(taskId)
          .then(open => { if (open) resolve({ parked: true, taskId: open.taskId, question: open.question }) })
          .catch(() => {})
      }, PARK_QUIET_MS)
    }
  })

  // Which tasks this watch listens to, AND whether any of them still has somebody expected to move
  // it — one fold answers both, so membership and stopped-ness can never disagree about a task that
  // appeared and finished between two events. Seeded at attach and refreshed on every event that
  // can change either: split_proposed (a new child, on the parent's own stream, in the same
  // transaction) and task_status_changed. Events outside the subtree belong to another run.
  let subtree = new Set<string>()
  const refreshSubtree = async (): Promise<void> => {
    const state = await kernel.state()
    subtree = new Set(subtreeTaskIds(state, taskId))
    if (lastSeen <= since) return
    for (const id of subtree)
      if (ACTIVE_TASK_STATUS.has(state.tasks.get(id)?.status ?? TASK_STATUS.draft)) return
    settle({ parked: false, outcome: subtreeOutcome(state, taskId) })
  }

  // The OTHER thing that stops a run, and the only one that announces nothing: `task_split` honours
  // the project's approvalPolicy, so under the default (manual) the child parks at
  // 'awaiting_approval' and the parent's join_splits recv's forever — no event, no output, no
  // outcome. Observed live: three gated splits, then join, then silence.
  //
  // Advisory, NOT a park: a gated child is a stopping point for the tree, so this watch settles
  // rather than hanging on a status only a human can change — and names the command that unblocks
  // it. Triggered by split_proposed, which lands on the PARENT's stream in the same transaction
  // that parks the child, so the status is already final — never by a timer, so a slow model call
  // can never be mistaken for a gate.
  const advised = new Set<string>()
  const adviseGated = async (): Promise<void> => {
    for (const child of await kernel.gatedChildren(taskId)) {
      if (advised.has(child.id)) continue
      advised.add(child.id)
      console.log(`child awaits plan approval: ${child.title}  (orc approve ${child.id})`)
    }
  }

  await refreshSubtree()
  const unsub = await kernel.subscribe({ fromSeq: lastSeen }, e => {
    if (e.taskId === null || !subtree.has(e.taskId)) return
    // only the tailed task's events are printed and tracked — lastSeen drives the final drain
    if (e.taskId === taskId) { print(e); lastSeen = e.seq }
    clearTimeout(quiet) // the tree is still moving: whatever we were about to conclude is stale
    if (e.kind === EVENT_KIND.feedback_requested) confirmPark()
    if (e.kind === EVENT_KIND.split_proposed) void refreshSubtree().then(adviseGated).catch(() => {})
    else if (e.kind === EVENT_KIND.task_status_changed) void refreshSubtree().catch(() => {})
  })
  try {
    // already at a gate when we attached — same quiet rule, so attaching to a busy run cannot
    // mistake an older unanswered question for a stopped one
    if (await kernel.openFeedbackInSubtree(taskId)) confirmPark()
    await adviseGated() // attaching to a tree that is already gated says so at once
    return await stopped
  } finally {
    clearTimeout(quiet)
    await unsub()
    for (const e of await kernel.eventsSince(taskId, lastSeen)) print(e) // drain final window
  }
}
