import { randomUUID } from 'node:crypto'
import {
  EVENT_KIND, PlanDraft, TASK_STATUS, validatePlan,
  type EventKind, type EventRecord, type Plan, type TaskNode, type TaskStatus,
} from '@orc/contracts'
import { EventLog } from './eventlog'
import { fold, type State } from './projections'
import { KERNEL_ERROR_CODE, KernelError } from './errors'

export class Kernel {
  constructor(private readonly log: EventLog) {}

  createTask(input: { title: string; spec?: string; type?: string; parentId?: string }): TaskNode {
    return this.log.transaction(() => {
      const parent = input.parentId ? this.requireTask(input.parentId) : null
      const task: TaskNode = {
        id: randomUUID(),
        parentId: parent?.id ?? null,
        type: input.type ?? 'generic',
        title: input.title,
        spec: input.spec ?? '',
        status: TASK_STATUS.draft,
        zone: [],
        budgetUSD: parent?.budgetUSD ?? null,
        depth: parent ? parent.depth + 1 : 0,
        createdAt: new Date().toISOString(),
      }
      this.append(task.id, EVENT_KIND.task_created, { task })
      return task
    })
  }

  proposePlan(taskId: string, draft: PlanDraft): Plan {
    return this.log.transaction(() => {
      const task = this.requireTask(taskId)
      if (task.status !== TASK_STATUS.draft)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot propose a plan while task is '${task.status}'`)
      return this.appendPlanVersion(taskId, draft, EVENT_KIND.plan_proposed, task.status)
    })
  }

  editPlan(taskId: string, draft: PlanDraft): Plan {
    return this.log.transaction(() => {
      const task = this.requireTask(taskId)
      if (task.status !== TASK_STATUS.awaiting_approval)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot edit a plan while task is '${task.status}'`)
      return this.appendPlanVersion(taskId, draft, EVENT_KIND.plan_edited, task.status)
    })
  }

  approvePlan(taskId: string, version?: number): Plan {
    return this.log.transaction(() => {
      const task = this.requireTask(taskId)
      if (task.status !== TASK_STATUS.awaiting_approval)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot approve while task is '${task.status}'`)
      const latest = this.state().plans.get(taskId)?.versions.at(-1)
      if (!latest) throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, 'no plan to approve')
      const wanted = version ?? latest.version
      if (wanted !== latest.version)
        throw new KernelError(KERNEL_ERROR_CODE.version_conflict, `latest plan is v${latest.version}, not v${wanted}`)
      this.append(taskId, EVENT_KIND.plan_approved, {
        taskId, version: wanted, approvedAt: new Date().toISOString(),
      })
      this.append(taskId, EVENT_KIND.task_status_changed, { taskId, from: task.status, to: TASK_STATUS.approved })
      return latest
    })
  }

  // ponytail: state() refolds the whole log on every call — add snapshots when it measurably slows
  state(): State {
    return fold(this.log.all())
  }

  getTask(id: string): TaskNode | undefined {
    return this.state().tasks.get(id)
  }

  listTasks(): TaskNode[] {
    return [...this.state().tasks.values()]
  }

  getPlan(taskId: string, version?: number): Plan | undefined {
    const tp = this.state().plans.get(taskId)
    if (!tp) return undefined
    return version === undefined ? tp.versions.at(-1) : tp.versions.find(p => p.version === version)
  }

  eventsFor(taskId: string): EventRecord[] {
    return this.log.byTask(taskId)
  }

  private appendPlanVersion(
    taskId: string,
    draft: PlanDraft,
    kind: Extract<EventKind, 'plan_proposed' | 'plan_edited'>,
    from: TaskStatus,
  ): Plan {
    const versions = this.state().plans.get(taskId)?.versions ?? []
    const plan: Plan = { ...PlanDraft.parse(draft), taskId, version: versions.length + 1 }
    const check = validatePlan(plan)
    if (!check.ok) throw new KernelError(KERNEL_ERROR_CODE.plan_validation_failed, check.errors.join('; '))
    this.append(taskId, kind, { plan })
    if (from !== TASK_STATUS.awaiting_approval)
      this.append(taskId, EVENT_KIND.task_status_changed, { taskId, from, to: TASK_STATUS.awaiting_approval })
    return plan
  }

  private append(taskId: string, kind: EventKind, payload: Record<string, unknown>): void {
    this.log.append({ taskId, stepId: null, runToken: null, kind, payload })
  }

  private requireTask(id: string): TaskNode {
    const t = this.state().tasks.get(id)
    if (!t) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${id}'`)
    return t
  }
}
