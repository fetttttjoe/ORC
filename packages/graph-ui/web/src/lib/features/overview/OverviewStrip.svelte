<script lang="ts">
  import StatTile from '$lib/components/StatTile.svelte'
  import RunMonitor from './RunMonitor.svelte'
  import { TASK_STATUS } from '@orc/contracts/task'
  import { graph } from '$lib/stores/graph.svelte'
  import { operator } from '$lib/stores/operator.svelte'
  import { session } from '$lib/stores/session.svelte'

  const counts = $derived.by(() => {
    let running = 0
    let stuck = 0
    let done = 0
    for (const t of graph.tasks()) {
      // roots only, matching the rail beside it — counting children made the two disagree
      if (graph.parentOf(t.id)) continue
      if (t.detail === TASK_STATUS.running) running += 1
      else if (t.detail === TASK_STATUS.blocked || t.detail === TASK_STATUS.failed) stuck += 1
      else if (t.detail === TASK_STATUS.done) done += 1
    }
    return { running, stuck, done }
  })

  // the tasks actually executing — children included, since that is where the steps run.
  // Capped so the strip cannot eat the ledger beneath it; the overflow is stated, never silent.
  const MAX_MONITORS = 2
  const allLive = $derived(graph.tasks().filter(t => t.detail === TASK_STATUS.running))
  const liveTasks = $derived(allLive.slice(0, MAX_MONITORS))
  const hiddenLive = $derived(allLive.length - liveTasks.length)

  const toGates = (): void => document.getElementById('open-gates')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })

  // a count is only useful if it takes you to what it counted
  const firstStuck = $derived(graph.tasks().find(t => !graph.parentOf(t.id) && (t.detail === TASK_STATUS.blocked || t.detail === TASK_STATUS.failed)) ?? null)
  const toStuck = (): void => {
    if (firstStuck) session.navigate({ node: firstStuck.id, tab: 'request' })
  }
</script>

<div class="flex shrink-0 flex-col gap-2 border-b border-line bg-ink/60 px-3 py-2">
  <div class="flex items-stretch gap-2">
    <StatTile label="waiting" value={operator.state.openQuestions.length} temp="human" hint="open questions — the run is parked until you answer" onclick={toGates} />
    <StatTile label="running" value={counts.running} temp="machine" hint="tasks a supervisor is driving right now" />
    <StatTile label="stuck" value={counts.stuck} temp="rust" hint="blocked or failed — opens the first one" onclick={firstStuck ? toStuck : undefined} />
    <StatTile label="done" value={counts.done} temp="moss" hint="tasks that finished and committed" />
  </div>

  <!-- while anything is live, say what it is doing rather than only how many there are -->
  {#each liveTasks as task (task.id)}
    <RunMonitor taskId={task.id} />
  {/each}
  {#if hiddenLive > 0}
    <p class="font-mono text-label text-fog">{hiddenLive} more running — open one from the rail</p>
  {/if}
</div>
