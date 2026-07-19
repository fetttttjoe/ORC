import type { ResolvedTool } from '@orc/contracts'
import type { Kernel } from '../kernel'

// read_annotations (M5b, D6 targeted re-plan): the plan-authoring agent's ONLY channel to read
// plan_annotated events. annotatePlan (kernel) is the write side (human/CLI `orc annotate`); this
// is the read side. Mirrors finalize_plan's shape exactly — taskId comes from the injected step
// context, never a model-supplied input, so the agent can't be tricked into reading another task.
export function readAnnotationsTool(opts: {
  kernel: Pick<Kernel, 'listAnnotations'>
  p: { taskId: string }
}): ResolvedTool {
  const { kernel, p } = opts
  return {
    ref: 'kernel/read_annotations', name: 'read_annotations',
    description:
      "List the human's queued plan annotations (plan_annotated events) for this task, oldest first. Each names a targetNote — revise ONLY that note and its decomposes_into subtree, leaving every other note byte-stable.",
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      try {
        const annotations = await kernel.listAnnotations(p.taskId)
        return { output: { annotations }, isError: false }
      } catch (e) {
        return { output: { error: e instanceof Error ? e.message : String(e) }, isError: true }
      }
    },
  }
}
