import { foldTranscript } from '../transcript'
import { VIEW } from '../wire'
import { defineView } from './view'

// A task's agent conversation — messages, tool calls, questions, the signal that ended a step.
export const transcript = defineView({
  name: VIEW.transcript,
  push: false,

  // never null: a task that has not spoken has an empty conversation, not a missing subject
  read: (model, { taskId, stepId }) => foldTranscript(model.events, taskId, stepId),

  // every task event: this view is built from the agent-loop kinds the others exclude
  touches: event => (event.taskId === null ? [] : [{ taskId: event.taskId }]),
})
