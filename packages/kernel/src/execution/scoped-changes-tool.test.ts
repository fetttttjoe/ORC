import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { ClaimClass, FINISH_STEP_ID, STEP_ID, STEP_ROLE, VERIFY_STEP_ID, type EventRecord, type KnowledgeClaim, type Plan, EVENT_KIND } from '@orc/contracts'
import { eventFixture, must, planFixture, recordOf, stepFixture } from '@orc/contracts/fixtures'
import { taskChangedPaths } from '../projections'
import { scopedChangesTool, SCOPED_CHANGES_TOOL_NAME } from './scoped-changes-tool'

// At the LOG level: the scoped set never consults the tree, so a sibling's write must be absent.
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

// Mirrors Kernel.listTaskChangedPaths without Postgres; subtreeTaskIds is covered in kernel.test.ts
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

// citing claims ride the OUTPUT: drift flags lag the uncommitted work verify just audited
describe('citingClaims (heal candidates)', () => {
  const CLAIM: KnowledgeClaim = { id: 'aaaaaaaa', text: 'X', class: ClaimClass.fact, anchors: [], tags: [], sources: [], decision: null, location: 'k/x.md' }
  const CitingClaimsOutput = z.object({ citingClaims: z.array(z.unknown()).nullable(), floor: z.string(), degraded: z.array(z.string()).optional() })

  const build = (opts: { claimsAt?: (paths: string[]) => Promise<KnowledgeClaim[]> } = {}) => {
    const [tool] = scopedChangesTool({ kernel: fakeKernel([THIS_TASK, CHILD_TASK], PLAN), p: verifyP, ...opts })
    return must(tool, 'scoped changes tool')
  }

  it('carries the claimsAt callback result, called once with the deduped changed paths', async () => {
    const seen: string[][] = []
    const r = await build({ claimsAt: async paths => { seen.push(paths); return [CLAIM] } }).execute({})
    expect(r.isError).toBe(false)
    expect(CitingClaimsOutput.parse(r.output).citingClaims).toEqual([CLAIM])
    expect(seen).toHaveLength(1)
    expect([...must(seen[0], 'seen[0]')].sort()).toEqual([
      'docs/unrelated-note.md',
      'packages/kernel/src/child.ts',
      'packages/kernel/src/execution/scoped-changes-tool.ts',
    ])
  })

  it('deduplicates: the same path written by two steps reaches the callback once', async () => {
    // a stub kernel returning one path from two contributors pins the dedupe itself
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
      claimsAt: async paths => { seen.push(paths); return [] },
    })
    await must(tool, 'scoped changes tool').execute({})
    expect(seen).toEqual([['packages/kernel/src/dup.ts']])
  })

  it('without the callback citingClaims is null and degraded names the gap (never smuggled into floor)', async () => {
    const o = CitingClaimsOutput.parse((await run()).output)
    expect(o.citingClaims).toBeNull()
    expect(o.floor).not.toContain('unavailable')
    expect(o.degraded).toEqual(['citingClaims unavailable (knowledge unavailable) — name that loudly in your summary.'])
  })

  it('with the callback present, degraded is absent entirely (not an empty array)', async () => {
    const r = await build({ claimsAt: async () => [] }).execute({})
    expect(r.isError).toBe(false)
    expect(recordOf(r.output)).not.toHaveProperty('degraded')
  })

  it('a failing claims lookup keeps the paths and names the failure in degraded', async () => {
    const tool = build({ claimsAt: async () => { throw new Error('bucket broken') } })
    const out = await tool.execute({})
    expect(out.isError).toBe(false)
    expect(out.output).toMatchObject({ citingClaims: null, degraded: ['citingClaims unavailable: bucket broken'] })
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
    // withCommitStep appends {zone: [], readOnlySource: true}: it must not unfence the whole task
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
    // judged against the WRITING steps' zone union: the read-only commit step's empty zone adds nothing
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
    // PLAN_STEP_ROLE === STEP_ROLE.auditor: a bare role check would hand this tool to the plan step
    it("is NOT registered for the grounded 'plan' step, which also has the auditor role", () => {
      expect(scopedChangesTool({ kernel, p: { taskId: THIS_TASK, stepId: STEP_ID.plan, role: STEP_ROLE.auditor } })).toEqual([])
    })
    it('is NOT registered for an implementer step', () => {
      expect(scopedChangesTool({ kernel, p: { taskId: THIS_TASK, stepId: 's1', role: STEP_ROLE.implementer } })).toEqual([])
    })
    it('is NOT registered for an implementer step that happens to be named verify', () => {
      expect(scopedChangesTool({ kernel, p: { taskId: THIS_TASK, stepId: VERIFY_STEP_ID, role: STEP_ROLE.implementer } })).toEqual([])
    })
    // the finish step reads the floor too (stepMayReconcile); a worker named 'finish' gets nothing
    it('registers for the finish step with the finisher role', () => {
      expect(scopedChangesTool({ kernel, p: { taskId: THIS_TASK, stepId: FINISH_STEP_ID, role: STEP_ROLE.finisher } })).toHaveLength(1)
    })
    it("is NOT registered for a worker step named 'finish'", () => {
      expect(scopedChangesTool({ kernel, p: { taskId: THIS_TASK, stepId: FINISH_STEP_ID, role: STEP_ROLE.worker } })).toEqual([])
    })
  })

  it('falls back to the union of the task\'s declared zones when the writing step is unknown', async () => {
    // no plan on the log: every path reports inZone:true instead of inventing an out-of-zone verdict
    const rows = ((await run(fakeKernel([THIS_TASK], undefined))).output as { paths: Array<{ inZone: boolean }> }).paths
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(x => x.inZone)).toBe(true)
  })
})
