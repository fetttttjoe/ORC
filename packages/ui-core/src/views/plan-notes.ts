import { EVENT_KIND, PAYLOAD_SCHEMAS, type EventRecord } from '@orc/contracts'
import { foldPlanNotes, planScope } from '@orc/kernel'
import { VIEW } from '../wire'
import type { ReadModel } from './view'
import { taskAndParent } from './task-touch'
import { defineView } from './view'

// memory_written/memory_deleted carry the project-scoped envelope (taskId: null — store.ts
// appends them project-scoped, never task-scoped: see store.test.ts's "null taskId" pin), so the
// task a note's write/delete stales cannot come from the event's own envelope. It has to be found
// by matching the note's own scope against every live task's planScope, the same map foldPlanNotes
// filters reads on. planScope is lossy (contracts/plan.ts lowercases and replaces), so this walks
// forward over the fold's tasks rather than trying to invert the hash back to a taskId.
const noteScopeOf = (event: EventRecord): string | null => {
  if (event.kind === EVENT_KIND.memory_written) {
    const p = PAYLOAD_SCHEMAS.memory_written.safeParse(event.payload)
    return p.success ? p.data.note.scope : null
  }
  if (event.kind === EVENT_KIND.memory_deleted) {
    const p = PAYLOAD_SCHEMAS.memory_deleted.safeParse(event.payload)
    return p.success ? p.data.scope : null
  }
  return null
}

const tasksInScope = (model: ReadModel, scope: string): string[] =>
  [...model.state.tasks.keys()].filter(taskId => planScope(taskId) === scope)

// The grounded decomposition: the plan-note graph living in the task's plan memory scope. The
// notes carry their own decomposes_into/depends_on links, so a client draws the graph from these.
export const planNotes = defineView({
  name: VIEW.planNotes,
  push: false,

  // Folded from the LOG, not from the note read model, so a settled task's decomposition stays
  // readable after its notes are retired. Never null: a task that was never decomposed has no
  // notes, which is an empty graph rather than a missing one.
  read: (model, { taskId }) => ({ notes: foldPlanNotes(model.events, planScope(taskId)) }),

  touches: (event, model) => {
    const scope = noteScopeOf(event)
    return [
      ...taskAndParent(event, model),
      ...(scope === null ? [] : tasksInScope(model, scope)),
    ].map(taskId => ({ taskId }))
  },
})
