// Pure row-building for the copilot pane: journaled exchanges → keyed rows. Zero imports on
// purpose — this is the file the keyed-each contract lives in, and the test pins it.

export type CopilotRow =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string }
  | { kind: 'tool'; id: string; toolName: string; state: 'running' | 'done' | 'error'; detail: string }

export interface ExchangeRecord {
  seq: number
  user: string
  assistant: string
  toolCalls: Array<{ toolName: string; summary: string }>
}

/**
 * Ids are strings scoped by seq AND position. The previous scheme derived numeric ids as
 * `seq*2 + offset`, which collided twice over: every tool call in one exchange shared `seq*2+1`,
 * and the assistant of exchange N (`2N+2`) equalled the user of exchange N+1 (`2(N+1)`) whenever
 * two exchanges landed on consecutive seqs — Svelte's keyed each threw `each_key_duplicate` the
 * moment the second exchange of a session rendered (observed live at seq 79327/79328).
 */
export function restoredRows(exchanges: ExchangeRecord[], maxRows: number): CopilotRow[] {
  const out: CopilotRow[] = []
  for (const x of exchanges) {
    out.push({ kind: 'message', id: `${x.seq}:u`, role: 'user', text: x.user })
    x.toolCalls.forEach((call, i) => out.push({ kind: 'tool', id: `${x.seq}:t${i}`, toolName: call.toolName, state: 'done', detail: call.summary }))
    if (x.assistant !== '') out.push({ kind: 'message', id: `${x.seq}:a`, role: 'assistant', text: x.assistant })
  }
  return out.slice(-maxRows)
}
