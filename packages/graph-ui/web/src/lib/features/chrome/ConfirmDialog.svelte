<script lang="ts">
  import * as AlertDialog from '$lib/components/ui/alert-dialog'
  import { Input } from '$lib/components/ui/input'
  import { Spinner } from '$lib/components/ui/spinner'
  import { buttonVariants } from '$lib/components/ui/button'
  import { cn } from '$lib/utils'
  import type { Snippet } from 'svelte'

  // Typing the exact name confirms; the action's own error renders inside the dialog
  let {
    open = $bindable(false),
    title,
    description,
    confirmWord,
    confirmLabel,
    onconfirm,
    trigger,
  }: {
    open?: boolean
    title: string
    description: string
    /** the operator must type this exactly */
    confirmWord: string
    confirmLabel: string
    onconfirm: () => Promise<void>
    trigger?: Snippet
  } = $props()

  let typed = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)

  const matches = $derived(typed === confirmWord)

  async function run(): Promise<void> {
    if (!matches || busy) return
    busy = true
    error = null
    try {
      await onconfirm()
      open = false
      typed = ''
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }
</script>

<AlertDialog.Root bind:open>
  {#if trigger}
    <AlertDialog.Trigger>{@render trigger()}</AlertDialog.Trigger>
  {/if}
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>{title}</AlertDialog.Title>
      <AlertDialog.Description>{description}</AlertDialog.Description>
    </AlertDialog.Header>

    <div class="flex flex-col gap-1.5">
      <label class="font-mono text-label tracking-widest text-fog uppercase" for="confirm-word">{confirmLabel}</label>
      <Input
        id="confirm-word"
        bind:value={typed}
        disabled={busy}
        placeholder={confirmWord}
        class="h-8 font-mono text-xs"
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === 'Enter' && matches) {
            e.preventDefault()
            void run()
          }
        }}
      />
      {#if error}<p class="font-mono text-row text-rust">{error}</p>{/if}
    </div>

    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={busy}>cancel</AlertDialog.Cancel>
      <button class={cn(buttonVariants({ variant: 'destructive' }))} disabled={!matches || busy} onclick={() => void run()}>
        {#if busy}<Spinner data-icon="inline-start" />{/if}
        {title}
      </button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
