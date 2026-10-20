import type { EventRecord } from '@orc/contracts'
import { STATE_CHANGE } from '../event-classes'
import type { ReadModel } from './view'

// a child's change stales its parent; agent_call is excluded (node.ts adds its own ids)
export function taskAndParent(event: EventRecord, model: ReadModel): string[] {
  if (event.taskId === null || !STATE_CHANGE.has(event.kind)) return []
  const parentId = model.state.tasks.get(event.taskId)?.parentId
  return parentId ? [event.taskId, parentId] : [event.taskId]
}
