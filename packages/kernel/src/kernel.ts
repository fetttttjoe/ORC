import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import path from 'node:path'
import { MASTERPLAN_NOTE_ID,
  AnalysisCompletedPayload, ApprovedBy, CHECKS_STEP_ID, ChildPlanDraft, EVENT_KIND, FINISH_STEP_ID, FeedbackProvidedPayload, GroundedApprovalDoor, IsolationTier, MemoryDeletedPayload, MemoryWrittenPayload, NOTE_TIER, PAYLOAD_SCHEMAS, PlanAnnotatedPayload, PlanDraft, RunRequestedPayload, STEP_ROLE, STRATEGY, TASK_STATUS, TERMINAL_TASK_STATUS, WORKSPACE_TITLE_MAX, Workspace, WorkspaceArchivedPayload, WorkspaceMergedPayload, WorkspaceRetitledPayload, evaluateApproval, feedbackKey, formatModelOption, isApprovalAnswer, openFeedbackTopics, validatePlan, type ChildPlanDraftInput, type ModelOption,
  type Analyzer, type ApprovalPolicy, type EventDraft, type EventKind, type EventRecord,
  type PlanNote, type Plan, type PlanStep, type TaskNode, type TaskStatus,
  type WorkspaceKind, authorSourceOf, directoryZoneEntries, type Origin,
} from '@orc/contracts'
import { foldPlanNotes, planApprovalStamp, planGraphHash, planScope, PLAN_STEP_ID, PLAN_STEP_ROLE } from './execution/strategies/grounded-plan'
import { kernelStepExecutorRef, reconcileFinishStep } from './finish-step'
import { DEFAULT_MAX_ITERATIONS } from './config'
import { EventLog, type EventLogOps } from './storage'
import { estimateCostUSD, fold, gatedChildren, subtreeTaskIds, subtreeUsage, taskChangedPaths, taskNoteWrites, taskVerifiedNotes, type State, type TaskNoteWrite, type TaskVerifiedNote } from './projections'
import { applyArchived, applyRetitle, workspaceByCwd, workspaceCwdFor } from './workspaces'
import { KERNEL_ERROR_CODE, KernelError } from './errors'

// D6 targeted re-plan (M5b): what listAnnotations hands back to the read_annotations tool — the
// plan_annotated payload plus the event's own seq, so the agent can order/dedupe across rounds.
export type PlanAnnotation = PlanAnnotatedPayload & { seq: number }

// `cwd` is the workspace's NATURAL KEY, so both mint points normalize it through here: '/repo' and
// '/repo/' are one directory, and two live records for it make workspaceByCwd answer whichever was
// minted first (and the duplicate guard wave the second one through). Normalization is SYNTACTIC
// only — resolving symlinks needs the filesystem, and stays with the adopting caller, which already
// realpaths the directory before it gets here. An empty cwd would resolve to the PROCESS's own
// directory, minting a record for a directory nobody named, so it is refused instead.
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

// Who authored a split's plan draft. Omitted = 'agent' (fail closed): only the kernel's own freeze
// (finalize_plan → withCommitStep) may claim it, and only that origin may carry the committer role.
export const SPLIT_ORIGIN = { agent: 'agent', freeze: 'freeze' } as const
export type SplitOrigin = (typeof SPLIT_ORIGIN)[keyof typeof SPLIT_ORIGIN]

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
    // OPERATOR-owned: the author.source values that satisfy the grounded plan-approval gate, from
    // config.groundedApprovalDoors (contracts' GroundedApprovalDoor). Default = today's exact
    // behaviour, 'cli' alone, which also covers the web UI (its replies record 'cli'). Public and
    // readonly because the refusal message has to name the SAME list the gate tests — a message
    // built from its own copy is a message that can advise a door the gate rejects. Widening this
    // lets the driving agent approve plans it authored, which is why it is a config file edit.
    readonly approvalDoors: readonly string[] = [GroundedApprovalDoor.cli],
    private readonly finishChecks: readonly string[] = [],
  ) {}

  // The grounded-plan bootstrap (M5b): an auto-approved [analyze, plan] template. The analyze
  // step is the resolved Analyzer's scout step; the plan step is an auditor api-loop step that
  // authors a plan-note graph and calls finalize_plan. Policy-approved because the human's real
  // gate is the conversational approve inside the plan step, not this scaffold.
  // maxIterations is the PROJECT's agent-loop budget (config.maxIterations), applied here to both
  // template steps rather than by each analyzer: the plan step hardcoded 30 and every subplan
  // inherits it (proposeSplit expands with parentStep.maxIterations), so raising the project
  // ceiling moved nothing below the analyze step. One override, one place, plans stay frozen data.
  // `workspaceId`: same rule as createTask — optional in the type only so a child inherits.
  async createGroundedTask(input: { title: string; spec: string; modelRef: string; analyzerRef: string; parentId?: string; budgetUSD?: number | null; workspaceId?: string; modelCatalog?: ModelOption[]; maxIterations?: number }, origin: Origin): Promise<TaskNode> {
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
      const task = await this.createTaskIn(tx, { title: input.title, spec, type: 'grounded', parentId: input.parentId, budgetUSD: input.budgetUSD, workspaceId: input.workspaceId }, origin)
      const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS
      const analyzeStep: PlanStep = { ...analyzer.analysisStep({ modelRef: input.modelRef, taskSpec: spec }), maxIterations, readOnlySource: true }
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
        isolation: IsolationTier.local, zone: [], maxIterations, dependsOn: [analyzeStep.id], readOnlySource: true,
      }
      // What this grounded task is likely to cost, from what comparable grounded tasks ACTUALLY
      // cost (projections.estimateCostUSD) — the plan-approval door printed 'none provided' for
      // every plan because this literal was null. Null still means null: no comparable history
      // yet, and the door says so rather than showing a made-up figure.
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

  // `workspaceId` is required in practice and optional in the type only so a child can inherit its
  // parent's (createTaskIn). Omitting it without a parentId is a KernelError, not a default.
  async createTask(input: { title: string; spec?: string; type?: string; parentId?: string; budgetUSD?: number | null; workspaceId?: string }, origin: Origin): Promise<TaskNode> {
    return this.log.transaction(tx => this.createTaskIn(tx, input, origin))
  }

  async proposePlan(taskId: string, draft: PlanDraft, origin: Origin): Promise<Plan> {
    return this.log.transaction(async tx => {
      const task = await this.requireTask(tx, taskId)
      if (task.status !== TASK_STATUS.draft)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot propose a plan while task is '${task.status}'`)
      // The finish step rides every ROOT plan from the moment it is proposed, so the human approves
      // the shape that actually runs — the same reason freezePlan appends before the approval
      // render. WHICH plans get one is finish-step.ts's rule (plansGetFinishStep), shared with
      // editPlan below so a proposed plan and its edit can never end differently.
      return this.appendPlanVersion(tx, taskId, reconcileFinishStep(task, draft, { checks: this.finishChecks }), EVENT_KIND.plan_proposed, task.status, origin)
    })
  }

  async editPlan(taskId: string, draft: PlanDraft, origin: Origin): Promise<Plan> {
    return this.log.transaction(async tx => {
      const task = await this.requireTask(tx, taskId)
      // `blocked` is editable, not just `awaiting_approval`: a plan froze a step whose zone entry
      // could match no path, so the step could not write the files it was spawned to write, and the
      // task settled blocked holding a DEFECTIVE plan. Retrying re-ran the same broken plan and this
      // guard refused the only correction, so the sole exit was cancelling the task and discarding
      // the steps that had already succeeded. Repair is now edit → approve → run: appendPlanVersion
      // stamps blocked → awaiting_approval, the next run resolves the newly approved version, and
      // completed steps are skipped. Every OTHER status stays refused with this same error — a
      // draft has nothing to edit, and a running or terminal task must not have the plan under it
      // swapped mid-flight.
      if (task.status !== TASK_STATUS.awaiting_approval && task.status !== TASK_STATUS.blocked)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot edit a plan while task is '${task.status}'`)
      // The SAME rule proposePlan applies, and it has to be: a human edits the RENDERED plan, which
      // already carries the kernel's finish step, so appending blindly would double it — and an
      // edit written from scratch (orc edit --file) would otherwise drop it silently, leaving a
      // task that never reconciles its notes. reconcileFinishStep strips the kernel's own trailing
      // step and re-derives it, so the edited plan ends exactly where the proposed one did.
      return this.appendPlanVersion(tx, taskId, reconcileFinishStep(task, draft, { checks: this.finishChecks }), EVENT_KIND.plan_edited, task.status, origin)
    })
  }

  // `version` and `approval` stay positional but lose their `?`: origin is required and LAST, and a
  // required parameter cannot follow an optional one (TS1016) — callers pass undefined explicitly.
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
      // The committer role arms git_commit (commit-tool's registration gate) and the finisher role
      // arms the finish step's knowledge-authoring tools (stepMayReconcile), so only the kernel's
      // own freeze may set either. Without this, any implementer could split off an auto-approved
      // child claiming the role: committer commits unreviewed work — with autoCommit off, and no
      // verify anywhere — and finisher records decisions the human never saw. The step ID is
      // reserved alongside the role because stepMayReconcile keys on BOTH terms: a split step named
      // 'finish' would shadow the kernel's own in every id-keyed read (status renders, resume).
      if (input.authoredBy !== SPLIT_ORIGIN.freeze) {
        const reserved = draft.steps.find(s => s.role === STEP_ROLE.committer || s.role === STEP_ROLE.finisher || s.id === FINISH_STEP_ID || s.id === CHECKS_STEP_ID)
        if (reserved)
          throw new KernelError(KERNEL_ERROR_CODE.invalid_transition,
            reserved.role === STEP_ROLE.committer
              ? `step '${reserved.id}' claims role '${STEP_ROLE.committer}', which only the kernel's autoCommit freeze may set — remove it from the split; the commit step is appended for you when the pipeline commits`
              : `step '${reserved.id}' claims the kernel-set ${reserved.role === STEP_ROLE.finisher ? `role '${STEP_ROLE.finisher}'` : `step id '${reserved.id}'`} — remove it from the split; the kernel appends that step itself at the end of the pipeline this split belongs to`)
      }
      const child: TaskNode = {
        // a split runs in the same checkout its parent step is running in — inherited, never
        // re-derived, so a subtree can never straddle two working directories
        id: childTaskId, parentId: parent.id, workspaceId: parent.workspaceId, type: 'split', title: input.title, spec: input.spec,
        status: TASK_STATUS.draft, zone: [], budgetUSD, depth: parent.depth + 1,
        createdAt: new Date().toISOString(),
      }
      await this.append(tx, child.id, { kind: EVENT_KIND.task_created, payload: { task: child } }, origin)
      await this.append(tx, input.parentTaskId, {
        kind: EVENT_KIND.split_proposed,
        payload: { splitId, taskId: input.parentTaskId, stepId: input.stepId, runToken: input.runToken, childTaskId },
      }, origin)

      // expand the trimmed draft with inherited refs (spec D3) and propose+maybe-approve
      const expanded: PlanDraft = {
        // measured history for splits, same rule as the grounded door (estimateCostUSD): the mean
        // subtree cost of past terminal split tasks, or null when none has settled yet. Feeds the
        // human's plan-approval render AND evaluateApproval's maxCostUSD rules below, which could
        // never fire while this was hardcoded null.
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

  // D5 human annotation on a plan-note (M5b): an input event only — the plan-authoring agent
  // reads it and re-renders on its next revise. No fold/state change of its own.
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

  // Audit scoped change set (log-derived): the paths THIS task's steps wrote, folded purely from
  // the event log so the auditor never has to trust git. Covers the task AND its descendant split
  // tasks — a sibling step may delegate its writes to a child task, and those writes are still this
  // task's changes — by reading log.byTask per subtree id and merging. Each result carries the
  // owning taskId plus the contributing steps (stepId/tool/seq).
  // This is a MEMBERSHIP projection with exactly ONE use: distinguishing this task's declared-zone
  // changes from sibling-task pollution in the scope-cleanliness check. It is a FLOOR (exec-driven
  // writes are uncaptured), never a complete diff, and NEVER a substitute for the full bun test /
  // bun run typecheck gate — the role-auditor skill contract's "any defect ⇒ signal failure" stays unqualified.
  async listTaskChangedPaths(taskId: string): Promise<Array<{ path: string; taskId: string; steps: Array<{ stepId: string | null; tool: string; seq: number }> }>> {
    const ids = subtreeTaskIds(await this.state(), taskId)
    const out: Array<{ path: string; taskId: string; steps: Array<{ stepId: string | null; tool: string; seq: number }> }> = []
    for (const id of ids)
      for (const changed of taskChangedPaths(await this.log.byTask(id)))
        out.push({ path: changed.path, taskId: id, steps: changed.steps })
    return out
  }

  // The restamp set for git_commit: semantic notes this task's subtree wrote, from the log (same
  // memory-kind read as listPlanNotes — memory events carry taskId:null, byTask can't see them).
  // Each row says whether the write HEALED an existing note; only those earn a stamp.
  async listTaskNoteWrites(taskId: string): Promise<TaskNoteWrite[]> {
    const subtree = new Set(subtreeTaskIds(await this.state(), taskId))
    return taskNoteWrites(await this.log.after(0, [EVENT_KIND.memory_written, EVENT_KIND.memory_deleted]), subtree)
  }

  // The reverify set for git_commit: notes a step of this task's subtree DECLARED verified. Reads
  // memory_written too, for the declared paths the post-commit dirty gate judges — a memory_verified
  // carries none, and the note it names always has a write behind it (store.verify refuses an id
  // the log has no live note for). Each row also carries the stamp's own revision — the tree the
  // auditor read — which is what the commit step's strict reverify gate diffs the cited paths against.
  async listTaskVerifiedNotes(taskId: string): Promise<TaskVerifiedNote[]> {
    const subtree = new Set(subtreeTaskIds(await this.state(), taskId))
    const kinds = [EVENT_KIND.memory_written, EVENT_KIND.memory_verified, EVENT_KIND.memory_deleted]
    return taskVerifiedNotes(await this.log.after(0, kinds), subtree)
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
    // WHICH questions are still open is feedback-open.ts's rule, shared with the workspace health
    // rung so the gate a human sees in `ws ls` and the gate a reply resolves cannot disagree. What
    // stays here is the part only this caller needs: the LATEST open one, with its event, because a
    // reply resumes that event's step/run envelope.
    const open = openFeedbackTopics(events)
    for (const event of [...events].reverse()) {
      if (event.kind !== EVENT_KIND.feedback_requested) continue
      // lenient like every other fold: a payload that does not parse is not a question anyone can
      // answer, so it must not present itself as the open gate and wedge the task
      const p = PAYLOAD_SCHEMAS.feedback_requested.safeParse(event.payload)
      if (!p.success) continue
      // A project-level event names no task and can hold no question. Unreachable through both
      // callers (byTask returns one task's stream), so it is a guard rather than an assertion —
      // narrowing the type is what removes the non-null assertion the key would otherwise need.
      if (event.taskId === null) continue
      if (!open.has(feedbackKey(event.taskId, p.data.topic))) continue
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
  // why it is invisible. Observed live: three gated splits, then join,
  // then never another event.
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

  // The scan + parse + isApprovalAnswer + planHash predicate approvedPlanHash and
  // nonHumanPlanApproval both need — they read the SAME feedback_provided events for this
  // (taskId, runToken) and differ only in which door they accept, so the read happens once, here.
  // Newest first (reverse log order): both callers want the MOST RECENT matching answer. What
  // counts as an approving answer comes from isApprovalAnswer (contracts/approval-answer.ts) — it
  // must be the SAME predicate replyFeedback stamped with, or this read finds nothing the writer left.
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

  // The hash the human approved, and WHEN — the seq lets finalize_plan name the notes edited since,
  // instead of reporting only that something moved. One derivation of "which approval", so the
  // check and the explanation can never disagree about which one they mean.
  async approvedPlanHash(taskId: string, runToken: string): Promise<{ hash: string; seq: number } | null> {
    const found = (await this.planApprovals(taskId, runToken)).find(a => this.approvalDoors.includes(a.source))
    return found ? { hash: found.hash, seq: found.seq } : null
  }

  // The approval approvedPlanHash THREW AWAY, and which door it came through — inverted on exactly
  // one term: the author.source is NOT in this.approvalDoors, the very list the gate accepts, so a
  // door an operator opened can never be both accepted and reported as the reason for a refusal.
  // Deliberately a SIBLING read rather than a widened return on
  // approvedPlanHash: that function IS the gate, and a refusal message must never be a reason to
  // touch what satisfies it. Nothing here decides anything — finalize_plan calls it only after
  // approvedPlanHash already said no, to tell "nobody approved" from "an agent approved through
  // the MCP door", which the log records identically apart from this field. Reports the source it
  // actually found, so the message can name the door instead of guessing 'mcp'.
  async nonHumanPlanApproval(taskId: string, runToken: string): Promise<{ source: string } | null> {
    const found = (await this.planApprovals(taskId, runToken)).find(a => !this.approvalDoors.includes(a.source))
    return found ? { source: found.source } : null
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
  // The ANSWERER's door names the author source (authorSourceOf), and it is recorded rather than
  // assumed because for a GROUNDED task the conversational approval answered here IS
  // the human gate — createGroundedTask policy-approves the scaffold precisely because "the human's
  // real gate is the conversational approve inside the plan step" — so who sent it decides whether
  // a plan was approved by a person or by an agent driving the MCP surface.
  // Which answers count is isApprovalAnswer's alone (contracts/approval-answer.ts): the word used to
  // be a bare literal here AND a second copy in the browser bundle, and a human who typed "agree"
  // was silently given ordinary feedback instead of the gate they meant to open.
  async replyFeedback(taskId: string, text: string, origin: Origin): Promise<string | null> {
    const open = await this.log.transaction(async tx => {
      const task = await this.requireTask(tx, taskId)
      const requested = this.openRequest(await tx.byTask(taskId))
      if (!requested) return null
      const { topic, event } = requested
      if (!event.stepId || !event.runToken)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `feedback_requested for topic '${topic}' has no step/run envelope to resume`)
      const approvingPlan = planApprovalStamp(task, event, text)
      const planHash = approvingPlan
        ? planGraphHash(foldPlanNotes(
          await tx.after(0, [EVENT_KIND.memory_written, EVENT_KIND.memory_deleted]),
          planScope(taskId),
        ))
        : undefined
      const payload = FeedbackProvidedPayload.parse({
        // workspaceId off the TASK, which requireTask above already has in hand: an answer belongs
        // to the checkout the task is being worked in, not to wherever the person answering happens
        // to be sitting — the web and MCP doors can both reply to a task in another worktree.
        // the author's own origin is the ANSWERER's, not the question's: MemoryAuthor.origin says
        // where the write came from, and omitting it made FeedbackProvidedPayload.parse throw.
        topic, text, author: { source: authorSourceOf(origin.door), workspaceId: task.workspaceId, origin }, ...(planHash && { planHash }),
      })
      // The QUESTION's chat, the ANSWERER's door: the reply belongs to the interaction that asked,
      // and a reply threaded into the answerer's own chat would leave the gate's transcript with a
      // question nobody ever answered.
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
  async reportCoverage(ctx: { taskId: string; stepId: string; runToken: string }, coverage: unknown, origin: Origin): Promise<void> {
    return this.log.transaction(async tx => {
      await this.requireTask(tx, ctx.taskId)
      const payload = AnalysisCompletedPayload.parse(coverage)
      await this.append(tx, ctx.taskId, { kind: EVENT_KIND.analysis_completed, payload }, origin, { stepId: ctx.stepId, runToken: ctx.runToken })
    })
  }

  // The client half of starting a run: record the ask. A supervisor turns it into a workflow.
  // The caller has already checked the task is drivable — this refuses an unknown task only, so
  // the event can never name something that does not exist.
  // Returns the recorded ask's seq: a client that then watches needs to tell "the supervisor has
  // not reacted yet" from "the run is over", and the only difference between those two is whether
  // anything happened after this event.
  async requestRun(taskId: string, opts: { cwd?: string; retry?: boolean }, origin: Origin): Promise<number> {
    return this.log.transaction(async tx => {
      const state = await this.stateOf(tx)
      const task = this.requireTaskIn(state, taskId)
      // Resolved HERE, not in the port: the port folds per task (byTask) and never sees the
      // project-level workspace events, so the workspace's cwd is recorded into the request and
      // the port's own chain (override → inherited → project dir) stays exactly as it was.
      const cwd = opts.cwd ?? workspaceCwdFor(task, state.workspaces)
      // null means ORPHAN — the task names a workspace the log never recorded. Recording null
      // would send the run to the project directory as if nothing were wrong; the operator needs
      // to see that the workspace record is missing.
      if (cwd === null)
        throw new KernelError(KERNEL_ERROR_CODE.workspace_not_found,
          `task '${taskId}' names workspace '${task.workspaceId}', which is not in the log — pass --cwd to run it anyway`)
      const requested = await this.append(tx, taskId,
        { kind: EVENT_KIND.run_requested, payload: RunRequestedPayload.parse({ taskId, cwd, retry: opts.retry ?? false }) }, origin)
      return requested.seq
    })
  }

  // The append half of a cancel, split out of dbos-port.cancelRun so a client with no execution
  // port can still stop a run: the supervisor sees each cancelled status and cancels the DBOS
  // workflows behind it. Children before parents, so a parent gate-waiting on a child sees the
  // child resolve first — the same order cancelRun already used. Folded inside the transaction,
  // so a run that finished in the meantime keeps its real terminal status.
  // ONE transaction, not one per task: the sweep used to snapshot the subtree first and stamp in
  // separate transactions, and a task_split committed mid-sweep by a still-running ancestor step
  // created an auto-approved child the stale snapshot never saw — the router started the orphan's
  // run AFTER the cancel completed. Under the project write lock a split lands either before the
  // sweep (its child is in the fold, so it gets stamped) or after commit, where proposeSplit's
  // terminal-parent guard refuses it — every subtree task is terminal by then.
  async cancelSubtree(taskId: string, origin: Origin): Promise<string[]> {
    return this.log.transaction(async tx => {
      const state = await this.stateOf(tx)
      const stamped: string[] = []
      for (const id of subtreeTaskIds(state, taskId).reverse()) {
        const status = state.tasks.get(id)?.status
        if (status === undefined || TERMINAL_TASK_STATUS.has(status)) continue
        // A running task's end belongs to the RUN's chat — that transcript is where the cancelled
        // status is read back from — while the door stays the canceller's, who is not the supervisor.
        const run = status === TASK_STATUS.running ? state.runs.get(id)?.at(-1) : undefined
        await this.append(tx, id,
          { kind: EVENT_KIND.task_status_changed, payload: { taskId: id, from: status, to: TASK_STATUS.cancelled } },
          run ? { chatId: run.workflowId, door: origin.door } : origin)
        stamped.push(id)
      }
      return stamped
    })
  }

  // ── Workspaces ────────────────────────────────────────────────────────────────────────────────
  // Adoption: the first orc command in ANY checkout records it, so a worktree becomes a workspace by
  // being used and nothing is ever registered by hand. Idempotent on the exact cwd among ACTIVE
  // records (workspaces.ts workspaceByCwd) — an archived one at the same path is finished business
  // and a new record is minted beside it.
  //
  // An existing record is returned UNCHANGED: `branch`, `onTrunk`, `kind` and `title` are the values
  // that record was MINTED with, and the ones passed here are DISCARDED. That is deliberate and not
  // a cheap idempotency — a difference has two opposite readings (the checkout really moved, or this
  // adoption raced a branch switch), and only the caller knows which. `created: false` plus the
  // record it found is what lets it decide; adoptCwd archives and re-adopts on a branch change.
  //
  // `managed` and `baseBranch` are OPTIONAL, defaulting to the adoption answer (false / null): a
  // directory orc merely walked into is not orc's to delete, and it was cut from nothing orc knows.
  // They exist for the ONE caller that is not discovering a directory but REPLACING a record for it —
  // the re-adoption above, which holds the prior record and is the only place those two facts can
  // come from. Derived they cannot be: nothing on disk says orc created this tree. Dropped, an
  // `orc ws new` worktree that switched branches would come back unmanaged, and `archive --remove`
  // would refuse to delete a tree orc had made itself. Still NOT a general update door — it mints or
  // it returns what it found, and `createWorkspace` remains the deliberate half.
  async ensureWorkspace(input: {
    cwd: string; branch: string | null; kind: WorkspaceKind; onTrunk: boolean; title?: string
    managed?: boolean; baseBranch?: string | null
  }, origin: Origin): Promise<{ workspace: Workspace; created: boolean }> {
    const cwd = workspaceCwdKey(input.cwd)
    return this.log.transaction(async tx => {
      const existing = workspaceByCwd((await this.stateOf(tx)).workspaces, cwd)
      if (existing) return { workspace: existing, created: false }
      // The DERIVED title is truncated, never refused. Adoption runs at BOOT, so a branch longer
      // than WORKSPACE_TITLE_MAX (or, on a detached HEAD, a very long directory name) would make
      // Workspace.parse throw and every single orc command in that checkout would fail before it
      // reached its own handler. An explicit title is the caller's own and still parses on its
      // own terms — an operator who typed one too long gets told, not silently shortened.
      const derived = (input.branch ?? path.basename(cwd)).slice(0, WORKSPACE_TITLE_MAX)
      const workspace = Workspace.parse({
        // a detached HEAD has no branch to name the workspace after, so the directory does it —
        // an untitled record would be a row the operator cannot tell from any other
        id: randomUUID(), title: input.title ?? derived, cwd,
        branch: input.branch, baseBranch: input.baseBranch ?? null, kind: input.kind,
        managed: input.managed ?? false, onTrunk: input.onTrunk,
        createdAt: new Date().toISOString(), archivedAt: null,
      })
      await this.appendProjectEvent(tx, { kind: EVENT_KIND.workspace_created, payload: { workspace } }, origin)
      return { workspace, created: true }
    })
  }

  // The deliberate half: orc created the directory (a `git worktree add`), so `managed` is the
  // caller's to declare — it is the fact that later licenses `git worktree remove`.
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

  // Re-seat a record that ALREADY EXISTED, under its original id. `orc purge` deletes every event,
  // workspace_created included, and then re-seeds the project's identity notes — whose MemoryAuthor
  // has to name a workspace the log still carries, and has to name the SAME one the notes were
  // written against. Re-adopting instead would mint a fresh uuid for that directory and orphan them.
  //
  // Through the kernel rather than a raw `log.append` at the call site, because the kernel is the
  // ONE writer of workspace records and the "no two ACTIVE records share a cwd" rule only holds
  // when the check and the append share a transaction: a boot adoption racing the purge would
  // otherwise leave two live records for one directory, and workspaceByCwd answers whichever it
  // finds first. Re-parsed on the way in — the caller is handing back a value it read before a
  // wipe, which is exactly when a half-stale shape reaches a writer.
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

  // `archived` is a PARAMETER, not two methods — the same rule `orc memory archive/restore` follows,
  // so restore cannot drift from archive. A SETTER, not a transition: re-archiving re-stamps
  // archivedAt and restoring a live record appends a no-op, both deliberately allowed — an operator
  // correcting a record must not have to know its current state, and the fold is idempotent either way.
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

  // The "commit" of the workspace transaction: the branch landed on trunk. Recorded ONCE — a reader
  // derives from this event alone (contracts' WorkspaceMergedPayload), so a second merge naming a
  // different commit for the same landing would answer differently depending on which one it folded.
  async mergeWorkspace(id: string, input: { mergeCommit: string; trunk: string }, origin: Origin): Promise<WorkspaceMergedPayload> {
    return this.log.transaction(async tx => {
      // ONE fold for both facts: this reads the workspace AND its merge, and stateOf refolds the
      // whole log per call.
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
    // `workspaceId` is optional in the TYPE for exactly one reason: a child may omit it and inherit
    // its parent's. TaskNode.workspaceId is required, and a root task that names none is refused
    // below — a default here would silently bind work to a workspace nobody chose.
    input: { title: string; spec?: string; type?: string; parentId?: string; budgetUSD?: number | null; workspaceId?: string },
    origin: Origin,
  ): Promise<TaskNode> {
    // ONE fold for both facts this needs — the parent (inheritance) and the workspace record.
    // stateOf refolds the whole log per call, so asking requireTask and requireWorkspace for their
    // own would pay for the same fold twice on every task creation.
    const state = await this.stateOf(tx)
    const parent = input.parentId ? this.requireTaskIn(state, input.parentId) : null
    const workspaceId = input.workspaceId ?? parent?.workspaceId
    if (workspaceId === undefined)
      throw new KernelError(KERNEL_ERROR_CODE.workspace_not_found,
        'a task needs a workspace — pass workspaceId (a child inherits its parent\'s)')
    this.requireWorkspace(state, workspaceId)
    const task: TaskNode = {
      id: randomUUID(), parentId: parent?.id ?? null, workspaceId, type: input.type ?? 'generic',
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

  // The ONE envelope spelling in this file: every verb's origin is spread here, so a new verb
  // cannot reach the log without naming the interaction and door it came from.
  private async append(
    ops: EventLogOps, taskId: string, draft: EventDraft, origin: Origin,
    extra: { stepId?: string; runToken?: string } = {},
  ): Promise<EventRecord> {
    return ops.append({
      ...origin, taskId, stepId: extra.stepId ?? null, runToken: extra.runToken ?? null, ...draft,
    })
  }

  // A project-level event carries NO task binding — the envelope's taskId is null by design (the
  // same shape models_discovered and commit_recorded already use), so `append` above, which demands
  // a task id, cannot express it.
  private async appendProjectEvent(ops: EventLogOps, draft: EventDraft, origin: Origin): Promise<void> {
    await ops.append({ ...origin, taskId: null, stepId: null, runToken: null, ...draft })
  }

  private async requireTask(ops: EventLogOps, id: string): Promise<TaskNode> {
    return this.requireTaskIn(await this.stateOf(ops), id)
  }

  // requireWorkspace's shape, for the same reason: a caller that already holds a fold (createTaskIn
  // needs the parent AND the workspace out of one) must not pay for a second one to ask this.
  private requireTaskIn(state: State, id: string): TaskNode {
    const t = state.tasks.get(id)
    if (!t) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${id}'`)
    return t
  }

  // Takes the STATE, not the log ops (requireTask's shape): every workspace caller already holds a
  // fold, and mergeWorkspace checks two facts out of it — folding the whole log twice to answer one
  // question is a cost the shape, not the caller, would impose.
  private requireWorkspace(state: State, id: string): Workspace {
    const w = state.workspaces.get(id)
    if (!w) throw new KernelError(KERNEL_ERROR_CODE.workspace_not_found, `no workspace '${id}'`)
    return w
  }
}
