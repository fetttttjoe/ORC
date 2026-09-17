import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PlanDraft, ROLE_SKILL, STEP_ROLE, validatePlan, VERIFY_STEP_ID } from '@orc/contracts'
import { parseSkillMd, SCOPED_CHANGES_TOOL_NAME } from '@orc/kernel'
import { driftLine, REGROUND_HEAL_PLAN, REGROUND_PLAN } from './main'
import { SHIPPED_SKILLS } from './shipped-skills'

// The tracked shipped-skill sources (exceptions inside gitignored vault/). The role skills carry
// contract prose the freeze used to inline as kernel constants (grounded-plan.ts); these pin the
// battle-tested sentences so an operator edit that guts a rule fails the build, not a live audit.
const DIR = fileURLToPath(new URL('../../../vault/skills', import.meta.url))

const read = (name: string) => parseSkillMd(readFileSync(path.join(DIR, name, 'SKILL.md'), 'utf8'), name)

describe('shipped skills', () => {
  test.each(SHIPPED_SKILLS)('%s parses under the strict frontmatter', name => {
    const { manifest, errors } = read(name)
    expect(errors).toEqual([])
    expect(manifest?.name).toBe(name)
  })

  test('role-auditor pins the auditor + heal contract sentences', () => {
    const { body } = read(ROLE_SKILL.auditor)
    expect(body).toContain("if your audit finds ANY defect, signal outcome 'failure'")
    expect(body).toContain('Success means zero defects.')
    expect(body).toContain(SCOPED_CHANGES_TOOL_NAME)
    expect(body).toContain('not from a working-tree diff')
    expect(body).toContain('never licenses skipping the test/typecheck gate')
    expect(body).toContain('never excuses a defect in a file that IS in scope')
    expect(body).toContain('empty set is not evidence of success')
    expect(body).toContain('title and summary')
    expect(body).toContain('retrieval surface')
    // heal-or-confirm: candidates come from scoped_changes' citingNotes (drift flags lag
    // uncommitted work — observed twice as post-commit drift). A still-true note is CONFIRMED by
    // DECLARING it verified, never by rewriting it: a rewrite is authorship, and authorship is
    // exactly what used to buy a free stamp for prose nobody checked.
    expect(body).toContain('citingNotes')
    expect(body).toContain('CONFIRM — call `memory_verify`')
  })

  test('role-committer pins the commit contract sentences', () => {
    const { body } = read(ROLE_SKILL.committer)
    expect(body).toContain('commit_preview')
    expect(body).toContain('READ the diff it returns')
    expect(body).toContain('refuses whenever the tree no longer matches')
    expect(body).toContain("'Nothing to commit' is a valid outcome")
    expect(body).toContain('STILL call git_commit once')
    // the receipt's honesty line: leftovers the auditor did not verify travel in the summary
    expect(body).toContain('stillDrifted')
    // C.7: the strict reverify gate's own honesty line — a stamp the gate withheld because a
    // foreign commit moved the note's paths after the audit must read the same way stillDrifted
    // does: carried into the summary, not silently dropped on the floor.
    expect(body).toContain('reverifyStale')
    // C.8: commit messages must follow Conventional Commits format with a concrete example
    // showing the type(scope): subject pattern for clarity and consistency in the message history.
    expect(body).toContain('Conventional Commits format')
    // C.9: guidance on type/scope fields and the importance of message clarity for the historical record
    expect(body).toContain('Type is one of fix, feat, refactor, docs, or test')
  })

  test('role-finisher pins the finish contract sentences', () => {
    const { body } = read(ROLE_SKILL.finisher)
    expect(body).toContain('task_notes')
    expect(body).toContain(SCOPED_CHANGES_TOOL_NAME)
    expect(body).toContain('memory_read')
    expect(body).toContain('same id, whole title, summary and body')
    expect(body).toContain('Most tasks make none')
    expect(body).toContain("memory_search")
    expect(body).toContain('ask_human ONCE')
    expect(body).toContain("reply 'approve' to finish")
    expect(body).toContain('record_decision')
    expect(body).toContain('never edit source files')
  })

  // A planner froze a newline-joined zone entry (zone: ["a/**\nb.ts"]); the fence then matched no
  // real path and two steps could not write their own files, with no repair path. This pins the
  // STRUCTURE RULES bullet that tells planners a zone entry is one glob, never a joined string.
  test('plan-authoring pins the one-glob-per-zone-entry rule', () => {
    const { body } = read('plan-authoring')
    expect(body).toContain('one glob per entry')
  })
})

// The planner had no clarify phase and no way to record WHY a decomposition looked the way it did
// past the owning task: a plan-note's `rationale` is task-bound, and archive.ts's taskSettled rule
// retires it out of the retrieval surface the moment the task ends unless something links to it.
// So every decision a plan committed to was readable only through `orc plan-notes <taskId>`, by
// someone who already knew which task to open. This pins the two-phase protocol that fixes it —
// ask once before authoring, propose the decisions inside the approval ask, write them on approve.
// Pinned failing-first against the pre-edit SKILL.md, which had neither phase.
describe('plan-authoring pins the ask-then-record-decisions protocol', () => {
  const { body } = read('plan-authoring')

  test('the clarify ask is batched into one call and skipped when nothing is ambiguous', () => {
    expect(body).toContain('batch EVERY such question into ONE')
    expect(body).toContain('ask nothing and author')
  })

  // The two-way gate this replaces ("answered in step 2, OR contradicts a recorded decision") had
  // no path for a decision that is still mostly right but now partly wrong — the common case, and
  // the one that silently accumulates contradictions when it has nowhere to go.
  test('every candidate is classified against the existing set, and all-false writes nothing', () => {
    expect(body).toContain('**collides**')
    expect(body).toContain('**needs rewrite**')
    expect(body).toContain('**new**')
    expect(body).toContain('If all three are false, write nothing')
  })

  test('the scarcity rule survives the rewrite', () => {
    expect(body).toContain('was not a decision, it was the obvious move')
  })

  // The decision set is read by `kind`, NOT by a tag. memory_search refuses a tag no note carries
  // (tools.ts's unknownTagError), so a tag-keyed read reported "no decisions recorded yet" as a
  // tool failure on every corpus until someone had already recorded one. A closed enum cannot
  // fail that way — an empty result is a real answer.
  test('the decision set is read by kind, not by tag', () => {
    expect(body).toContain("`memory_search` with `kind: 'decision'`")
    expect(body).not.toContain("tags: ['adr']")
  })

  test('the decisions ride the approval ask rather than a second gate', () => {
    expect(body).toContain('SAME `ask_human` that asks for approval')
    expect(body).toContain('a gate that asks twice gets skimmed')
  })

  test('the written decision is a pathless, project-scoped semantic note', () => {
    expect(body).toContain("kind: 'decision'")
    expect(body).toContain('No `paths`')
  })

  // One decision is one note, rewritten in place. A second note for the same subject leaves the
  // next planner unable to tell which is current — and the agent cannot retire the loser, because
  // `archived` is off the memory_write schema BY DESIGN (tools.ts:477: retiring knowledge is an
  // operator decision from evidence, never something an agent mid-task does to a note it dislikes).
  test('a changed decision rewrites the existing note by id rather than minting a second', () => {
    expect(body).toContain('Re-`memory_write` that note under its OWN id')
    expect(body).toContain('two notes that half-agree')
  })

  test('it links back to the reasoning and forward over what it replaces', () => {
    // Both words already appear in the STRUCTURE RULES (subplans link derived_from the analysis
    // notes; step 1 traverses supersedes), so a bare toContain on either passes against the
    // pre-edit file and pins nothing. These two sentences exist only in the decision step.
    // The inbound derived_from is also what keeps the plan-note out of archive.ts's taskSettled
    // rule (inboundFrom protects), so the reasoning survives alongside the one-line decision.
    expect(body).toContain('keeps that plan-note out of the archive')
    expect(body).toContain('leaves two live notes disagreeing')
  })

  test('the write happens BEFORE finalize_plan', () => {
    expect(body).toContain('FIRST write each confirmed decision, THEN call `finalize_plan()`')
  })
})

// The scout skill used to ask_human on EVERY grounded request (even zero-drift, "the graph still
// matches this tree") — three consecutive cheap, incremental scouts interrupted the operator when
// nothing expensive was ever on the table. The door belongs on the one decision that IS expensive:
// a wholesale re-read when the corpus has drifted past plugins/memory/src/drift.ts's
// CORPUS_DRIFT_ADVISORY. Pinned failing-first against the pre-edit two-ask_human-branches SKILL.md.
describe('codebase-analysis pins the drift-advisory two-branch protocol', () => {
  const { body } = read('codebase-analysis')

  test('keys the branches on the wholesale-remap advisory, not a literal percentage', () => {
    expect(body).toContain('CORPUS_DRIFT_ADVISORY')
    expect(body).toContain('plugins/memory/src/drift.ts')
    expect(body).not.toContain('34%')
  })

  test('below-advisory branch proceeds without asking', () => {
    expect(body).toContain('proceed without asking')
  })

  test('states the why: interruptions over cheap scouts, door belongs on the expensive decision', () => {
    expect(body).toContain('cheap, incremental scouts')
    expect(body).toContain('door belongs on the expensive decision')
  })

  test('retains ask_human for at/above-advisory, no Currency line, or no notes at all', () => {
    expect(body).toContain('At or above the advisory, or there is no Currency line, or there are no notes at all')
    expect(body).toContain('ask_human(')
  })

  test('the memory-first paragraph survives untouched', () => {
    expect(body).toContain('search before you read')
    expect(body).toContain('never re-derived')
  })
})

// P5 (boundary-contracts spec): driftLine could only ever recommend the full kb-build REBUILD —
// healing a handful of drifted notes had no targeted instrument. This is that instrument's other
// tracked data file (docs/, not vault/skills/), so it gets the same "stays valid" home. Parses the
// draft, validates it, and pins the ONE thing the runtime tool gate actually reads: role===auditor
// AND id===VERIFY_STEP_ID is what earns memory_verify/scoped_changes registration
// (plugins/memory/src/tools.ts memoryVerifyTool, packages/kernel/src/execution/scoped-changes-tool.ts) —
// a plan file that drifts off either term silently loses the tools it needs to do its job.
describe('reground-heal plan file', () => {
  // Repo root, not docs/: REGROUND_HEAL_PLAN already carries the 'docs/' prefix (it is the same
  // string driftLine hands the operator to paste into `orc propose --file`), so joining it under
  // DOCS_DIR a second time would double the segment. Reading the path through the constant, not a
  // second 'reground-heal.plan.json' literal, closes the rename direction: renaming the file in
  // main.ts alone used to leave this test pointed at the old name until someone remembered to edit
  // both spellings.
  const ROOT_DIR = fileURLToPath(new URL('../../../', import.meta.url))

  test('stays a valid, single-step auditor plan that earns the verify-step tools', () => {
    const raw = JSON.parse(readFileSync(path.join(ROOT_DIR, REGROUND_HEAL_PLAN), 'utf8'))
    const draft = PlanDraft.parse(raw)
    const plan = { taskId: 'reground-heal-check', version: 1, ...draft }
    expect(validatePlan(plan)).toEqual({ ok: true })
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.role).toBe(STEP_ROLE.auditor)
    expect(plan.steps[0]?.id).toBe(VERIFY_STEP_ID)
  })
})

// C.4: driftLine names the command whose plan file matches the branch it took — the ≥34%
// (needsReground) branch recommends the full REGROUND_PLAN remap, the below-threshold branch
// recommends the cheaper REGROUND_HEAL_PLAN instrument. Exact-substring pins on both paths, so a
// swap between the two (recommending the wrong instrument for the wrong severity) fails the build
// instead of shipping a human the wrong command.
describe('driftLine', () => {
  test('at/above the reground threshold (34%) names REGROUND_PLAN', () => {
    expect(driftLine({ checkable: 10, drifted: 4, ratio: 0.4 })).toContain(REGROUND_PLAN)
  })

  test('below the reground threshold names REGROUND_HEAL_PLAN', () => {
    expect(driftLine({ checkable: 10, drifted: 2, ratio: 0.2 })).toContain(REGROUND_HEAL_PLAN)
  })
})
