<script lang="ts">
  import * as Accordion from '$lib/components/ui/accordion'
  import { Separator } from '$lib/components/ui/separator'
  import Chip from '$lib/components/Chip.svelte'
  import NodeLink from '$lib/components/NodeLink.svelte'
  import ClaimList from './ClaimList.svelte'
  import NoteBody from './NoteBody.svelte'
  import GitCommitIcon from '@lucide/svelte/icons/git-commit-horizontal'
  import PenIcon from '@lucide/svelte/icons/pen-line'
  import PullIcon from '@lucide/svelte/icons/download'
  import { noteNodeId } from '$lib/node-id'
  import { graph } from '$lib/stores/graph.svelte'
  import type { NoteDetail } from './detail-view'

  /**
   * A note, sectioned. Everything a note holds — prose, claims, both link directions, sources,
   * provenance — used to render as one column, which read as a wall of text and buried the parts
   * a reader came for. Now the summary and body stay open (that IS the note) and the rest opens
   * on demand, each section stating its count so nothing is hidden, only folded.
   */
  let { note: n }: { note: NoteDetail } = $props()

  // the writing task's title if the graph knows it; a bare id says nothing to a reader
  const authorLabel = $derived(n.author?.taskId ? (graph.taskTitle(n.author.taskId) ?? n.author.taskId.slice(0, 8)) : '')

  const sections = $derived(
    [
      n.note.body !== '' && n.note.body !== undefined ? 'body' : null,
      n.note.claims.length > 0 ? 'claims' : null,
    ].filter((s): s is string => s !== null),
  )
</script>

<div class="flex flex-col p-3">
  <h3 class="mb-1.5 text-sm leading-snug font-medium break-words text-paper">{n.note.title}</h3>

  <!-- what KIND of knowledge this is, before anything it says -->
  <div class="mb-2 flex flex-wrap gap-1">
    {#if n.note.kind}<Chip mono temp="machine" title="what kind of knowledge this is">{n.note.kind.replace(/_/g, ' ')}</Chip>{/if}
    {#if n.note.tier}<Chip mono title="semantic notes describe how things are; episodic ones record what happened">{n.note.tier}</Chip>{/if}
    {#if n.note.retention}
      <Chip mono title={n.note.retention === 'durable' ? 'kept until something contradicts it' : 'expires unless something touches it'}>{n.note.retention}</Chip>
    {/if}
    {#each n.note.tags as tag (tag)}<Chip>{tag}</Chip>{/each}
  </div>

  {#if n.note.summary}
    <p class="mb-2 text-xs leading-relaxed break-words text-paper">{n.note.summary}</p>
  {/if}

  <!-- provenance: the commit it was checked against, who wrote it, how often it has been used.
       Read left to right it answers "how much should I trust this, and how current is it". -->
  <div class="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-(--radius-chip) border border-line bg-desk/30 px-2 py-1.5">
    {#if n.note.sourceRevision}
      <span class="flex items-center gap-1.5" title="the commit this note was last checked against — drift is measured from here">
        <GitCommitIcon class="size-3 text-fog" />
        <span class="font-mono text-row text-paper">{n.note.sourceRevision.slice(0, 9)}</span>
      </span>
    {/if}
    {#if n.author?.taskId}
      <span class="flex min-w-0 items-center gap-1.5" title="the task whose step wrote this note">
        <PenIcon class="size-3 shrink-0 text-fog" />
        <NodeLink node={n.author.taskId} label={authorLabel} tab="request" />
      </span>
    {/if}
    {#if n.hits !== undefined}
      <span class="flex items-center gap-1.5" title="how many times an agent has pulled this note into a step">
        <PullIcon class="size-3 text-fog" />
        <span class="font-mono text-row text-mist">{n.hits} pull{n.hits === 1 ? '' : 's'}</span>
      </span>
    {/if}
    <span class="grow"></span>
    <span class="truncate font-mono text-label text-fog" title="the note's stable id">{n.note.id}</span>
  </div>

  <Accordion.Root type="multiple" value={sections}>
    {#if n.note.body}
      <Accordion.Item value="body" class="border-line">
        <Accordion.Trigger class="py-2 font-mono text-label tracking-widest text-fog uppercase hover:no-underline">what it says</Accordion.Trigger>
        <Accordion.Content class="pb-3"><NoteBody text={n.note.body} /></Accordion.Content>
      </Accordion.Item>
    {/if}

    {#if n.note.claims.length > 0}
      <Accordion.Item value="claims" class="border-line">
        <Accordion.Trigger class="py-2 font-mono text-label tracking-widest text-fog uppercase hover:no-underline">
          claims<span class="ml-1 text-fog/70">{n.note.claims.length}</span>
        </Accordion.Trigger>
        <Accordion.Content class="pb-3"><ClaimList claims={n.note.claims} noteRevision={n.note.sourceRevision} bare /></Accordion.Content>
      </Accordion.Item>
    {/if}

    {#if n.note.links.length > 0 || n.backlinks.length > 0}
      <Accordion.Item value="links" class="border-line">
        <Accordion.Trigger class="py-2 font-mono text-label tracking-widest text-fog uppercase hover:no-underline">
          connections<span class="ml-1 text-fog/70">{n.note.links.length + n.backlinks.length}</span>
        </Accordion.Trigger>
        <Accordion.Content class="flex flex-col gap-2 pb-3">
          {#if n.note.links.length > 0}
            <div>
              <p class="mb-1 font-mono text-label text-fog">this note →</p>
              {#each n.note.links as link (link.id + link.kind)}
                <div class="flex min-w-0 items-baseline gap-2 py-0.5">
                  <Chip mono class="shrink-0">{link.kind.replace(/_/g, ' ')}</Chip>
                  <NodeLink node={noteNodeId(n.note.scope, link.id)} label={link.id} />
                </div>
              {/each}
            </div>
          {/if}
          {#if n.backlinks.length > 0}
            <div>
              <p class="mb-1 font-mono text-label text-fog">→ this note</p>
              {#each n.backlinks as link (link.id + link.kind)}
                <div class="flex min-w-0 items-baseline gap-2 py-0.5">
                  <Chip mono class="shrink-0">{link.kind.replace(/_/g, ' ')}</Chip>
                  <NodeLink node={noteNodeId(link.scope ?? n.note.scope, link.id)} label={link.title ?? link.id} />
                </div>
              {/each}
            </div>
          {/if}
        </Accordion.Content>
      </Accordion.Item>
    {/if}

    {#if n.note.paths.length > 0 || n.note.sources.length > 0}
      <Accordion.Item value="grounding" class="border-line">
        <Accordion.Trigger class="py-2 font-mono text-label tracking-widest text-fog uppercase hover:no-underline">
          grounding<span class="ml-1 text-fog/70">{n.note.paths.length + n.note.sources.length}</span>
        </Accordion.Trigger>
        <Accordion.Content class="flex flex-col gap-2 pb-3">
          {#if n.note.paths.length > 0}
            <div>
              <p class="mb-1 font-mono text-label text-fog">cites — drift is measured against these</p>
              {#each n.note.paths as path (path)}<p class="truncate font-mono text-row text-mist" title={path}>{path}</p>{/each}
            </div>
          {/if}
          {#if n.note.sources.length > 0}
            <div>
              <p class="mb-1 font-mono text-label text-fog">derived from</p>
              {#each n.note.sources as src (src)}<p class="truncate font-mono text-row text-mist" title={src}>{src}</p>{/each}
            </div>
          {/if}
        </Accordion.Content>
      </Accordion.Item>
    {/if}
  </Accordion.Root>
</div>
