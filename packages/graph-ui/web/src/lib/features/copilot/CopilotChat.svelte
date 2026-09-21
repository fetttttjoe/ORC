<script lang="ts">
  import SquareIcon from '@lucide/svelte/icons/square'
  import SendIcon from '@lucide/svelte/icons/send-horizontal'
  import { Button } from '$lib/components/ui/button'
  import { Textarea } from '$lib/components/ui/textarea'
  import Chip from '$lib/components/Chip.svelte'
  import Payload from '$lib/components/Payload.svelte'
  import { copilotSend, type CopilotMessage } from '$lib/api/copilot'
  import { notify } from '$lib/notify'
  import { session } from '$lib/stores/session.svelte'
  import { createQuery } from '@tanstack/svelte-query'
  import { viewQuery } from '$lib/api/view-query'
  import { CopilotFrameType, VIEW } from '@orc/ui-core/wire'
  import { ChatKind, MessageRole } from '@orc/contracts/chat'
  import { ScopeType } from '@orc/contracts/scope'
  import { taskIdOf } from '$lib/node-id'
  import { EVENT_KIND } from '$lib/event-kinds'
  import { fmtCost, fmtTokens } from '$lib/features/inspector/node-head'
  import { restoredRows, type CopilotRow as Row } from './copilot-rows'

  /**
   * The copilot strip. Bubbles persist per chat in localStorage: the ledger records the exchange
   * as an event, but a reload used to leave the operator staring at an empty pane with their own
   * question gone. Tool calls render as their own rows — a copilot that silently reads state and
   * then asserts something is indistinguishable from one that guessed.
   */
  const HISTORY_CAP = 20
  const NEW_CHAT_COMMAND = '/new'

  // live rows carry their own namespace so they can never collide with a journal seq
  let nextId = 0
  const liveId = (): string => `live:${nextId++}`
  let input = $state('')
  let busy = $state(false)
  let usage = $state<{ inputTokens: number; outputTokens: number; costUSD: number | null } | null>(null)
  let abort: AbortController | null = null
  let list = $state<HTMLElement | null>(null)

  const ready = $derived(session.info.copilot && session.sel.project !== '')

  // What the copilot is ABOUT: the task the operator has selected, which is what the server builds
  // the prompt's focus block from. Null workspace — the server resolves it from that task.
  const taskId = $derived(session.sel.node === null ? null : taskIdOf(session.sel.node))

  /**
   * Which chat this pane is in. Across a reload the pointer is DERIVED, not stored: the chats view
   * folds chat_opened out of the log, so the newest copilot chat is the conversation to continue —
   * browser storage would hold a private copy of a record the server already keeps. `adopted` is
   * the id the server reported once the turn was COMMITTED, which beats the view until it refetches.
   */
  const known = createQuery(viewQuery(VIEW.chats, () => (ready ? { scope: { type: ScopeType.project } } : null)))
  let adopted = $state<string | null>(null)
  // `/new` leaves the journal alone and puts this pane in NO chat, so the next turn opens one
  let cleared = $state(false)
  const chatId = $derived(adopted ?? (cleared ? null : (known.data ?? []).find(d => d.kind === ChatKind.copilot)?.chatId ?? null))

  /**
   * The conversation is journaled: every exchange is a `copilot_exchange` event carrying the
   * question, the answer and the tools it called. Restoring from the LOG means the same history
   * is there from another browser and survives a cleared cache — browser storage held a private
   * copy of a record the server already keeps.
   *
   * Scoped to THIS chat, and filtered server-side by KIND rather than windowed by row count: a
   * fixed-size tail can run past every exchange in it once enough agent-loop noise (tool_call, …)
   * follows — observed with 450 tool_call rows after one exchange, which pushed it out of a
   * 400-row window entirely. `kinds` narrows BEFORE the slice (timeline.ts), so the last
   * `HISTORY_CAP * 2` matching rows are always the newest exchanges, whatever else happened after.
   */
  const history = createQuery(
    viewQuery(VIEW.timeline, () => (chatId === null ? null : { scope: { type: ScopeType.chat, id: chatId }, kinds: [EVENT_KIND.copilot_exchange], limit: HISTORY_CAP * 2 })),
  )

  const restored = $derived(
    restoredRows(
      (history.data ?? []).flatMap(row =>
        row.kind === EVENT_KIND.copilot_exchange && row.exchange ? [{ seq: row.seq, ...row.exchange }] : [],
      ),
      HISTORY_CAP * 2,
    ),
  )

  // live turns append to whatever the log restored; clearing drops only what this pane shows
  let live = $state<Row[]>([])
  const rows = $derived(cleared ? live : [...restored, ...live])

  const messages = $derived(rows.filter((r): r is Extract<Row, { kind: 'message' }> => r.kind === 'message'))

  // follow the tail (reading the last row subscribes to streaming deltas)
  $effect(() => {
    void rows.at(-1)
    void (rows.at(-1)?.kind === 'message' ? (rows.at(-1) as Extract<Row, { kind: 'message' }>).text : '')
    if (list) list.scrollTop = list.scrollHeight
  })

  function clear(): void {
    // the journal is the record; /new clears THIS pane's view of it, never the log
    live = []
    cleared = true
    adopted = null
    usage = null
  }

  async function send(): Promise<void> {
    const text = input.trim()
    if (!text || busy || !ready) return
    if (text === NEW_CHAT_COMMAND) {
      input = ''
      clear()
      return
    }
    busy = true
    usage = null
    abort = new AbortController()
    input = ''
    live = [...live, { kind: 'message', id: liveId(), role: 'user', text }]
    const wire: CopilotMessage[] = messages.map(m => ({ role: m.role === 'user' ? MessageRole.user : MessageRole.assistant, content: m.text }))
    const answerId = liveId()
    live = [...live, { kind: 'message', id: answerId, role: 'assistant', text: '' }]

    const appendToAnswer = (delta: string): void => {
      live = live.map(r => (r.kind === 'message' && r.id === answerId ? { ...r, text: r.text + delta } : r))
    }

    try {
      await copilotSend({
        project: session.sel.project,
        chatId,
        taskId,
        workspaceId: null,
        messages: wire,
        signal: abort.signal,
        onPart: part => {
          if (part.type === CopilotFrameType.text) appendToAnswer(part.text)
          else if (part.type === CopilotFrameType.toolCall)
            live = [...live, { kind: 'tool', id: liveId(), toolName: part.toolName, state: 'running', detail: JSON.stringify(part.input ?? {}) }]
          else if (part.type === CopilotFrameType.toolResult)
            live = live.map(r =>
              r.kind === 'tool' && r.toolName === part.toolName && r.state === 'running' ? { ...r, state: 'done', detail: JSON.stringify(part.output ?? {}) } : r,
            )
          else if (part.type === CopilotFrameType.toolError)
            live = live.map(r => (r.kind === 'tool' && r.toolName === part.toolName && r.state === 'running' ? { ...r, state: 'error', detail: part.error } : r))
          else if (part.type === CopilotFrameType.error) notify(part.message, 'error')
          else if (part.type === CopilotFrameType.done) usage = part.usage
          else if (part.type === CopilotFrameType.chat) adopted = part.chatId
        },
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') appendToAnswer(' ⏹')
      else notify(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      // an answer that never produced text leaves no ghost bubble
      live = live.filter(r => !(r.kind === 'message' && r.id === answerId && r.text === ''))
      busy = false
      abort = null
      // Take the durable copy AND drop the optimistic one. Refetching alone left both on screen:
      // `rows` concatenates restored + live, so every question and answer rendered twice and
      // stayed that way (measured: still 2 copies 3s after the turn). Only when the refetch
      // actually succeeded — a failed one leaves `restored` without this turn, and a duplicate is
      // a far better failure than a vanished answer. `cleared` (/new) hides `restored` on purpose,
      // so there the optimistic rows ARE the pane and must survive.
      const refreshed = await history.refetch()
      if (!cleared && refreshed.isSuccess) live = []
    }
  }
</script>

<!-- The cap is viewport-relative, not a fixed 20rem: on a short window a fixed cap ate the ledger
     above it, and on a tall one it wasted the space it could have used. The rem term still bounds
     it on very tall screens, where a chat half the page high reads as the whole console. -->
<section aria-label="copilot" class="flex max-h-[min(20rem,45vh)] shrink-0 flex-col border-t border-line bg-ink">
  {#if rows.length > 0}
    <div bind:this={list} class="flex min-h-0 grow flex-col gap-1.5 overflow-y-auto px-3 py-2">
      {#each rows as row (row.id)}
        {#if row.kind === 'message'}
          <div
            class={[
              'max-w-[85%] rounded-(--radius-card) px-2.5 py-1.5 text-xs leading-relaxed break-words whitespace-pre-wrap',
              row.role === 'user' ? 'self-end border border-rule bg-desk text-paper' : 'self-start text-paper',
            ]}
          >
            {row.text}{#if busy && row.id === rows.at(-1)?.id && row.role === 'assistant'}<span class="breathe">▍</span>{/if}
          </div>
        {:else}
          <!-- min-w-0 + max-w-full: a tool payload is arbitrary text (paths, ids, JSON), and without
               these a single long line stretched the flex column and pushed the composer sideways -->
          <details class="min-w-0 max-w-full self-start rounded-(--radius-chip) border border-line bg-desk/40 px-2 py-1">
            <summary class="flex cursor-pointer items-center gap-1.5 select-none">
              <Chip mono temp={row.state === 'error' ? 'rust' : row.state === 'running' ? 'machine' : 'neutral'}>{row.toolName}</Chip>
              <span class="font-mono text-label text-fog">{row.state}</span>
            </summary>
            <div class="mt-1 overflow-x-auto">
              <Payload label={row.state === 'error' ? 'error' : row.state === 'running' ? 'called with' : 'returned'} value={row.detail} temp={row.state === 'error' ? 'rust' : row.state === 'done' ? 'machine' : 'neutral'} />
            </div>
          </details>
        {/if}
      {/each}
    </div>
  {/if}

  {#if usage}
    <p class="px-3 font-mono text-label text-fog">
      {fmtTokens(usage.inputTokens)} in · {fmtTokens(usage.outputTokens)} out · {fmtCost(usage.costUSD)}
    </p>
  {/if}

  <div class="flex items-end gap-2 px-3 py-2">
    <Textarea
      class="max-h-24 min-h-8 min-w-0 grow resize-y text-xs"
      rows={1}
      disabled={!ready}
      placeholder={ready ? 'ask the copilot…' : 'copilot unavailable — start orc graph inside a project'}
      bind:value={input}
      onkeydown={(e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          void send()
        }
      }}
    />
    {#if busy}
      <Button variant="destructive" size="sm" class="shrink-0" onclick={() => abort?.abort()}>
        <SquareIcon data-icon="inline-start" />
        stop
      </Button>
    {:else}
      <Button size="sm" class="shrink-0" disabled={!ready || input.trim() === ''} onclick={() => void send()}>
        <SendIcon data-icon="inline-start" />
        send
      </Button>
    {/if}
  </div>
</section>
