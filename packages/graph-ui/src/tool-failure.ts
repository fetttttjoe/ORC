// Reads the isError flag off the raw tool_result, which the LogRow summary folds away
import { EVENT_KIND, type EventRecord } from '@orc/contracts'
import { z } from 'zod'

export interface ToolFailure { toolName: string; error: string }

// Lenient read: a payload that does not parse skips its event, never takes the stream down
const ToolResultView = z.object({ toolName: z.string(), output: z.unknown(), isError: z.boolean() })

// Room for a rejection reason, too short for a megabyte result to become the pane
const ERROR_TEXT_LIMIT = 600

export function toolFailure(event: EventRecord | null): ToolFailure | null {
  if (event === null || event.kind !== EVENT_KIND.tool_result) return null
  const parsed = ToolResultView.safeParse(event.payload)
  if (!parsed.success || !parsed.data.isError) return null
  const { toolName, output } = parsed.data
  const text = typeof output === 'string' ? output : JSON.stringify(output) ?? ''
  return { toolName, error: text.slice(0, ERROR_TEXT_LIMIT) }
}
