<script lang="ts">
  import Chip from '$lib/components/Chip.svelte'
  import type { Temperature } from '$lib/temperature'

  let { kind }: { kind: string } = $props()

  const TABLE: Record<string, { label: string; temp: Temperature }> = {
    feedback_requested: { label: 'question', temp: 'human' },
    feedback_provided: { label: 'answered', temp: 'human' },
    plan_proposed: { label: 'plan', temp: 'machine' },
    plan_edited: { label: 'plan edited', temp: 'machine' },
    plan_approved: { label: 'approved', temp: 'human' },
    plan_annotated: { label: 'annotated', temp: 'human' },
    run_requested: { label: 'run queued', temp: 'machine' },
    run_started: { label: 'run started', temp: 'machine' },
    step_started: { label: 'step started', temp: 'machine' },
    step_completed: { label: 'step done', temp: 'moss' },
    step_failed: { label: 'step failed', temp: 'rust' },
    task_created: { label: 'request', temp: 'machine' },
    task_status_changed: { label: 'status', temp: 'neutral' },
    split_proposed: { label: 'split', temp: 'machine' },
    split_resolved: { label: 'split done', temp: 'moss' },
    analysis_completed: { label: 'grounded', temp: 'moss' },
    memory_written: { label: 'note written', temp: 'machine' },
    memory_deleted: { label: 'note removed', temp: 'neutral' },
    memory_verified: { label: 'note verified', temp: 'moss' },
    models_discovered: { label: 'models', temp: 'neutral' },
    signal_received: { label: 'signal', temp: 'machine' },
    artifact_produced: { label: 'artifact', temp: 'moss' },
    operation_failed: { label: 'operation failed', temp: 'rust' },
    rate_limit_wait: { label: 'rate limited', temp: 'rust' },
    reaction_failed: { label: 'reaction failed', temp: 'rust' },
    copilot_exchange: { label: 'copilot', temp: 'neutral' },
  }
  const FALLBACK_TEMP: Temperature = 'neutral'
  const entry = $derived(TABLE[kind] ?? { label: kind.replace(/_/g, ' '), temp: FALLBACK_TEMP })
</script>

<Chip temp={entry.temp} mono>{entry.label}</Chip>
