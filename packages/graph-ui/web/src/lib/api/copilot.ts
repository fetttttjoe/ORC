// POST-SSE client for /api/copilot — the one streaming call; plain JSON fetches live in client.ts.
import { authHeaders } from './client'
// Wire contract: server.ts CopilotBody in, `data: <json CopilotPart>` events out. The body carries
// projectId — the legacy page sent no x-orc-project header on this route, only on /api/actions.
import { z } from 'zod'
import { ApiError } from './client'

export interface CopilotMessage {
  role: 'user' | 'assistant'
  content: string
}

// the parts the server emits (it maps the model stream's text-delta → 'text' before the wire)
const CopilotPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool-call'), toolName: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool-result'), toolName: z.string(), output: z.unknown() }),
  z.object({ type: z.literal('tool-error'), toolName: z.string(), error: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({
    type: z.literal('done'),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), costUSD: z.number().nullable() }),
  }),
])
export type CopilotPart = z.infer<typeof CopilotPartSchema>

// server caps messages at 60; send the recent tail like the legacy pane did
export const COPILOT_HISTORY_LIMIT = 20

// parse an SSE body: events split on \n\n, `data: ` lines joined per event
async function readSse(res: Response, onData: (data: string) => void): Promise<void> {
  if (!res.body) throw new ApiError('copilot', 'response carried no body')
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buf += dec.decode(value, { stream: true })
    const blocks = buf.split('\n\n')
    buf = blocks.pop() ?? ''
    for (const block of blocks) {
      const data = block
        .split('\n')
        .filter(l => l.startsWith('data: '))
        .map(l => l.slice(6))
        .join('')
      if (data.trim()) onData(data)
    }
  }
}

/** Streams one exchange; resolves when the stream closes. The signal aborts mid-stream. */
export async function copilotSend(opts: {
  project: string
  modelRef?: string
  messages: CopilotMessage[]
  signal?: AbortSignal
  onPart: (part: CopilotPart) => void
}): Promise<void> {
  const res = await fetch('/api/copilot', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      projectId: opts.project,
      ...(opts.modelRef !== undefined && { modelRef: opts.modelRef }),
      messages: opts.messages.slice(-COPILOT_HISTORY_LIMIT),
    }),
    ...(opts.signal !== undefined && { signal: opts.signal }),
  })
  if (!res.ok) throw new ApiError('copilot', await res.text().catch(() => res.statusText))
  await readSse(res, data => {
    // safeParse, not parse: an unknown part kind is forward-compat noise, not a dead stream
    const part = CopilotPartSchema.safeParse(JSON.parse(data))
    if (part.success) opts.onPart(part.data)
  })
}
