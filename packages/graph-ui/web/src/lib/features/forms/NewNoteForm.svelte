<script lang="ts">
  // quick capture: title + optional markdown body. slugId keys the note by title, so re-noting
  // the same title UPDATES it (writeNote is an upsert) — same rule as the legacy page.
  import { slugId } from '@orc/contracts/ids'
  import { Button } from '$lib/components/ui/button'
  import * as Field from '$lib/components/ui/field'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { actions } from '$lib/api/actions'
  import { notify } from '$lib/notify'
  import { session } from '$lib/stores/session.svelte'

  // the host owns the surface this form lives in — it closes on success
  let { onsubmitted }: { onsubmitted?: () => void } = $props()

  const uid = $props.id()
  let title = $state('')
  let body = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)

  async function submit(): Promise<void> {
    error = null
    const t = title.trim()
    if (!t) {
      notify('a note needs a title', 'error')
      return
    }
    let id: string
    try {
      id = slugId(t) // throws its own friendly error for non-latin titles
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
      return
    }
    busy = true
    try {
      await actions.writeNote({ id, title: t, ...(body.trim() && { body }) })
      notify(`noted '${id}'`, 'ok')
      onsubmitted?.()
      title = ''
      body = ''
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }
</script>

<form
  class="flex flex-col gap-2 p-3"
  onsubmit={e => {
    e.preventDefault()
    void submit()
  }}
>
  {#if !session.canAct()}
    <p class="text-xs text-fog">read-only here — notes are written where orc graph was started</p>
  {/if}
  <fieldset class="flex min-w-0 flex-col gap-2" disabled={!session.canAct() || busy}>
    <label class="font-mono text-label tracking-widest text-fog uppercase" for="{uid}-title">title</label>
    <Input id="{uid}-title" class="h-8 text-xs" bind:value={title} placeholder="what to remember?" />

    <label class="font-mono text-label tracking-widest text-fog uppercase" for="{uid}-body">body</label>
    <Textarea id="{uid}-body" class="h-8 text-xs" bind:value={body} placeholder="markdown (optional)"></Textarea>

    <div class="mt-1 flex items-center gap-2">
      <Button type="submit" disabled={!session.canAct() || busy}>{busy ? 'saving…' : '+ note'}</Button>
    </div>
  </fieldset>
</form>
