// The project conversation — center stage. User ↔ copilot messages (streamed, tool calls as
// visible cards) interleaved with system cards narrating the event stream (zero copilot
// tokens). History (text messages only) persists per project in localStorage; the copilot
// re-grounds itself from live state each exchange, so history is presentational context.
import { EVENT_KIND } from '@orc/contracts'
import type { LogRow, TodoWave } from '@orc/ui-core'
import { api, session, type CopilotPart } from './api'
import { mermaidInto } from './mermaid'
import { el } from './ui/el'
import { Badge, Btn, Empty, Pre, toast, type Tone } from './ui/components'

interface ChatMessage { role: 'user' | 'assistant'; content: string }

const HISTORY_LIMIT = 20
const CARD_KINDS: Record<string, { label: string; tone: Tone }> = {
  [EVENT_KIND.task_created]: { label: 'request created', tone: 'accent' },
  [EVENT_KIND.plan_proposed]: { label: 'plan proposed', tone: 'accent' },
  [EVENT_KIND.plan_edited]: { label: 'plan edited', tone: 'accent' },
  [EVENT_KIND.plan_approved]: { label: 'plan approved', tone: 'ok' },
  [EVENT_KIND.run_started]: { label: 'run started', tone: 'accent' },
  [EVENT_KIND.step_started]: { label: 'step started', tone: 'muted' },
  [EVENT_KIND.step_completed]: { label: 'step completed', tone: 'ok' },
  [EVENT_KIND.step_failed]: { label: 'step failed', tone: 'danger' },
  [EVENT_KIND.feedback_requested]: { label: 'question', tone: 'warn' },
  [EVENT_KIND.feedback_provided]: { label: 'answered', tone: 'ok' },
  [EVENT_KIND.artifact_produced]: { label: 'artifact', tone: 'warn' },
  [EVENT_KIND.memory_written]: { label: 'note written', tone: 'purple' },
  [EVENT_KIND.task_status_changed]: { label: 'status', tone: 'muted' },
}
// kinds that carry a plan change — these get a rich diagram card, not just a line
const PLAN_KINDS = new Set<string>([EVENT_KIND.plan_proposed, EVENT_KIND.plan_edited, EVENT_KIND.plan_approved])

export function renderWaves(waves: TodoWave[]): HTMLElement {
  return el('div', { class: 'waves' }, ...waves.map(w =>
    el('div', { class: 'wave' },
      el('span', { class: 'wave-label' }, `wave ${w.wave}`, w.parallel ? Badge('parallel', 'accent') : ''),
      ...w.steps.map(s => el('span', { class: `wave-step ${s.status}` },
        s.status === 'completed' ? '✓ ' : s.status === 'failed' ? '✗ ' : s.status === 'running' ? '◔ ' : '○ ', s.title)),
    )))
}

export class Conversation {
  readonly root = el('div', { class: 'conv' })
  private readonly list = el('div', { class: 'conv-list' })
  private readonly input = el('textarea', { class: 'conv-input' }) as HTMLTextAreaElement
  private projectId = ''
  private busy = false
  private readonly goNode: (node: string) => void

  constructor(goNode: (node: string) => void) {
    this.goNode = goNode
    this.input.placeholder = 'ask the copilot — it can read state, create requests, approve, run…'
    this.input.rows = 2
    this.input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void this.send() }
    })
    const sendBtn = Btn('send', () => this.send())
    this.root.append(
      this.list,
      session.copilot
        ? el('div', { class: 'conv-inputrow' }, this.input, sendBtn)
        : el('div', { class: 'conv-inputrow' }, Empty('copilot unavailable — start orc graph inside a project')),
    )
  }

  setProject(projectId: string): void {
    if (this.projectId === projectId) return
    this.projectId = projectId
    this.list.replaceChildren()
    for (const m of this.history()) this.bubble(m.role, m.content)
    if (this.list.childElementCount === 0)
      this.list.append(Empty('this is the project chat — system events appear here live, and the copilot can guide you'))
    this.scroll()
  }

  // system narration from the SSE envelope — no tokens spent
  addSystemRow(row: LogRow): void {
    const kind = CARD_KINDS[row.kind]
    if (!kind) return
    const target = row.noteRef ?? row.taskId
    this.list.append(el('div', {
      class: 'sys-card',
      onClick: target ? () => this.goNode(target) : undefined,
      title: target ? 'open in inspector' : undefined,
    },
      Badge(kind.label, kind.tone),
      el('span', { class: 'sys-line' }, row.line),
      el('span', { class: 'sys-seq' }, `#${row.seq}`),
    ))
    if (PLAN_KINDS.has(row.kind) && row.taskId) void this.planCard(row.taskId)
    this.trim()
    this.scroll()
  }

  // rich plan card: diagram + todo waves, straight from the plans endpoint's embedded visual
  private async planCard(taskId: string): Promise<void> {
    const plans = await api.plans(this.projectId, taskId).catch(() => null)
    if (!plans?.visual) return
    const diagram = el('div', { class: 'diagram' })
    void mermaidInto(diagram, plans.visual.mermaid)
    this.list.append(el('div', { class: 'card plan-card' },
      el('div', { class: 'card-title' }, `plan v${plans.visual.version}`, Badge(`${plans.visual.waves.length} wave(s)`, 'accent')),
      diagram,
      renderWaves(plans.visual.waves),
    ))
    this.scroll()
  }

  private history(): ChatMessage[] {
    try { return JSON.parse(localStorage.getItem(`chat:${this.projectId}`) ?? '[]') as ChatMessage[] } catch { return [] }
  }

  private saveHistory(messages: ChatMessage[]): void {
    localStorage.setItem(`chat:${this.projectId}`, JSON.stringify(messages.slice(-HISTORY_LIMIT)))
  }

  private bubble(role: 'user' | 'assistant', text: string): HTMLElement {
    const b = el('div', { class: `bubble ${role}` }, text)
    this.list.append(b)
    return b
  }

  private toolCard(toolName: string, input: unknown): HTMLElement {
    const d = el('details', { class: 'tool-row' })
    d.append(
      el('summary', {}, `⚙ ${toolName}`, Badge('running', 'muted')),
      el('div', { class: 'tool-body' }, Pre(JSON.stringify(input, null, 2) ?? '')),
    )
    this.list.append(d)
    return d
  }

  private async send(): Promise<void> {
    const text = this.input.value.trim()
    if (!text || this.busy || !this.projectId) return
    this.busy = true
    this.input.value = ''
    const messages = [...this.history(), { role: 'user' as const, content: text }]
    this.saveHistory(messages)
    this.bubble('user', text)
    const assistant = this.bubble('assistant', '')
    assistant.classList.add('streaming')
    let answer = ''
    let openTool: HTMLElement | null = null
    const onPart = (part: CopilotPart): void => {
      switch (part.type) {
        case 'text':
          answer += part.text
          assistant.textContent = answer
          break
        case 'tool-call':
          openTool = this.toolCard(part.toolName, part.input)
          this.list.append(assistant) // keep the streaming bubble last
          break
        case 'tool-result':
          if (openTool) {
            openTool.querySelector('.badge')?.replaceWith(Badge('done', 'ok'))
            openTool.querySelector('.tool-body')?.append(Pre(JSON.stringify(part.output, null, 2)?.slice(0, 2_000) ?? ''))
            openTool = null
          }
          break
        case 'tool-error':
          openTool?.querySelector('.badge')?.replaceWith(Badge('error', 'danger'))
          toast(`${part.toolName}: ${part.error}`, 'danger')
          break
        case 'error':
          toast(part.message, 'danger')
          break
        case 'done':
          this.list.append(el('div', { class: 'conv-usage' },
            `${part.usage.inputTokens} in / ${part.usage.outputTokens} out${part.usage.costUSD !== null ? ` · $${part.usage.costUSD.toFixed(4)}` : ''}`))
          break
      }
      this.scroll()
    }
    try {
      await api.copilot({ projectId: this.projectId, messages: messages.slice(-HISTORY_LIMIT) }, onPart)
      if (answer) this.saveHistory([...messages, { role: 'assistant', content: answer }])
    } catch {
      // the api layer already routed the error to the configured handler
    } finally {
      assistant.classList.remove('streaming')
      if (!assistant.textContent) assistant.remove()
      this.busy = false
      this.scroll()
    }
  }

  private trim(): void {
    while (this.list.childElementCount > 300) this.list.firstElementChild!.remove()
  }

  private scroll(): void {
    this.list.scrollTop = this.list.scrollHeight
  }
}
