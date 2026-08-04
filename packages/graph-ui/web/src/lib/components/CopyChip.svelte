<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check'
  import CopyIcon from '@lucide/svelte/icons/copy'
  import { Button } from '$lib/components/ui/button'

  // a command the operator must run elsewhere: shown whole, copied in one click
  let { text }: { text: string } = $props()
  let copied = $state(false)
  let clearAt: ReturnType<typeof setTimeout> | null = null

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(text)
    copied = true
    if (clearAt) clearTimeout(clearAt)
    clearAt = setTimeout(() => (copied = false), 1600)
  }
</script>

<Button variant="outline" size="sm" class="font-mono text-row" title="copy" onclick={() => void copy()}>
  {#if copied}<CheckIcon data-icon="inline-start" />{:else}<CopyIcon data-icon="inline-start" />{/if}
  {text}
</Button>
