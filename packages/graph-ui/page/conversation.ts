// The project conversation — center stage. User ↔ copilot messages (streamed, tool calls as
// visible cards) interleaved with system cards narrating the event stream (zero copilot
// tokens). History (text messages only) persists per project in localStorage; the copilot
// re-grounds itself from live state each exchange, so history is presentational context.
import { EVENT_KIND, planScope } from '@orc/contracts'
import type { LogRow, TodoWave } from '@orc/ui-core'
import { isUiMetaNote, noteNodeId, stepNodeId } from '@orc/ui-core/graph'
import { api, canAct, session, type CopilotPart } from './api'
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
  [EVENT_KIND.analysis_completed]: { label: 'analysis done', tone: 'purple' },
}
// agent work between lifecycle cards — rendered as ONE in-place updating ticker line, so a
// minutes-long step never looks frozen (and never floods the chat with per-call cards)
const WORKING_KINDS = new Set<string>([
  EVENT_KIND.agent_call, EVENT_KIND.tool_call, EVENT_KIND.tool_result,
  EVENT_KIND.operation_started, EVENT_KIND.operation_completed, EVENT_KIND.skill_loaded,
])
// kinds that carry a plan change — these get a rich diagram card, not just a line
const PLAN_KINDS = new Set<string>([EVENT_KIND.plan_proposed, EVENT_KIND.plan_edited, EVENT_KIND.plan_approved])
// a finished analysis means the grounded decomposition exists — show it as a card
const DECOMPOSITION_KINDS = new Set<string>([EVENT_KIND.analysis_completed])
// step lifecycle — refreshes the task's live plan card (statuses in the waves change)
const STEP_KINDS = new Set<string>([
  EVENT_KIND.run_started, EVENT_KIND.step_started, EVENT_KIND.step_completed,
  EVENT_KIND.step_failed, EVENT_KIND.task_status_changed,
])

// onStep makes each step chip a door into the graph: click → the step node's audit view
// (attempts, run state, transcript) opens in the inspector
export function renderWaves(waves: TodoWave[], onStep?: (stepId: string) => void): HTMLElement {
  return el('div', { class: 'waves' }, ...waves.map(w =>
    el('div', { class: 'wave' },
      el('span', { class: 'wave-label' }, `wave ${w.wave}`, w.parallel ? Badge('parallel', 'accent') : ''),
      ...w.steps.map(s => el('span', {
        class: `wave-step ${s.status}${onStep ? ' link' : ''}`,
        onClick: onStep ? () => onStep(s.id) : undefined,
        title: onStep ? 'open step in inspector' : undefined,
        data: { step: s.id },
      },
        s.status === 'completed' ? '✓ ' : s.status === 'failed' ? '✗ ' : s.status === 'running' ? '◔ ' : '○ ', s.title)),
    )))
}

export class Conversation {
  readonly root = el('div', { class: 'conv' })
  private readonly list = el('div', { class: 'conv-list' })
  private readonly input = el('textarea', { class: 'conv-input' }) as HTMLTextAreaElement
  private projectId = ''
  private busy = false
  private abort: AbortController | null = null
  private readonly sendBtn = Btn('send', () => this.sendOrStop())
  private readonly goNode: (node: string) => void

  constructor(goNode: (node: string) => void) {
    this.goNode = goNode
    this.input.placeholder = 'ask the copilot — it can read state, create requests, propose, run… (approval stays yours)  (/new starts a fresh chat)'
    this.input.rows = 2
    this.input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void this.sendOrStop() }
    })
    this.root.append(
      this.list,
      session.copilot
        ? el('div', { class: 'conv-inputrow' }, this.input, this.sendBtn)
        : el('div', { class: 'conv-inputrow' }, Empty('copilot unavailable — start orc graph inside a project')),
    )
  }

  private sendOrStop(): Promise<void> | void {
    if (this.busy) { this.abort?.abort(); return }
    return this.send()
  }

  setProject(projectId: string): void {
    if (this.projectId === projectId) return
    this.projectId = projectId
    this.reload()
  }

  // repaint to empty — the caller re-seeds from the log, which rebuilds BOTH the event
  // narrative and the copilot bubbles (copilot_exchange events) in true seq order.
  // localStorage only feeds the model's short-term context (history()), never the pane.
  reload(): void {
    this.planCards.clear()
    this.decoCards.clear()
    this.answerRows.clear()
    this.retryRows.clear()
    this.ticker = null
    this.list.replaceChildren()
    this.list.append(Empty('this is the project chat — system events appear here live, and the copilot can guide you'))
    this.scroll()
  }

  // Reload persistence: the event log IS the chat's memory. Replaying recent summaries
  // through the SAME pipeline as the live stream rebuilds cards, the plan/decomposition
  // state, and — crucially — the answer boxes of still-open questions. Rows beyond uptoSeq
  // are left to the live stream (which attaches at exactly that seq): no gap, no duplicate.
  private seedCutoff = 0
  async seed(uptoSeq: number, limit = 150): Promise<void> {
    const project = this.projectId
    this.seedCutoff = uptoSeq
    const rows = await api.log(project, { limit }).catch(() => [])
    if (this.projectId !== project) return // switched away while fetching
    for (const row of rows) if (row.seq <= uptoSeq) this.addSystemRow(row)
  }

  // system narration from the SSE envelope — no tokens spent
  addSystemRow(row: LogRow): void {
    // chat-metadata notes (project name/dir, e.g. the post-purge identity re-seed) are
    // infrastructure — they'd read as "notes written" right after purging
    if (row.noteRef?.startsWith('note:project\u0000') && isUiMetaNote('project', row.noteRef.split('\u0000')[1] ?? '')) return
    // copilot exchanges: seeded rows rebuild real bubbles (the log is the record); live rows
    // are skipped — this tab already rendered the exchange as it streamed (localhost, one user)
    if (row.kind === EVENT_KIND.copilot_exchange) {
      if (row.seq <= this.seedCutoff) this.renderExchange(row)
      return
    }
    const kind = CARD_KINDS[row.kind]
    if (!kind) { this.tick(row); return }
    // a lifecycle card supersedes the ticker — it re-appears on the next working event
    this.ticker?.remove()
    this.ticker = null
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
    // agent questions are answerable RIGHT HERE — the chat is the conversation, not a viewer.
    // A plan-gate question comes with the decomposition DIAGRAM, not just prose: see, then answer.
    if (row.kind === EVENT_KIND.feedback_requested && row.taskId) {
      void this.decompositionCard(row.taskId)
      if (canAct()) this.answerBox(row.taskId)
    }
    // answered elsewhere (inspector, copilot, CLI): retire this chat's open box
    if (row.kind === EVENT_KIND.feedback_provided && row.taskId) {
      this.answerRows.get(row.taskId)?.remove()
      this.answerRows.delete(row.taskId)
    }
    // a failed step is actionable RIGHT HERE (P3): the card names the failure class, the row
    // retries with the same action the inspector uses — no tab switch to unblock a run
    if (row.kind === EVENT_KIND.step_failed && row.taskId && canAct()) this.retryRow(row.taskId)
    // a new run/attempt supersedes the offer — stale retry buttons must not double-start
    if ((row.kind === EVENT_KIND.run_started || row.kind === EVENT_KIND.step_started) && row.taskId) {
      this.retryRows.get(row.taskId)?.remove()
      this.retryRows.delete(row.taskId)
    }
    if (PLAN_KINDS.has(row.kind) && row.taskId) void this.planCard(row.taskId)
    if (DECOMPOSITION_KINDS.has(row.kind) && row.taskId) void this.decompositionCard(row.taskId)
    // live progress: step events render the task's plan card — CREATING it if the plan events
    // fell outside the seed window (a long run's chat must still show current status)
    if (STEP_KINDS.has(row.kind) && row.taskId) void this.planCard(row.taskId)
    this.ripple(row)
    this.trim()
    this.scroll()
  }

  // event ripple: the chip the SSE handler just processed pulses for a moment — the chat's
  // plan/decomposition cards show WHERE work is happening, not just that it happened
  private ripple(row: LogRow): void {
    if (!row.taskId) return
    const chips: Element[] = []
    if (row.stepId) {
      const card = this.planCards.get(row.taskId)
      if (card?.root.isConnected) chips.push(...card.root.querySelectorAll(`[data-step="${CSS.escape(row.stepId)}"]`))
    }
    const noteId = row.noteRef?.split('\u0000')[1]
    if (noteId) {
      const deco = this.decoCards.get(row.taskId)
      if (deco?.root.isConnected) chips.push(...deco.root.querySelectorAll(`[data-note="${CSS.escape(noteId)}"]`))
    }
    for (const chip of chips) {
      chip.classList.remove('ripple') // restart the animation if it is still running
      void (chip as HTMLElement).offsetWidth
      chip.classList.add('ripple')
      // drop the class when the flash ends so a `.running` chip's infinite pulse resumes
      chip.addEventListener('animationend', () => chip.classList.remove('ripple'), { once: true })
    }
  }

  // targeted correction on one plan-note: annotates it and wakes the plan agent (revise) —
  // corrections are conversation, not silent edits, so the agent can ask back
  private correctionRow(taskId: string, noteId: string, title: string): void {
    document.querySelector('.conv-inputrow.correction')?.remove() // one open correction at a time
    const input = el('textarea', { class: 'conv-input' }) as HTMLTextAreaElement
    input.rows = 2
    input.placeholder = `what should change about “${title}”?`
    const row = el('div', { class: 'conv-inputrow answer correction' }, input, Btn('send correction', async () => {
      const text = input.value.trim()
      if (!text) return
      await api.act('revise', { taskId, text, scope: [noteId] })
      toast('correction sent — the plan agent revises and will ask again', 'ok')
      row.remove()
    }))
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); (row.querySelector('button.btn') as HTMLButtonElement).click() }
    })
    this.list.append(row)
    this.scroll()
    input.focus()
  }

  // inline retry for a failed step — same retry action as the inspector, one per task
  private readonly retryRows = new Map<string, HTMLElement>()
  private retryRow(taskId: string): void {
    this.retryRows.get(taskId)?.remove() // latest failure owns the button
    const row = el('div', { class: 'conv-inputrow answer' }, Btn('retry failed step', async () => {
      await api.act('retry', { taskId })
      toast('retry started', 'ok')
      row.remove()
      this.retryRows.delete(taskId)
    }, 'danger'))
    this.retryRows.set(taskId, row)
    this.list.append(row)
    this.scroll()
  }

  // inline reply for an open agent question — same reply action as the inspector, one shot
  private readonly answerRows = new Map<string, HTMLElement>()
  private answerBox(taskId: string): void {
    this.answerRows.get(taskId)?.remove() // one open box per task — the gate is serial
    const input = el('textarea', { class: 'conv-input' }) as HTMLTextAreaElement
    input.rows = 1
    input.placeholder = 'answer the agent…'
    const row = el('div', { class: 'conv-inputrow answer' }, input, Btn('answer', async () => {
      const text = input.value.trim()
      if (!text) return
      await api.act('reply', { taskId, text }) // throws → Btn toasts (e.g. already answered elsewhere)
      row.remove()
      this.answerRows.delete(taskId) // the feedback_provided card lands via the stream as the receipt
    }))
    this.answerRows.set(taskId, row)
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); (row.querySelector('button.btn') as HTMLButtonElement).click() }
    })
    this.list.append(row)
    input.focus()
  }

  // the single live-activity line: latest agent/tool event, updated in place, kept last
  private ticker: HTMLElement | null = null
  private tick(row: LogRow): void {
    if (!WORKING_KINDS.has(row.kind)) return
    this.ripple(row) // working events are exactly the "currently processing" signal
    const line = `${row.kind.replace(/_/g, ' ')}  ${row.line}`.trim()
    if (!this.ticker) {
      this.ticker = el('div', {
        class: 'sys-card working',
        onClick: () => { if (row.taskId) this.goNode(row.taskId) },
        title: 'open in inspector',
      }, Badge('working', 'accent'), el('span', { class: 'sys-line' }, line), el('span', { class: 'sys-seq' }, `#${row.seq}`))
    } else {
      this.ticker.querySelector('.sys-line')!.textContent = line
      this.ticker.querySelector('.sys-seq')!.textContent = `#${row.seq}`
    }
    this.list.append(this.ticker) // re-append keeps it below the newest card
    this.scroll()
  }

  // ONE decomposition card per task, updated in place as the plan-note graph grows — the
  // same no-duplicates contract as the plan card below
  private readonly decoCards = new Map<string, { root: HTMLElement; key: string }>()
  private async decompositionCard(taskId: string): Promise<void> {
    const res = await api.planNotes(this.projectId, taskId).catch(() => null)
    if (!res?.mermaid) return
    const existing = this.decoCards.get(taskId)
    if (existing && !existing.root.isConnected) this.decoCards.delete(taskId)
    if (existing?.root.isConnected && existing.key === res.mermaid) return
    const diagram = el('div', { class: 'diagram' })
    void mermaidInto(diagram, res.mermaid)
    const content = [
      el('div', { class: 'card-title' }, 'proposed decomposition', Badge(`${res.notes.length} subplans`, 'purple')),
      diagram,
      // each subplan chip is a door into the graph (title → its note node: summary, rationale,
      // reads, backlinks) and a correction handle (✎ → revise loop with the plan agent)
      el('div', { class: 'deco-chips' },
        el('span', { class: 'sys-line' }, 'subplans:'),
        ...res.notes.flatMap(n => [
          el('button', {
            class: 'tab', title: 'open in inspector (audit: content, reads, backlinks)',
            onClick: () => this.goNode(noteNodeId(planScope(taskId), n.id)),
            data: { note: n.id },
          }, n.title),
          ...(canAct() ? [el('button', { class: 'tab correct', title: `correct “${n.title}”`, onClick: () => this.correctionRow(taskId, n.id, n.title) }, '✎')] : []),
        ]),
      ),
    ]
    if (existing?.root.isConnected) {
      existing.root.replaceChildren(...content)
      this.decoCards.set(taskId, { root: existing.root, key: res.mermaid })
    } else {
      const root = el('div', { class: 'card plan-card' }, ...content)
      this.decoCards.set(taskId, { root, key: res.mermaid })
      this.list.append(root)
      this.scroll()
    }
  }

  // The live plan card: ONE element per task, updated in place — proposal, approval, and
  // every step transition render into the same card (no duplicates), so its waves are a
  // real-time progress view: what the request contains and which step runs right now.
  private readonly planCards = new Map<string, { root: HTMLElement; key: string }>()
  private async planCard(taskId: string): Promise<void> {
    const plans = await api.plans(this.projectId, taskId).catch(() => null)
    if (!plans?.visual) return
    const v = plans.visual
    // skip re-renders that would change nothing (approval straight after proposal)
    const key = `${v.version}:${v.waves.map(w => w.steps.map(s => s.status).join(',')).join('|')}`
    const existing = this.planCards.get(taskId)
    if (existing && !existing.root.isConnected) this.planCards.delete(taskId) // trimmed away
    if (existing?.root.isConnected && existing.key === key) return
    const diagram = el('div', { class: 'diagram' })
    void mermaidInto(diagram, v.mermaid)
    // a one-step template is not a decomposition — say so instead of dressing it up
    const single = v.waves.length === 1 && v.waves[0]!.steps.length === 1
    const content = [
      el('div', { class: 'card-title' }, `plan v${v.version}`,
        single ? Badge('single-step template', 'muted') : Badge(`${v.waves.length} wave(s)`, 'accent')),
      ...(single ? [] : [diagram]),
      renderWaves(v.waves, id => this.goNode(stepNodeId(taskId, id))),
    ]
    if (existing?.root.isConnected) {
      existing.root.replaceChildren(...content)
      this.planCards.set(taskId, { root: existing.root, key })
    } else {
      const root = el('div', { class: 'card plan-card' }, ...content)
      this.planCards.set(taskId, { root, key })
      this.list.append(root)
      this.scroll()
    }
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

  // one journaled exchange → user bubble, collapsed tool summaries, assistant bubble — the
  // same shapes the live stream renders, so a reloaded pane is indistinguishable from live
  private renderExchange(row: LogRow): void {
    const x = row.exchange
    if (!x) return
    if (x.user) this.bubble('user', x.user)
    for (const t of x.toolCalls) {
      const d = el('details', { class: 'tool-row' })
      d.append(el('summary', {}, `⚙ ${t.toolName}`), el('div', { class: 'tool-body' }, Pre(t.summary)))
      this.list.append(d)
    }
    if (x.assistant) this.bubble('assistant', x.assistant)
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

  // fresh start: forget the stored exchange history (the copilot re-grounds from live state
  // anyway, so this is purely a context/token reset — project data is untouched). Public:
  // the app also calls it after a project purge, when the old exchanges reference dead tasks.
  clear(): void {
    localStorage.removeItem(`chat:${this.projectId}`)
    this.planCards.clear()
    this.decoCards.clear()
    this.answerRows.clear()
    this.ticker = null
    this.list.replaceChildren(Empty('fresh chat — history cleared'))
    this.input.value = ''
  }

  private async send(): Promise<void> {
    const text = this.input.value.trim()
    if (!text || this.busy || !this.projectId) return
    if (text === '/new' || text === '/clear') { this.clear(); return }
    this.busy = true
    this.abort = new AbortController()
    this.sendBtn.textContent = 'stop'
    this.sendBtn.classList.add('danger')
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
      await api.copilot({ projectId: this.projectId, messages: messages.slice(-HISTORY_LIMIT) }, onPart, this.abort.signal)
      if (answer) this.saveHistory([...messages, { role: 'assistant', content: answer }])
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        assistant.append(' ⏹')
        if (answer) this.saveHistory([...messages, { role: 'assistant', content: `${answer} (aborted)` }])
      }
      // other failures were already routed to the configured error handler by the api layer
    } finally {
      assistant.classList.remove('streaming')
      if (!assistant.textContent) assistant.remove()
      this.busy = false
      this.abort = null
      this.sendBtn.textContent = 'send'
      this.sendBtn.classList.remove('danger')
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
