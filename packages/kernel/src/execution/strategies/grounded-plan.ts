import { createHash } from 'node:crypto'
import { COMMIT_STEP_ID, EVENT_KIND, MASTERPLAN_NOTE_ID, PAYLOAD_SCHEMAS, PlanNote, PlanNoteToolName, ROLE_SKILL, STEP_ID, STEP_ROLE, STRATEGY, TaskType, VERIFY_STEP_ID, isApprovalAnswer, type ChildPlanDraft, type EventRecord, type TaskNode } from '@orc/contracts'
import { withFinishStep } from '../../finish-step'

// the grounded plan step's role, stamped by createGroundedTask
export const PLAN_STEP_ROLE = STEP_ROLE.auditor

// Its step id, stamped by createGroundedTask — one source, so the step that must produce a plan and
// the check that it did cannot drift apart.
export const PLAN_STEP_ID = STEP_ID.plan

// the line a frozen step's instructions and the split's spec carry the plan's rationale on
export const WHY_PREFIX = 'Why: '

// True when a feedback answer IS the grounded-plan approval: sent to this strategy's plan step, on
// a grounded task, using the approval word (isApprovalAnswer, contracts/approval-answer.ts). Named
// so the generic conversational-feedback path (Kernel.replyFeedback, which runs for every task
// type) asks this strategy the question instead of re-deriving its step/task shape inline.
export function planApprovalStamp(task: TaskNode, event: EventRecord, text: string): boolean {
  return task.type === TaskType.grounded && event.stepId === PLAN_STEP_ID && isApprovalAnswer(text)
}

// A grounded plan step's whole job is to PRODUCE a plan: a decomposition the human approved, which
// finalize_plan freezes into a split. Signalling success without one means the agent did the work
// itself, or merely narrated it — and the run then reports success while the entire point of the
// strategy, splitting into executable steps, silently did not happen. Observed live on a real run:
// a plan step wrote two unlinked notes, never called finalize_plan, and passed.
//
// Returns the reason to REFUSE the success, or null when this is not a grounded plan step or it did
// produce its split. Pure: the caller supplies the task's events.
export function groundedPlanOmission(events: EventRecord[], stepId: string, runToken: string): string | null {
  if (stepId !== PLAN_STEP_ID) return null
  const isGrounded = events.some(e => {
    if (e.kind !== EVENT_KIND.plan_proposed) return false
    const p = PAYLOAD_SCHEMAS.plan_proposed.safeParse(e.payload)
    return p.success && p.data.plan.strategyRef === STRATEGY.groundedPlan
  })
  if (!isGrounded) return null
  const split = events.some(e => {
    if (e.kind !== EVENT_KIND.split_proposed) return false
    const p = PAYLOAD_SCHEMAS.split_proposed.safeParse(e.payload)
    return p.success && p.data.runToken === runToken
  })
  return split
    ? null
    : `the plan step signalled success without calling ${PlanNoteToolName.finalize} — author the plan with ${PlanNoteToolName.write} `
      + `(a '${MASTERPLAN_NOTE_ID}' note whose subplans lists each subplan note id), get the human to approve it, `
      + `then call ${PlanNoteToolName.finalize}. Doing the work yourself instead of decomposing it defeats the grounded-plan strategy.`
}

// The grounded analyze step's role (agentAnalyzer.analysisStep stamps it). report_coverage is only meaningful for THIS step, so its gate reads this one
// source rather than a scattered 'scout' literal.
export const ANALYZE_STEP_ROLE = STEP_ROLE.scout

// The auditor/heal/commit contracts live in the shipped role skills (vault/skills/role-auditor,
// vault/skills/role-committer — ROLE_SKILL in contracts). The kernel appends the REF at the
// freeze, so a planner can neither author nor remove a role contract; the BODY is operator-
// editable and audited by skill_loaded content-hash events at step init. Enforcement never
// lived in this prose — the commit handshake, scoped_changes gating and write fences are tool
// code — so moving the prose moves guidance, not the guarantees. A vault missing a role skill
// fails refValidator when finalize_plan proposes the split (kernel.appendPlanVersion), before
// any step runs.

export function planGraphHash(notes: PlanNote[]): string {
  const canonical = [...notes].sort((a, b) => a.id.localeCompare(b.id)).map(note => PlanNote.parse(note))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

// a dependsOn target that is no longer a sibling widens to every sibling: late beats racing
function healDependsOn(stepId: string, declared: readonly string[], kids: readonly string[]): string[] {
  const out = new Set<string>()
  for (const d of declared) {
    if (kids.includes(d)) { out.add(d); continue }
    for (const k of kids) if (k !== stepId) out.add(k)
  }
  out.delete(stepId)
  return kids.filter(k => out.has(k))
}

// the why leads, so a reader that cuts the text keeps the reason
export function noteText(n: PlanNote): string {
  const base = n.body || n.summary || n.title
  return n.rationale === '' ? base : `${WHY_PREFIX}${n.rationale}\n\n${base}`
}

function instructionsFor(n: PlanNote): string {
  const base = noteText(n)
  if (n.uncertainty.length === 0) return base
  return [base, '', 'Unresolved uncertainty (reviewed at approval — act on these, do not skip):', ...n.uncertainty.map(u => `- ${u}`)].join('\n')
}

const subplansError = (masterId: string, detail: string): Error =>
  new Error(`masterplan '${masterId}' ${detail} — list each subplan note id in the masterplan's subplans (write the notes with ${PlanNoteToolName.write}) before finalizing`)

// the freeze is a pure function of the approved notes: the masterplan's subplans, in order, become the steps
export function instantiateFrozenPlan(masterId: string, notes: PlanNote[]): ChildPlanDraft {
  const byId = new Map(notes.map(n => [n.id, n]))
  const kids = byId.get(masterId)?.subplans ?? []
  // an empty plan would freeze to a finish/commit-only pipeline that reports done having written nothing
  if (kids.length === 0) throw subplansError(masterId, 'lists no subplans')
  return {
    steps: kids.map(id => {
      const n = byId.get(id)
      if (!n) throw subplansError(masterId, `lists subplan '${id}', but no plan note has that id`)
      return {
        id, role: id === VERIFY_STEP_ID ? STEP_ROLE.auditor : STEP_ROLE.implementer, title: n.title,
        instructions: instructionsFor(n),
        dependsOn: healDependsOn(id, n.dependsOn, kids),
        zone: n.zone,
        // deduped: a note that already names the auditor skill must not inject its body twice
        skillRefs: id === VERIFY_STEP_ID ? [...new Set([...n.skillRefs, ROLE_SKILL.auditor])] : n.skillRefs,
        toolRefs: n.toolRefs,
        // '' means the planner expressed no preference — omit the key so the expansion inherits
        ...(n.modelRef ? { modelRef: n.modelRef } : {}),
      }
    }),
  }
}

// The ONE derivation of "what finalize_plan will freeze": the approval render (orc's derived-plan
// block) and the freeze itself both call this, so a human can never approve a shape the freeze
// then silently changes.
export function freezePlan(masterId: string, notes: PlanNote[], opts: { autoCommit?: boolean; checks: readonly string[] }): ChildPlanDraft {
  // instantiateFrozenPlan FIRST, and its blank-plan refusal with it: a childless masterplan must
  // throw before anything is appended, or the append would turn `steps: []` into a finish-only
  // pipeline that asks the human to summarize a task that wrote nothing — the same silent success
  // the commit-only pipeline reported (incidents c4bc1d38, 8b5e1034).
  const frozen = withFinishStep(instantiateFrozenPlan(masterId, notes), { checks: opts.checks })
  return opts.autoCommit ? withCommitStep(frozen) : frozen
}

// The trailing commit step (config autoCommit; freezePlan applies it after the freeze).
// dependsOn EVERY sibling, not just verify: a plan is not required to have one, and last-by-
// construction is what makes the stamp truthful — nothing moves the tree after it.
export function withCommitStep(draft: ChildPlanDraft): ChildPlanDraft {
  if (draft.steps.some(s => s.id === COMMIT_STEP_ID))
    throw new Error(`the plan already carries a step named '${COMMIT_STEP_ID}' — that id belongs to the kernel-appended commit step; rename the subplan`)
  return {
    steps: [...draft.steps, {
      id: COMMIT_STEP_ID, role: STEP_ROLE.committer, title: 'Commit',
      instructions: `Commit this task's changes; the '${ROLE_SKILL.committer}' skill is your contract.`,
      dependsOn: draft.steps.map(s => s.id),
      skillRefs: [ROLE_SKILL.committer], toolRefs: [], zone: [], readOnlySource: true,
    }],
  }
}
