// The project conversation — center stage. User ↔ copilot messages (streamed, tool calls as
// visible cards) interleaved with system cards narrating the event stream (zero copilot
// tokens). History (text messages only) persists per project in localStorage; the copilot
// re-grounds itself from live state each exchange, so history is presentational context.
import { APPROVAL_ANSWER, EVENT_KIND, planScope } from '@orc/contracts'
import { isUiMetaNote, noteNodeId, stepNodeId } from '@orc/ui-core/graph'
import { api, canAct, canAnswer, session, type CopilotPart, type FeedRow, type ToolFailure } from './api'
import { mermaidInto } from './mermaid'
import { el } from './ui/el'
import { Badge, Btn, CmdChip, Empty, Pre, toast, type Tone } from './ui/components'
import { planVisual, planVisualKey } from './plan-visual'
import { REPLY_AFFORDANCE, isApprovalGate, replyAffordance, replyReceipt, type ReplyResult } from './affordance'

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
// The ONE tool result that gets a card of its own — not in CARD_KINDS, because that map is keyed
// by event kind and every tool_result would qualify. See failureCard for why this one does.
const FAILURE_CARD = { label: 'tool failed', tone: 'danger' as Tone, class: 'card failure' }
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

export class Conversation {
  readonly root = el('div', { class: 'conv' })
  private readonly list = el('div', { class: 'conv-list' })
  private readonly input = el('textarea', { class: 'conv-input' }) as HTMLTextAreaElement
  private projectId = ''
  private busy = false
  private abort: AbortController | null = null
  private readonly sendBtn = Btn('send', () => this.sendOrStop())
  private readonly goNode: (node: string) => void
  // live task status, sourced from app.ts's SSE-kept `nodes` map — undefined when unknown.
  // Threaded in so answerRow can render a terminal task's still-open question as inert history
  // instead of a live answer box that could never resume anything.
  private readonly taskStatus: (taskId: string) => string | undefined

  constructor(goNode: (node: string) => void, taskStatus: (taskId: string) => string | undefined) {
    this.goNode = goNode
    this.taskStatus = taskStatus
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
  addSystemRow(row: FeedRow): void {
    // A tool call that FAILED gets a card before anything else looks at this row. The motivating
    // failure: a broken approval gate rejected eight consecutive "approve" answers, and the pane
    // rendered none of them — the rejection was a tool_result, which falls into WORKING_KINDS and
    // flashes past in the one-line ticker before the next event overwrites it. The user saw eight
    // near-identical questions, concluded the system was running in circles, and had no way to
    // learn otherwise: the reason existed only in the event log. An answer that does not take is
    // indistinguishable from one nobody asked for unless the pane says why.
    if (row.failure) { this.failureCard(row, row.failure); return }
    // chat-metadata notes (project name/dir, e.g. the post-purge identity re-seed) are
    // infrastructure — they'd read as "notes written" right after purging
    if (row.noteRef?.startsWith(noteNodeId('project', '')) && isUiMetaNote('project', row.noteRef.split('\u0000')[1] ?? '')) return
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
      this.answerRow(row.taskId, row.stepId)
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
    if (STEP_KINDS.has(row.kind) && row.taskId) {
      void this.planCard(row.taskId)
      // a step event names the CHILD task, never the parent whose decomposition card must repaint,
      // so refresh the open cards rather than deriving a parent from the child's id shape
      for (const id of [...this.decoCards.keys()]) void this.decompositionCard(id)
    }
    this.ripple(row)
    this.trim()
    this.scroll()
  }

  // Why an answer did not take. Its own card kind, deliberately unlike a question card: the tool
  // that refused, the error verbatim, and a door into the inspector for the full result. It
  // supersedes the ticker the way a lifecycle card does, so the failure is the last thing on
  // screen and not a line that scrolls away under the next working event.
  private failureCard(row: FeedRow, failure: ToolFailure): void {
    this.ticker?.remove()
    this.ticker = null
    const target = row.taskId
    this.list.append(el('div', {
      class: FAILURE_CARD.class,
      onClick: target ? () => this.goNode(target) : undefined,
      title: target ? 'open in inspector' : undefined,
    },
      el('div', { class: 'card-title' },
        Badge(FAILURE_CARD.label, FAILURE_CARD.tone),
        el('span', { class: 'sys-line' }, failure.toolName),
        el('span', { class: 'sys-seq' }, `#${row.seq}`),
      ),
      Pre(failure.error),
    ))
    this.trim()
    this.scroll()
  }

  // event ripple: the chip the SSE handler just processed pulses for a moment — the chat's
  // plan/decomposition cards show WHERE work is happening, not just that it happened
  private ripple(row: FeedRow): void {
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

  // inline reply for an open agent question — same reply action as the inspector, one shot.
  // Every chat gets the box, foreign ones included: this pane streams the question live, so refusing
  // to let the user answer it was a dead end with nothing behind it (the answer is an append into
  // that project's log, not a run). Only a server started outside any project cannot write at all,
  // and there the question still gets a route: the CLI command that answers it.
  private readonly answerRows = new Map<string, HTMLElement>()
  private answerRow(taskId: string, stepId: string | null): void {
    const offer = replyAffordance(canAnswer(), taskId, this.taskStatus(taskId))
    if (offer.kind === REPLY_AFFORDANCE.box) { this.answerBox(taskId, stepId); return }
    this.answerRows.get(taskId)?.remove()
    // A terminal task's still-open question is inert history: no box, no command, no handler —
    // answering it could never resume anything. The question card itself already rendered above
    // (addSystemRow's sys-card); this is just a muted marker where the control would have gone.
    // Still tracked in answerRows so a later feedback_provided retires it the same as any other.
    const row = offer.kind === REPLY_AFFORDANCE.closed
      ? el('div', { class: 'conv-inputrow answer' },
          el('span', { class: 'sys-line muted' }, `task ${offer.status} — question expired`))
      : el('div', { class: 'conv-inputrow answer' },
          el('span', { class: 'sys-line' }, 'this server cannot write — answer it from the project’s own directory:'),
          CmdChip(offer.cmd),
        )
    this.answerRows.set(taskId, row) // same map, so feedback_provided retires it either way
    this.list.append(row)
  }

  private answerBox(taskId: string, stepId: string | null): void {
    this.answerRows.get(taskId)?.remove() // one open box per task — the gate is serial
    const input = el('textarea', { class: 'conv-input' }) as HTMLTextAreaElement
    input.rows = 1
    input.placeholder = 'answer the agent…'
    const send = async (text: string): Promise<void> => {
      if (!text) return
      // throws → Btn toasts (e.g. already answered elsewhere)
      const receipt = replyReceipt(await api.act<ReplyResult>('reply', { taskId, text }))
      // …and when it lands, WHERE it landed: a project with no supervisor of its own running holds
      // the answer until one starts. The feedback_provided card arrives via the stream either way,
      // which is exactly why silence here would read as "the run resumed".
      toast(receipt.text, receipt.tone)
      row.remove()
      this.answerRows.delete(taskId)
    }
    // One-click approve on the plan gate. It is only a typing shortcut — it sends the exact word
    // through the same reply action — and it earns its place ONLY because a rejected approval now
    // renders as a failure card above: a button that silently re-arms a gate the user cannot see
    // failing just makes an unsatisfiable loop spin faster.
    const answerBtn = Btn('answer', () => send(input.value.trim())) as HTMLButtonElement
    const row = el('div', { class: 'conv-inputrow answer' }, input,
      ...(isApprovalGate(stepId) ? [Btn('approve', () => send(APPROVAL_ANSWER), 'ok')] : []),
      answerBtn)
    this.answerRows.set(taskId, row)
    input.addEventListener('keydown', ev => {
      // the button by reference, not `querySelector('button.btn')` — the approve button is now
      // first in the row, and Enter must still send what the user actually typed
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); answerBtn.click() }
    })
    this.list.append(row)
    input.focus()
  }

  // the single live-activity line: latest agent/tool event, updated in place, kept last
  private ticker: HTMLElement | null = null
  private tick(row: FeedRow): void {
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
      const lineEl = this.ticker.querySelector('.sys-line')
      const seqEl = this.ticker.querySelector('.sys-seq')
      if (lineEl) lineEl.textContent = line
      if (seqEl) seqEl.textContent = `#${row.seq}`
    }
    this.list.append(this.ticker) // re-append keeps it below the newest card
    this.scroll()
  }

  // ONE decomposition card per task, updated in place as the plan-note graph grows — the
  // same no-duplicates contract as the plan card below
  private readonly decoCards = new Map<string, { root: HTMLElement; key: string }>()
  private async decompositionCard(taskId: string): Promise<void> {
    // claim the slot BEFORE the fetch: a reload's seed replay fires this in a burst, and
    // post-await registration appended one card per in-flight call (the reload-duplicate bug)
    const entry = this.claimCard(this.decoCards, taskId)
    const res = await api.planNotes(this.projectId, taskId).catch(() => null)
    if (!res?.mermaid) { this.dropIfEmpty(this.decoCards, taskId, entry); return }
    if (entry.key === res.mermaid) return
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
    entry.root.replaceChildren(...content)
    entry.key = res.mermaid
    this.scroll()
  }

  // shared card-slot claim: reuse the connected card, or append a placeholder SYNCHRONOUSLY
  // so concurrent calls converge on one element (they dedupe on `key` after their fetches)
  private claimCard(map: Map<string, { root: HTMLElement; key: string }>, taskId: string): { root: HTMLElement; key: string } {
    let entry = map.get(taskId)
    if (entry && !entry.root.isConnected) { map.delete(taskId); entry = undefined } // trimmed away
    if (!entry) {
      entry = { root: el('div', { class: 'card plan-card' }), key: '' }
      map.set(taskId, entry)
      this.list.append(entry.root)
    }
    return entry
  }

  // a placeholder whose fetch came back empty must not linger as a blank card — but only
  // remove it while still unfilled: a concurrent call may have rendered into it meanwhile
  private dropIfEmpty(map: Map<string, { root: HTMLElement; key: string }>, taskId: string, entry: { root: HTMLElement; key: string }): void {
    if (entry.key === '') { entry.root.remove(); map.delete(taskId) }
  }

  // reload safety: materialize the live cards for tasks whose plan/step events fell outside
  // the seed window — the chat must show the current plan, not only recent event noise
  ensureCards(taskIds: string[]): void {
    for (const id of taskIds) { void this.planCard(id); void this.decompositionCard(id) }
  }

  // The live plan card: ONE element per task, updated in place — proposal, approval, and
  // every step transition render into the same card (no duplicates), so its waves are a
  // real-time progress view: what the request contains and which step runs right now.
  private readonly planCards = new Map<string, { root: HTMLElement; key: string }>()
  private async planCard(taskId: string): Promise<void> {
    const entry = this.claimCard(this.planCards, taskId) // sync claim — see decompositionCard
    const plans = await api.plans(this.projectId, taskId).catch(() => null)
    if (!plans?.visual) { this.dropIfEmpty(this.planCards, taskId, entry); return }
    const v = plans.visual
    // skip re-renders that would change nothing (approval straight after proposal)
    const key = planVisualKey(v)
    if (entry.key === key) return
    entry.root.replaceChildren(...planVisual(v, { onStep: id => this.goNode(stepNodeId(taskId, id)) }))
    entry.key = key
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

  // one journaled exchange → user bubble, collapsed tool summaries, assistant bubble — the
  // same shapes the live stream renders, so a reloaded pane is indistinguishable from live
  private renderExchange(row: FeedRow): void {
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
    while (this.list.childElementCount > 300) this.list.firstElementChild?.remove()
  }

  private scroll(): void {
    this.list.scrollTop = this.list.scrollHeight
  }
}
