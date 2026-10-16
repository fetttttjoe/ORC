import { planNotesOf } from '@orc/kernel'
import { VIEW } from '../wire'
import { taskAndParent } from './task-touch'
import { defineView } from './view'

// The grounded decomposition: the task's plan notes, the masterplan naming its subplans.
export const planNotes = defineView({
  name: VIEW.planNotes,
  push: false,

  // Never null: a task that was never decomposed has no notes, which is an empty graph rather than
  // a missing one.
  read: (model, { taskId }) => ({ notes: planNotesOf(model.events, taskId) }),

  touches: (event, model) => taskAndParent(event, model).map(taskId => ({ taskId })),
})
