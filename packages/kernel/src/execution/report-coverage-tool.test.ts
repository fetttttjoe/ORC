import { describe, expect, it } from 'bun:test'
import { reportCoverageTool } from './report-coverage-tool'
import { ANALYZE_STEP_ROLE } from './strategies/grounded-plan'

const scoutP = { taskId: 't1', stepId: 'analyze', runToken: 'rt', role: ANALYZE_STEP_ROLE }

describe('report_coverage tool', () => {
  it('reports the scout CoverageReport through the kernel with the injected step context', async () => {
    const calls: Array<{ ctx: unknown; coverage: unknown }> = []
    const kernel = { reportCoverage: async (ctx: unknown, coverage: unknown) => { calls.push({ ctx, coverage }) } }
    const tool = reportCoverageTool({ kernel, p: scoutP })
    expect(tool.name).toBe('report_coverage')
    const r = await tool.execute({ analyzed: true, gaps: ['x'] })
    expect(r.isError).toBe(false)
    expect(calls).toEqual([{ ctx: { taskId: 't1', stepId: 'analyze', runToken: 'rt' }, coverage: { analyzed: true, gaps: ['x'] } }])
  })

  it('rejects a non-scout role — only the analyze step may report coverage', async () => {
    const kernel = { reportCoverage: async () => { throw new Error('should not be called') } }
    const tool = reportCoverageTool({ kernel, p: { ...scoutP, role: 'auditor' } })
    const r = await tool.execute({ analyzed: false })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain(ANALYZE_STEP_ROLE)
  })

  it('surfaces a kernel failure as isError, never a throw', async () => {
    const kernel = { reportCoverage: async () => { throw new Error('log down') } }
    const tool = reportCoverageTool({ kernel, p: scoutP })
    const r = await tool.execute({ analyzed: true })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('log down')
  })
})
