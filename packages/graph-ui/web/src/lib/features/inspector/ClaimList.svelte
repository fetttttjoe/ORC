<script lang="ts">
  import { Separator } from '$lib/components/ui/separator'
  import { cn } from '$lib/utils'

  /**
   * A note's claims: the atomic statements the retrieval layer actually matches on. They are the
   * substance of the note, so they read as evidence — numbered, on their own rail, in body colour
   * — rather than as a bullet list of afterthoughts.
   *
   * Each claim records the revision it was written at. A claim whose revision differs from the
   * note's is the interesting case: the note has been rewritten since, and that statement was
   * carried forward rather than re-checked.
   */
  let {
    claims,
    noteRevision,
    bare = false,
  }: {
    // "no revision recorded" arrives as null (a claim written where none could be stamped), as
    // undefined (an older row without the key), and both mean the same thing to every test below
    claims: readonly { id: string; text: string; sourceRevision?: string | null | undefined }[]
    noteRevision?: string | null | undefined
    /** inside a titled section the heading is the section's job, not ours */
    bare?: boolean
  } = $props()

  const short = (rev: string): string => rev.slice(0, 8)
</script>

{#if claims.length > 0}
  {#if !bare}
    <Separator class="my-2" />
    <div class="mb-1.5 flex items-baseline gap-2">
      <span class="font-mono text-label tracking-widest text-fog uppercase">claims</span>
      <span class="font-mono text-label text-fog/70">{claims.length}</span>
    </div>
  {/if}

  <ol class="flex flex-col">
    {#each claims as claim, i (claim.id)}
      {@const carried = claim.sourceRevision != null && noteRevision != null && claim.sourceRevision !== noteRevision}
      <li class="group flex gap-2 border-l border-line py-1 pl-2 transition-colors hover:border-machine/50 hover:bg-desk/30">
        <span class="w-4 shrink-0 pt-px text-right font-mono text-label tabular-nums text-fog select-none">{i + 1}</span>
        <div class="min-w-0 grow">
          <p class="text-xs leading-relaxed break-words text-paper/90">{claim.text}</p>
          {#if claim.sourceRevision}
            <p
              class={cn('mt-0.5 font-mono text-label opacity-0 transition-opacity group-hover:opacity-100', carried ? 'text-human/80 opacity-100' : 'text-fog')}
              title={carried
                ? 'recorded at an earlier revision than the note — carried forward, not re-checked'
                : 'the revision this statement was recorded at'}
            >
              {short(claim.sourceRevision)}{carried ? ' · carried forward' : ''}
            </p>
          {/if}
        </div>
      </li>
    {/each}
  </ol>
{/if}
