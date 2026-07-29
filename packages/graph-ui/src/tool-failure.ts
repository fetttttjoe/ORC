// The one thing the conversation pane needs from a raw tool_result and cannot get from the
// LogRow summary it normally consumes: whether the call FAILED, and why.
//
// Motivating failure: a broken approval gate rejected eight consecutive "approve" answers. Every
// rejection was a finalize_plan tool_result carrying the reason, and the pane showed none of it —
// summarizeEvent folds isError into a display string and no consumer can read the flag back. The
// user saw eight near-identical questions and concluded the system was running in circles.
//
// The web adapter is the one place that holds both the raw event and the row the pane receives,
// so the flag is read here, once.
import { EVENT_KIND, type EventRecord } from '@orc/contracts'
import { z } from 'zod'

export interface ToolFailure { toolName: string; error: string }

// Lenient read-side view (the transcript.ts pattern): a payload that does not parse skips its
// event rather than throwing — one malformed row must never take the live stream down.
const ToolResultView = z.object({ toolName: z.string(), output: z.unknown(), isError: z.boolean() })

// Long enough for a rejection reason with its context, short enough that a tool returning a
// megabyte of JSON cannot become the pane. The card links to the inspector for the full result.
const ERROR_TEXT_LIMIT = 600

export function toolFailure(event: EventRecord | null): ToolFailure | null {
  if (event === null || event.kind !== EVENT_KIND.tool_result) return null
  const parsed = ToolResultView.safeParse(event.payload)
  if (!parsed.success || !parsed.data.isError) return null
  const { toolName, output } = parsed.data
  const text = typeof output === 'string' ? output : JSON.stringify(output) ?? ''
  return { toolName, error: text.slice(0, ERROR_TEXT_LIMIT) }
}
