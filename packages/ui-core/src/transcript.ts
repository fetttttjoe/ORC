import { z } from 'zod'
import { EVENT_KIND, type EventRecord } from '@orc/contracts'

export type TranscriptItem =
  | { kind: 'message'; iteration: number; stepId: string; text: string }
  | { kind: 'tool'; iteration: number; stepId: string; toolName: string; input: unknown; output: unknown; isError: boolean }
  | { kind: 'question'; stepId: string; question: string; answer: string | null }
  | { kind: 'signal'; stepId: string; outcome: string; summary: string }

// Lenient read-side views (the projections.ts pattern): a malformed payload skips its event,
// never throws — transcripts must render for any history.
const View = {
  agent_call: z.object({
    stepId: z.string(), iteration: z.number(),
    response: z.object({ text: z.string().optional() }).loose().optional(),
  }),
  tool_call: z.object({ stepId: z.string(), iteration: z.number(), toolCallId: z.string(), toolName: z.string(), input: z.unknown() }),
  tool_result: z.object({ stepId: z.string(), iteration: z.number(), toolCallId: z.string(), output: z.unknown(), isError: z.boolean() }),
  feedback_requested: z.object({ question: z.string(), topic: z.string() }),
  feedback_provided: z.object({ topic: z.string(), text: z.string() }),
  signal_received: z.object({ stepId: z.string(), signal: z.object({ outcome: z.string(), summary: z.string() }) }),
}

// Ordered conversation for a task (optionally one step). Tool calls pair with their results by
// toolCallId; a dangling call (crash window) renders with output null.
export function foldTranscript(events: EventRecord[], taskId: string, stepId?: string): TranscriptItem[] {
  const items: TranscriptItem[] = []
  const openTools = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>()
  const openQuestions = new Map<string, Extract<TranscriptItem, { kind: 'question' }>>()

  for (const e of events) {
    if (e.taskId !== taskId) continue
    if (stepId && e.stepId !== stepId) continue
    switch (e.kind) {
      case EVENT_KIND.agent_call: {
        const p = View.agent_call.safeParse(e.payload)
        if (p.success && p.data.response?.text)
          items.push({ kind: 'message', iteration: p.data.iteration, stepId: p.data.stepId, text: p.data.response.text })
        break
      }
      case EVENT_KIND.tool_call: {
        const p = View.tool_call.safeParse(e.payload)
        if (!p.success) break
        const item: Extract<TranscriptItem, { kind: 'tool' }> =
          { kind: 'tool', iteration: p.data.iteration, stepId: p.data.stepId, toolName: p.data.toolName, input: p.data.input, output: null, isError: false }
        openTools.set(p.data.toolCallId, item)
        items.push(item) // placed at call position; the result mutates it in place
        break
      }
      case EVENT_KIND.tool_result: {
        const p = View.tool_result.safeParse(e.payload)
        if (!p.success) break
        const open = openTools.get(p.data.toolCallId)
        if (open) { open.output = p.data.output; open.isError = p.data.isError; openTools.delete(p.data.toolCallId) }
        break
      }
      case EVENT_KIND.feedback_requested: {
        const p = View.feedback_requested.safeParse(e.payload)
        if (!p.success) break
        const item: Extract<TranscriptItem, { kind: 'question' }> =
          { kind: 'question', stepId: e.stepId ?? '', question: p.data.question, answer: null }
        openQuestions.set(p.data.topic, item)
        items.push(item)
        break
      }
      case EVENT_KIND.feedback_provided: {
        const p = View.feedback_provided.safeParse(e.payload)
        if (!p.success) break
        const open = openQuestions.get(p.data.topic)
        if (open) { open.answer = p.data.text; openQuestions.delete(p.data.topic) }
        break
      }
      case EVENT_KIND.signal_received: {
        const p = View.signal_received.safeParse(e.payload)
        if (p.success)
          items.push({ kind: 'signal', stepId: p.data.stepId, outcome: p.data.signal.outcome, summary: p.data.signal.summary })
        break
      }
    }
  }
  return items
}
