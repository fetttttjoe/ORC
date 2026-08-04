<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import { MEMORY_HEALTH } from '@orc/contracts/health'
  import { SUPERVISOR_HEALTH } from '@orc/contracts/health'
  import { Progress } from '$lib/components/ui/progress'
  import { api } from '$lib/api/client'
  import { qk } from '$lib/query-keys'
  import { cn } from '$lib/utils'
  import type { Temperature } from '$lib/temperature'
  import { TEMP_TEXT } from '$lib/temperature'

  /**
   * What the system is doing when it cannot yet do what you asked.
   *
   * A chip reading "supervisor booting" is true and useless: it never says why, whether it is
   * moving, or what to do. Measured live — a supervisor sat in boot for minutes recovering an
   * interrupted workflow while the operator had no way to tell that from a hang.
   *
   * So: a bar (determinate where a real number exists, indeterminate otherwise), the reason in
   * plain words, and the action when there is one. It shows only while something is transitional
   * and disappears the moment the system is ready — a permanent banner teaches people to skip it.
   */
  const POLL_MS = 3_000

  const health = createQuery(() => ({
    queryKey: qk.health(),
    queryFn: api.health,
    // faster than the header's 15s poll: this banner exists for the minutes when things move
    refetchInterval: POLL_MS,
  }))

  const sup = $derived(health.data?.supervisor)
  const mem = $derived(health.data?.memory)

  interface Banner {
    title: string
    detail: string
    temp: Temperature
    /** 0–100 when a real measurement exists; null renders the indeterminate sweep */
    percent: number | null
  }

  const banner = $derived.by<Banner | null>(() => {
    if (mem?.state === MEMORY_HEALTH.unreachable)
      return {
        title: 'knowledge store unreachable',
        detail: mem.reason ?? 'runs still execute, but agents cannot read or write notes until it returns.',
        temp: 'rust',
        percent: null,
      }

    if (sup?.state === SUPERVISOR_HEALTH.booting)
      return {
        title: 'supervisor starting',
        detail: 'it replays the projection and recovers any interrupted work before accepting runs — a long boot means it found work to finish, not that it hung.',
        temp: 'human',
        percent: null,
      }

    if (sup?.state === SUPERVISOR_HEALTH.stale)
      return {
        title: 'supervisor stopped without cleaning up',
        detail: 'nothing is driving runs. Start one with `orc serve`, or any orc command will spawn it.',
        temp: 'rust',
        percent: null,
      }

    if (sup?.state === SUPERVISOR_HEALTH.none)
      return {
        title: 'no supervisor is running',
        detail: 'requests can be written and approved, but nothing will execute until one starts (`orc serve`).',
        temp: 'rust',
        percent: null,
      }

    if (mem?.state === MEMORY_HEALTH.catchingUp && mem.pending > 0)
      return {
        title: `knowledge graph catching up · ${mem.pending} events behind`,
        detail: 'runs execute normally; notes and drift readings lag until it lands.',
        temp: 'machine',
        // pending only ever shrinks toward zero, so its own peak is the honest denominator
        percent: peak > 0 ? Math.min(100, Math.round(((peak - mem.pending) / peak) * 100)) : null,
      }

    return null
  })

  // remember the deepest backlog seen so the bar measures progress against where it started
  let peak = $state(0)
  $effect(() => {
    const pending = mem?.state === MEMORY_HEALTH.catchingUp ? mem.pending : 0
    if (pending > peak) peak = pending
    if (pending === 0) peak = 0
  })
</script>

{#if banner}
  <section class="flex shrink-0 flex-col gap-1 border-b border-line bg-bureau px-3 py-2" aria-label="system status" aria-live="polite">
    <div class="flex items-baseline gap-2">
      <span class={cn('font-mono text-label tracking-widest uppercase', TEMP_TEXT[banner.temp])}>{banner.title}</span>
      {#if banner.percent !== null}<span class="font-mono text-label text-fog">{banner.percent}%</span>{/if}
    </div>
    <Progress
      value={banner.percent ?? undefined}
      class={cn('h-1', banner.percent === null && 'animate-pulse')}
      aria-label={banner.title}
    />
    <p class="text-row leading-relaxed text-mist">{banner.detail}</p>
  </section>
{/if}
