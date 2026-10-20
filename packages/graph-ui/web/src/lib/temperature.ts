import { TASK_STATUS } from '@orc/contracts/task'
import { StepRunStatus } from '@orc/contracts/execution'

// Amber waits on a HUMAN, steel is machine work, moss settled well, rust settled badly
export type Temperature = 'human' | 'machine' | 'moss' | 'rust' | 'neutral'

export const TEMP_TEXT: Record<Temperature, string> = {
  human: 'text-human',
  machine: 'text-machine',
  moss: 'text-moss',
  rust: 'text-rust',
  neutral: 'text-mist',
}

export const TEMP_BORDER: Record<Temperature, string> = {
  human: 'border-l-human',
  machine: 'border-l-machine',
  moss: 'border-l-moss',
  rust: 'border-l-rust',
  neutral: 'border-l-transparent',
}

export const TEMP_DOT: Record<Temperature, string> = {
  human: 'bg-human',
  machine: 'bg-machine',
  moss: 'bg-moss',
  rust: 'bg-rust',
  neutral: 'bg-fog',
}

/** a task/step lifecycle status → its temperature */
export const statusTemperature = (status: string): Temperature => {
  switch (status) {
    case TASK_STATUS.running:
    case TASK_STATUS.approved:
      return 'machine'
    case TASK_STATUS.awaiting_approval:
      return 'human'
    case TASK_STATUS.done:
    // a step reports `completed` where a task reports `done`: else a finished step rendered grey
    case StepRunStatus.completed:
      return 'moss'
    case TASK_STATUS.blocked:
    case TASK_STATUS.failed:
      return 'rust'
    default:
      return 'neutral'
  }
}
