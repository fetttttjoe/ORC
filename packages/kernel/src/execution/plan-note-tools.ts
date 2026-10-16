import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { MASTERPLAN_NOTE_ID, PlanNoteToolName, PlanNoteWrite, stepMayPlan, toolError, toolSchemaOf, type Origin, type ResolvedTool } from '@orc/contracts'
import type { Kernel } from '../kernel'

const ReadInput = z.object({ id: z.string().min(1).optional() })

// The plan step's authoring surface: its own task's plan notes, written through the kernel.
export function planNoteTools(opts: {
  kernel: Pick<Kernel, 'writePlanNote' | 'listPlanNotes'>
  p: { taskId: string; stepId: string; runToken: string; role: string; origin: Origin }
}): ResolvedTool[] {
  const { kernel, p } = opts
  if (!stepMayPlan(p)) return []
  return [
    {
      ref: `kernel/${PlanNoteToolName.write}`, name: PlanNoteToolName.write,
      description: `Create or revise one note of this task's plan, by id: fields you omit keep their stored values, an explicit empty list clears a list field, and \`modelRef: ''\` inherits the parent's model. The '${MASTERPLAN_NOTE_ID}' note lists each subplan note id in \`subplans\`, in step order. A subplan holds its requirements (body), \`rationale\`, \`dependsOn\` (the sibling ids it must run after — the only thing that orders the plan), \`zone\` (one write glob per entry), \`uncertainty\`, \`skillRefs\`/\`toolRefs\`, and \`modelRef\`. A new note needs a non-empty title.`,
      inputSchema: toolSchemaOf(PlanNoteWrite),
      execute: async (input, toolCallId) => {
        try {
          const write = PlanNoteWrite.parse(input)
          const idempotencyKey = `${p.runToken}:tool:${toolCallId ?? randomUUID()}:plan-note:${write.id}`
          const note = await kernel.writePlanNote(p.taskId, write, p.origin, { stepId: p.stepId, runToken: p.runToken, idempotencyKey })
          return { output: { note }, isError: false }
        } catch (e) {
          return toolError(e)
        }
      },
    },
    {
      ref: `kernel/${PlanNoteToolName.read}`, name: PlanNoteToolName.read,
      description: "Read this task's plan notes: every note, or the one whose id you pass.",
      inputSchema: toolSchemaOf(ReadInput),
      execute: async input => {
        try {
          const { id } = ReadInput.parse(input)
          const notes = await kernel.listPlanNotes(p.taskId)
          if (id === undefined) return { output: { notes }, isError: false }
          const note = notes.find(n => n.id === id)
          return note
            ? { output: { note }, isError: false }
            : { output: { error: `no plan note '${id}' — call ${PlanNoteToolName.read} without an id to list them` }, isError: true }
        } catch (e) {
          return toolError(e)
        }
      },
    },
  ]
}
