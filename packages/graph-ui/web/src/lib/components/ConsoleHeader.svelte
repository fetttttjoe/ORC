<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import { MEMORY_HEALTH, SUPERVISOR_HEALTH } from '@orc/contracts/health'
  import { Separator } from '$lib/components/ui/separator'
  import Chip from '$lib/components/Chip.svelte'
  import { api } from '$lib/api/client'
  import { qk } from '$lib/query-keys'
  import { cn } from '$lib/utils'
  import { graph } from '$lib/stores/graph.svelte'
  import { ledger } from '$lib/stores/ledger.svelte'
  import { session } from '$lib/stores/session.svelte'
  import type { Temperature } from '$lib/temperature'

  // The operator's standing questions, answered without scrolling: is anything driving, is the
  // graph current, how far is the log, and does anything want me.
  const HEALTH_POLL_MS = 15_000
  // the read model is often a little behind mid-write; only a real backlog is worth saying
  const CATCHUP_FLOOR = 50

  const health = createQuery(() => ({ queryKey: qk.health(), queryFn: api.health, refetchInterval: HEALTH_POLL_MS }))

  const sup = $derived(health.data?.supervisor)
  const mem = $derived(health.data?.memory)
  const gates = $derived(ledger.gates.length)

  const SUPERVISOR: Record<string, { text: string; temp: Temperature; hint: string }> = {
    [SUPERVISOR_HEALTH.ready]: { text: 'supervisor ready', temp: 'moss', hint: 'a supervisor holds the runtime — runs execute' },
    [SUPERVISOR_HEALTH.booting]: { text: 'supervisor booting', temp: 'human', hint: 'projections catching up — runs start when it reports ready' },
    [SUPERVISOR_HEALTH.stale]: { text: 'supervisor stale', temp: 'rust', hint: 'its heartbeat stopped without cleanup — start `orc serve` to reclaim' },
    [SUPERVISOR_HEALTH.none]: { text: 'no supervisor', temp: 'rust', hint: 'nothing will run — start `orc serve`' },
  }
  const supervisor = $derived(sup ? (SUPERVISOR[sup.state] ?? SUPERVISOR[SUPERVISOR_HEALTH.none]) : null)

  const memoryNote = $derived.by(() => {
    if (!mem) return null
    if (mem.state === MEMORY_HEALTH.unreachable) return { text: 'memory unreachable', temp: 'rust' as Temperature, hint: mem.reason ?? '' }
    if (mem.state === MEMORY_HEALTH.catchingUp && mem.pending >= CATCHUP_FLOOR)
      return { text: `rebuilding · ${mem.pending} behind`, temp: 'human' as Temperature, hint: 'the read model is replaying the log — runs still execute' }
    return null
  })

  const drift = $derived(mem?.drift && mem.drift.drifted > 0 ? mem.drift : null)
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
    {#if memoryNote}
      <Separator orientation="vertical" class="h-3.5" />
      <Chip temp={memoryNote.temp} title={memoryNote.hint}>{memoryNote.text}</Chip>
    {/if}
    {#if drift}
      <Separator orientation="vertical" class="h-3.5" />
      <Chip temp="neutral" title="notes describing code that changed since they were written — a reground-heal task refreshes them">
        drift {drift.drifted}/{drift.checkable}
      </Chip>
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
