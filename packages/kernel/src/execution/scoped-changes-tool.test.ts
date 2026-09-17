import { describe, expect, it } from 'bun:test'
import { FINISH_STEP_ID, STEP_ID, STEP_ROLE, VERIFY_STEP_ID, type EventRecord, type Plan, EVENT_KIND } from '@orc/contracts'
import { eventFixture, must, planFixture, recordOf, stepFixture } from '@orc/contracts/fixtures'
import { taskChangedPaths } from '../projections'
import { scopedChangesTool, SCOPED_CHANGES_TOOL_NAME } from './scoped-changes-tool'

// The auditor false-positive scenario, expressed at the LOG level on purpose.
//
// In production the workspace tree is SHARED with sibling tasks, so `git status` in this task's
// verify step shows the siblings' completed work too — that is the false positive this tool exists
// to remove. The removal is BY CONSTRUCTION: the scoped set is derived from EventRecord[] attributed
// to this task (and its descendant split tasks) and never consults the tree, so whether the sibling's
// file also sits on disk is irrelevant to the result. Reproducing an actual dirty tree would need a
// real git repo (and Postgres for a real Kernel) and would still exercise nothing extra, so the
// sibling's write lives in the SAME event log here and the assertion is that it is absent from the
// output. Tree state cannot influence a pure log derivation.
const THIS_TASK = 'task-me'
const CHILD_TASK = 'task-me.s1.c1' // a descendant split task — its writes ARE this task's changes
const SIBLING_TASK = 'task-sibling' // NOT a descendant: a parallel task sharing the worktree

const rt = (stepId: string): string => `run-${stepId}`
const call = (seq: number, taskId: string, stepId: string, id: string, path: string): EventRecord =>
  eventFixture({ seq, taskId, stepId, runToken: rt(stepId), kind: EVENT_KIND.tool_call,
    payload: { stepId, runToken: rt(stepId), iteration: 1, toolCallId: id, toolName: 'fs_write', input: { path } } })
const ok = (seq: number, taskId: string, stepId: string, id: string): EventRecord =>
  eventFixture({ seq, taskId, stepId, runToken: rt(stepId), kind: EVENT_KIND.tool_result,
    payload: { stepId, runToken: rt(stepId), iteration: 1, toolCallId: id, toolName: 'fs_write', output: {}, isError: false } })

// ONE log holding every task's events, exactly as production does.
const LOG: EventRecord[] = [
  // this task's implementer step, inside its declared zone
  call(1, THIS_TASK, 's1', 'c1', 'packages/kernel/src/execution/scoped-changes-tool.ts'),
  ok(2, THIS_TASK, 's1', 'c1'),
  // this task's implementer step, OUTSIDE its declared zone — an in-scope defect the audit must keep
  call(3, THIS_TASK, 's1', 'c2', 'docs/unrelated-note.md'),
  ok(4, THIS_TASK, 's1', 'c2'),
  // a SIBLING task's completed work, present in the shared worktree, must never appear
  call(5, SIBLING_TASK, 's9', 'c3', 'packages/ui-core/src/sessions.ts'),
  ok(6, SIBLING_TASK, 's9', 'c3'),
  // a DESCENDANT split task's write — delegated, still this task's change
  call(7, CHILD_TASK, 'kid', 'c4', './packages/kernel/src/child.ts'),
  ok(8, CHILD_TASK, 'kid', 'c4'),
]

// Mirrors Kernel.listTaskChangedPaths (subtree ids × the real taskChangedPaths projection) without
// needing Postgres: subtreeTaskIds itself is covered in kernel.test.ts.
const fakeKernel = (subtree: string[], plan: Plan | undefined, opts: { throws?: boolean } = {}) => ({
  listTaskChangedPaths: async (taskId: string) => {
    if (opts.throws) throw new Error('log unavailable')
    const ids = taskId === THIS_TASK ? subtree : [taskId]
    return ids.flatMap(id =>
      taskChangedPaths(LOG.filter(e => e.taskId === id)).map(c => ({ path: c.path, taskId: id, steps: c.steps })))
  },
  getPlan: async () => plan,
})

const PLAN = planFixture({
  taskId: THIS_TASK,
  steps: [
    stepFixture({ id: 's1', role: STEP_ROLE.implementer, zone: ['packages/kernel/**'] }),
    stepFixture({ id: VERIFY_STEP_ID, role: STEP_ROLE.auditor, zone: ['packages/kernel/**'] }),
  ],
})

const verifyP = { taskId: THIS_TASK, stepId: VERIFY_STEP_ID, role: STEP_ROLE.auditor }

const run = async (kernel = fakeKernel([THIS_TASK, CHILD_TASK], PLAN)) => {
  const [tool] = scopedChangesTool({ kernel, p: verifyP })
  const r = await must(tool, 'scoped changes tool').execute({})
  return r
}

// The heal-or-confirm candidate list: citing notes ride the OUTPUT because drift flags are
// measured against committed revisions and lag the uncommitted work verify just audited —
// observed twice as post-commit drift (4/7 corpus) before this existed.
describe('citingNotes (heal-or-confirm candidates)', () => {
  const NOTE = { id: 'area-x', scope: 'project', title: 'X', sourceRevision: 'abc' }

  it('carries the citing callback result, called once with the deduped changed paths', async () => {
    const seen: string[][] = []
    const [tool] = scopedChangesTool({
      kernel: fakeKernel([THIS_TASK, CHILD_TASK], PLAN), p: verifyP,
      citing: async paths => { seen.push(paths); return [NOTE] },
    })
    const r = await must(tool, 'scoped changes tool').execute({})
    expect(r.isError).toBe(false)
    expect((r.output as { citingNotes: unknown }).citingNotes).toEqual([NOTE])
    expect(seen).toHaveLength(1)
    expect([...must(seen[0], 'seen[0]')].sort()).toEqual([
      'docs/unrelated-note.md',
      'packages/kernel/src/child.ts',
      'packages/kernel/src/execution/scoped-changes-tool.ts',
    ])
  })

  it('deduplicates: the same path written by two steps reaches the callback once', async () => {
    // the shared fixture has no duplicate paths, so the deduped-list test above cannot pin the
    // dedupe itself — a stub kernel returning one path from two contributors does
    const seen: string[][] = []
    const [tool] = scopedChangesTool({
      kernel: {
        listTaskChangedPaths: async () => [
          { path: 'packages/kernel/src/dup.ts', taskId: THIS_TASK, steps: [{ stepId: 's1', tool: 'fs_write', seq: 1 }] },
          { path: 'packages/kernel/src/dup.ts', taskId: CHILD_TASK, steps: [{ stepId: 'kid', tool: 'fs_write', seq: 2 }] },
        ],
        getPlan: async () => PLAN,
      },
      p: verifyP,
      citing: async paths => { seen.push(paths); return [] },
    })
    await must(tool, 'scoped changes tool').execute({})
    expect(seen).toEqual([['packages/kernel/src/dup.ts']])
  })

  it('without the callback citingNotes is null and degraded names the gap (never smuggled into floor)', async () => {
    const o = (await run()).output as { citingNotes: unknown; floor: string; degraded?: string[] }
    expect(o.citingNotes).toBeNull()
    expect(o.floor).not.toContain('unavailable')
    expect(o.degraded).toEqual(['citingNotes unavailable (memory degraded) — name that loudly in your summary.'])
  })

  it('with the callback present, degraded is absent entirely (not an empty array)', async () => {
    const [tool] = scopedChangesTool({
      kernel: fakeKernel([THIS_TASK, CHILD_TASK], PLAN), p: verifyP,
      citing: async () => [],
    })
    const r = await must(tool, 'scoped changes tool').execute({})
    expect(r.isError).toBe(false)
    expect(recordOf(r.output)).not.toHaveProperty('degraded')
  })
})

describe('scoped_changes tool', () => {
  it("excludes a sibling task's write from this task's scoped set (the false positive)", async () => {
    const r = await run()
    expect(r.isError).toBe(false)
    const rows = (r.output as { paths: Array<{ path: string }> }).paths
    expect(rows.map(x => x.path)).not.toContain('packages/ui-core/src/sessions.ts')
    expect(rows.some(x => x.path.startsWith('packages/ui-core/'))).toBe(false)
  })

  it("keeps this task's own out-of-zone write and flags it inZone:false", async () => {
    const rows = ((await run()).output as { paths: Array<{ path: string; inZone: boolean; zoneMatched?: string; stepId: string | null; taskId: string }> }).paths
    const stray = rows.find(x => x.path === 'docs/unrelated-note.md')
    expect(stray).toBeDefined()
    expect(must(stray, 'stray path').inZone).toBe(false)
    expect(must(stray, 'stray path').zoneMatched).toBeUndefined()
    expect(must(stray, 'stray path').stepId).toBe('s1')
    expect(must(stray, 'stray path').taskId).toBe(THIS_TASK)
  })

  it('reports an in-zone write with the glob it matched', async () => {
    const rows = ((await run()).output as { paths: Array<{ path: string; inZone: boolean; zoneMatched?: string; tool: string }> }).paths
    const own = rows.find(x => x.path === 'packages/kernel/src/execution/scoped-changes-tool.ts')
    expect(own).toBeDefined()
    expect(must(own, 'own path').inZone).toBe(true)
    expect(must(own, 'own path').zoneMatched).toBe('packages/kernel/**')
    expect(must(own, 'own path').tool).toBe('fs_write')
  })

  it('includes a descendant split task\'s write, attributed to the child task', async () => {
    const rows = ((await run()).output as { paths: Array<{ path: string; taskId: string; inZone: boolean }> }).paths
    const kid = rows.find(x => x.path === 'packages/kernel/src/child.ts')
    expect(kid).toBeDefined()
    expect(must(kid, 'kid path').taskId).toBe(CHILD_TASK)
    expect(must(kid, 'kid path').inZone).toBe(true)
  })

  it('the kernel-appended commit step (zone:[], readOnlySource) does not unfence the task', async () => {
    // withCommitStep appends {zone: [], readOnlySource: true}; zonesFor's empty-zone rule would
    // otherwise read the whole task as unfenced and an out-of-union descendant write would pass
    // the audit as inZone
    const withCommit = planFixture({
      taskId: THIS_TASK,
      steps: [
        stepFixture({ id: 's1', role: STEP_ROLE.implementer, zone: ['packages/kernel/**'] }),
        stepFixture({ id: VERIFY_STEP_ID, role: STEP_ROLE.auditor, zone: ['packages/kernel/**'] }),
        stepFixture({ id: STEP_ID.commit, role: STEP_ROLE.committer, zone: [], readOnlySource: true }),
      ],
    })
    const kernel = {
      listTaskChangedPaths: async () => [
        { path: 'plugins/memory/src/rogue.ts', taskId: CHILD_TASK, steps: [{ stepId: 'kid', tool: 'fs_write', seq: 1 }] },
      ],
      getPlan: async () => withCommit,
    }
    const r = await run(kernel)
    const rows = (r.output as { paths: Array<{ path: string; inZone: boolean }> }).paths
    // judged against the WRITING steps' zone union — the read-only commit step's empty zone
    // neither unfences the task nor joins the union
    expect(must(rows[0], 'first row').inZone).toBe(false)
  })

  it('surfaces a kernel failure as isError, never a throw', async () => {
    const r = await run(fakeKernel([THIS_TASK], PLAN, { throws: true }))
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('log unavailable')
  })

  it('describes itself as a floor that never licenses skipping a gate', async () => {
    const [tool] = scopedChangesTool({ kernel: fakeKernel([THIS_TASK], PLAN), p: verifyP })
    expect(must(tool, 'scoped changes tool').name).toBe(SCOPED_CHANGES_TOOL_NAME)
    expect(must(tool, 'scoped changes tool').ref).toBe(`kernel/${SCOPED_CHANGES_TOOL_NAME}`)
    const d = must(tool, 'scoped changes tool').description.toLowerCase()
    expect(d).toContain('exec')
    expect(d).toContain('floor')
    expect(d).toContain('never')
  })

  describe('registration gate', () => {
    const kernel = fakeKernel([THIS_TASK], PLAN)
    it('registers only for the verify (auditor) step', () => {
      expect(scopedChangesTool({ kernel, p: verifyP })).toHaveLength(1)
    })
    // PLAN_STEP_ROLE === STEP_ROLE.auditor, so a bare role check would hand this tool to the
    // grounded task's `plan` step, where a scoped change set means nothing.
    it("is NOT registered for the grounded 'plan' step, which also has the auditor role", () => {
      expect(scopedChangesTool({ kernel, p: { taskId: THIS_TASK, stepId: STEP_ID.plan, role: STEP_ROLE.auditor } })).toEqual([])
    })
    it('is NOT registered for an implementer step', () => {
      expect(scopedChangesTool({ kernel, p: { taskId: THIS_TASK, stepId: 's1', role: STEP_ROLE.implementer } })).toEqual([])
    })
    it('is NOT registered for an implementer step that happens to be named verify', () => {
      expect(scopedChangesTool({ kernel, p: { taskId: THIS_TASK, stepId: VERIFY_STEP_ID, role: STEP_ROLE.implementer } })).toEqual([])
    })
    // The finish step reads the same floor to know WHAT it is summarizing — which paths this task
    // changed — so the gate widened to stepMayReconcile as well. Both terms there too: a worker step
    // a planner happened to name 'finish' gets nothing.
    it('registers for the finish step with the finisher role', () => {
      expect(scopedChangesTool({ kernel, p: { taskId: THIS_TASK, stepId: FINISH_STEP_ID, role: STEP_ROLE.finisher } })).toHaveLength(1)
    })
    it("is NOT registered for a worker step named 'finish'", () => {
      expect(scopedChangesTool({ kernel, p: { taskId: THIS_TASK, stepId: FINISH_STEP_ID, role: STEP_ROLE.worker } })).toEqual([])
    })
  })

  it('falls back to the union of the task\'s declared zones when the writing step is unknown', async () => {
    // no plan on the log (a task whose plan cannot be read) → nothing to classify against, so every
    // path reports inZone:true rather than inventing an out-of-zone verdict the auditor would act on.
    const rows = ((await run(fakeKernel([THIS_TASK], undefined))).output as { paths: Array<{ inZone: boolean }> }).paths
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(x => x.inZone)).toBe(true)
  })
})
