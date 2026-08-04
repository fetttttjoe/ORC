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
  import { createQuery, keepPreviousData } from '@tanstack/svelte-query'
  import { api } from '$lib/api/client'
  import { EVENT_KIND } from '$lib/event-kinds'
  import { fmtCost, fmtTokens } from '$lib/features/inspector/node-head'

  /**
   * The copilot strip. Bubbles persist per chat in localStorage: the ledger records the exchange
   * as an event, but a reload used to leave the operator staring at an empty pane with their own
   * question gone. Tool calls render as their own rows — a copilot that silently reads state and
   * then asserts something is indistinguishable from one that guessed.
   */
  const HISTORY_CAP = 20
  const NEW_CHAT_COMMAND = '/new'
  // how far back to look for journaled exchanges when the pane opens
  const HISTORY_WINDOW = 400

  type Row =
    | { kind: 'message'; id: number; role: 'user' | 'assistant'; text: string }
    | { kind: 'tool'; id: number; toolName: string; state: 'running' | 'done' | 'error'; detail: string }

  let nextId = 0
  let input = $state('')
  let busy = $state(false)
  let usage = $state<{ inputTokens: number; outputTokens: number; costUSD: number | null } | null>(null)
  let abort: AbortController | null = null
  let list = $state<HTMLElement | null>(null)

  const ready = $derived(session.info.copilot && session.sel.project !== '')

  /**
   * The conversation is journaled: every exchange is a `copilot_exchange` event carrying the
   * question, the answer and the tools it called. Restoring from the LOG means the same history
   * is there from another browser and survives a cleared cache — browser storage held a private
   * copy of a record the server already keeps.
   */
  const history = createQuery(() => ({
    queryKey: ['copilot', session.sel.project],
    queryFn: () => api.log(session.sel.project, { limit: HISTORY_WINDOW }),
    enabled: session.sel.project !== '',
    // keep the last good answer on screen while a refetch runs
    placeholderData: keepPreviousData,
  }))

  const restored = $derived.by(() => {
    const out: Row[] = []
    for (const row of history.data ?? []) {
      if (row.kind !== EVENT_KIND.copilot_exchange || !row.exchange) continue
      out.push({ kind: 'message', id: row.seq * 2, role: 'user', text: row.exchange.user })
      for (const call of row.exchange.toolCalls) out.push({ kind: 'tool', id: row.seq * 2 + 1, toolName: call.toolName, state: 'done', detail: call.summary })
      if (row.exchange.assistant !== '') out.push({ kind: 'message', id: row.seq * 2 + 2, role: 'assistant', text: row.exchange.assistant })
    }
    return out.slice(-HISTORY_CAP * 2)
  })

  // live turns append to whatever the log restored; clearing drops only what this pane shows
  let live = $state<Row[]>([])
  let cleared = $state(false)
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
    live = [...live, { kind: 'message', id: nextId++, role: 'user', text }]
    const wire: CopilotMessage[] = messages.map(m => ({ role: m.role, content: m.text }))
    const answerId = nextId++
    live = [...live, { kind: 'message', id: answerId, role: 'assistant', text: '' }]

    const appendToAnswer = (delta: string): void => {
      live = live.map(r => (r.kind === 'message' && r.id === answerId ? { ...r, text: r.text + delta } : r))
    }

    try {
      await copilotSend({
        project: session.sel.project,
        messages: wire,
        signal: abort.signal,
        onPart: part => {
          if (part.type === 'text') appendToAnswer(part.text)
          else if (part.type === 'tool-call')
            live = [...live, { kind: 'tool', id: nextId++, toolName: part.toolName, state: 'running', detail: JSON.stringify(part.input ?? {}) }]
          else if (part.type === 'tool-result')
            live = live.map(r =>
              r.kind === 'tool' && r.toolName === part.toolName && r.state === 'running' ? { ...r, state: 'done', detail: JSON.stringify(part.output ?? {}) } : r,
            )
          else if (part.type === 'tool-error')
            live = live.map(r => (r.kind === 'tool' && r.toolName === part.toolName && r.state === 'running' ? { ...r, state: 'error', detail: part.error } : r))
          else if (part.type === 'error') notify(part.message, 'error')
          else if (part.type === 'done') usage = part.usage
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
