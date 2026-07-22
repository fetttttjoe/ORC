import type { ResolvedTool } from '@orc/contracts'
import { errorMessage } from '@orc/contracts'
import type { Kernel } from '../kernel'
import { ANALYZE_STEP_ROLE } from './strategies/grounded-plan'

// report_coverage (M5b, D3/RG7): the analyze (scout) step self-reports what it covered, just before
// it signals success — the production emitter for analysis_completed. Mirrors finalize_plan's factory
// shape: taskId/stepId/runToken come from the injected step context (never a model input), and the
// role is gated so only the grounded analyze step can emit. The report body IS model-supplied — it is
// the scout's own coverage claim (analyzed:false with a gap = the RG7 degradation path). The kernel
// validates it (AnalysisCompletedPayload) and applies defaults.
// ponytail: nothing consumes analysis_completed today beyond orc status; this stays a thin seam so
// the reserved RG7 telemetry (confidence/scope) already lands as a real event when a reader arrives.
export function reportCoverageTool(opts: {
  kernel: Pick<Kernel, 'reportCoverage'>
  p: { taskId: string; stepId: string; runToken: string; role: string }
}): ResolvedTool {
  const { kernel, p } = opts
  return {
    ref: 'kernel/report_coverage', name: 'report_coverage',
    description:
      'Record what this analysis covered: { analyzed, scope?, gaps?, confidence?, notesWritten? }. Call once, just before signaling success. Set analyzed:false with a gap explaining why when you could not read the codebase.',
    inputSchema: {
      type: 'object',
      properties: {
        analyzed: { type: 'boolean' },
        scope: { type: 'array', items: { type: 'string' } },
        gaps: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
        notesWritten: { type: 'number' },
      },
      required: ['analyzed'],
    },
    execute: async input => {
      if (p.role !== ANALYZE_STEP_ROLE)
        return { output: { error: `report_coverage is only valid for a grounded-plan's '${ANALYZE_STEP_ROLE}' step` }, isError: true }
      try {
        await kernel.reportCoverage({ taskId: p.taskId, stepId: p.stepId, runToken: p.runToken }, input)
        return { output: { recorded: true }, isError: false }
      } catch (e) {
        return { output: { error: errorMessage(e) }, isError: true }
      }
    },
  }
}
