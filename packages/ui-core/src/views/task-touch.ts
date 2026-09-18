import type { EventRecord } from '@orc/contracts'
import { STATE_CHANGE } from '../event-classes'
import type { ReadModel } from './view'

// The tasks one event leaves stale, shared by every task-keyed view because they go stale
// together. Two rules, both measured:
//
// - agent-loop noise names no task here — EXCEPT `agent_call`, which moves usage/stepUsage/
//   iterations that `node`'s read returns (`node.ts`'s own `touches` adds its task/step/model ids
//   directly, since `plans`/`planNotes`/`transcript` never read those fields and widening this
//   SHARED set would put every task-keyed view on the loop's cadence for no reason). Measured:
//   `node.read`'s task branch depends on exactly those three fields, so excluding the kind here
//   was never what kept it fresh — the browser's 250ms trailing coalescer (view-client.ts) is what
//   bounds the refetch rate `agent_call` drives, the same bargain `transcript` already makes by
//   touching on every task event.
// - a CHILD's change stales its PARENT: the parent's rendered plan carries its children's step
//   states, so emitting only the child left a live run's statuses, iteration count and spend frozen
//   at the value they had when the panel mounted — nothing threw, the numbers just stopped moving.
//
// Parentage is read from the fold, never from the id string.
export function taskAndParent(event: EventRecord, model: ReadModel): string[] {
  if (event.taskId === null || !STATE_CHANGE.has(event.kind)) return []
  const parentId = model.state.tasks.get(event.taskId)?.parentId
  return parentId ? [event.taskId, parentId] : [event.taskId]
}
