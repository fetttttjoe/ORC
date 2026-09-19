// POST-SSE client for /api/copilot — the one streaming call; plain JSON fetches live in client.ts.
import { authHeaders } from './client'
// Wire contract: server.ts CopilotBody in, `data: <json CopilotPart>` events out. The body carries
// projectId — the legacy page sent no x-orc-project header on this route, only on /api/actions.
import { CopilotPart } from '@orc/ui-core/wire'
import { ApiError } from './client'

export interface CopilotMessage {
  role: 'user' | 'assistant'
  content: string
}


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
  // The conversation this turn belongs to (null opens one) and what it is ABOUT. All three are
  // required-nullable, like CopilotBody: an omitted key reads as "opening a new chat", which is
  // how a dropped id silently forks a live conversation.
  chatId: string | null
  taskId: string | null
  workspaceId: string | null
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
      chatId: opts.chatId,
      taskId: opts.taskId,
      workspaceId: opts.workspaceId,
      ...(opts.modelRef !== undefined && { modelRef: opts.modelRef }),
      messages: opts.messages.slice(-COPILOT_HISTORY_LIMIT),
    }),
    ...(opts.signal !== undefined && { signal: opts.signal }),
  })
  if (!res.ok) throw new ApiError('copilot', await res.text().catch(() => res.statusText))
  await readSse(res, data => {
    const part = CopilotPart.safeParse(JSON.parse(data))
    if (part.success) opts.onPart(part.data)
    else console.error('copilot: frame did not match its schema —', part.error.issues[0]?.message)
  })
}
