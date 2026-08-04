<script lang="ts">
  import { createQuery, keepPreviousData } from '@tanstack/svelte-query'
  import FileIcon from '@lucide/svelte/icons/file'
  import * as Empty from '$lib/components/ui/empty'
  import { Separator } from '$lib/components/ui/separator'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import Chip from '$lib/components/Chip.svelte'
  import Payload from '$lib/components/Payload.svelte'
  import NoteView from './NoteView.svelte'
  import KeyValue from '$lib/components/KeyValue.svelte'
  import NodeLink from '$lib/components/NodeLink.svelte'
  import StatusPill from '$lib/components/StatusPill.svelte'
  import { api } from '$lib/api/client'
  import { qk } from '$lib/query-keys'
  import { nodeKind, noteNodeId, stepNodeId, taskIdOf } from '$lib/node-id'
  import { session } from '$lib/stores/session.svelte'
  import { ArtifactDetail, fmtBytes, ModelDetail, NoteDetail, StepDetail, TaskDetail } from './detail-view'
  import { parseOrReport } from '$lib/api/parse'
  import { fmtCost, fmtTokens } from './node-head'

  // One typed view per node kind. The old generic renderer showed the data but severed every
  // navigation edge and printed link arrays as JSON — an inspector exists to walk the graph.
  let { nodeId }: { nodeId: string } = $props()

  const project = $derived(session.sel.project)
  const detail = createQuery(() => ({
    queryKey: qk.node(nodeId),
    queryFn: () => api.node(project, nodeId),
    enabled: project !== '',
    // keep the last good answer on screen while a refetch runs
    placeholderData: keepPreviousData,
  }))

  // parseOrReport, not safeParse: a view that falls back to the raw record must say WHY in the
  // console, or a single renamed field hides behind a plausible-looking pane
  const kind = $derived(nodeKind(nodeId))
  const ready = $derived(!detail.isPending && detail.data !== undefined && detail.data !== null)
  const task = $derived(ready && kind === 'task' ? parseOrReport(TaskDetail, detail.data, 'node detail (task)') : null)
  const step = $derived(ready && kind === 'step' ? parseOrReport(StepDetail, detail.data, 'node detail (step)') : null)
  const note = $derived(ready && kind === 'note' ? parseOrReport(NoteDetail, detail.data, 'node detail (note)') : null)
  const artifact = $derived(ready && kind === 'artifact' ? parseOrReport(ArtifactDetail, detail.data, 'node detail (artifact)') : null)
  const model = $derived(ready && kind === 'model' ? parseOrReport(ModelDetail, detail.data, 'node detail (model)') : null)
  const recognised = $derived(Boolean(task || step || note || artifact || model))
</script>

{#if detail.isPending}
  <div class="flex flex-col gap-2 p-3">
    {#each [0, 1, 2, 3, 4] as i (i)}<Skeleton class="h-4 w-full" />{/each}
  </div>
{:else if detail.data === undefined || detail.data === null}
  <Empty.Root class="py-10">
    <Empty.Header>
      <Empty.Media variant="icon"><FileIcon /></Empty.Media>
      <Empty.Title>nothing to show</Empty.Title>
      <Empty.Description>this node has no detail record — it may have been removed since the graph was drawn.</Empty.Description>
    </Empty.Header>
  </Empty.Root>
{:else if task}
  {@const t = task}
  <dl class="flex flex-col p-3">
    <h3 class="mb-2 text-sm font-medium break-words text-paper">{t.task.title}</h3>
    <KeyValue label="status"><StatusPill status={t.task.status} /></KeyValue>
    {#if t.task.parentId}<KeyValue label="parent"><NodeLink node={t.task.parentId} label={t.task.parentId} tab="request" /></KeyValue>{/if}
    {#if t.task.createdAt}<KeyValue label="created" mono>{t.task.createdAt}</KeyValue>{/if}
    {#if t.usage}
      <KeyValue label="cost" mono>
        {fmtCost(t.usage.costUSD)}{t.usage.estimated ? ' (est)' : ''}{#if t.task.budgetUSD != null}<span class="text-fog"> of {fmtCost(t.task.budgetUSD)} budget</span>{/if}
      </KeyValue>
      <KeyValue label="tokens" mono>{fmtTokens(t.usage.inputTokens)} in · {fmtTokens(t.usage.outputTokens)} out</KeyValue>
    {/if}
    {#if t.task.zone?.length}
      <KeyValue label="zone">
        <span class="flex flex-col gap-0.5">
          {#each t.task.zone as z (z)}<span class="truncate font-mono text-row text-mist" title={z}>{z}</span>{/each}
        </span>
      </KeyValue>
    {/if}
    {#if t.memoryPulls !== undefined}<KeyValue label="memory pulls" mono>{t.memoryPulls}</KeyValue>{/if}

    {#if t.task.spec}
      <Separator class="my-2" />
      <p class="text-xs leading-relaxed break-words whitespace-pre-wrap text-mist">{t.task.spec}</p>
    {/if}
    {#if t.steps.length > 0}
      <Separator class="my-2" />
      <p class="mb-1 font-mono text-label tracking-widest text-fog uppercase">steps</p>
      {#each t.steps as s (s.stepId)}
        <div class="flex flex-col gap-0.5 py-1">
          <div class="flex min-w-0 items-center gap-2">
            <span class="min-w-0 grow"><NodeLink node={stepNodeId(t.task.id, s.stepId)} label={s.stepId} /></span>
            {#if s.iterations !== undefined}<span class="shrink-0 font-mono text-label text-fog">{s.iterations} iter</span>{/if}
            {#if s.attempt !== undefined && s.attempt > 1}<span class="shrink-0 font-mono text-label text-human">attempt {s.attempt}</span>{/if}
            {#if s.usage}<span class="shrink-0 font-mono text-row text-mist">{fmtCost(s.usage.costUSD)}</span>{/if}
            <StatusPill status={s.status} />
          </div>
          {#if s.failure}
            <p class="truncate font-mono text-label text-rust" title={s.failure.message}>{s.failure.class ?? 'failed'}: {s.failure.message}</p>
          {/if}
        </div>
      {/each}
    {/if}
    {#if t.artifacts.length > 0}
      <Separator class="my-2" />
      <p class="mb-1 font-mono text-label tracking-widest text-fog uppercase">artifacts</p>
      {#each t.artifacts as a (a.path)}
        <div class="flex items-baseline gap-2 py-0.5 font-mono text-row">
          <span class="min-w-0 grow truncate text-paper" title={a.path}>{a.path}</span>
          {#if a.size !== undefined}<span class="shrink-0 text-fog">{fmtBytes(a.size)}</span>{/if}
        </div>
      {/each}
    {/if}
  </dl>
{:else if step}
  {@const s = step}
  {@const owner = taskIdOf(nodeId)}
  <dl class="flex flex-col p-3">
    <h3 class="mb-2 text-sm font-medium break-words text-paper">{s.step.title}</h3>
    {#if s.run}<KeyValue label="status"><StatusPill status={s.run.status} /></KeyValue>{/if}
    {#if owner}<KeyValue label="task"><NodeLink node={owner} tab="request" /></KeyValue>{/if}
    {#if s.step.role}<KeyValue label="role" mono>{s.step.role}</KeyValue>{/if}
    {#if s.step.modelRef}<KeyValue label="model" mono>{s.step.modelRef}</KeyValue>{/if}
    {#if s.run?.attempt !== undefined}<KeyValue label="attempt" mono>{s.run.attempt}</KeyValue>{/if}
    {#if s.usage}<KeyValue label="cost" mono>{fmtCost(s.usage.costUSD)}</KeyValue>{/if}
    {#if s.step.dependsOn?.length}<KeyValue label="after" mono>{s.step.dependsOn.join(', ')}</KeyValue>{/if}
    {#if s.run?.failure}
      <Separator class="my-2" />
      <Payload label={s.run.failure.class ?? 'failure'} value={s.run.failure.message} temp="rust" />
    {/if}
    {#if s.step.instructions}
      <Separator class="my-2" />
      <details>
        <summary class="cursor-pointer font-mono text-label tracking-widest text-fog uppercase select-none">instructions</summary>
        <p class="mt-1 text-xs leading-relaxed break-words whitespace-pre-wrap text-mist">{s.step.instructions}</p>
      </details>
    {/if}
  </dl>
{:else if note}
  <NoteView {note} />
{:else if artifact}
  {@const a = artifact}
  {@const owner = taskIdOf(nodeId)}
  <dl class="flex flex-col p-3">
    <h3 class="mb-2 font-mono text-xs break-all text-paper">{a.path}</h3>
    {#if a.size !== undefined}<KeyValue label="size" mono>{fmtBytes(a.size)}</KeyValue>{/if}
    {#if a.sha256}<KeyValue label="sha256" mono>{a.sha256.slice(0, 16)}…</KeyValue>{/if}
    {#if owner && a.stepId}
      <KeyValue label="produced by"><NodeLink node={stepNodeId(owner, a.stepId)} label={a.stepId} /></KeyValue>
    {/if}
    {#if owner}<KeyValue label="task"><NodeLink node={owner} tab="request" /></KeyValue>{/if}
  </dl>
{:else if model}
  {@const m = model}
  <dl class="flex flex-col p-3">
    <h3 class="mb-2 font-mono text-xs break-all text-paper">{m.ref}</h3>
    {#if m.totals}
      <KeyValue label="spent" mono>{fmtCost(m.totals.costUSD)}</KeyValue>
      <KeyValue label="tokens" mono>{fmtTokens(m.totals.inputTokens)} in · {fmtTokens(m.totals.outputTokens)} out</KeyValue>
    {/if}
    {#if m.tasks.length > 0}
      <Separator class="my-2" />
      <p class="mb-1 font-mono text-label tracking-widest text-fog uppercase">used by</p>
      {#each m.tasks as t (t.taskId)}
        <div class="flex items-baseline gap-2 py-0.5">
          <span class="min-w-0 grow"><NodeLink node={t.taskId} label={t.title ?? t.taskId} tab="request" /></span>
          {#if t.calls !== undefined}<span class="shrink-0 font-mono text-label text-fog">{t.calls} calls</span>{/if}
          {#if t.usage}<span class="shrink-0 font-mono text-row text-mist">{fmtCost(t.usage.costUSD)}</span>{/if}
        </div>
      {/each}
    {/if}
  </dl>
{:else if !recognised}
  <div class="p-3">
    <Payload label="unrecognised shape — raw record" value={detail.data} />
  </div>
{/if}
