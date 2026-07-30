import { createHash } from 'node:crypto'
import { COMMIT_STEP_ID, deriveNoteProvenance, EVENT_KIND, LINK_KIND, MemoryDeletedPayload, MemoryNote, MemoryWrittenPayload, MASTERPLAN_NOTE_ID, NOTE_TIER, PAYLOAD_SCHEMAS, ROLE_SKILL, siblingOrderingMisuse, STEP_ID, STEP_ROLE, STRATEGY, VERIFY_STEP_ID, isApprovalAnswer, planScope, type ChildPlanDraft, type EventRecord, type PlanNote, type TaskNode } from '@orc/contracts'

// planScope moved to contracts (one format, one place); re-exported so kernel callers keep working
export { planScope }

// The grounded plan-authoring step's role. finalize_plan is only meaningful for THIS step, so both
// createGroundedTask (which stamps it) and finalize_plan's defensive gate reference this one source.
export const PLAN_STEP_ROLE = STEP_ROLE.auditor

// Its step id, stamped by createGroundedTask — one source, so the step that must produce a plan and
// the check that it did cannot drift apart.
export const PLAN_STEP_ID = STEP_ID.plan

// True when a feedback answer IS the grounded-plan approval: sent to this strategy's plan step, on
// a grounded task, using the approval word (isApprovalAnswer, contracts/approval-answer.ts). Named
// so the generic conversational-feedback path (Kernel.replyFeedback, which runs for every task
// type) asks this strategy the question instead of re-deriving its step/task shape inline.
export function planApprovalStamp(task: TaskNode, event: EventRecord, text: string): boolean {
  return task.type === 'grounded' && event.stepId === PLAN_STEP_ID && isApprovalAnswer(text)
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
    : 'the plan step signalled success without calling finalize_plan — author the plan-note graph '
      + `in scope '${planScope(events[0]?.taskId ?? '')}' (root note '${MASTERPLAN_NOTE_ID}', each subplan linked `
      + 'decomposes_into), get the human to approve it, then call finalize_plan. Doing the work '
      + 'yourself instead of decomposing it defeats the grounded-plan strategy.'
}

// The grounded analyze step's role (agentAnalyzer.analysisStep stamps it; runtime maps it → the
// scout memory tier). report_coverage is only meaningful for THIS step, so its gate reads this one
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
  const canonical = [...notes]
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id))
    .map(note => MemoryNote.parse(note))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

// FixE: reconstruct the task's plan-note graph from the EVENT LOG (the source of truth) rather than
// the async SurrealDB projection — the log is synchronously durable the instant finalize runs, so the
// frozen executable plan can never be built from a stale read model. Folds memory_written/deleted in
// seq order to the latest note per id (a later memory_deleted drops it), mirroring the projector's
// provenance derivation (surreal.applyEvent) so the note shape matches what instantiateFrozenPlan
// expects. Pure: the caller supplies the already-read events (scoped to the memory kinds).
// ponytail: caller hands the full memory-event history; add a scope-indexed read if it ever costs.
// PLAN TIER ONLY: a task's plan scope also holds the episodic notes its own planning step left
// behind (ambient capture writes one per step, into the same scope). Those are not part of the
// decomposition, and including them would let a step note the human never reviewed change the
// plan hash between approval and freeze.
export function foldPlanNotes(events: EventRecord[], scope: string): PlanNote[] {
  const byId = new Map<string, PlanNote>()
  for (const e of events) {
    if (e.kind === EVENT_KIND.memory_written) {
      // lenient like the projector's fold contract: one unparseable/legacy payload (any scope, any
      // age) must skip its case, not throw out of every grounded task's plan freeze and approval.
      const parsed = MemoryWrittenPayload.safeParse(e.payload)
      if (!parsed.success) continue
      const { note, author } = parsed.data
      if (note.scope !== scope || note.tier !== NOTE_TIER.plan) continue
      const prev = byId.get(note.id)
      // shared derivation with the projector — this once forgot to stamp sources.retrievedAt and
      // threw MemoryNote.parse on every sourced plan note, blocking approval.
      const full = MemoryNote.parse({ ...note, ...deriveNoteProvenance(note, author, e.ts, prev) })
      if (full.tier === NOTE_TIER.plan) byId.set(note.id, full)
    } else if (e.kind === EVENT_KIND.memory_deleted) {
      const del = MemoryDeletedPayload.safeParse(e.payload)
      if (del.success && del.data.scope === scope) byId.delete(del.data.id)
    }
  }
  return [...byId.values()]
}

// The deterministic freeze (S1): the executable plan is a PURE function of the approved
// plan-notes — no clock/random/IO — so it can never drift from what the human approved.
// master's decomposes_into children → steps; each child's depends_on links → dependsOn.
// ponytail: one decomposition level per approve — a subplan that itself decomposes re-splits
// when its child runs; recurse only when a real 3-level plan needs it.
// The subplan's ordering, with ONE spelling and two different repairs.
//
// Ordering is the `dependsOn` FIELD. A `depends_on` LINK is knowledge ("this subplan builds on that
// finding") and never schedules — that separation is the whole point: a link is a durable statement
// about how facts relate, and ordering stops meaning anything the moment the plan is frozen.
//
// The two mistakes are not the same mistake, so they are not handled the same way:
//
//   * A depends_on LINK to a SIBLING means the author reached for the wrong one. It is a spelling
//     error with an obvious correction, so it FAILS at the approval gate and says what to write.
//     Silently honouring it would keep both spellings alive; silently ignoring it would drop the
//     ordering and let a step run early, which is the race this all exists to prevent.
//
//   * A FIELD naming a step that no longer exists means the plan changed underneath it — the
//     planner replaced `api` with api-read/api-write while `verify` kept dependsOn ['api'], because
//     the skill tells it to leave untouched notes byte-stable. Nobody can know the right answer, so
//     it widens to EVERY sibling. A missing dependency lets a step start too early (silent
//     corruption); a surplus one only makes it start later. The safe direction is the ordered one,
//     and the human sees it — a step that suddenly waits on everything is what the rendered plan shows.
//
// Returned in `kids` order and deduped, so identical notes always freeze identically.
function healDependsOn(
  stepId: string,
  declared: readonly string[],
  links: ReadonlyArray<{ id: string; kind: string }>,
  kids: readonly string[],
): string[] {
  // the rule and its wording live in contracts (siblingOrderingMisuse) because memory_write warns
  // about the same edge the moment it is written; here, at the freeze, it is fatal
  const misuse = siblingOrderingMisuse(stepId, links, kids)
  if (misuse) throw new Error(misuse)
  const out = new Set<string>()
  for (const d of declared) {
    if (kids.includes(d)) { out.add(d); continue }
    for (const k of kids) if (k !== stepId) out.add(k)
  }
  out.delete(stepId)
  return kids.filter(k => out.has(k))
}

export function instantiateFrozenPlan(masterId: string, notes: PlanNote[]): ChildPlanDraft {
  const byId = new Map(notes.map(n => [n.id, n]))
  const kids = (byId.get(masterId)?.links ?? []).filter(l => l.kind === LINK_KIND.decomposes_into).map(l => l.id)
  return {
    steps: kids.map(id => {
      const n = byId.get(id)
      if (!n) throw new Error(`masterplan decomposes_into '${id}' but no such plan-note exists`)
      return {
        // role mapping at the freeze (P2): the verify subplan runs as auditor — memory tier
        // and prompt framing follow from the role automatically
        id, role: id === VERIFY_STEP_ID ? STEP_ROLE.auditor : STEP_ROLE.implementer, title: n.title,
        instructions: n.body || n.summary || n.title,
        // Ordering comes from the FIELD, never from links. A link is a durable statement about how
        // facts relate; ordering is execution structure that stops meaning anything once the plan is
        // frozen. Reading a field removes the guess entirely — there is no "was this target a
        // sibling once?" question left to get wrong — and `depends_on` goes back to meaning exactly
        // one thing in the knowledge graph.
        //
        // A target that is no longer a step HEALS TOWARD SAFETY rather than failing the freeze or
        // being dropped. Reachable through the ordinary revise loop: the planner replaces `api` with
        // api-read/api-write while `verify` keeps dependsOn ['api'], because the skill tells it to
        // leave untouched notes byte-stable. Dropping the edge is the dangerous repair — it lets the
        // step run EARLY, which is the "verify audited a file draft had not written yet" race. So an
        // unresolvable target is replaced by every current sibling: strictly no looser than intended,
        // never a race, and it costs only parallelism.
        //
        // It stays VISIBLE rather than silent: the human approves a rendered plan, and a step that
        // suddenly waits on everything is exactly what that render shows.
        dependsOn: healDependsOn(id, n.dependsOn, n.links, kids),
        // the note's declared write-globs become the step's zone — the executor fence makes
        // "parallel siblings must not write the same files" mechanical instead of prose
        zone: n.zone,
        // the planner decides what each subplan needs; the operator decided what exists at all.
        // The verify step additionally carries the kernel-appended auditor contract skill (deduped:
        // a planner note that already names it must not double-inject the body into the prompt).
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
export function freezePlan(masterId: string, notes: PlanNote[], opts: { autoCommit?: boolean }): ChildPlanDraft {
  const frozen = instantiateFrozenPlan(masterId, notes)
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
