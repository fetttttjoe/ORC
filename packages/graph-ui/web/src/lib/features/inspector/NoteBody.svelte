<script lang="ts">
  /**
   * A note's prose, with the structure its authors actually write. Notes are composed by agents
   * following the knowledge skills: dash bullets, backticked identifiers, and file paths. Rendered
   * as one pre-wrapped block it reads as a wall of grey — the reason a reader skips the very text
   * the graph exists to preserve.
   *
   * Parsed into blocks and rendered as elements, never as HTML: note bodies are model-authored
   * input, so nothing here may become markup.
   */
  let { text }: { text: string } = $props()

  type Block = { kind: 'para'; text: string } | { kind: 'list'; items: string[] }

  const blocks = $derived.by(() => {
    const out: Block[] = []
    for (const chunk of text.split(/\n{2,}/)) {
      const lines = chunk.split('\n').filter(l => l.trim() !== '')
      if (lines.length === 0) continue
      // a run of dash-led lines is a list; a continuation line folds into the item above it
      if (lines[0]?.trimStart().startsWith('- ')) {
        const items: string[] = []
        for (const line of lines) {
          const trimmed = line.trimStart()
          if (trimmed.startsWith('- ')) items.push(trimmed.slice(2))
          else if (items.length > 0) items[items.length - 1] += ` ${trimmed}`
        }
        out.push({ kind: 'list', items })
      } else {
        out.push({ kind: 'para', text: lines.join(' ') })
      }
    }
    return out
  })

  /** split on backticked spans so identifiers and paths render as code, not prose */
  const segments = (s: string): { code: boolean; text: string }[] =>
    s.split(/`([^`]+)`/).map((part, i) => ({ code: i % 2 === 1, text: part })).filter(p => p.text !== '')
</script>

{#snippet prose(s: string)}
  {#each segments(s) as seg, i (i)}
    {#if seg.code}
      <code class="rounded-[3px] bg-ink px-1 py-px font-mono text-row text-machine">{seg.text}</code>
    {:else}{seg.text}{/if}
  {/each}
{/snippet}

<div class="flex flex-col gap-2">
  {#each blocks as block, i (i)}
    {#if block.kind === 'list'}
      <ul class="flex flex-col gap-1">
        {#each block.items as item, j (j)}
          <li class="flex gap-2 text-xs leading-relaxed text-paper/90">
            <span class="mt-1.5 size-1 shrink-0 rounded-full bg-fog"></span>
            <span class="min-w-0 break-words">{@render prose(item)}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="text-xs leading-relaxed break-words text-paper/90">{@render prose(block.text)}</p>
    {/if}
  {/each}
</div>
