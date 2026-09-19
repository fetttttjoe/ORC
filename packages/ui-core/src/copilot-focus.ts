// Derive the copilot's focus from folded state on every exchange: a stored copy of the selection
// could describe a different task or workspace than the pane the user is reading.
import type { TaskStatus } from '@orc/contracts'
import type { State } from '@orc/kernel'
import { ScopeType } from '@orc/contracts/scope'

/** id carried too: the copilot's tools all take a taskId, so a listed task must be callable. */
export interface FocusTask { id: string; title: string; status: TaskStatus }

export type CopilotFocus =
  | { type: ScopeType.task; title: string; spec: string; status: TaskStatus; subtasks: FocusTask[] }
  | { type: ScopeType.workspace; title: string; tasks: FocusTask[] }

const ref = (t: { id: string; title: string; status: TaskStatus }): FocusTask =>
  ({ id: t.id, title: t.title, status: t.status })

export function copilotFocus(
  state: State,
  sel: { taskId: string | null; workspaceId: string | null },
): CopilotFocus | null {
  // A task selection is authoritative, including when it names nothing the fold holds: falling
  // back to the workspace would describe a different thing than the pane the user is reading.
  if (sel.taskId !== null) {
    const task = state.tasks.get(sel.taskId)
    if (task === undefined) return null
    const subtasks = [...state.tasks.values()].filter(t => t.parentId === task.id).map(ref)
    return { type: ScopeType.task, title: task.title, spec: task.spec, status: task.status, subtasks }
  }
  if (sel.workspaceId !== null) {
    const ws = state.workspaces.get(sel.workspaceId)
    if (ws === undefined) return null
    // ROOT tasks only: a checkout's subtasks belong to the request that decomposed into them, and
    // listing them flat makes a decomposition read as a pile of unrelated requests.
    const tasks = [...state.tasks.values()].filter(t => t.workspaceId === ws.id && t.parentId === null).map(ref)
    return { type: ScopeType.workspace, title: ws.title, tasks }
  }
  return null
}
