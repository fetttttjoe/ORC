// The status vocabulary every plan surface reads; a step says `completed` where a task says `done`
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

// A wave is completed only when EVERY step is; running over failed; an empty wave is pending
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
