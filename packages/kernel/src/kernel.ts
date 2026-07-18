import { randomUUID } from 'node:crypto'
import {
  EVENT_KIND, PlanDraft, TASK_STATUS, validatePlan,
  type EventKind, type EventRecord, type Plan, type TaskNode, type TaskStatus,
} from '@orc/contracts'
import { EventLog, type EventLogOps } from './eventlog'
import { fold, type State } from './projections'
import { KERNEL_ERROR_CODE, KernelError } from './errors'

export class Kernel {
  constructor(
    private readonly log: EventLog,
    private readonly refValidator?: (plan: Plan) => Promise<string[]>,
  ) {}

  async createTask(input: { title: string; spec?: string; type?: string; parentId?: string; budgetUSD?: number | null }): Promise<TaskNode> {
    return this.log.transaction(async tx => {
      const parent = input.parentId ? await this.requireTask(tx, input.parentId) : null
      const task: TaskNode = {
        id: randomUUID(),
        parentId: parent?.id ?? null,
        type: input.type ?? 'generic',
        title: input.title,
        spec: input.spec ?? '',
        status: TASK_STATUS.draft,
        zone: [],
        budgetUSD: input.budgetUSD ?? parent?.budgetUSD ?? null,
        depth: parent ? parent.depth + 1 : 0,
        createdAt: new Date().toISOString(),
      }
      await this.append(tx, task.id, EVENT_KIND.task_created, { task })
      return task
    })
  }

  async proposePlan(taskId: string, draft: PlanDraft): Promise<Plan> {
    return this.log.transaction(async tx => {
      const task = await this.requireTask(tx, taskId)
      if (task.status !== TASK_STATUS.draft)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot propose a plan while task is '${task.status}'`)
      return this.appendPlanVersion(tx, taskId, draft, EVENT_KIND.plan_proposed, task.status)
    })
  }

  async editPlan(taskId: string, draft: PlanDraft): Promise<Plan> {
    return this.log.transaction(async tx => {
      const task = await this.requireTask(tx, taskId)
      if (task.status !== TASK_STATUS.awaiting_approval)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot edit a plan while task is '${task.status}'`)
      return this.appendPlanVersion(tx, taskId, draft, EVENT_KIND.plan_edited, task.status)
    })
  }

  async approvePlan(taskId: string, version?: number): Promise<Plan> {
    return this.log.transaction(async tx => {
      const task = await this.requireTask(tx, taskId)
      if (task.status !== TASK_STATUS.awaiting_approval)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot approve while task is '${task.status}'`)
      const latest = (await this.stateOf(tx)).plans.get(taskId)?.versions.at(-1)
      if (!latest) throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, 'no plan to approve')
      const wanted = version ?? latest.version
      if (wanted !== latest.version)
        throw new KernelError(KERNEL_ERROR_CODE.version_conflict, `latest plan is v${latest.version}, not v${wanted}`)
      await this.append(tx, taskId, EVENT_KIND.plan_approved, {
        taskId, version: wanted, approvedAt: new Date().toISOString(), approvedBy: 'human',
      })
      await this.append(tx, taskId, EVENT_KIND.task_status_changed, { taskId, from: task.status, to: TASK_STATUS.approved })
      return latest
    })
  }

  // ponytail: state() refolds the whole log on every call — add snapshots when it measurably slows
  async state(): Promise<State> {
    return this.stateOf(this.log)
  }

  async getTask(id: string): Promise<TaskNode | undefined> {
    return (await this.state()).tasks.get(id)
  }

  async listTasks(): Promise<TaskNode[]> {
    return [...(await this.state()).tasks.values()]
  }

  async getPlan(taskId: string, version?: number): Promise<Plan | undefined> {
    const tp = (await this.state()).plans.get(taskId)
    if (!tp) return undefined
    return version === undefined ? tp.versions.at(-1) : tp.versions.find(p => p.version === version)
  }

  eventsFor(taskId: string): Promise<EventRecord[]> {
    return this.log.byTask(taskId)
  }

  eventsSince(taskId: string, afterSeq: number): Promise<EventRecord[]> {
    return this.log.byTaskSince(taskId, afterSeq)
  }

  subscribe(opts: { fromSeq?: number }, handler: (e: EventRecord) => void | Promise<void>): Promise<() => Promise<void>> {
    return this.log.subscribe(opts, handler)
  }

  private async stateOf(ops: EventLogOps): Promise<State> {
    return fold(await ops.all())
  }

  private async appendPlanVersion(
    tx: EventLogOps,
    taskId: string,
    draft: PlanDraft,
    kind: Extract<EventKind, 'plan_proposed' | 'plan_edited'>,
    from: TaskStatus,
  ): Promise<Plan> {
    const versions = (await this.stateOf(tx)).plans.get(taskId)?.versions ?? []
    const plan: Plan = { ...PlanDraft.parse(draft), taskId, version: versions.length + 1 }
    const check = validatePlan(plan)
    if (!check.ok) throw new KernelError(KERNEL_ERROR_CODE.plan_validation_failed, check.errors.join('; '))
    const refErrors = this.refValidator ? await this.refValidator(plan) : []
    if (refErrors.length > 0)
      throw new KernelError(KERNEL_ERROR_CODE.plan_validation_failed, refErrors.join('; '))
    await this.append(tx, taskId, kind, { plan })
    if (from !== TASK_STATUS.awaiting_approval)
      await this.append(tx, taskId, EVENT_KIND.task_status_changed, { taskId, from, to: TASK_STATUS.awaiting_approval })
    return plan
  }

  private async append(ops: EventLogOps, taskId: string, kind: EventKind, payload: Record<string, unknown>): Promise<void> {
    await ops.append({ taskId, stepId: null, runToken: null, kind, payload })
  }

  private async requireTask(ops: EventLogOps, id: string): Promise<TaskNode> {
    const t = (await this.stateOf(ops)).tasks.get(id)
    if (!t) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${id}'`)
    return t
  }
}
