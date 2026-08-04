<script lang="ts">
  import { createQuery, keepPreviousData } from '@tanstack/svelte-query'
  import MessageIcon from '@lucide/svelte/icons/message-square-dashed'
  import * as Empty from '$lib/components/ui/empty'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import Chip from '$lib/components/Chip.svelte'
  import Payload from '$lib/components/Payload.svelte'
  import GateCard from '$lib/features/gates/GateCard.svelte'
  import { api } from '$lib/api/client'
  import { qk } from '$lib/query-keys'
  import { stepIdOf, taskIdOf } from '$lib/node-id'
  import { ledger } from '$lib/stores/ledger.svelte'
  import { session } from '$lib/stores/session.svelte'
  import { toolPreview } from './tool-preview'

  /**
   * The agent's transcript, scoped to one step when a step node is selected. Questions and
   * signals render VERBATIM — a truncated question cannot be answered — and tool payloads are
   * arbitrary JSON, so they are formatted, never interpolated (that printed "[object Object]").
   */
  let { nodeId }: { nodeId: string } = $props()

  const project = $derived(session.sel.project)
  const taskId = $derived(taskIdOf(nodeId))
  const stepId = $derived(stepIdOf(nodeId))
  const gate = $derived(taskId === null ? null : (ledger.gates.find(g => g.taskId === taskId) ?? null))

  const transcript = createQuery(() => ({
    queryKey: qk.taskTranscript(taskId ?? '', stepId),
    queryFn: () => api.transcript(project, taskId ?? '', stepId ?? undefined),
    enabled: taskId !== null && project !== '',
    // keep the last good answer on screen while a refetch runs
    placeholderData: keepPreviousData,
  }))

  const items = $derived(transcript.data ?? [])

</script>

{#if gate !== null}
  <GateCard {gate} />
{/if}

{#if taskId === null}
  <Empty.Root class="py-10">
    <Empty.Header>
      <Empty.Media variant="icon"><MessageIcon /></Empty.Media>
      <Empty.Title>no transcript</Empty.Title>
      <Empty.Description>this node belongs to no task, so there is no agent conversation behind it.</Empty.Description>
    </Empty.Header>
  </Empty.Root>
{:else if transcript.isPending}
  <div class="flex flex-col gap-2 p-3">
    {#each [0, 1, 2] as i (i)}<Skeleton class="h-12 w-full" />{/each}
  </div>
{:else if items.length === 0}
  <Empty.Root class="py-10">
    <Empty.Header>
      <Empty.Media variant="icon"><MessageIcon /></Empty.Media>
      <Empty.Title>nothing said yet</Empty.Title>
      <Empty.Description>the transcript fills as soon as an agent runs this task.</Empty.Description>
    </Empty.Header>
  </Empty.Root>
{:else}
  <div class="flex flex-col gap-2 p-3">
    <!-- keyed by position: the server returns a stable ordered list, and object identity changes
         on every refetch (which re-rendered the whole transcript) -->
    {#each items as item, i (i)}
      {#if item.kind === 'message'}
        <article class="rounded-(--radius-card) border border-line bg-bureau px-3 py-2">
          <p class="mb-1 font-mono text-label text-fog">{item.stepId} · iteration {item.iteration}</p>
          <p class="text-xs leading-relaxed break-words whitespace-pre-wrap text-paper">{item.text}</p>
        </article>
      {:else if item.kind === 'tool'}
        <!-- what this call did, so sixty fs_read rows are told apart without expanding sixty times -->
        {@const preview = toolPreview(item.input)}
        <details class={['rounded-(--radius-chip) border', item.isError ? 'border-rust/40 bg-rust/5' : 'border-line bg-desk/30']}>
          <summary class="flex cursor-pointer items-center gap-2 px-2 py-1 select-none">
            <Chip mono temp={item.isError ? 'rust' : 'neutral'}>{item.toolName}</Chip>
            {#if item.isError}<span class="font-mono text-label text-rust">error</span>{/if}
            <!-- min-w-0 + truncate: the preview yields the line, never widens the panel -->
            {#if preview !== ''}
              <span class="min-w-0 grow truncate font-mono text-label text-mist" title={preview}>{preview}</span>
            {:else}
              <span class="grow"></span>
            {/if}
            <span class="shrink-0 font-mono text-label text-fog">iteration {item.iteration}</span>
          </summary>
          <div class="flex flex-col gap-1.5 border-t border-line/50 p-2">
            <Payload label="input" value={item.input} />
            <Payload
              label={item.isError ? 'error' : 'output'}
              value={item.output}
              temp={item.isError ? 'rust' : 'machine'}
              empty="no result recorded — the step may have died mid-call"
            />
          </div>
        </details>
      {:else if item.kind === 'question'}
        <article class="rounded-(--radius-card) border border-human/45 bg-human/10 px-3 py-2">
          <p class="mb-1 font-mono text-label tracking-widest text-human uppercase">asked the operator</p>
          <p class="text-xs leading-relaxed break-words whitespace-pre-wrap text-paper">{item.question}</p>
          {#if item.answer !== null}
            <p class="mt-1.5 border-t border-human/25 pt-1.5 text-xs break-words whitespace-pre-wrap text-mist">
              <span class="font-mono text-label tracking-widest text-human uppercase">answered</span>
              {item.answer}
            </p>
          {:else}
            <p class="mt-1.5 font-mono text-label text-human/80">waiting for an answer</p>
          {/if}
        </article>
      {:else}
        <article class="rounded-(--radius-card) border border-machine/40 bg-machine/8 px-3 py-2">
          <p class="mb-1 font-mono text-label tracking-widest text-machine uppercase">signalled {item.outcome}</p>
          <p class="text-xs leading-relaxed break-words whitespace-pre-wrap text-paper">{item.summary}</p>
        </article>
      {/if}
    {/each}
  </div>
{/if}
