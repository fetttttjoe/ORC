// Chat tab — the step/task transcript, composed from ui/ primitives. Task node → whole task,
// step node → that step only. Live: app.ts re-renders on matching SSE summaries (debounced).
import type { TranscriptItem } from '@orc/ui-core'
import { el } from './ui/el'
import { Badge, Card, Empty, Pre, statusTone } from './ui/components'

const iterDivider = (n: number): HTMLElement => el('div', { class: 'chat-iter' }, `iter ${n}`)

function item(i: TranscriptItem): HTMLElement[] {
  switch (i.kind) {
    case 'message':
      return [el('div', { class: 'card msg' }, i.text)]
    case 'tool': {
      const d = el('details', { class: 'tool-row' })
      d.append(
        el('summary', {}, i.toolName, i.isError ? Badge('error', 'danger') : '', i.output === null ? Badge('no result', 'warn') : ''),
        el('div', { class: 'tool-body' },
          Pre(JSON.stringify(i.input, null, 2) ?? 'null'),
          i.output === null ? Empty('no result recorded (crash window?)') : Pre(typeof i.output === 'string' ? i.output : JSON.stringify(i.output, null, 2) ?? 'null'),
        ),
      )
      return [d]
    }
    case 'question':
      return [el('div', { class: 'card msg-q' },
        el('div', { class: 'card-title' }, 'Q: ' + i.question, i.answer === null ? Badge('waiting', 'warn') : ''),
        i.answer !== null ? el('div', {}, `A: ${i.answer}`) : null,
      )]
    case 'signal':
      return [el('div', { class: 'card' },
        el('div', { class: 'card-title' }, Badge(i.outcome, statusTone(i.outcome === 'success' ? 'done' : 'failed')), 'signal'),
        el('div', {}, i.summary),
      )]
  }
}

export function renderChat(items: TranscriptItem[]): HTMLElement {
  if (items.length === 0) return Empty('no conversation yet — select a task or step with agent activity')
  const out = el('div', { class: 'chat' })
  let iter = 0
  for (const i of items) {
    const itemIter = 'iteration' in i ? i.iteration : iter
    if (itemIter !== iter) { iter = itemIter; out.append(iterDivider(iter)) }
    out.append(...item(i))
  }
  return out
}
