// Status→visual mapping for graph nodes — pure, DOM-free, pinned by status-style.test.ts.
// Node color encodes TYPE at rest; live lifecycle states override it so the graph shows what
// is going on. Colors come from the ONE palette; statuses from the contracts enums — no
// scattered literals (the EDGE_DIRECTION convention).
import { STEP_RUN_STATUS, TASK_STATUS } from '@orc/contracts'
// palette via its own subpath — the ui-core ROOT index re-exports the server world
// (sessions → kernel → pg/DBOS) and must never enter the browser bundle
import { PALETTE } from '@orc/ui-core/palette'
import type { GraphNode } from '@orc/ui-core/graph'

export const TYPE_COLORS: Record<GraphNode['type'], string> = {
  task: PALETTE.task, step: PALETTE.step, artifact: PALETTE.artifact, note: PALETTE.note, model: PALETTE.model,
}

const STATUS_COLORS: Record<string, string> = {
  [TASK_STATUS.running]: PALETTE.running,
  [TASK_STATUS.failed]: PALETTE.danger,
  [TASK_STATUS.blocked]: PALETTE.danger,
  [TASK_STATUS.cancelled]: PALETTE.cancelled,
}

// only task/step carry a lifecycle in `detail`; note detail is its kind, artifact its size
export const colorFor = (type: GraphNode['type'], detail: string): string =>
  ((type === 'task' || type === 'step') ? STATUS_COLORS[detail] : undefined) ?? TYPE_COLORS[type]

export const isActive = (type: GraphNode['type'], detail: string): boolean =>
  (type === 'task' || type === 'step') && detail === STEP_RUN_STATUS.running

// A plan's state, rolled up from its steps, so the chat card says done/failed/running WITHOUT the
// reader opening the request. A one-step plan renders no diagram (nothing to lay out), so its only
// state signal used to be one chip's text colour — invisible at a glance, which is the bug this
// exists to fix. Failure dominates a mixed plan: one failed step is the thing a reader must see,
// even when every other step finished.
export type PlanState = 'done' | 'failed' | 'running' | 'pending'
export const planState = (waves: ReadonlyArray<{ steps: ReadonlyArray<{ status: string }> }>): PlanState => {
  const steps = waves.flatMap(w => [...w.steps])
  if (steps.some(s => s.status === STEP_RUN_STATUS.failed)) return 'failed'
  if (steps.some(s => s.status === STEP_RUN_STATUS.running)) return 'running'
  // an empty plan has finished nothing — `every` on [] is true, which would read as done
  return steps.length > 0 && steps.every(s => s.status === STEP_RUN_STATUS.completed) ? 'done' : 'pending'
}
