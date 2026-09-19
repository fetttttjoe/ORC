<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import PlusIcon from '@lucide/svelte/icons/plus'
  import * as Field from '$lib/components/ui/field'
  import * as Select from '$lib/components/ui/select'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Spinner } from '$lib/components/ui/spinner'
  import { actions } from '$lib/api/actions'
  import { notify } from '$lib/notify'
  import { viewQuery } from '$lib/api/view-query'
  import { VIEW } from '@orc/ui-core/wire'
  import { session } from '$lib/stores/session.svelte'

  /**
   * Grounded analyses the repo and decomposes before asking for approval; draft is one step
   * running the spec verbatim. The distinction is the presence of the `grounded` block on the
   * wire — the server's newTask schema has no `mode` field, and this form sets no budget.
   */
  const MODES = [
    { value: 'grounded', label: 'grounded — analyse, decompose, review' },
    { value: 'draft', label: 'draft — one step, your spec verbatim' },
  ] as const
  type Mode = (typeof MODES)[number]['value']

  // the host owns the surface this form lives in (a dialog today) — it closes on success
  let { onsubmitted }: { onsubmitted?: () => void } = $props()

  const uid = $props.id()
  let title = $state('')
  let spec = $state('')
  let mode = $state<Mode>('grounded')
  let modelRef = $state('')
  let cwd = $state('')
  let busy = $state(false)

  const models = createQuery(viewQuery(VIEW.models, () => (session.canAct() && mode === 'grounded' ? {} : null)))

  const modeLabel = $derived(MODES.find(m => m.value === mode)?.label ?? '')
  const effectiveCwd = $derived(cwd.trim() || session.info.defaultCwd || '')
  const ready = $derived(title.trim() !== '' && (mode === 'draft' || (spec.trim() !== '' && modelRef !== '' && effectiveCwd !== '')))

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault()
    if (!ready || busy) return
    busy = true
    try {
      const taskId = await actions.newTask({
        title: title.trim(),
        ...(spec.trim() !== '' && { spec: spec.trim() }),
        ...(mode === 'grounded' && { grounded: { modelRef, cwd: effectiveCwd } }),
      })
      notify('request created', 'ok')
      title = ''
      spec = ''
      onsubmitted?.()
      session.navigate({ node: taskId, tab: 'request' })
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      busy = false
    }
  }
</script>

{#if session.canAct()}
  <form onsubmit={submit}>
    <Field.FieldGroup class="gap-2">
      <Field.Field>
        <Field.FieldLabel for="{uid}-title" class="font-mono text-label tracking-widest text-fog uppercase">title</Field.FieldLabel>
        <Input id="{uid}-title" bind:value={title} disabled={busy} placeholder="what should happen?" class="h-8 text-xs" />
      </Field.Field>

      <Field.Field>
        <Textarea bind:value={spec} disabled={busy} rows={2} placeholder="details, constraints, outputs…" class="resize-y text-xs" />
      </Field.Field>

      <Field.Field>
        <Select.Root type="single" bind:value={mode} disabled={busy}>
          <Select.Trigger class="h-8 text-xs">{modeLabel}</Select.Trigger>
          <Select.Content>
            <Select.Group>
              {#each MODES as m (m.value)}
                <Select.Item value={m.value} label={m.label}>{m.label}</Select.Item>
              {/each}
            </Select.Group>
          </Select.Content>
        </Select.Root>
      </Field.Field>

      {#if mode === 'grounded'}
        <Field.Field>
          <Select.Root type="single" bind:value={modelRef} disabled={busy || models.isPending}>
            <Select.Trigger class="h-8 font-mono text-xs">{modelRef || 'provider/model'}</Select.Trigger>
            <Select.Content>
              <Select.Group>
                {#each models.data ?? [] as ref (ref)}
                  <Select.Item value={ref} label={ref}>{ref}</Select.Item>
                {/each}
              </Select.Group>
            </Select.Content>
          </Select.Root>
        </Field.Field>
        <Field.Field>
          <Input bind:value={cwd} disabled={busy} placeholder={session.info.defaultCwd ?? 'workspace directory'} class="h-8 font-mono text-xs" />
        </Field.Field>
      {/if}

      <Button type="submit" size="sm" disabled={!ready || busy}>
        {#if busy}<Spinner data-icon="inline-start" />{:else}<PlusIcon data-icon="inline-start" />{/if}
        create request
      </Button>
    </Field.FieldGroup>
  </form>
{:else}
  <p class="px-1 text-row text-fog">read-only chat — requests run in the project this server was started in</p>
{/if}
