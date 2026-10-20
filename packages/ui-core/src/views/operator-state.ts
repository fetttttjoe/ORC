import { TERMINAL_TASK_STATUS } from '@orc/contracts/task'
import { canRetry } from '@orc/kernel'
import { openQuestions } from '../open-questions'
import { VIEW } from '../wire'
import { defineView } from './view'

// pushed, not fetched: small, changes per append; questions come from the stream
export const operatorStateView = defineView({
  name: VIEW.operatorState,
  push: true,

  read: model => ({
    // Terminality is the projection's fact too, injected rather than re-read from status events.
    openQuestions: openQuestions(model.events, id => {
      const task = model.state.tasks.get(id)
      return task !== undefined && TERMINAL_TASK_STATUS.has(task.status)
    }),
    // the kernel's own admission rule: an offered retry is one assertRetryable and port.retry accept
    retryable: [...model.state.tasks.keys()].filter(id => canRetry(model.state, id)),
    // a task is in plans exactly when a proposal or edit parsed: the condition for something to render
    planned: [...model.state.plans.keys()],
  }),

  // A pushed view is never refetched, so it stales nothing: the frame carries its value.
  touches: () => [],
})
