import type { OperatorState, OpenQuestion } from '@orc/ui-core/wire'

const EMPTY_STATE: OperatorState = { openQuestions: [], retryable: [], planned: [] }

/**
 * Everything waiting on a human, as the server last pushed it on the stream frame. sse.ts is the
 * ONLY writer — it holds the last non-null `operator` value a frame carried (a frame rides it on
 * the catch-up frame or on an id-less sync frame, never on every frame — see sse.ts) and assigns it
 * here. Nowhere else derives this from events: a second fold of the log would be a second spelling
 * of what the server's `operatorStateView` already decided, and the two could disagree about which
 * questions are still open.
 */
class OperatorStore {
  state = $state<OperatorState>(EMPTY_STATE)

  /** the open questions on ONE task — a task can be parked on two topics at once (see feedbackKey) */
  questionsFor(taskId: string): OpenQuestion[] {
    return this.state.openQuestions.filter(q => q.taskId === taskId)
  }

  /** Project switch/resync: called beside `ledger.reset` — until the new stream's first frame
   * lands, holding the PREVIOUS project's gates/waiting-tile/retry rows is a wrong answer, not a
   * missing one. */
  reset(): void {
    this.state = EMPTY_STATE
  }
}

export const operator = new OperatorStore()
