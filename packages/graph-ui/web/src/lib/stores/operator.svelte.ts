import type { OperatorState, OpenQuestion } from '@orc/ui-core/wire'

const EMPTY_STATE: OperatorState = { openQuestions: [], retryable: [], planned: [] }

// Everything waiting on a human, as the server last pushed it; sse.ts is the ONLY writer
class OperatorStore {
  state = $state<OperatorState>(EMPTY_STATE)

  /** the open questions on ONE task: it can be parked on two topics at once */
  questionsFor(taskId: string): OpenQuestion[] {
    return this.state.openQuestions.filter(q => q.taskId === taskId)
  }

  // Called beside ledger.reset: the previous project's gates are a wrong answer, not a missing one
  reset(): void {
    this.state = EMPTY_STATE
  }
}

export const operator = new OperatorStore()
