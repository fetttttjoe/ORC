import { randomUUID } from 'node:crypto'
import {
  ChildPlanDraft, EVENT_KIND, FeedbackProvidedPayload, ISOLATION_TIER, PlanAnnotatedPayload, PlanDraft, STRATEGY, TASK_STATUS, evaluateApproval, validatePlan,
  type Analyzer, type ApprovalPolicy, type EventKind, type EventRecord, type FeedbackRequestedPayload,
  type Plan, type PlanStep, type TaskNode, type TaskStatus,
} from '@orc/contracts'
import { planScope } from './execution/strategies/grounded-plan'
import { EventLog, type EventLogOps } from './storage'
import { fold, subtreeUsage, type State } from './projections'
import { KERNEL_ERROR_CODE, KernelError } from './errors'

export class Kernel {
  constructor(
    private readonly log: EventLog,
    private readonly refValidator?: (plan: Plan) => Promise<string[]>,
    // analyzers seed the grounded-plan template's analyze step (D2); optional so non-grounded
    // kernels (most tests, read-only CLI) construct without a plugin host.
    private readonly analyzers?: Map<string, Analyzer>,
    // resumes a parked feedback gate (D4 conversational gate): DBOS.recv(`feedback:<topic>`, 60)
    // runs inside the step workflow whose id IS the destination; the kernel stays DBOS-agnostic
    // (unit-testable with a fake) and the real port-backed sender is wired at CLI runtime
    // construction. Optional so most tests / read-only CLI contexts construct without it —
    // replyFeedback still appends feedback_provided and returns the topic when it's absent.
    private readonly send?: (workflowId: string, message: string, topic: string) => Promise<void>,
  ) {}

  // The grounded-plan bootstrap (M5b): an auto-approved [analyze, plan] template. The analyze
  // step is the resolved Analyzer's scout step; the plan step is an auditor api-loop step that
  // authors a plan-note graph and calls finalize_plan. Policy-approved because the human's real
  // gate is the conversational approve inside the plan step, not this scaffold.
  async createGroundedTask(input: { title: string; spec: string; modelRef: string; analyzerRef: string; budgetUSD?: number | null }): Promise<TaskNode> {
    const analyzer = this.analyzers?.get(input.analyzerRef)
    if (!analyzer)
      throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `unknown analyzer '${input.analyzerRef}' — register it or pass a valid analyzerRef`)
    const task = await this.createTask({ title: input.title, spec: input.spec, type: 'grounded', budgetUSD: input.budgetUSD })
    const analyzeStep = analyzer.analysisStep({ modelRef: input.modelRef, taskSpec: input.spec })
    const planStep: PlanStep = {
      id: 'plan', role: 'auditor', title: 'Author the executable plan',
      // the concrete scope + root id, so the authoring agent (which never sees its taskId) and
      // finalize_plan agree on where the plan-note graph lives.
      instructions: `Author the plan-note graph in memory scope '${planScope(task.id)}' with root note id 'masterplan', iterate with the human via ask_human, then call finalize_plan. Follow the plan-authoring skill.`,
      executorRef: 'api-loop', modelRef: input.modelRef, skillRefs: ['plan-authoring'], toolRefs: [],
      isolation: ISOLATION_TIER.local, zone: [], maxIterations: 30, dependsOn: [analyzeStep.id],
    }
    const draft: PlanDraft = {
      strategyRef: STRATEGY.groundedPlan, analyzerRef: input.analyzerRef, costEstimateUSD: null,
      steps: [analyzeStep, planStep],
    }
    const plan = await this.proposePlan(task.id, draft)
    await this.approvePlan(task.id, plan.version, { approvedBy: 'policy' })
    return task
  }

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

  async approvePlan(
    taskId: string,
    version?: number,
    approval?: { approvedBy: 'human' | 'policy'; ruleIndex?: number },
  ): Promise<Plan> {
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
        taskId, version: wanted, approvedAt: new Date().toISOString(),
        approvedBy: approval?.approvedBy ?? 'human',
        ...(approval?.ruleIndex !== undefined && { ruleIndex: approval.ruleIndex }),
      })
      await this.append(tx, taskId, EVENT_KIND.task_status_changed, { taskId, from: task.status, to: TASK_STATUS.approved })
      return latest
    })
  }

  async proposeSplit(input: {
    parentTaskId: string; stepId: string; runToken: string; toolCallId: string
    title: string; spec: string; plan: ChildPlanDraft; budgetUSD?: number
    parentStep: Pick<PlanStep, 'executorRef' | 'modelRef' | 'maxIterations'>
    policy: ApprovalPolicy; maxDepth: number
  }): Promise<{ splitId: string; childTaskId: string; gated: boolean }> {
    const splitId = `split:${input.runToken}:${input.toolCallId}`
    const childTaskId = `${input.parentTaskId}.${input.stepId}.${input.toolCallId}`
    return this.log.transaction(async tx => {
      const state = await this.stateOf(tx)
      const parent = state.tasks.get(input.parentTaskId)
      if (!parent) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${input.parentTaskId}'`)

      // crash idempotency (D6): the checkpoint re-runs after append-before-commit — same ids, no-op
      const existing = state.splits.get(splitId)
      if (existing) return { splitId, childTaskId, gated: state.tasks.get(childTaskId)?.status === TASK_STATUS.awaiting_approval }

      // childTaskId is attempt-independent (parentTaskId, stepId, toolCallId) but splitId carries
      // the runToken — so a different attempt/split reusing this childTaskId slips past the check
      // above. Reject it: re-appending task_created would poison the fold (duplicate subtree).
      if (state.tasks.has(childTaskId))
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `childTaskId '${childTaskId}' already exists from a different split`)

      if (parent.depth + 1 > input.maxDepth)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `split exceeds max depth ${input.maxDepth}`)

      // subtree budget (D8): clamp to what the whole tree under the parent has left
      let budgetUSD = input.budgetUSD ?? null
      if (parent.budgetUSD !== null) {
        const remaining = parent.budgetUSD - (subtreeUsage(state, input.parentTaskId).costUSD ?? 0)
        if (remaining <= 0) throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `subtree budget exhausted`)
        budgetUSD = Math.min(budgetUSD ?? remaining, remaining)
      }

      const draft = ChildPlanDraft.parse(input.plan)
      const child: TaskNode = {
        id: childTaskId, parentId: parent.id, type: 'split', title: input.title, spec: input.spec,
        status: TASK_STATUS.draft, zone: [], budgetUSD, depth: parent.depth + 1,
        createdAt: new Date().toISOString(),
      }
      await this.append(tx, child.id, EVENT_KIND.task_created, { task: child })
      await this.append(tx, input.parentTaskId, EVENT_KIND.split_proposed, {
        splitId, taskId: input.parentTaskId, stepId: input.stepId, runToken: input.runToken, childTaskId,
      })

      // expand the trimmed draft with inherited refs (spec D3) and propose+maybe-approve
      const expanded: PlanDraft = {
        strategyRef: STRATEGY.split, costEstimateUSD: null,
        steps: draft.steps.map(s => ({
          ...s, executorRef: input.parentStep.executorRef, modelRef: input.parentStep.modelRef,
          isolation: ISOLATION_TIER.local, zone: [], maxIterations: input.parentStep.maxIterations,
        })),
      }
      const plan = await this.appendPlanVersion(tx, childTaskId, expanded, EVENT_KIND.plan_proposed, TASK_STATUS.draft)

      const verdict = evaluateApproval(input.policy, { depth: child.depth, costEstimateUSD: plan.costEstimateUSD, type: child.type })
      if (verdict.then === 'auto') {
        await this.append(tx, childTaskId, EVENT_KIND.plan_approved, {
          taskId: childTaskId, version: plan.version, approvedAt: new Date().toISOString(),
          approvedBy: 'policy', ...(verdict.ruleIndex !== undefined && { ruleIndex: verdict.ruleIndex }),
        })
        await this.append(tx, childTaskId, EVENT_KIND.task_status_changed, { taskId: childTaskId, from: TASK_STATUS.awaiting_approval, to: TASK_STATUS.approved })
      }
      return { splitId, childTaskId, gated: verdict.then === 'manual' }
    })
  }

  // D5 human annotation on a plan-note (M5b): an input event only — the plan-authoring agent
  // reads it and re-renders on its next revise. No fold/state change of its own.
  async annotatePlan(taskId: string, input: { targetNote: string; refs?: string[]; text: string }): Promise<void> {
    return this.log.transaction(async tx => {
      const task = await this.requireTask(tx, taskId)
      if (task.status === TASK_STATUS.done || task.status === TASK_STATUS.cancelled || task.status === TASK_STATUS.failed)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot annotate a plan while task is '${task.status}'`)
      const plan = (await this.stateOf(tx)).plans.get(taskId)?.versions.at(-1)
      if (!plan) throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, 'no plan to annotate')
      const payload = PlanAnnotatedPayload.parse({ planVersion: plan.version, targetNote: input.targetNote, refs: input.refs ?? [], text: input.text })
      await this.append(tx, taskId, EVENT_KIND.plan_annotated, payload)
    })
  }

  // D4 conversational gate, human side: answers the latest still-open feedback_requested (one
  // with no later feedback_provided on its topic) and resumes the step workflow parked on
  // DBOS.recv(`feedback:<topic>`, 60) — that workflow's id is the event's own envelope runToken,
  // recorded by the port from inside the step (never reconstructed here). Returns the resolved
  // topic, or null if the task has no open question (the CLI reports either outcome).
  async replyFeedback(taskId: string, text: string): Promise<string | null> {
    const open = await this.log.transaction(async tx => {
      await this.requireTask(tx, taskId)
      const events = await tx.byTask(taskId)
      const answeredAfter = (seq: number, topic: string): boolean =>
        events.some(e => e.seq > seq && e.kind === EVENT_KIND.feedback_provided && (e.payload as FeedbackProvidedPayload).topic === topic)
      const requested = [...events].reverse().find(e =>
        e.kind === EVENT_KIND.feedback_requested && !answeredAfter(e.seq, (e.payload as FeedbackRequestedPayload).topic))
      if (!requested) return null
      const { topic } = requested.payload as FeedbackRequestedPayload
      if (!requested.runToken)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `feedback_requested for topic '${topic}' has no runToken to resume`)
      const payload = FeedbackProvidedPayload.parse({ topic, text, author: { source: 'cli' } })
      await this.append(tx, taskId, EVENT_KIND.feedback_provided, payload)
      return { topic, runToken: requested.runToken }
    })
    if (!open) return null
    await this.send?.(open.runToken, text, `feedback:${open.topic}`)
    return open.topic
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
