// Pure row building: journaled exchanges to keyed rows; the keyed-each contract lives here

export type CopilotRow =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string }
  | { kind: 'tool'; id: string; toolName: string; state: 'running' | 'done' | 'error'; detail: string }

export interface ExchangeRecord {
  seq: number
  user: string
  assistant: string
  toolCalls: Array<{ toolName: string; summary: string }>
}

// Ids are strings scoped by seq AND position: numeric ids collided and threw each_key_duplicate
export function restoredRows(exchanges: ExchangeRecord[], maxRows: number): CopilotRow[] {
  const out: CopilotRow[] = []
  for (const x of exchanges) {
    out.push({ kind: 'message', id: `${x.seq}:u`, role: 'user', text: x.user })
    x.toolCalls.forEach((call, i) => out.push({ kind: 'tool', id: `${x.seq}:t${i}`, toolName: call.toolName, state: 'done', detail: call.summary }))
    if (x.assistant !== '') out.push({ kind: 'message', id: `${x.seq}:a`, role: 'assistant', text: x.assistant })
  }
  return out.slice(-maxRows)
}
