import { EVENT_KIND } from '@orc/contracts'
import type { EventRecord, Plan, TaskNode, TaskStatus } from '@orc/contracts'

export interface TaskPlans {
  versions: Plan[]
  approvedVersion: number | null
}

export interface State {
  tasks: Map<string, TaskNode>
  plans: Map<string, TaskPlans>
}

export function fold(events: EventRecord[]): State {
  const state: State = { tasks: new Map(), plans: new Map() }
  for (const e of events) {
    switch (e.kind) {
      case EVENT_KIND.task_created: {
        const { task } = e.payload as { task: TaskNode }
        state.tasks.set(task.id, task)
        break
      }
      case EVENT_KIND.plan_proposed:
      case EVENT_KIND.plan_edited: {
        const { plan } = e.payload as { plan: Plan }
        const tp = state.plans.get(plan.taskId) ?? { versions: [], approvedVersion: null }
        tp.versions.push(plan)
        state.plans.set(plan.taskId, tp)
        break
      }
      case EVENT_KIND.plan_approved: {
        const p = e.payload as { taskId: string; version: number }
        const tp = state.plans.get(p.taskId)
        if (tp) tp.approvedVersion = p.version
        break
      }
      case EVENT_KIND.task_status_changed: {
        const p = e.payload as { taskId: string; to: TaskStatus }
        const t = state.tasks.get(p.taskId)
        if (t) state.tasks.set(p.taskId, { ...t, status: p.to })
        break
      }
      default: {
        const unhandled: never = e.kind
        void unhandled
        break
      }
    }
  }
  return state
}
