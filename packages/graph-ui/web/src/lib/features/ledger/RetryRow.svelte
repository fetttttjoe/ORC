<script lang="ts">
  import RotateIcon from '@lucide/svelte/icons/rotate-ccw'
  import TaskChip from '$lib/components/TaskChip.svelte'
  import { Button } from '$lib/components/ui/button'
  import { actions } from '$lib/api/actions'
  import { notify } from '$lib/notify'
  import { session } from '$lib/stores/session.svelte'

  // a failed step is actionable where it is reported — no tab switch to unblock a run
  let { taskId }: { taskId: string } = $props()
  let busy = $state(false)

  async function retry(): Promise<void> {
    if (busy) return
    busy = true
    try {
      await actions.retry(taskId)
      notify('retry started', 'ok')
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      busy = false
    }
  }
</script>

{#if session.canAct()}
  <!-- The indent aligns with the seq spine on wide panes; decoration, so it yields on narrow -->
  <div class="flex flex-wrap items-center gap-2 border-b border-rust/25 bg-rust/5 px-3 py-2 lg:flex-nowrap lg:pl-33">
    <TaskChip {taskId} />
    <span class="min-w-0 grow text-row text-mist">a step failed — retry re-runs the failed steps as new attempts</span>
    <Button size="sm" variant="destructive" disabled={busy} onclick={() => void retry()}>
      <RotateIcon data-icon="inline-start" />
      retry
    </Button>
  </div>
{/if}
