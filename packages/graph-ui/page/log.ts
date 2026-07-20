// Log tab — the live event feed. Initial rows from /api/log, then appended from SSE summaries
// by app.ts. Rows navigate: task events → their task node, memory events → the note node.
import type { LogRow } from '@orc/ui-core'
import { el } from './ui/el'
import { Badge, type Tone } from './ui/components'

const CLIENT_CAP = 500

const toneFor = (kind: string): Tone =>
  kind.startsWith('memory_') ? 'purple'
    : kind.startsWith('tool_') ? 'warn'
    : kind === 'step_failed' || kind === 'operation_failed' ? 'danger'
    : kind.startsWith('step_') || kind.startsWith('run_') || kind === 'agent_call' ? 'accent'
    : 'muted'

export class LogView {
  readonly root = el('div', { class: 'log' })
  private readonly go: (node: string) => void
  private taskFilter: string | null = null

  constructor(go: (node: string) => void) {
    this.go = go
  }

  setRows(rows: LogRow[], taskFilter: string | null): void {
    this.taskFilter = taskFilter
    this.root.replaceChildren(...rows.map(r => this.row(r)))
    this.root.scrollTop = this.root.scrollHeight
  }

  append(r: LogRow): void {
    if (this.taskFilter && r.taskId !== null && r.taskId !== this.taskFilter) return
    // pin-to-bottom unless the user scrolled up to read (scrolling container is the panel)
    const scroller = this.root.closest('.detail')
    const pinned = !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 40
    this.root.append(this.row(r))
    while (this.root.childElementCount > CLIENT_CAP) this.root.firstElementChild!.remove()
    if (pinned && scroller) scroller.scrollTop = scroller.scrollHeight
  }

  private row(r: LogRow): HTMLElement {
    const target = r.noteRef ?? r.taskId
    return el('div', {
      class: 'log-row',
      title: r.line,
      onClick: target ? () => this.go(target) : undefined,
    },
      el('span', { class: 'seq' }, String(r.seq)),
      Badge(r.kind, toneFor(r.kind)),
      el('span', { class: 'line' }, r.line),
    )
  }
}
