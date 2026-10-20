import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import path from 'node:path'
import { MASTERPLAN_NOTE_ID,
  AnalysisCompletedPayload, ApprovedBy, CHECKS_STEP_ID, ChildPlanDraft, EVENT_KIND, FINISH_STEP_ID, FeedbackProvidedPayload, GroundedApprovalDoor, IsolationTier, PAYLOAD_SCHEMAS, PlanAnnotatedPayload, PlanDraft, PlanNoteToolName, PlanNoteWrittenPayload, ProjectIdentity, RunRequestedPayload, STEP_ROLE, STRATEGY, TASK_STATUS, TERMINAL_TASK_STATUS, WORKSPACE_TITLE_MAX, Workspace, WorkspaceArchivedPayload, WorkspaceMergedPayload, WorkspaceRetitledPayload, evaluateApproval, feedbackKey, formatModelOption, isApprovalAnswer, openFeedbackTopics, validatePlan, type ChildPlanDraftInput, type ModelOption,
  type Analyzer, type ApprovalPolicy, type EventDraft, type EventKind, type EventRecord, type KnowledgeWrites,
  type PlanNote, type PlanNoteWrite, type Plan, type PlanStep, type TaskNode, type TaskStatus,
  TaskType,
  type WorkspaceKind, authorSourceOf, directoryZoneEntries, type Origin,
} from '@orc/contracts'
import { planApprovalStamp, planGraphHash, PLAN_STEP_ID, PLAN_STEP_ROLE } from './execution/strategies/grounded-plan'
import { PlanNoteRefusal, mergePlanNote, planNotesOf, planNotesWrittenAfter } from './plan-notes'
import { kernelStepExecutorRef, reconcileFinishStep } from './finish-step'
import { DEFAULT_MAX_ITERATIONS } from './config'
import { EventLog, type EventLogOps } from './storage'
import { estimateCostUSD, fold, gatedChildren, knowledgeOwnerTaskIds, subtreeTaskIds, subtreeUsage, taskChangedPaths, type State } from './projections'
import { knowledgeWritesIn } from './task-knowledge'
import { applyArchived, applyRetitle, workspaceByCwd, workspaceCwdFor } from './workspaces'
import { KERNEL_ERROR_CODE, KernelError, type KernelErrorCode } from './errors'

// the plan_annotated payload plus the event's own seq, for ordering across rounds
export type PlanAnnotation = PlanAnnotatedPayload & { seq: number }

// natural key: '/repo' and '/repo/' are one; syntactic only, and empty is refused
const workspaceCwdKey = (cwd: string): string => {
  if (cwd.trim() === '') throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, 'a workspace needs a cwd')
  return path.resolve(cwd)
}

// A workspace directory that is missing or unresolvable is not judged here.
function assertZonesCanMatch(plan: Plan, workspaceCwd: string | null): void {
  if (workspaceCwd === null) return
  if (statSync(workspaceCwd, { throwIfNoEntry: false })?.isDirectory() !== true) return
  const isDirectory = (rel: string): boolean =>
    statSync(path.resolve(workspaceCwd, rel), { throwIfNoEntry: false })?.isDirectory() === true
  for (const step of plan.steps)
    for (const entry of directoryZoneEntries(step.zone, isDirectory))
      throw new KernelError(KERNEL_ERROR_CODE.plan_validation_failed,
        `step '${step.id}' zone entry '${entry}' names a directory, which matches no file — write '${entry}/**'`)
}

// omitted = 'agent' (fail closed): only the kernel's own freeze may claim 'freeze'
export const SPLIT_ORIGIN = { agent: 'agent', freeze: 'freeze' } as const
export type SplitOrigin = (typeof SPLIT_ORIGIN)[keyof typeof SPLIT_ORIGIN]

const PLAN_NOTE_REFUSAL_CODE = {
  [PlanNoteRefusal.untitled]: KERNEL_ERROR_CODE.invalid_transition,
  [PlanNoteRefusal.shape]: KERNEL_ERROR_CODE.plan_validation_failed,
} satisfies Record<PlanNoteRefusal, KernelErrorCode>

// the raw event travels with it: the reply path resumes its step/run envelope
interface OpenRequest {
  event: EventRecord
  topic: string
  question: string
  noteId?: string
}

export class Kernel {
  constructor(
    private readonly log: EventLog,
    private readonly refValidator?: (plan: Plan) => Promise<string[]>,
    // optional so non-grounded kernels (most tests, read-only CLI) need no plugin host
    private readonly analyzers?: Map<string, Analyzer>,
    // optional and DBOS-agnostic: without it replyFeedback still appends and returns the topic
    private readonly send?: (workflowId: string, message: string, topic: string, idempotencyKey: string) => Promise<void>,
    // public readonly: the refusal message must name the SAME list the gate tests
    readonly approvalDoors: readonly string[] = [GroundedApprovalDoor.cli],
    private readonly finishChecks: readonly string[] = [],
  ) {}

  // project maxIterations applies to both template steps: subplans inherit it from their parent
  async createGroundedTask(input: { title: string; spec: string; modelRef: string; analyzerRef: string; parentId?: string; budgetUSD?: number | null; workspaceId?: string; modelCatalog?: ModelOption[]; maxIterations?: number }, origin: Origin): Promise<TaskNode> {
    // the title is a label, never the goal: without intent the agents guess
    const spec = input.spec.trim()
    if (spec === '')
      throw new KernelError(KERNEL_ERROR_CODE.invalid_transition,
        'grounded tasks need a spec — the title is only a label. State the intent: what should happen, constraints, expected outputs.')
    const analyzer = this.analyzers?.get(input.analyzerRef)
    if (!analyzer)
      throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `unknown analyzer '${input.analyzerRef}' — register it or pass a valid analyzerRef`)
    return this.log.transaction(async tx => {
      const task = await this.createTaskIn(tx, { title: input.title, spec, type: TaskType.grounded, parentId: input.parentId, budgetUSD: input.budgetUSD, workspaceId: input.workspaceId }, origin)
      const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS
      const analyzeStep: PlanStep = { ...analyzer.analysisStep({ modelRef: input.modelRef, taskSpec: spec }), maxIterations, readOnlySource: true }
      const planStep: PlanStep = {
        id: PLAN_STEP_ID, role: PLAN_STEP_ROLE, title: 'Author the executable plan',
        instructions: `Author the plan with ${PlanNoteToolName.write}: a '${MASTERPLAN_NOTE_ID}' note whose \`subplans\` lists each subplan note id, iterate with the human via ask_human, then call ${PlanNoteToolName.finalize}. Follow the plan-authoring skill.`
          // the planner cannot price a trade-off between models it has never heard of
          + (input.modelCatalog?.length
            ? ` Models you may set as a subplan's modelRef, with their rates: ${input.modelCatalog.map(formatModelOption).join('; ')}. Omit it to inherit '${input.modelRef}'.`
            : ''),
        executorRef: 'api-loop', modelRef: input.modelRef, skillRefs: ['plan-authoring'], toolRefs: [],
        isolation: IsolationTier.local, zone: [], maxIterations, dependsOn: [analyzeStep.id], readOnlySource: true,
      }
      // null means no comparable history: the door says so rather than show a made-up figure
      const state = await this.stateOf(tx)
      const draft: PlanDraft = {
        strategyRef: STRATEGY.groundedPlan, analyzerRef: input.analyzerRef,
        costEstimateUSD: estimateCostUSD(state, { strategyRef: STRATEGY.groundedPlan, analyzerRef: input.analyzerRef }),
        steps: [analyzeStep, planStep],
      }
      const plan = await this.appendPlanVersion(tx, task.id, draft, EVENT_KIND.plan_proposed, task.status, origin)
      await this.approvePlanIn(tx, task.id, plan.version, { approvedBy: ApprovedBy.policy }, origin)
      return task
    })
  }

  // optional only so a child inherits its parent's; none without a parentId is a KernelError
  async createTask(input: { title: string; spec?: string; type?: TaskType; parentId?: string; budgetUSD?: number | null; workspaceId?: string }, origin: Origin): Promise<TaskNode> {
    return this.log.transaction(tx => this.createTaskIn(tx, input, origin))
  }

  async proposePlan(taskId: string, draft: PlanDraft, origin: Origin): Promise<Plan> {
    return this.log.transaction(async tx => {
      const task = await this.requireTask(tx, taskId)
      if (task.status !== TASK_STATUS.draft)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot propose a plan while task is '${task.status}'`)
      // every ROOT plan carries the finish step from the proposal: the human approves what runs
      return this.appendPlanVersion(tx, taskId, reconcileFinishStep(task, draft, { checks: this.finishChecks }), EVENT_KIND.plan_proposed, task.status, origin)
    })
  }

  async editPlan(taskId: string, draft: PlanDraft, origin: Origin): Promise<Plan> {
    return this.log.transaction(async tx => {
      const task = await this.requireTask(tx, taskId)
      // `blocked` is editable too: a defective frozen plan's only exit would otherwise be cancelling
      if (task.status !== TASK_STATUS.awaiting_approval && task.status !== TASK_STATUS.blocked)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot edit a plan while task is '${task.status}'`)
      // same rule as proposePlan: edits start from the rendered plan, which already ends with it
      return this.appendPlanVersion(tx, taskId, reconcileFinishStep(task, draft, { checks: this.finishChecks }), EVENT_KIND.plan_edited, task.status, origin)
    })
  }

  // required `origin` must be last, so `version` and `approval` are explicit undefined (TS1016)
  async approvePlan(
    taskId: string,
    version: number | undefined,
    approval: { approvedBy: ApprovedBy; ruleIndex?: number } | undefined,
    origin: Origin,
  ): Promise<Plan> {
    return this.log.transaction(tx => this.approvePlanIn(tx, taskId, version, approval, origin))
  }

  async proposeSplit(input: {
    parentTaskId: string; stepId: string; runToken: string; toolCallId: string
    title: string; spec: string; plan: ChildPlanDraftInput; budgetUSD?: number
    parentStep: Pick<PlanStep, 'executorRef' | 'modelRef' | 'maxIterations'>
    policy: ApprovalPolicy; maxDepth: number
    // WHO authored the draft — not the caller's Origin, which is the last parameter
    authoredBy?: SplitOrigin
  }, origin: Origin): Promise<{ splitId: string; childTaskId: string; gated: boolean }> {
    const splitId = `split:${input.runToken}:${input.toolCallId}`
    const childTaskId = `${input.parentTaskId}.${input.stepId}.${input.toolCallId}`
    return this.log.transaction(async tx => {
      const state = await this.stateOf(tx)
      const parent = state.tasks.get(input.parentTaskId)
      if (!parent) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${input.parentTaskId}'`)

      // crash idempotency: the checkpoint re-runs after append-before-commit — same ids, no-op
      const existing = state.splits.get(splitId)
      if (existing) return { splitId, childTaskId, gated: state.tasks.get(childTaskId)?.status === TASK_STATUS.awaiting_approval }

      // no subtree under a terminal parent: a late task_split must not race the cancel sweep
      if (parent.status === TASK_STATUS.cancelled || parent.status === TASK_STATUS.done || parent.status === TASK_STATUS.failed)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot split a '${parent.status}' task — its run is no longer live`)

      // childTaskId ignores the attempt but splitId carries the runToken: re-appending poisons the fold
      if (state.tasks.has(childTaskId))
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `childTaskId '${childTaskId}' already exists from a different split`)

      if (parent.depth + 1 > input.maxDepth)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `split exceeds max depth ${input.maxDepth}`)

      // subtree budget: clamp to what the whole tree under the parent has left
      let budgetUSD = input.budgetUSD ?? null
      if (parent.budgetUSD !== null) {
        const remaining = parent.budgetUSD - (subtreeUsage(state, input.parentTaskId).costUSD ?? 0)
        if (remaining <= 0) throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `subtree budget exhausted`)
        budgetUSD = Math.min(budgetUSD ?? remaining, remaining)
      }

      const draft = ChildPlanDraft.parse(input.plan)
      // committer and finisher arm git_commit and the finish tools: only the freeze may set them
      if (input.authoredBy !== SPLIT_ORIGIN.freeze) {
        const reserved = draft.steps.find(s => s.role === STEP_ROLE.committer || s.role === STEP_ROLE.finisher || s.id === FINISH_STEP_ID || s.id === CHECKS_STEP_ID)
        if (reserved)
          throw new KernelError(KERNEL_ERROR_CODE.invalid_transition,
            reserved.role === STEP_ROLE.committer
              ? `step '${reserved.id}' claims role '${STEP_ROLE.committer}', which only the kernel's autoCommit freeze may set — remove it from the split; the commit step is appended for you when the pipeline commits`
              : `step '${reserved.id}' claims the kernel-set ${reserved.role === STEP_ROLE.finisher ? `role '${STEP_ROLE.finisher}'` : `step id '${reserved.id}'`} — remove it from the split; the kernel appends that step itself at the end of the pipeline this split belongs to`)
      }
      const child: TaskNode = {
        // inherited, never re-derived: a subtree cannot straddle two working directories
        id: childTaskId, parentId: parent.id, workspaceId: parent.workspaceId, type: TaskType.split, title: input.title, spec: input.spec,
        status: TASK_STATUS.draft, zone: [], budgetUSD, depth: parent.depth + 1,
        createdAt: new Date().toISOString(),
      }
      await this.append(tx, child.id, { kind: EVENT_KIND.task_created, payload: { task: child } }, origin)
      await this.append(tx, input.parentTaskId, {
        kind: EVENT_KIND.split_proposed,
        payload: { splitId, taskId: input.parentTaskId, stepId: input.stepId, runToken: input.runToken, childTaskId },
      }, origin)

      // expand the trimmed draft with inherited refs and propose+maybe-approve
      const expanded: PlanDraft = {
        // same rule as the grounded door; null until a split has settled, so maxCostUSD rules can fire
        strategyRef: STRATEGY.split, costEstimateUSD: estimateCostUSD(state, { strategyRef: STRATEGY.split }),
        steps: draft.steps.map(s => ({
          ...s, executorRef: kernelStepExecutorRef(s.id, input.parentStep.executorRef),
          modelRef: s.modelRef ?? input.parentStep.modelRef,
          // zone is the child's own declaration (write-fence) — parsed default [] = unfenced
          isolation: IsolationTier.local, zone: s.zone, maxIterations: input.parentStep.maxIterations,
        })),
      }
      const plan = await this.appendPlanVersion(tx, childTaskId, expanded, EVENT_KIND.plan_proposed, TASK_STATUS.draft, origin)

      const verdict = evaluateApproval(input.policy, { depth: child.depth, costEstimateUSD: plan.costEstimateUSD, type: child.type })
      if (verdict.then === 'auto') {
        await this.append(tx, childTaskId, {
          kind: EVENT_KIND.plan_approved,
          payload: {
            taskId: childTaskId, version: plan.version, approvedAt: new Date().toISOString(),
            approvedBy: ApprovedBy.policy, ...(verdict.ruleIndex !== undefined && { ruleIndex: verdict.ruleIndex }),
          },
        }, origin)
        await this.append(tx, childTaskId, { kind: EVENT_KIND.task_status_changed, payload: { taskId: childTaskId, from: TASK_STATUS.awaiting_approval, to: TASK_STATUS.approved } }, origin)
      }
      return { splitId, childTaskId, gated: verdict.then === 'manual' }
    })
  }

  // an input event only: the plan-authoring agent reads it on its next revise
  async annotatePlan(taskId: string, input: { targetNote: string; refs?: string[]; text: string }, origin: Origin): Promise<void> {
    return this.log.transaction(async tx => {
      const task = await this.requireTask(tx, taskId)
      if (task.status === TASK_STATUS.done || task.status === TASK_STATUS.cancelled || task.status === TASK_STATUS.failed)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot annotate a plan while task is '${task.status}'`)
      const plan = (await this.stateOf(tx)).plans.get(taskId)?.versions.at(-1)
      if (!plan) throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, 'no plan to annotate')
      const payload = PlanAnnotatedPayload.parse({ planVersion: plan.version, targetNote: input.targetNote, refs: input.refs ?? [], text: input.text })
      await this.append(tx, taskId, { kind: EVENT_KIND.plan_annotated, payload }, origin)
    })
  }

  // reads the plan_annotated events straight off the log, in chronological order
  async listAnnotations(taskId: string): Promise<PlanAnnotation[]> {
    const events = await this.log.byTask(taskId)
    return events
      .flatMap(e => {
        if (e.kind !== EVENT_KIND.plan_annotated) return []
        // parsed, not asserted: an unparseable annotation is dropped rather than passed as a shaped lie
        const p = PAYLOAD_SCHEMAS.plan_annotated.safeParse(e.payload)
        return p.success ? [{ ...p.data, seq: e.seq }] : []
      })
  }

  // covers descendant split tasks too; a floor for scope cleanliness, never a complete diff
  async listTaskChangedPaths(taskId: string): Promise<Array<{ path: string; taskId: string; steps: Array<{ stepId: string | null; tool: string; seq: number }> }>> {
    const ids = subtreeTaskIds(await this.state(), taskId)
    const out: Array<{ path: string; taskId: string; steps: Array<{ stepId: string | null; tool: string; seq: number }> }> = []
    for (const id of ids)
      for (const changed of taskChangedPaths(await this.log.byTask(id)))
        out.push({ path: changed.path, taskId: id, steps: changed.steps })
    return out
  }

  // The subtree, plus a grounded parent: it has no commit step, so its frozen child owns its writes.
  async listTaskKnowledgeWrites(taskId: string): Promise<KnowledgeWrites> {
    const ids = knowledgeOwnerTaskIds(await this.state(), taskId)
    const events = (await Promise.all(ids.map(id => this.log.byTask(id)))).flat()
    return knowledgeWritesIn(events, new Set(ids))
  }

  async listPlanNotes(taskId: string): Promise<PlanNote[]> {
    return planNotesOf(await this.log.byTask(taskId), taskId)
  }

  // a replayed key returns the note it stored and appends nothing
  async writePlanNote(taskId: string, write: PlanNoteWrite, origin: Origin, run?: { stepId: string; runToken: string; idempotencyKey: string }): Promise<PlanNote> {
    return this.log.transaction(async tx => {
      const task = await this.requireTask(tx, taskId)
      if (task.type !== TaskType.grounded)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `only a grounded task has plan notes, and this task is '${task.type}'`)
      if (TERMINAL_TASK_STATUS.has(task.status))
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot write a plan note while task is '${task.status}'`)
      const events = await tx.byTask(taskId)
      const replayed = run && events.find(e => e.kind === EVENT_KIND.plan_note_written && e.idempotencyKey === run.idempotencyKey)
      if (replayed) return PlanNoteWrittenPayload.parse(replayed.payload).note
      const prev = planNotesOf(events, taskId).find(n => n.id === write.id)
      const note = mergePlanNote(prev, write)
      if ('refusal' in note) throw new KernelError(PLAN_NOTE_REFUSAL_CODE[note.code], note.refusal)
      await this.append(tx, taskId, { kind: EVENT_KIND.plan_note_written, payload: { note }, ...(run && { idempotencyKey: run.idempotencyKey }) }, origin,
        run ? { stepId: run.stepId, runToken: run.runToken } : {})
      return note
    })
  }

  // returned PARSED so no caller re-asserts the shape; shared by openFeedback and replyFeedback
  private openRequest(events: EventRecord[]): OpenRequest | null {
    // which questions are open is feedback-open.ts's rule; only the LATEST, with its event, lives here
    const open = openFeedbackTopics(events)
    for (const event of [...events].reverse()) {
      if (event.kind !== EVENT_KIND.feedback_requested) continue
      // lenient like every fold: an unparseable payload must not present itself as the open gate
      const p = PAYLOAD_SCHEMAS.feedback_requested.safeParse(event.payload)
      if (!p.success) continue
      // project-level events hold no question: a guard that also narrows away a non-null assertion
      if (event.taskId === null) continue
      if (!open.has(feedbackKey(event.taskId, p.data.topic))) continue
      return { event, ...p.data }
    }
    return null
  }

  // the pending question and topic, or null: lets a human see the prompt, not answer blind
  async openFeedback(taskId: string): Promise<{ topic: string; question: string; noteId?: string } | null> {
    const open = this.openRequest(await this.log.byTask(taskId))
    if (!open) return null
    const { topic, question, noteId } = open
    return { topic, question, ...(noteId ? { noteId } : {}) }
  }

  // the other human gate, announced by no event: see projections.gatedChildren
  async gatedChildren(taskId: string): Promise<Array<{ id: string; title: string }>> {
    return gatedChildren(await this.state(), taskId)
  }

  // the gate can sit on a DESCENDANT's stream; nearest-first so the shallowest live gate is answered
  async openFeedbackInSubtree(rootId: string): Promise<{ taskId: string; topic: string; question: string; noteId?: string } | null> {
    for (const id of subtreeTaskIds(await this.state(), rootId)) {
      const open = await this.openFeedback(id)
      if (open) return { taskId: id, ...open }
    }
    return null
  }

  // newest first; isApprovalAnswer must be the SAME predicate replyFeedback recorded with
  private async planApprovals(taskId: string, runToken: string): Promise<Array<{ source: string; hash: string; seq: number }>> {
    const out: Array<{ source: string; hash: string; seq: number }> = []
    for (const event of [...(await this.log.byTask(taskId))].reverse()) {
      if (event.kind !== EVENT_KIND.feedback_provided || event.runToken !== runToken) continue
      const parsed = FeedbackProvidedPayload.safeParse(event.payload)
      if (parsed.success && isApprovalAnswer(parsed.data.text) && parsed.data.planHash)
        out.push({ source: parsed.data.author.source, hash: parsed.data.planHash, seq: event.seq })
    }
    return out
  }

  // the seq lets finalize_plan name the plan notes edited since, not just that something moved
  async approvedPlanHash(taskId: string, runToken: string): Promise<{ hash: string; seq: number } | null> {
    const found = (await this.planApprovals(taskId, runToken)).find(a => this.approvalDoors.includes(a.source))
    return found ? { hash: found.hash, seq: found.seq } : null
  }

  // sibling of approvedPlanHash, which is the gate: names the actual door behind a refusal
  async nonHumanPlanApproval(taskId: string, runToken: string): Promise<{ source: string } | null> {
    const found = (await this.planApprovals(taskId, runToken)).find(a => !this.approvalDoors.includes(a.source))
    return found ? { source: found.source } : null
  }

  // plan note ids written after `seq`: names which edit cost the human gate
  async planNotesChangedSince(taskId: string, seq: number): Promise<string[]> {
    return planNotesWrittenAfter(await this.log.byTaskSince(taskId, seq), taskId, seq)
  }

  // the answerer's door is recorded as author source: it tells a person's approval from an agent's
  async replyFeedback(taskId: string, text: string, origin: Origin): Promise<string | null> {
    const open = await this.log.transaction(async tx => {
      const task = await this.requireTask(tx, taskId)
      const events = await tx.byTask(taskId)
      const requested = this.openRequest(events)
      if (!requested) return null
      const { topic, event } = requested
      if (!event.stepId || !event.runToken)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `feedback_requested for topic '${topic}' has no step/run envelope to resume`)
      const planHash = planApprovalStamp(task, event, text) ? planGraphHash(planNotesOf(events, taskId)) : undefined
      const payload = FeedbackProvidedPayload.parse({
        // workspaceId off the task, not the answerer; `origin` is the answerer's, or the parse throws
        topic, text, author: { source: authorSourceOf(origin.door), workspaceId: task.workspaceId, origin }, ...(planHash && { planHash }),
      })
      // the question's chat, the answerer's door: the reply belongs to the interaction that asked
      const provided = await this.append(tx, taskId,
        { kind: EVENT_KIND.feedback_provided, payload, idempotencyKey: `feedback:${event.seq}:provided` },
        { chatId: event.chatId, door: origin.door },
        { stepId: event.stepId, runToken: event.runToken })
      return { topic, runToken: event.runToken, seq: provided.seq }
    })
    if (!open) return null
    await this.send?.(open.runToken, text, `feedback:${open.topic}`, `feedback:${open.seq}`)
    return open.topic
  }

  // the latest analysis_completed, or null before any: shows what the analysis did NOT cover
  async latestCoverage(taskId: string): Promise<AnalysisCompletedPayload | null> {
    const last = [...(await this.log.byTask(taskId))].reverse().find(e => e.kind === EVENT_KIND.analysis_completed)
    return last ? AnalysisCompletedPayload.parse(last.payload) : null
  }

  // the scout self-reports before signaling success; degradation (analyzed:false) is valid
  async reportCoverage(ctx: { taskId: string; stepId: string; runToken: string }, coverage: unknown, origin: Origin): Promise<void> {
    return this.log.transaction(async tx => {
      await this.requireTask(tx, ctx.taskId)
      const payload = AnalysisCompletedPayload.parse(coverage)
      await this.append(tx, ctx.taskId, { kind: EVENT_KIND.analysis_completed, payload }, origin, { stepId: ctx.stepId, runToken: ctx.runToken })
    })
  }

  // returns the ask's seq: a watching client needs it to tell 'not reacted yet' from 'run over'
  async requestRun(taskId: string, opts: { cwd?: string; retry?: boolean }, origin: Origin): Promise<number> {
    return this.log.transaction(async tx => {
      const state = await this.stateOf(tx)
      const task = this.requireTaskIn(state, taskId)
      // resolved here, not in the port: the port folds per task and never sees workspace events
      const cwd = opts.cwd ?? workspaceCwdFor(task, state.workspaces)
      // null means ORPHAN: recording it would silently send the run to the project directory
      if (cwd === null)
        throw new KernelError(KERNEL_ERROR_CODE.workspace_not_found,
          `task '${taskId}' names workspace '${task.workspaceId}', which is not in the log — pass --cwd to run it anyway`)
      const requested = await this.append(tx, taskId,
        { kind: EVENT_KIND.run_requested, payload: RunRequestedPayload.parse({ taskId, cwd, retry: opts.retry ?? false }) }, origin)
      return requested.seq
    })
  }

  // ONE transaction: a task_split committed mid-sweep must not escape the cancel; children first
  async cancelSubtree(taskId: string, origin: Origin): Promise<string[]> {
    return this.log.transaction(async tx => {
      const state = await this.stateOf(tx)
      const stamped: string[] = []
      for (const id of subtreeTaskIds(state, taskId).reverse()) {
        const status = state.tasks.get(id)?.status
        if (status === undefined || TERMINAL_TASK_STATUS.has(status)) continue
        // a running task's end belongs to the RUN's chat; the door stays the canceller's
        const run = status === TASK_STATUS.running ? state.runs.get(id)?.at(-1) : undefined
        await this.append(tx, id,
          { kind: EVENT_KIND.task_status_changed, payload: { taskId: id, from: status, to: TASK_STATUS.cancelled } },
          run ? { chatId: run.workflowId, door: origin.door } : origin)
        stamped.push(id)
      }
      return stamped
    })
  }

  // idempotent on the exact cwd among ACTIVE records; an existing record is returned UNCHANGED
  async ensureWorkspace(input: {
    cwd: string; branch: string | null; kind: WorkspaceKind; onTrunk: boolean; title?: string
    managed?: boolean; baseBranch?: string | null
  }, origin: Origin): Promise<{ workspace: Workspace; created: boolean }> {
    const cwd = workspaceCwdKey(input.cwd)
    return this.log.transaction(async tx => {
      const existing = workspaceByCwd((await this.stateOf(tx)).workspaces, cwd)
      if (existing) return { workspace: existing, created: false }
      // truncate the derived title, never refuse: adoption runs at boot, and a throw fails every command
      const derived = (input.branch ?? path.basename(cwd)).slice(0, WORKSPACE_TITLE_MAX)
      const workspace = Workspace.parse({
        // a detached HEAD has no branch to name it after, so the directory does
        id: randomUUID(), title: input.title ?? derived, cwd,
        branch: input.branch, baseBranch: input.baseBranch ?? null, kind: input.kind,
        managed: input.managed ?? false, onTrunk: input.onTrunk,
        createdAt: new Date().toISOString(), archivedAt: null,
      })
      await this.appendProjectEvent(tx, { kind: EVENT_KIND.workspace_created, payload: { workspace } }, origin)
      return { workspace, created: true }
    })
  }

  // `managed` is the caller's to declare: it later licenses `git worktree remove`
  async createWorkspace(input: { title: string; cwd: string; branch: string; baseBranch: string; kind: WorkspaceKind; managed: boolean; onTrunk: boolean }, origin: Origin): Promise<Workspace> {
    const cwd = workspaceCwdKey(input.cwd)
    return this.log.transaction(async tx => {
      if (workspaceByCwd((await this.stateOf(tx)).workspaces, cwd))
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `a workspace already exists at ${cwd}`)
      const workspace = Workspace.parse({ id: randomUUID(), ...input, cwd, createdAt: new Date().toISOString(), archivedAt: null })
      await this.appendProjectEvent(tx, { kind: EVENT_KIND.workspace_created, payload: { workspace } }, origin)
      return workspace
    })
  }

  // re-seats a record under its ORIGINAL id: the kernel is the one writer of workspace records
  async restoreWorkspace(workspace: Workspace, origin: Origin): Promise<Workspace> {
    const parsed = Workspace.parse(workspace)
    const cwd = workspaceCwdKey(parsed.cwd)
    return this.log.transaction(async tx => {
      if (workspaceByCwd((await this.stateOf(tx)).workspaces, cwd))
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `a workspace already exists at ${cwd}`)
      const restored = { ...parsed, cwd }
      await this.appendProjectEvent(tx, { kind: EVENT_KIND.workspace_created, payload: { workspace: restored } }, origin)
      return restored
    })
  }

  async retitleWorkspace(id: string, title: string, origin: Origin): Promise<Workspace> {
    return this.log.transaction(async tx => {
      const w = this.requireWorkspace(await this.stateOf(tx), id)
      await this.appendProjectEvent(tx, { kind: EVENT_KIND.workspace_retitled, payload: WorkspaceRetitledPayload.parse({ workspaceId: id, title }) }, origin)
      return applyRetitle(w, title) // the fold's own transition — never a second spelling of it
    })
  }

  async identifyProject(identity: ProjectIdentity, origin: Origin): Promise<ProjectIdentity> {
    return this.log.transaction(async tx => {
      await this.appendProjectEvent(tx, { kind: EVENT_KIND.project_identified, payload: identity }, origin)
      return identity
    })
  }

  // a setter: re-archiving and restoring a live record are allowed, so callers need not know state
  async setWorkspaceArchived(id: string, archived: boolean, origin: Origin): Promise<Workspace> {
    return this.log.transaction(async tx => {
      const w = this.requireWorkspace(await this.stateOf(tx), id)
      const at = new Date().toISOString()
      await this.appendProjectEvent(tx, { kind: EVENT_KIND.workspace_archived, payload: WorkspaceArchivedPayload.parse({ workspaceId: id, archived, at }) }, origin)
      return applyArchived(w, archived, at)
    })
  }

  async listWorkspaces(opts: { includeArchived?: boolean } = {}): Promise<Workspace[]> {
    const all = [...(await this.state()).workspaces.values()]
    return opts.includeArchived ? all : all.filter(w => w.archivedAt === null)
  }

  // recorded ONCE: a second merge naming a different commit would fold differently
  async mergeWorkspace(id: string, input: { mergeCommit: string; trunk: string }, origin: Origin): Promise<WorkspaceMergedPayload> {
    return this.log.transaction(async tx => {
      // one fold for both facts: stateOf refolds the whole log per call
      const state = await this.stateOf(tx)
      this.requireWorkspace(state, id)
      if (state.workspaceMerges.has(id))
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `workspace '${id}' is already merged`)
      const payload = WorkspaceMergedPayload.parse({ workspaceId: id, ...input, at: new Date().toISOString() })
      await this.appendProjectEvent(tx, { kind: EVENT_KIND.workspace_merged, payload }, origin)
      return payload
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

  private async createTaskIn(
    tx: EventLogOps,
    // optional only so a child inherits; a default would silently bind work to an unchosen workspace
    input: { title: string; spec?: string; type?: TaskType; parentId?: string; budgetUSD?: number | null; workspaceId?: string },
    origin: Origin,
  ): Promise<TaskNode> {
    // one fold for the parent and the workspace: stateOf refolds the whole log per call
    const state = await this.stateOf(tx)
    const parent = input.parentId ? this.requireTaskIn(state, input.parentId) : null
    const workspaceId = input.workspaceId ?? parent?.workspaceId
    if (workspaceId === undefined)
      throw new KernelError(KERNEL_ERROR_CODE.workspace_not_found,
        'a task needs a workspace — pass workspaceId (a child inherits its parent\'s)')
    this.requireWorkspace(state, workspaceId)
    const task: TaskNode = {
      id: randomUUID(), parentId: parent?.id ?? null, workspaceId, type: input.type ?? TaskType.generic,
      title: input.title, spec: input.spec ?? '', status: TASK_STATUS.draft, zone: [],
      budgetUSD: input.budgetUSD ?? parent?.budgetUSD ?? null,
      depth: parent ? parent.depth + 1 : 0, createdAt: new Date().toISOString(),
    }
    await this.append(tx, task.id, { kind: EVENT_KIND.task_created, payload: { task } }, origin)
    return task
  }

  private async approvePlanIn(
    tx: EventLogOps,
    taskId: string,
    version: number | undefined,
    approval: { approvedBy: ApprovedBy; ruleIndex?: number } | undefined,
    origin: Origin,
  ): Promise<Plan> {
    const task = await this.requireTask(tx, taskId)
    if (task.status !== TASK_STATUS.awaiting_approval)
      throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot approve while task is '${task.status}'`)
    const latest = (await this.stateOf(tx)).plans.get(taskId)?.versions.at(-1)
    if (!latest) throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, 'no plan to approve')
    const wanted = version ?? latest.version
    if (wanted !== latest.version)
      throw new KernelError(KERNEL_ERROR_CODE.version_conflict, `latest plan is v${latest.version}, not v${wanted}`)
    await this.append(tx, taskId, {
      kind: EVENT_KIND.plan_approved,
      payload: {
        taskId, version: wanted, approvedAt: new Date().toISOString(),
        approvedBy: approval?.approvedBy ?? ApprovedBy.human,
        ...(approval?.ruleIndex !== undefined && { ruleIndex: approval.ruleIndex }),
      },
    }, origin)
    await this.append(tx, taskId, { kind: EVENT_KIND.task_status_changed, payload: { taskId, from: task.status, to: TASK_STATUS.approved } }, origin)
    return latest
  }

  private async appendPlanVersion(
    tx: EventLogOps,
    taskId: string,
    draft: PlanDraft,
    kind: Extract<EventKind, 'plan_proposed' | 'plan_edited'>,
    from: TaskStatus,
    origin: Origin,
  ): Promise<Plan> {
    const state = await this.stateOf(tx)
    const versions = state.plans.get(taskId)?.versions ?? []
    const plan: Plan = { ...PlanDraft.parse(draft), taskId, version: versions.length + 1 }
    const check = validatePlan(plan)
    if (!check.ok) throw new KernelError(KERNEL_ERROR_CODE.plan_validation_failed, check.errors.join('; '))
    assertZonesCanMatch(plan, workspaceCwdFor(this.requireTaskIn(state, taskId), state.workspaces))
    const refErrors = this.refValidator ? await this.refValidator(plan) : []
    if (refErrors.length > 0)
      throw new KernelError(KERNEL_ERROR_CODE.plan_validation_failed, refErrors.join('; '))
    await this.append(tx, taskId, { kind, payload: { plan } }, origin)
    if (from !== TASK_STATUS.awaiting_approval)
      await this.append(tx, taskId, { kind: EVENT_KIND.task_status_changed, payload: { taskId, from, to: TASK_STATUS.awaiting_approval } }, origin)
    return plan
  }

  // the ONE envelope spelling: a new verb cannot reach the log without naming its origin
  private async append(
    ops: EventLogOps, taskId: string, draft: EventDraft, origin: Origin,
    extra: { stepId?: string; runToken?: string } = {},
  ): Promise<EventRecord> {
    return ops.append({
      ...origin, taskId, stepId: extra.stepId ?? null, runToken: extra.runToken ?? null, ...draft,
    })
  }

  // project-level events carry no task binding (taskId null), which `append` cannot express
  private async appendProjectEvent(ops: EventLogOps, draft: EventDraft, origin: Origin): Promise<void> {
    await ops.append({ ...origin, taskId: null, stepId: null, runToken: null, ...draft })
  }

  private async requireTask(ops: EventLogOps, id: string): Promise<TaskNode> {
    return this.requireTaskIn(await this.stateOf(ops), id)
  }

  // requireWorkspace's shape: a caller holding a fold must not pay for a second one
  private requireTaskIn(state: State, id: string): TaskNode {
    const t = state.tasks.get(id)
    if (!t) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${id}'`)
    return t
  }

  // takes the STATE, not log ops: every caller holds a fold, and refolding twice costs
  private requireWorkspace(state: State, id: string): Workspace {
    const w = state.workspaces.get(id)
    if (!w) throw new KernelError(KERNEL_ERROR_CODE.workspace_not_found, `no workspace '${id}'`)
    return w
  }
}
