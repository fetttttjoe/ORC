/**
 * The step/wave status vocabulary every plan surface reads — the rail, the graph, and whatever is
 * added next. Zero imports, one spelling.
 *
 * It exists because the rail and the graph each had their own copy of "a wave is done when every
 * step is": two answers to one question, drifting the moment either gained a state. A step reports
 * `completed` where a task reports `done`, which is exactly the kind of detail that gets
 * half-remembered at the second call site.
 */
export const STEP_STATUS = {
  running: 'running',
  failed: 'failed',
  completed: 'completed',
  /** what a TASK calls a finished step; both spellings reach these surfaces */
  done: 'done',
  pending: 'pending',
} as const

export type WaveState = 'completed' | 'running' | 'failed' | 'pending'

export const isFinished = (status: string): boolean =>
  status === STEP_STATUS.completed || status === STEP_STATUS.done

/**
 * A wave is completed only when EVERY step is; running as soon as any has started; failed if any
 * failed and none are still going. Order matters: a wave with one failure and one still running is
 * running, because the operator can still act on it — reporting it failed would say it is over.
 * An empty wave is pending, never completed — "all of nothing" must not read as success.
 */
export function waveState(statuses: readonly string[]): WaveState {
  if (statuses.length === 0) return 'pending'
  if (statuses.every(isFinished)) return 'completed'
  if (statuses.some(s => s === STEP_STATUS.running)) return 'running'
  if (statuses.some(s => s === STEP_STATUS.failed)) return 'failed'
  return 'pending'
}

/** how far a run has got, 0–1 — the number the progress rail and the ring both render */
export const completedFraction = (statuses: readonly string[]): number =>
  statuses.length === 0 ? 0 : statuses.filter(isFinished).length / statuses.length
