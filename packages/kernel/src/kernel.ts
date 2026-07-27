import { randomUUID } from 'node:crypto'
import { MASTERPLAN_NOTE_ID,
  AnalysisCompletedPayload, ChildPlanDraft, EVENT_KIND, FeedbackProvidedPayload, ISOLATION_TIER, MemoryDeletedPayload, MemoryWrittenPayload, NOTE_TIER, PAYLOAD_SCHEMAS, PlanAnnotatedPayload, PlanDraft, RunRequestedPayload, STRATEGY, TASK_STATUS, TERMINAL_TASK_STATUS, evaluateApproval, formatModelOption, validatePlan, type ChildPlanDraftInput, type ModelOption,
  type Analyzer, type ApprovalPolicy, type EventKind, type EventRecord,
  type PlanNote, type Plan, type PlanStep, type TaskNode, type TaskStatus,
  type MemoryAuthor,
} from '@orc/contracts'
import { foldPlanNotes, planGraphHash, planScope, PLAN_STEP_ID, PLAN_STEP_ROLE } from './execution/strategies/grounded-plan'
import { DEFAULT_MAX_ITERATIONS } from './config'
import { EventLog, type EventLogOps } from './storage'
import { fold, gatedChildren, subtreeTaskIds, subtreeUsage, type State } from './projections'
import { KERNEL_ERROR_CODE, KernelError } from './errors'

// D6 targeted re-plan (M5b): what listAnnotations hands back to the read_annotations tool — the
// plan_annotated payload plus the event's own seq, so the agent can order/dedupe across rounds.
export type PlanAnnotation = PlanAnnotatedPayload & { seq: number }

// One open feedback question, already parsed. The raw event travels with it because the reply path
// resumes the step/run envelope the question was asked from.
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
    // analyzers seed the grounded-plan template's analyze step (D2); optional so non-grounded
    // kernels (most tests, read-only CLI) construct without a plugin host.
    private readonly analyzers?: Map<string, Analyzer>,
    // resumes a parked feedback gate (D4 conversational gate): DBOS.recv(`feedback:<topic>`, 60)
    // runs inside the step workflow whose id IS the destination; the kernel stays DBOS-agnostic
    // (unit-testable with a fake) and the real port-backed sender is wired at CLI runtime
    // construction. Optional so most tests / read-only CLI contexts construct without it —
    // replyFeedback still appends feedback_provided and returns the topic when it's absent.
    private readonly send?: (workflowId: string, message: string, topic: string, idempotencyKey: string) => Promise<void>,
  ) {}

  // The grounded-plan bootstrap (M5b): an auto-approved [analyze, plan] template. The analyze
  // step is the resolved Analyzer's scout step; the plan step is an auditor api-loop step that
  // authors a plan-note graph and calls finalize_plan. Policy-approved because the human's real
  // gate is the conversational approve inside the plan step, not this scaffold.
  // maxIterations is the PROJECT's agent-loop budget (config.maxIterations), applied here to both
  // template steps rather than by each analyzer: the plan step hardcoded 30 and every subplan
  // inherits it (proposeSplit expands with parentStep.maxIterations), so raising the project
  // ceiling moved nothing below the analyze step. One override, one place, plans stay frozen data.
  async createGroundedTask(input: { title: string; spec: string; modelRef: string; analyzerRef: string; budgetUSD?: number | null; modelCatalog?: ModelOption[]; maxIterations?: number }): Promise<TaskNode> {
    // the title is a LABEL, never the goal — a grounded run without intent would make the
    // analyze/plan agents guess (burning an analyze pass on "what did you mean?")
    const spec = input.spec.trim()
    if (spec === '')
      throw new KernelError(KERNEL_ERROR_CODE.invalid_transition,
        'grounded tasks need a spec — the title is only a label. State the intent: what should happen, constraints, expected outputs.')
    const analyzer = this.analyzers?.get(input.analyzerRef)
    if (!analyzer)
      throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `unknown analyzer '${input.analyzerRef}' — register it or pass a valid analyzerRef`)
    return this.log.transaction(async tx => {
      const task = await this.createTaskIn(tx, { title: input.title, spec, type: 'grounded', budgetUSD: input.budgetUSD })
      const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS
      const analyzeStep: PlanStep = { ...analyzer.analysisStep({ modelRef: input.modelRef, taskSpec: spec }), maxIterations }
      const planStep: PlanStep = {
        id: PLAN_STEP_ID, role: PLAN_STEP_ROLE, title: 'Author the executable plan',
        // the concrete scope + root id, so the authoring agent (which never sees its taskId) and
        // finalize_plan agree on where the plan-note graph lives.
        instructions: `Author the plan-note graph in memory scope '${planScope(task.id)}' with root note id '${MASTERPLAN_NOTE_ID}', iterate with the human via ask_human, then call finalize_plan. Follow the plan-authoring skill.`
          // the planner cannot price a trade-off between models it has never heard of
          + (input.modelCatalog?.length
            ? ` Models you may set as a subplan's modelRef, with their rates: ${input.modelCatalog.map(formatModelOption).join('; ')}. Omit it to inherit '${input.modelRef}'.`
            : ''),
        executorRef: 'api-loop', modelRef: input.modelRef, skillRefs: ['plan-authoring'], toolRefs: [],
        isolation: ISOLATION_TIER.local, zone: [], maxIterations, dependsOn: [analyzeStep.id],
      }
      const draft: PlanDraft = {
        strategyRef: STRATEGY.groundedPlan, analyzerRef: input.analyzerRef, costEstimateUSD: null,
        steps: [analyzeStep, planStep],
      }
      const plan = await this.appendPlanVersion(tx, task.id, draft, EVENT_KIND.plan_proposed, task.status)
      await this.approvePlanIn(tx, task.id, plan.version, { approvedBy: 'policy' })
      return task
    })
  }

  async createTask(input: { title: string; spec?: string; type?: string; parentId?: string; budgetUSD?: number | null }): Promise<TaskNode> {
    return this.log.transaction(tx => this.createTaskIn(tx, input))
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
    approval?: { approvedBy: 'human' | 'policy' | 'mcp'; ruleIndex?: number },
  ): Promise<Plan> {
    return this.log.transaction(tx => this.approvePlanIn(tx, taskId, version, approval))
  }

  async proposeSplit(input: {
    parentTaskId: string; stepId: string; runToken: string; toolCallId: string
    title: string; spec: string; plan: ChildPlanDraftInput; budgetUSD?: number
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

      // no subtree under a TERMINAL parent: an `orc cancel` stamps the parent cancelled under this
      // same project lock, so once that commits a late task_split is refused here — it can never race
      // into an orphaned, auto-approved, unattended running subtree that the cancel sweep (folded
      // before this child existed) never reaches. done/failed are refused for the same reason.
      if (parent.status === TASK_STATUS.cancelled || parent.status === TASK_STATUS.done || parent.status === TASK_STATUS.failed)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot split a '${parent.status}' task — its run is no longer live`)

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
          ...s, executorRef: input.parentStep.executorRef, modelRef: s.modelRef ?? input.parentStep.modelRef,
          // zone is the child's own declaration (write-fence) — parsed default [] = unfenced
          isolation: ISOLATION_TIER.local, zone: s.zone, maxIterations: input.parentStep.maxIterations,
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

  // D6 targeted re-plan, read side (M5b): the plan-authoring agent's read_annotations tool calls
  // this to see what the human flagged — annotatePlan (above) is the write side, this reads the
  // same plan_annotated events straight back off the log (the only source of truth). byTask is
  // seq-ordered, so this returns in chronological order for free.
  // ponytail: returns ALL annotations for the task; a since-marker (skip ones already applied) is
  // a later refinement once multi-round convergence needs it, not now.
  async listAnnotations(taskId: string): Promise<PlanAnnotation[]> {
    const events = await this.log.byTask(taskId)
    return events
      .flatMap(e => {
        if (e.kind !== EVENT_KIND.plan_annotated) return []
        // parsed, not asserted: an annotation whose payload does not parse is not an instruction
        // the plan agent can act on, and passing it through as a shaped lie is worse than dropping it
        const p = PAYLOAD_SCHEMAS.plan_annotated.safeParse(e.payload)
        return p.success ? [{ ...p.data, seq: e.seq }] : []
      })
  }

  // FixE freeze-from-log (M5b): reconstruct the task's plan-note graph from the event log — the
  // source of truth — NOT the eventually-consistent SurrealDB projection. memory_written/deleted
  // events carry taskId:null (scoped by note.scope), so they can't be read via byTask; after() with
  // the memory kinds is how the projector reads them too. finalize_plan folds these into the
  // deterministic executable plan, so the freeze never depends on projection catch-up.
  async listPlanNotes(taskId: string): Promise<PlanNote[]> {
    const events = await this.log.after(0, [EVENT_KIND.memory_written, EVENT_KIND.memory_deleted])
    return foldPlanNotes(events, planScope(taskId))
  }

  // The latest still-open feedback_requested (no later feedback_provided on its topic), or null.
  // Returns it PARSED — every caller needs `topic`, and handing back a raw event made each of them
  // re-assert the payload shape by hand, which is the one thing this codebase does not do at a
  // boundary. The event travels alongside because the reply path resumes its step/run envelope.
  // The ONE derivation shared by openFeedback (read side) and replyFeedback (write side) — so the
  // question a human sees and the topic a reply resolves can never drift apart. byTask is seq-ordered.
  private openRequest(events: EventRecord[]): OpenRequest | null {
    const answers = events.flatMap(e => {
      if (e.kind !== EVENT_KIND.feedback_provided) return []
      const p = PAYLOAD_SCHEMAS.feedback_provided.safeParse(e.payload)
      return p.success ? [{ seq: e.seq, topic: p.data.topic }] : []
    })
    for (const event of [...events].reverse()) {
      if (event.kind !== EVENT_KIND.feedback_requested) continue
      // lenient like every other fold: a payload that does not parse is not a question anyone can
      // answer, so it must not present itself as the open gate and wedge the task
      const p = PAYLOAD_SCHEMAS.feedback_requested.safeParse(event.payload)
      if (!p.success) continue
      if (answers.some(a => a.seq > event.seq && a.topic === p.data.topic)) continue
      return { event, ...p.data }
    }
    return null
  }

  // D4 gate, read side (M5b): the human-facing "what am I replying to?" — the pending question +
  // topic, or null when nothing is open. orc status renders it so the conversational gate isn't
  // one-directional (a human can see the prompt, not just answer a blind topic).
  async openFeedback(taskId: string): Promise<{ topic: string; question: string; noteId?: string } | null> {
    const open = this.openRequest(await this.log.byTask(taskId))
    if (!open) return null
    const { topic, question, noteId } = open
    return { topic, question, ...(noteId ? { noteId } : {}) }
  }

  // The OTHER human gate, and the one nothing ever announced — see projections.gatedChildren for
  // why it is invisible. Observed live (events-pilot.log 161-188: three gated splits, then join,
  // then never another event).
  async gatedChildren(taskId: string): Promise<Array<{ id: string; title: string }>> {
    return gatedChildren(await this.state(), taskId)
  }

  // The gate can be on a DESCENDANT. A step that task_splits and then joins sits inside recv while
  // its child runs, so a child's ask_human lands on the CHILD's stream — and a tail scanning only
  // the root saw no event, armed no park, and waited forever on a run that was waiting on a person.
  // Nearest-first (subtreeTaskIds is breadth-first), so the human answers the shallowest live gate.
  // ponytail: one byTask read per subtree task — fine for a project's trees; index by task if it costs.
  async openFeedbackInSubtree(rootId: string): Promise<{ taskId: string; topic: string; question: string; noteId?: string } | null> {
    for (const id of subtreeTaskIds(await this.state(), rootId)) {
      const open = await this.openFeedback(id)
      if (open) return { taskId: id, ...open }
    }
    return null
  }

  // The hash the human approved, and WHEN — the seq lets finalize_plan name the notes edited since,
  // instead of reporting only that something moved. One derivation of "which approval", so the
  // check and the explanation can never disagree about which one they mean.
  async approvedPlanHash(taskId: string, runToken: string): Promise<{ hash: string; seq: number } | null> {
    for (const event of [...(await this.log.byTask(taskId))].reverse()) {
      if (event.kind !== EVENT_KIND.feedback_provided || event.runToken !== runToken) continue
      const parsed = FeedbackProvidedPayload.safeParse(event.payload)
      if (parsed.success && parsed.data.author.source === 'cli'
        && parsed.data.text.trim().toLowerCase() === 'approve' && parsed.data.planHash)
        return { hash: parsed.data.planHash, seq: event.seq }
    }
    return null
  }

  // Plan-tier note ids written or deleted after `seq` in this task's plan scope — what actually
  // changed since the human approved. "The graph changed" alone sends the agent back to re-ask
  // without knowing which edit cost it a human gate, and it re-edits and re-asks again.
  async planNotesChangedSince(taskId: string, seq: number): Promise<string[]> {
    const scope = planScope(taskId)
    const ids = new Set<string>()
    for (const e of await this.log.after(seq, [EVENT_KIND.memory_written, EVENT_KIND.memory_deleted])) {
      if (e.kind === EVENT_KIND.memory_written) {
        const p = MemoryWrittenPayload.safeParse(e.payload)
        if (p.success && p.data.note.scope === scope && p.data.note.tier === NOTE_TIER.plan) ids.add(p.data.note.id)
      } else {
        const p = MemoryDeletedPayload.safeParse(e.payload)
        if (p.success && p.data.scope === scope) ids.add(p.data.id)
      }
    }
    return [...ids]
  }

  // D4 conversational gate, human side: answers the latest still-open feedback_requested and resumes
  // the step workflow parked on DBOS.recv(`feedback:<topic>`, 60) — that workflow's id is the event's
  // own envelope runToken, recorded by the port from inside the step (never reconstructed here).
  // Returns the resolved topic, or null if the task has no open question (the CLI reports either).
  // `via` names the DOOR the answer arrived through, and defaults to the terminal. It is recorded
  // rather than assumed because for a GROUNDED task the conversational 'approve' answered here IS
  // the human gate — createGroundedTask policy-approves the scaffold precisely because "the human's
  // real gate is the conversational approve inside the plan step" — so who sent it decides whether
  // a plan was approved by a person or by an agent driving the MCP surface.
  async replyFeedback(taskId: string, text: string, via: MemoryAuthor['source'] = 'cli'): Promise<string | null> {
    const open = await this.log.transaction(async tx => {
      const task = await this.requireTask(tx, taskId)
      const requested = this.openRequest(await tx.byTask(taskId))
      if (!requested) return null
      const { topic, event } = requested
      if (!event.stepId || !event.runToken)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `feedback_requested for topic '${topic}' has no step/run envelope to resume`)
      const approvingPlan = task.type === 'grounded' && event.stepId === PLAN_STEP_ID
        && text.trim().toLowerCase() === 'approve'
      const planHash = approvingPlan
        ? planGraphHash(foldPlanNotes(
          await tx.after(0, [EVENT_KIND.memory_written, EVENT_KIND.memory_deleted]),
          planScope(taskId),
        ))
        : undefined
      const payload = FeedbackProvidedPayload.parse({
        topic, text, author: { source: via }, ...(planHash && { planHash }),
      })
      const provided = await tx.append({
        taskId, stepId: event.stepId, runToken: event.runToken,
        kind: EVENT_KIND.feedback_provided, payload,
        idempotencyKey: `feedback:${event.seq}:provided`,
      })
      return { topic, runToken: event.runToken, seq: provided.seq }
    })
    if (!open) return null
    await this.send?.(open.runToken, text, `feedback:${open.topic}`, `feedback:${open.seq}`)
    return open.topic
  }

  // D3 read side (M5b): the latest analysis_completed for the task (the scout's coverage self-report),
  // or null before any. orc status renders it so a grounded task shows what its analysis covered and,
  // crucially, the gaps it did NOT — the read half of the emitter below.
  async latestCoverage(taskId: string): Promise<AnalysisCompletedPayload | null> {
    const last = [...(await this.log.byTask(taskId))].reverse().find(e => e.kind === EVENT_KIND.analysis_completed)
    return last ? AnalysisCompletedPayload.parse(last.payload) : null
  }

  // D3/RG7 emitter (M5b): the analyze (scout) step self-reports its CoverageReport before signaling
  // success — the report_coverage tool's write side. Carries the step's runToken for provenance;
  // orc status reads the latest back off the log. Degradation (analyzed:false) is a valid report.
  async reportCoverage(ctx: { taskId: string; stepId: string; runToken: string }, coverage: unknown): Promise<void> {
    return this.log.transaction(async tx => {
      await this.requireTask(tx, ctx.taskId)
      const payload = AnalysisCompletedPayload.parse(coverage)
      await tx.append({ taskId: ctx.taskId, stepId: ctx.stepId, runToken: ctx.runToken, kind: EVENT_KIND.analysis_completed, payload })
    })
  }

  // The client half of starting a run: record the ask. A supervisor turns it into a workflow.
  // The caller has already checked the task is drivable — this refuses an unknown task only, so
  // the event can never name something that does not exist.
  // Returns the recorded ask's seq: a client that then watches needs to tell "the supervisor has
  // not reacted yet" from "the run is over", and the only difference between those two is whether
  // anything happened after this event.
  async requestRun(taskId: string, opts: { cwd?: string; retry?: boolean } = {}): Promise<number> {
    return this.log.transaction(async tx => {
      await this.requireTask(tx, taskId)
      const requested = await tx.append({
        taskId, stepId: null, runToken: null, kind: EVENT_KIND.run_requested,
        payload: RunRequestedPayload.parse({ taskId, cwd: opts.cwd ?? null, retry: opts.retry ?? false }),
      })
      return requested.seq
    })
  }

  // The append half of a cancel, split out of dbos-port.cancelRun so a client with no execution
  // port can still stop a run: the supervisor sees each cancelled status and cancels the DBOS
  // workflows behind it. Children before parents, so a parent gate-waiting on a child sees the
  // child resolve first — the same order cancelRun already used. Re-checks under the write lock,
  // so a run that finished in the meantime keeps its real terminal status.
  async cancelSubtree(taskId: string): Promise<string[]> {
    const state = await this.state()
    const ids = subtreeTaskIds(state, taskId).reverse()
    const stamped: string[] = []
    for (const id of ids) {
      await this.log.transaction(async tx => {
        const status = fold(await tx.byTask(id)).tasks.get(id)?.status
        if (status === undefined || TERMINAL_TASK_STATUS.has(status)) return
        await tx.append({
          taskId: id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
          payload: { taskId: id, from: status, to: TASK_STATUS.cancelled },
        })
        stamped.push(id)
      })
    }
    return stamped
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
    input: { title: string; spec?: string; type?: string; parentId?: string; budgetUSD?: number | null },
  ): Promise<TaskNode> {
    const parent = input.parentId ? await this.requireTask(tx, input.parentId) : null
    const task: TaskNode = {
      id: randomUUID(), parentId: parent?.id ?? null, type: input.type ?? 'generic',
      title: input.title, spec: input.spec ?? '', status: TASK_STATUS.draft, zone: [],
      budgetUSD: input.budgetUSD ?? parent?.budgetUSD ?? null,
      depth: parent ? parent.depth + 1 : 0, createdAt: new Date().toISOString(),
    }
    await this.append(tx, task.id, EVENT_KIND.task_created, { task })
    return task
  }

  private async approvePlanIn(
    tx: EventLogOps,
    taskId: string,
    version?: number,
    approval?: { approvedBy: 'human' | 'policy' | 'mcp'; ruleIndex?: number },
  ): Promise<Plan> {
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
