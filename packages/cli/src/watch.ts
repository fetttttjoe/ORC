// park detection and tailing, shared by every driving command
import { EVENT_KIND, TASK_STATUS, type EventRecord, type RunOutcome, type TaskStatus } from '@orc/contracts'
import { Kernel, subtreeOutcome, subtreeTaskIds } from '@orc/kernel'

// parking is not an outcome: the run is alive and resumable, so it is its own case
export type TailResult =
  | { parked: false; outcome: RunOutcome }
  | { parked: true; taskId: string; question: string }

// an open question only means MIGHT be parked: a retry may work concurrently, so wait for quiet
const PARK_QUIET_MS = 750

// not DRIVABLE_TASK_STATUS: `blocked` is drivable by retry, but nothing drives it unasked
const ACTIVE_TASK_STATUS: ReadonlySet<TaskStatus> =
  new Set([TASK_STATUS.approved, TASK_STATUS.running])

// stream-driven, no polling: finished is re-derived from the log over the whole subtree
export async function watchSubtree(kernel: Kernel, taskId: string, since = 0): Promise<TailResult> {
  const print = (e: EventRecord) => console.log(`${String(e.seq).padStart(4)}  ${e.kind}${e.stepId ? `  ${e.stepId}` : ''}`)
  let lastSeen = Math.max(0, ...(await kernel.eventsFor(taskId)).map(e => e.seq))
  let quiet: ReturnType<typeof setTimeout> | undefined
  // both assigned synchronously by the Promise executor below, before any subscriber can call them
  let confirmPark: () => void = () => {}
  let settle: (result: TailResult) => void = () => {}
  const stopped = new Promise<TailResult>(resolve => {
    settle = resolve
    // openFeedbackInSubtree is shared with the reply side, so 'open' means one thing; reread at fire
    confirmPark = () => {
      quiet = setTimeout(() => {
        void kernel.openFeedbackInSubtree(taskId)
          .then(open => { if (open) resolve({ parked: true, taskId: open.taskId, question: open.question }) })
          .catch(() => {})
      }, PARK_QUIET_MS)
    }
  })

  // one fold answers membership and stopped-ness, so they cannot disagree about a fast child
  let subtree = new Set<string>()
  const refreshSubtree = async (): Promise<void> => {
    const state = await kernel.state()
    subtree = new Set(subtreeTaskIds(state, taskId))
    if (lastSeen <= since) return
    for (const id of subtree)
      if (ACTIVE_TASK_STATUS.has(state.tasks.get(id)?.status ?? TASK_STATUS.draft)) return
    settle({ parked: false, outcome: subtreeOutcome(state, taskId) })
  }

  // advisory, not a park: a gated child is a stopping point; trigger on split_proposed, never a timer
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
    // already at a gate when we attached: same quiet rule, so an older question reads as parked
    if (await kernel.openFeedbackInSubtree(taskId)) confirmPark()
    await adviseGated() // attaching to a tree that is already gated says so at once
    return await stopped
  } finally {
    clearTimeout(quiet)
    await unsub()
    for (const e of await kernel.eventsSince(taskId, lastSeen)) print(e) // drain final window
  }
}
