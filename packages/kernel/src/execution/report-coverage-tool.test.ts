import { describe, expect, it } from 'bun:test'
import type { Origin } from '@orc/contracts'
import { Confidence, Door } from '@orc/contracts'
import { must } from '@orc/contracts/fixtures'
import { reportCoverageTool } from './report-coverage-tool'
import { runOrigin } from './run-chat'
import { ANALYZE_STEP_ROLE } from './strategies/grounded-plan'

const STEP_ORIGIN: Origin = runOrigin('run:t1:v1')
const scoutP = { taskId: 't1', stepId: 'analyze', runToken: 'rt', role: ANALYZE_STEP_ROLE, origin: STEP_ORIGIN }

const fakeKnowledgeWrites = (live: Array<{ id: string; location: string }> = []) =>
  ({ listTaskKnowledgeWrites: async () => ({ live, retired: [], files: [] }) })

describe('report_coverage tool', () => {
  it('reports the scout CoverageReport through the kernel with the injected step context, claimsWritten counted from the log', async () => {
    const calls: Array<{ ctx: unknown; coverage: unknown; origin: unknown }> = []
    const kernel = {
      reportCoverage: async (ctx: unknown, coverage: unknown, origin: Origin) => { calls.push({ ctx, coverage, origin }) },
      ...fakeKnowledgeWrites([{ id: 'aaaaaaaa', location: 'k' }, { id: 'bbbbbbbb', location: 'k' }]),
    }
    const [tool] = reportCoverageTool({ kernel, p: scoutP })
    expect(must(tool, 'report_coverage tool').name).toBe('report_coverage')
    const r = await must(tool, 'report_coverage tool').execute({ analyzed: true, gaps: ['x'], claimsWritten: 99 })
    expect(r.isError).toBe(false)
    // the model's claimsWritten (99) is DISCARDED: the count comes from the log
    expect(calls).toEqual([{
      ctx: { taskId: 't1', stepId: 'analyze', runToken: 'rt' },
      coverage: { analyzed: true, scope: [], gaps: ['x'], confidence: Confidence.none, claimsWritten: 2 },
      origin: { chatId: 'run:t1:v1', door: Door.supervisor },
    }])
  })

  // Registration gate: a visible always-erroring tool still gets called, so other roles lack it
  it('is not offered to a non-scout role', () => {
    const kernel = { reportCoverage: async () => { throw new Error('should not be called') }, ...fakeKnowledgeWrites() }
    expect(reportCoverageTool({ kernel, p: { ...scoutP, role: 'auditor' } })).toEqual([])
    expect(reportCoverageTool({ kernel, p: scoutP })).toHaveLength(1)
  })

  it('surfaces a kernel failure as isError, never a throw', async () => {
    const kernel = { reportCoverage: async () => { throw new Error('log down') }, ...fakeKnowledgeWrites() }
    const [tool] = reportCoverageTool({ kernel, p: scoutP })
    const r = await must(tool, 'report_coverage tool').execute({ analyzed: true })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('log down')
  })
})
