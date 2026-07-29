// Log tab — the live event feed. Initial rows from /api/log, then appended from SSE summaries
// by app.ts. Rows navigate: task events → their task node, memory events → the note node.
// the sub-path, not the barrel: a VALUE import of '@orc/ui-core' resolves sessions.ts → @orc/kernel
// → node builtins and breaks the browser bundle (type-only barrel imports are erased and safe)
import { shouldAdmitLogRow, type LogRow } from '@orc/ui-core/summarize'
import { el } from './ui/el'
import { Badge, type Tone } from './ui/components'

const CLIENT_CAP = 500

// The scrolling container: .log has no overflow of its own — the inspector overlay scrolls
// (theme.css). Was '.detail' from before the shell-v2 rename, so closest() found nothing and
// neither the initial render nor live rows ever moved the panel.
const SCROLLER_SELECTOR = '.inspector'

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

  // callers mount `root` BEFORE calling this — closest() resolves the panel only once attached
  setRows(rows: LogRow[], taskFilter: string | null): void {
    this.taskFilter = taskFilter
    this.root.replaceChildren(...rows.map(r => this.row(r)))
    const scroller = this.root.closest(SCROLLER_SELECTOR)
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }

  append(r: LogRow): void {
    // ONE admit/reject rule with the server-side initial batch (sessions.ts log()) — same
    // shouldAdmitLogRow — so the initial task-filtered rows and the live SSE tail cannot drift.
    // A sibling task's project-scoped memory row (envelope taskId null) is now rejected unless it
    // was AUTHORED by this task (row.authorTaskId === taskFilter), where the old rule blanket-let
    // every null-taskId row through.
    if (!shouldAdmitLogRow(r, this.taskFilter)) return
    // pin-to-bottom unless the user scrolled up to read (scrolling container is the panel)
    const scroller = this.root.closest(SCROLLER_SELECTOR)
    const pinned = !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 40
    this.root.append(this.row(r))
    while (this.root.childElementCount > CLIENT_CAP) this.root.firstElementChild?.remove()
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
