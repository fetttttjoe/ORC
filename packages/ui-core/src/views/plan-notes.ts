import { planNotesOf } from '@orc/kernel'
import { VIEW } from '../wire'
import { taskAndParent } from './task-touch'
import { defineView } from './view'

// The grounded decomposition: the task's plan notes, the masterplan naming its subplans.
export const planNotes = defineView({
  name: VIEW.planNotes,
  push: false,

  // never null: a task never decomposed has an empty graph, not a missing one
  read: (model, { taskId }) => ({ notes: planNotesOf(model.events, taskId) }),

  touches: (event, model) => taskAndParent(event, model).map(taskId => ({ taskId })),
})
