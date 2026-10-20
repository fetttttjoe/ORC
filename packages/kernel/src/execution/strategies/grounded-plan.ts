import { createHash } from 'node:crypto'
import { COMMIT_STEP_ID, EVENT_KIND, MASTERPLAN_NOTE_ID, PAYLOAD_SCHEMAS, PlanNote, PlanNoteToolName, ROLE_SKILL, STEP_ID, STEP_ROLE, STRATEGY, TaskType, VERIFY_STEP_ID, isApprovalAnswer, type ChildPlanDraft, type EventRecord, type TaskNode } from '@orc/contracts'
import { withFinishStep } from '../../finish-step'

// the grounded plan step's role, set by createGroundedTask
export const PLAN_STEP_ROLE = STEP_ROLE.auditor

// One source, so the step that must produce a plan and the check that it did cannot drift.
export const PLAN_STEP_ID = STEP_ID.plan

// the line a frozen step's instructions and the split's spec carry the plan's rationale on
export const WHY_PREFIX = 'Why: '

// True when an answer sent to a grounded plan step is the approval word.
export function planApprovalStamp(task: TaskNode, event: EventRecord, text: string): boolean {
  return task.type === TaskType.grounded && event.stepId === PLAN_STEP_ID && isApprovalAnswer(text)
}

// Pure: the caller supplies the task's events; returns the refusal reason, or null.
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

// report_coverage gates on this role (one source), not a scattered 'scout' literal.
export const ANALYZE_STEP_ROLE = STEP_ROLE.scout

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

// Pure function of the approved notes: the masterplan's subplans, in order, become the steps
export function instantiateFrozenPlan(masterId: string, notes: PlanNote[]): ChildPlanDraft {
  const byId = new Map(notes.map(n => [n.id, n]))
  const kids = byId.get(masterId)?.subplans ?? []
  // an empty plan would freeze to a finish-only pipeline that reports done having written nothing
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

// The one derivation of what finalize_plan freezes: the approval render and the freeze share it.
export function freezePlan(masterId: string, notes: PlanNote[], opts: { autoCommit?: boolean; checks: readonly string[] }): ChildPlanDraft {
  // Freeze first: a childless masterplan must throw before a finish-only pipeline can be built.
  const frozen = withFinishStep(instantiateFrozenPlan(masterId, notes), { checks: opts.checks })
  return opts.autoCommit ? withCommitStep(frozen) : frozen
}

// dependsOn every sibling, not just verify: last by construction keeps the commit truthful.
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
