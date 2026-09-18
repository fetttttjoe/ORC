import { TERMINAL_TASK_STATUS } from '@orc/contracts/task'
import { canRetry } from '@orc/kernel'
import { openQuestions } from '../open-questions'
import { VIEW } from '../wire'
import { defineView } from './view'

// Everything waiting on a human, in one value. Pushed rather than fetched: it is small, it changes
// on almost every append, and the alternative — a touch the client answers with a refetch — is a
// round trip per event for a value that already travels beside the frame.
//
// Composed from two sources, and the split is the point. Open questions need the EVENT STREAM: the
// wording, step and seq of an ask live nowhere else. Retryability and plannedness are facts the
// projection already holds, so they are read from it — a second derivation over the same events
// would be a rule that can disagree with the door that has to serve what this offers.
export const operatorStateView = defineView({
  name: VIEW.operatorState,
  push: true,

  read: model => ({
    // Terminality is the projection's fact too, injected rather than re-read from status events.
    openQuestions: openQuestions(model.events, id => {
      const task = model.state.tasks.get(id)
      return task !== undefined && TERMINAL_TASK_STATUS.has(task.status)
    }),
    // The kernel's own admission rule, so an offered retry is one both `assertRetryable` and
    // port.retry will accept. Nothing here re-states what retryable means.
    retryable: [...model.state.tasks.keys()].filter(id => canRetry(model.state, id)),
    // Holding a plan IS having one worth showing: the projection writes a task into `plans` exactly
    // when a proposal or edit of its plan parsed, which is the same condition under which there is
    // something to render.
    planned: [...model.state.plans.keys()],
  }),

  // A pushed view is never refetched, so it stales nothing: the frame carries its value.
  touches: () => [],
})
