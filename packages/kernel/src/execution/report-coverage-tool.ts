import type { Origin, ResolvedTool } from '@orc/contracts'
import { Confidence, CoverageReport, toolError } from '@orc/contracts'
import type { Kernel } from '../kernel'
import { ANALYZE_STEP_ROLE } from './strategies/grounded-plan'

// claimsWritten is measured in execute(), never self-reported by the model.
const ModelCoverage = CoverageReport.omit({ claimsWritten: true })

export function reportCoverageTool(opts: {
  kernel: Pick<Kernel, 'reportCoverage' | 'listTaskKnowledgeWrites'>
  p: { taskId: string; stepId: string; runToken: string; role: string; origin: Origin }
}): ResolvedTool[] {
  const { kernel, p } = opts
  // Registration gate: a visible tool that can only error gets called anyway.
  if (p.role !== ANALYZE_STEP_ROLE) return []
  return [{
    ref: 'kernel/report_coverage', name: 'report_coverage',
    description:
      'Record what this analysis covered: { analyzed, scope?, gaps?, confidence? }. Call once, just before signaling success. Set analyzed:false with a gap explaining why when you could not read the codebase.',
    inputSchema: {
      type: 'object',
      properties: {
        analyzed: { type: 'boolean' },
        scope: { type: 'array', items: { type: 'string' } },
        gaps: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'string', enum: Object.values(Confidence) },
      },
      required: ['analyzed'],
    },
    execute: async input => {
      try {
        const claimsWritten = (await kernel.listTaskKnowledgeWrites(p.taskId)).live.length
        await kernel.reportCoverage({ taskId: p.taskId, stepId: p.stepId, runToken: p.runToken }, { ...ModelCoverage.parse(input), claimsWritten }, p.origin)
        return { output: { recorded: true }, isError: false }
      } catch (e) {
        return toolError(e)
      }
    },
  }]
}
