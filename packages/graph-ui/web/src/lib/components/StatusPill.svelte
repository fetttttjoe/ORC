<script lang="ts">
  import Chip from '$lib/components/Chip.svelte'
  import { cn } from '$lib/utils'

  let { status, class: klass = '' }: { status: string; class?: string } = $props()

  const TEMP: Record<string, 'human' | 'machine' | 'moss' | 'rust' | 'neutral'> = {
    running: 'machine',
    completed: 'moss',
    approved: 'machine',
    awaiting_approval: 'human',
    draft: 'neutral',
    queued: 'neutral',
    done: 'moss',
    blocked: 'rust',
    failed: 'rust',
    cancelled: 'neutral',
  }
</script>

<Chip temp={TEMP[status] ?? 'neutral'} class={klass}>
  {#if status === 'running'}<span class="breathe inline-block h-1.5 w-1.5 rounded-full bg-machine"></span>{/if}
  <span class={cn(status === 'running' && 'text-machine')}>{status.replace(/_/g, ' ')}</span>
</Chip>
