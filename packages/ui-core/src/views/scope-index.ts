import { ScopeType, taskOf, workspaceOf, type EventRecord, type Scope, type ScopeIndex } from '@orc/contracts'
import type { ReadModel } from './view'

// The bridge between the read model and the pure scope rule: the task tree as the two questions
// inScope asks of it, and the scopes one appended event leaves stale. Both views read through here,
// so a timeline row and a chat digest can never disagree about what a scope contains.

export function scopeIndexOf(model: ReadModel): ScopeIndex {
  const tasks = model.state.tasks
  return {
    workspaceOfTask: (taskId) => tasks.get(taskId)?.workspaceId ?? null,
    // Bounded by the task count: a parentId cycle would otherwise spin forever inside a view read,
    // and the fold cannot promise acyclicity (parentage arrives as payload).
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

/**
 * The scope queries one event stales: the whole project, plus the workspace, task and chat it
 * belongs to. A held query is refetched when the pattern matches it, so naming ANOTHER chat here
 * would put every chat pane on every other chat's cadence.
 *
 * A subtree query over an ancestor is NOT matched — no consumer issues one yet; when one does, walk
 * the ancestors here rather than widening the pattern to a bare `{}`.
 */
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
