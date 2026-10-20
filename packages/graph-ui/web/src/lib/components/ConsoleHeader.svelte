<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import { KnowledgeHealthState, SupervisorHealthState } from '@orc/contracts/health'
  import { Separator } from '$lib/components/ui/separator'
  import Chip from '$lib/components/Chip.svelte'
  import { api } from '$lib/api/client'
  import { healthKey } from '$lib/api/view-client'
  import { cn } from '$lib/utils'
  import { graph } from '$lib/stores/graph.svelte'
  import { operator } from '$lib/stores/operator.svelte'
  import { session } from '$lib/stores/session.svelte'
  import type { Temperature } from '$lib/temperature'

  const HEALTH_POLL_MS = 15_000
  const SUSPECT_HINT = 'claims whose code changed since they were written — the heal sweep after the next commit checks them'

  const health = createQuery(() => ({ queryKey: healthKey(session.sel.project), queryFn: api.health, refetchInterval: HEALTH_POLL_MS }))

  const sup = $derived(health.data?.supervisor)
  const knowledge = $derived(health.data?.knowledge)
  const gates = $derived(operator.state.openQuestions.length)

  const SUPERVISOR: Record<SupervisorHealthState, { text: string; temp: Temperature; hint: string }> = {
    [SupervisorHealthState.ready]: { text: 'supervisor ready', temp: 'moss', hint: 'a supervisor holds the runtime — runs execute' },
    [SupervisorHealthState.booting]: { text: 'supervisor booting', temp: 'human', hint: 'projections catching up — runs start when it reports ready' },
    [SupervisorHealthState.stale]: { text: 'supervisor stale', temp: 'rust', hint: 'its heartbeat stopped without cleanup — start `orc serve` to reclaim' },
    [SupervisorHealthState.client]: { text: 'client driving', temp: 'machine', hint: 'no supervisor, but a foreground command or the graph server holds the runtime — runs execute' },
    [SupervisorHealthState.none]: { text: 'no supervisor', temp: 'rust', hint: 'nothing will run — start `orc serve`' },
  }
  const supervisor = $derived(sup ? SUPERVISOR[sup.state] : null)

  const knowledgeNote = $derived.by(() => {
    if (!knowledge) return null
    if (knowledge.state === KnowledgeHealthState.unavailable) return { text: 'knowledge unavailable', temp: 'rust' as Temperature, hint: knowledge.reason }
    if (knowledge.suspect > 0) return { text: `suspect ${knowledge.suspect}/${knowledge.claims}`, temp: 'neutral' as Temperature, hint: SUSPECT_HINT }
    return null
  })
  const bootedAt = $derived(session.info.bootedAt ? new Date(session.info.bootedAt).toLocaleTimeString() : null)
</script>

<header class="flex h-9 shrink-0 items-center gap-2.5 border-b border-line bg-bureau px-3">
  <span
    class={cn('size-2 shrink-0 rounded-[3px] transition-colors', gates > 0 ? 'bg-human' : session.live ? 'bg-machine' : 'bg-fog')}
    title={gates > 0 ? 'a question is waiting on you' : session.live ? 'live' : 'stream down'}
  ></span>
  <span class="text-[13px] font-semibold tracking-wide text-paper">orc</span>

  {#if gates > 0}
    <Chip temp="human" title="open questions wait on you">{gates} waiting</Chip>
  {/if}

  <span class="grow"></span>

  <!-- one status cluster, hairline-divided: read left to right as machine → knowledge -->
  <div class="flex items-center gap-2">
    {#if supervisor}
      <Chip temp={supervisor.temp} title={supervisor.hint}>{supervisor.text}</Chip>
    {/if}
    {#if knowledgeNote}
      <Separator orientation="vertical" class="h-3.5" />
      <Chip temp={knowledgeNote.temp} title={knowledgeNote.hint}>{knowledgeNote.text}</Chip>
    {/if}
    <Separator orientation="vertical" class="h-3.5" />
    {#if bootedAt}
      <span class="font-mono text-label text-fog" title="when this server process started — an old stamp means the page is talking to a stale process">up {bootedAt}</span>
    {/if}
    <span
      class={cn('font-mono text-row tabular-nums', session.live ? 'text-mist' : 'text-rust')}
      title={session.live ? 'the log position this page has caught up to' : 'stream down — reconnecting'}
    >
      {session.live ? 'seq' : 'offline'}&nbsp;{graph.seq}
    </span>
  </div>
</header>
