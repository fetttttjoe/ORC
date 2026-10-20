import type { ResolvedTool } from '@orc/contracts'
import { toolError, NO_INPUT_SCHEMA } from '@orc/contracts'
import type { Kernel } from '../kernel'

// taskId comes from the step context, never model input, so no other task is readable.
export function readAnnotationsTool(opts: {
  kernel: Pick<Kernel, 'listAnnotations'>
  p: { taskId: string }
}): ResolvedTool {
  const { kernel, p } = opts
  return {
    ref: 'kernel/read_annotations', name: 'read_annotations',
    description:
      "List the human's queued plan annotations (plan_annotated events) for this task, oldest first. Each names a targetNote — revise ONLY that note and the notes its `subplans` lists, leaving every other note byte-stable.",
    inputSchema: NO_INPUT_SCHEMA,
    execute: async () => {
      try {
        const annotations = await kernel.listAnnotations(p.taskId)
        return { output: { annotations }, isError: false }
      } catch (e) {
        return toolError(e)
      }
    },
  }
}
