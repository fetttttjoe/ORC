import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { KnowledgeToolName, PlanDraft, ROLE_SKILL, STEP_ROLE, validatePlan, VERIFY_STEP_ID } from '@orc/contracts'
import { parseSkillMd, SCOPED_CHANGES_TOOL_NAME } from '@orc/kernel'
import { driftLine, REGROUND_HEAL_PLAN, REGROUND_PLAN } from './drift-line'
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
    // heal candidates come from scoped_changes' citingClaims — every recorded claim anchored at a
    // path this task changed. Each gets a knowledge_check verdict.
    expect(body).toContain('citingClaims')
    expect(body).toContain(`${KnowledgeToolName.check}, one call per claim: \`holds\` for a claim still true`)
    expect(body).toContain(`\`false\` carries the patch that retires the claim or changes it`)
    expect(body).not.toContain('stays as it is')
    expect(body).not.toContain('memory_')
  })

  test('role-committer pins the commit contract sentences', () => {
    const { body } = read(ROLE_SKILL.committer)
    expect(body).toContain('knowledge files')
    expect(body).toContain('commit_preview')
    expect(body).toContain('READ the diff it returns')
    expect(body).toContain('refuses whenever the tree no longer matches')
    expect(body).toContain("'Nothing to commit' is a valid outcome")
    expect(body).toContain('STILL call git_commit once')
    expect(body).toContain('Carry stillDrifted into your step summary verbatim')
    expect(body).toContain('Carry degraded the same way')
    expect(body).not.toContain('stamp')
    // C.8: commit messages must follow Conventional Commits format with a concrete example
    // showing the type(scope): subject pattern for clarity and consistency in the message history.
    expect(body).toContain('Conventional Commits format')
    // C.9: guidance on type/scope fields and the importance of message clarity for the historical record
    expect(body).toContain('Type is one of fix, feat, refactor, docs, or test')
  })

  test('role-finisher pins the finish contract sentences', () => {
    const { body } = read(ROLE_SKILL.finisher)
    expect(body).toContain('task_claims')
    expect(body).toContain(SCOPED_CHANGES_TOOL_NAME)
    expect(body).toContain('knowledge_write')
    expect(body).toContain('missing')
    expect(body).toContain('Most tasks make none')
    expect(body).toContain('decision_list')
    expect(body).not.toContain('memory_search')
    expect(body).toContain('draft it as a supersession of that id')
    expect(body).not.toContain('supersession is a human act')
    expect(body).toContain('ask_human ONCE')
    expect(body).toContain("reply 'approve' to finish")
    expect(body).toContain('record_decision with it exactly as approved, with `supersedes` when it changes a recorded decision')
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
// ask once before authoring, propose the decisions inside the approval ask, record them on approve.
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

  test('the decision set is read with decision_list and a candidate with decision_read', () => {
    expect(body).toContain('with `decision_list` (an empty list is a real answer')
    expect(body).toContain('`decision_read` a candidate before you say the plan collides with it')
    expect(body).not.toContain('memory_search')
  })

  test('the decisions ride the approval ask rather than a second gate', () => {
    expect(body).toContain('SAME `ask_human` that asks for approval')
    expect(body).toContain('a gate that asks twice gets skimmed')
  })

  test('a confirmed decision is recorded with record_decision, never written as a memory note', () => {
    expect(body).toContain('Each is one `record_decision`')
    expect(body).not.toContain("kind: 'decision'")
    expect(body).not.toContain('No `paths`')
  })

  test('a changed decision is recorded as a supersession that names the recorded id', () => {
    expect(body).toContain('**collides** and **needs rewrite** are recorded as a supersession')
    expect(body).toContain('`supersedes` is the recorded')
    expect(body).not.toContain('rewrite the EXISTING note')
  })

  test('reads recorded claims before authoring', () => {
    expect(body).toContain('knowledge_card')
    expect(body).not.toContain('memory_neighbors')
  })

  test('it no longer claims a derived_from link protects the plan-note', () => {
    expect(body).not.toContain('keeps that plan-note out of the archive')
  })

  test('what was ruled out is asked for once', () => {
    expect(body.split('RULED OUT').length - 1).toBe(1)
  })

  test('the write happens BEFORE finalize_plan', () => {
    expect(body).toContain('FIRST record each confirmed decision, THEN call `finalize_plan()`')
  })
})

// The scout used to author a linked note graph from working-tree reading. It now reads what is
// already recorded FIRST and writes only classed, anchored claims — re-deriving existing knowledge
// is the single biggest waste in a scout run, and report_coverage counts claims from the log itself
// rather than trusting a self-report.
describe('codebase-analysis pins the knowledge-first grounding protocol', () => {
  const { body } = read('codebase-analysis')

  test('reads recorded claims before touching the tree', () => {
    expect(body).toContain('knowledge_card')
    expect(body).toContain('knowledge_search')
    expect(body).toContain('never re-derived')
  })

  test('records claims with knowledge_write, classed fact/why', () => {
    expect(body).toContain('knowledge_write')
    expect(body).toContain("class: 'why'")
  })

  test('reports coverage from the log, not a self-count', () => {
    expect(body).toContain('report_coverage')
    expect(body).toContain('taken from the log')
  })

  test('never mentions the retired memory tools or the drift-advisory percentage', () => {
    expect(body).not.toContain('memory_')
    expect(body).not.toContain('34%')
  })
})

// P5 (boundary-contracts spec): driftLine could only ever recommend the full kb-build REBUILD —
// healing a handful of drifted notes had no targeted instrument. This is that instrument's other
// tracked data file (docs/, not vault/skills/), so it gets the same "stays valid" home. Parses the
// draft, validates it, and pins the ONE thing the runtime tool gate actually reads: role===auditor
// AND id===VERIFY_STEP_ID is what earns scoped_changes registration
// (packages/kernel/src/execution/scoped-changes-tool.ts) — a plan file that drifts off either term
// silently loses the tool it needs to do its job.
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
