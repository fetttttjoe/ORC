import { ScopeType, taskOf, workspaceOf, type EventRecord, type Scope, type ScopeIndex } from '@orc/contracts'
import type { ReadModel } from './view'

// bridges the read model and the pure scope rule: both views read through it

export function scopeIndexOf(model: ReadModel): ScopeIndex {
  const tasks = model.state.tasks
  return {
    workspaceOfTask: (taskId) => tasks.get(taskId)?.workspaceId ?? null,
    // bounded by task count: parentage is payload, so a parentId cycle must not spin
    inSubtree: (taskId, rootId) => {
      let current: string | undefined = taskId
      for (let hops = 0; current !== undefined && hops <= tasks.size; hops++) {
        if (current === rootId) return true
        current = tasks.get(current)?.parentId ?? undefined
      }
      return false
    },
  }
}

// only the event's own project, workspace, task and chat: another chat would sync every pane
export function scopePatternsOf(event: EventRecord, model: ReadModel): Array<{ scope: Scope }> {
  const index = scopeIndexOf(model)
  const workspaceId = workspaceOf(event, index)
  const taskId = taskOf(event)
  const patterns: Array<{ scope: Scope }> = [{ scope: { type: ScopeType.project } }]
  if (workspaceId !== null) patterns.push({ scope: { type: ScopeType.workspace, id: workspaceId } })
  if (taskId !== null) patterns.push({ scope: { type: ScopeType.task, id: taskId, subtree: false } })
  if (event.chatId !== null) patterns.push({ scope: { type: ScopeType.chat, id: event.chatId } })
  return patterns
}
