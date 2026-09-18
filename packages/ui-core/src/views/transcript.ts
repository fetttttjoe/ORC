import { foldTranscript } from '../transcript'
import { VIEW } from '../wire'
import { defineView } from './view'

// A task's agent conversation — messages, tool calls, questions, the signal that ended a step.
export const transcript = defineView({
  name: VIEW.transcript,
  push: false,

  // Never null: a task that has not spoken yet has an EMPTY conversation, which is a thing the
  // pane renders, not a missing subject.
  read: (model, { taskId, stepId }) => foldTranscript(model.events, taskId, stepId),

  // Every event a task emits, not only the state changes the other task-keyed views filter on:
  // this view is BUILT from the agent-loop kinds those exclude, so a transcript refreshing on
  // state changes alone would sit still for the whole of a step's actual work.
  touches: event => (event.taskId === null ? [] : [{ taskId: event.taskId }]),
})
