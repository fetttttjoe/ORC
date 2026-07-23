import { describe, expect, it } from 'bun:test'
import { reportCoverageTool } from './report-coverage-tool'
import { ANALYZE_STEP_ROLE } from './strategies/grounded-plan'

const scoutP = { taskId: 't1', stepId: 'analyze', runToken: 'rt', role: ANALYZE_STEP_ROLE }

describe('report_coverage tool', () => {
  it('reports the scout CoverageReport through the kernel with the injected step context', async () => {
    const calls: Array<{ ctx: unknown; coverage: unknown }> = []
    const kernel = { reportCoverage: async (ctx: unknown, coverage: unknown) => { calls.push({ ctx, coverage }) } }
    const [tool] = reportCoverageTool({ kernel, p: scoutP })
    expect(tool!.name).toBe('report_coverage')
    const r = await tool!.execute({ analyzed: true, gaps: ['x'] })
    expect(r.isError).toBe(false)
    expect(calls).toEqual([{ ctx: { taskId: 't1', stepId: 'analyze', runToken: 'rt' }, coverage: { analyzed: true, gaps: ['x'] } }])
  })

  // Registration gate, not an execute-time rejection: a visible always-erroring tool still gets
  // called (scenario-2's verify burned an iteration per attempt on it) — so for any other role
  // the tool must not exist at all.
  it('is not offered to a non-scout role', () => {
    const kernel = { reportCoverage: async () => { throw new Error('should not be called') } }
    expect(reportCoverageTool({ kernel, p: { ...scoutP, role: 'auditor' } })).toEqual([])
    expect(reportCoverageTool({ kernel, p: scoutP })).toHaveLength(1)
  })

  it('surfaces a kernel failure as isError, never a throw', async () => {
    const kernel = { reportCoverage: async () => { throw new Error('log down') } }
    const [tool] = reportCoverageTool({ kernel, p: scoutP })
    const r = await tool!.execute({ analyzed: true })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('log down')
  })
})
