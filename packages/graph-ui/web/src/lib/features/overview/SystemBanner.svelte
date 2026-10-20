<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import { SupervisorHealthState } from '@orc/contracts/health'
  import { Progress } from '$lib/components/ui/progress'
  import { api } from '$lib/api/client'
  import { healthKey } from '$lib/api/view-client'
  import { cn } from '$lib/utils'
  import { session } from '$lib/stores/session.svelte'
  import type { Temperature } from '$lib/temperature'
  import { TEMP_TEXT } from '$lib/temperature'

  // What the system is doing when it cannot yet do what you asked; shown only while transitional
  const POLL_MS = 3_000
  // A boot writes its heartbeat well inside this; past it, silence is the story worth telling.
  const STALE_BEAT_MS = 20_000
  const TICK_MS = 1_000

  /** a clock that advances between polls, so the heartbeat age counts up instead of stepping */
  let now = $state(Date.now())
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), TICK_MS)
    return () => clearInterval(t)
  })

  const ago = (ms: number): string => (ms < 60_000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m`)

  const health = createQuery(() => ({
    queryKey: healthKey(session.sel.project),
    queryFn: api.health,
    // faster than the header's 15s poll: this banner exists for the minutes when things move
    refetchInterval: POLL_MS,
  }))

  const sup = $derived(health.data?.supervisor)

  // Null when the supervisor never reported: absent evidence must not render as '0s ago'
  const beatAge = $derived.by<number | null>(() => {
    const at = sup?.lastSeenAt === undefined ? NaN : Date.parse(sup.lastSeenAt)
    return Number.isFinite(at) ? Math.max(0, now - at) : null
  })

  interface Banner {
    title: string
    detail: string
    temp: Temperature
  }

  const banner = $derived.by<Banner | null>(() => {
    if (sup?.state === SupervisorHealthState.booting)
      return {
        title: 'supervisor starting',
        // The heartbeat age is the evidence that tells a long boot from a hang
        detail:
          beatAge === null
            ? 'it recovers any interrupted work before accepting runs.'
            : beatAge > STALE_BEAT_MS
              ? `it is recovering interrupted work before accepting runs — but its heartbeat has not moved for ${ago(beatAge)}, which is longer than a healthy boot goes silent. Check the supervisor process${sup.pid === undefined ? '' : ` (pid ${sup.pid})`}.`
              : 'it recovers any interrupted work before accepting runs — a long boot means it found work to finish, not that it hung.',
        temp: beatAge !== null && beatAge > STALE_BEAT_MS ? 'rust' : 'human',
      }

    // A client holds the execution runtime: work IS running, so it must not read like the rust states
    if (sup?.state === SupervisorHealthState.client)
      return {
        title: 'a client is driving this project',
        detail: 'no background supervisor, but something holds the execution runtime — a foreground `orc` command or this graph server. Runs execute while it lives.',
        temp: 'machine',
      }

    if (sup?.state === SupervisorHealthState.stale)
      return {
        title: 'supervisor stopped without cleaning up',
        detail: 'nothing is driving runs. Start one with `orc serve`, or any orc command will spawn it.',
        temp: 'rust',
      }

    if (sup?.state === SupervisorHealthState.none)
      return {
        title: 'no supervisor is running',
        detail: 'requests can be written and approved, but nothing will execute until one starts (`orc serve`).',
        temp: 'rust',
      }

    return null
  })

</script>

{#if banner}
  <section class="flex shrink-0 flex-col gap-1 border-b border-line bg-bureau px-3 py-2" aria-label="system status" aria-live="polite">
    <div class="flex items-baseline gap-2">
      <span class={cn('font-mono text-label tracking-widest uppercase', TEMP_TEXT[banner.temp])}>{banner.title}</span>
      <span class="grow"></span>
      <!-- the liveness tell: an age counting up is a running process, a frozen one a dead boot -->
      {#if beatAge !== null && banner.temp !== 'rust'}
        <span class="flex shrink-0 items-center gap-1 font-mono text-label text-fog tabular-nums">
          <span class={cn('size-1 rounded-full', beatAge > STALE_BEAT_MS ? 'bg-rust' : 'bg-moss breathe')}></span>
          heartbeat {ago(beatAge)} ago
        </span>
      {/if}
    </div>
    <Progress class="h-1 animate-pulse" aria-label={banner.title} />
    <p class="text-row leading-relaxed text-mist">{banner.detail}</p>
  </section>
{/if}
