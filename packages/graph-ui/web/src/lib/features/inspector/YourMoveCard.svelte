<script lang="ts">
  import CopyChip from '$lib/components/CopyChip.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { actions, replyReceipt } from '$lib/api/actions'
  import { notify } from '$lib/notify'
  import { session } from '$lib/stores/session.svelte'
  import { cn } from '$lib/utils'
  import { TEMP_BORDER, TEMP_TEXT } from '$lib/temperature'
  import type { Move } from './your-move'

  /** the shown plan version — required only by the `replan` move, which reopens it for editing */
  interface PlanDraftish { strategyRef: string; costEstimateUSD: number | null; steps: unknown[] }

  let { move, taskId, plan }: { move: Move; taskId: string; plan?: PlanDraftish | undefined } = $props()

  let busy = $state(false)
  let answer = $state('')
  let modelRef = $state('')
  let cwd = $state(session.info.defaultCwd ?? '')

  // executing needs this server's own runtime; answering is a pure append any chat may make
  const canRun = $derived(session.canAct())
  const canAnswer = $derived(session.canAnswer())

  async function perform(label: string, fn: () => Promise<unknown>): Promise<void> {
    if (busy) return
    busy = true
    try {
      await fn()
      notify(label, 'ok')
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      busy = false
    }
  }

  // A rejected run reopens via edit: revise resumes an open gate, and a finished run has none
  async function reopen(): Promise<{ version: number }> {
    const draft = plan
    // the template gates the control on plan; a thrown message beats reopening an empty plan
    if (!draft) throw new Error('no plan version on screen to reopen')
    return actions.edit(taskId, { strategyRef: draft.strategyRef, costEstimateUSD: draft.costEstimateUSD, steps: draft.steps })
  }

  async function sendAnswer(): Promise<void> {
    const text = answer.trim()
    if (!text || busy) return
    busy = true
    try {
      const receipt = replyReceipt(await actions.reply(taskId, text))
      notify(receipt.text, receipt.tone)
      answer = ''
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      busy = false
    }
  }
</script>

<section class={cn('flex flex-col gap-2 border-l-2 bg-bureau px-3 py-2.5', TEMP_BORDER[move.temp])}>
  <p class="font-mono text-label tracking-widest text-fog uppercase">your move</p>
  <p class={cn('text-xs leading-relaxed', TEMP_TEXT[move.temp])}>{move.text}</p>

  {#if move.kind === 'retry' && canRun}
    <Button size="sm" variant="destructive" disabled={busy} onclick={() => void perform('retry started', () => actions.retry(taskId))}>retry failed steps</Button>
  {:else if move.kind === 'replan' && canRun && plan}
    <!-- Reopen as a new editable version: no model call, unlike re-running an unchanged verdict -->
    <Button size="sm" disabled={busy} onclick={() => void perform('plan reopened for editing', reopen)}>
      reopen plan for editing
    </Button>
  {:else if move.kind === 'answer' && canAnswer}
    <div class="flex items-center gap-2">
      <Input
        bind:value={answer}
        disabled={busy}
        placeholder="your answer…"
        class="h-8 grow text-xs"
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void sendAnswer()
          }
        }}
      />
      <Button size="sm" disabled={busy || answer.trim() === ''} onclick={() => void sendAnswer()}>reply</Button>
    </div>
  {:else if move.kind === 'propose' && canRun}
    <div class="flex items-center gap-2">
      <Input bind:value={modelRef} disabled={busy} placeholder="provider/model" class="h-8 grow font-mono text-xs" />
      <Button size="sm" disabled={busy || modelRef.trim() === ''} onclick={() => void perform('plan proposed', () => actions.propose(taskId, modelRef.trim()))}>propose</Button>
    </div>
  {:else if move.kind === 'approve' && canRun}
    <Button size="sm" disabled={busy} onclick={() => void perform('plan approved', () => actions.approve(taskId))}>approve plan</Button>
  {:else if move.kind === 'run' && canRun}
    <div class="flex items-center gap-2">
      <Input bind:value={cwd} disabled={busy} placeholder="workspace directory" class="h-8 grow font-mono text-xs" />
      <Button size="sm" disabled={busy || cwd.trim() === ''} onclick={() => void perform('run started', () => actions.run(taskId, cwd.trim()))}>run</Button>
    </div>
  {:else if move.cmd}
    <CopyChip text={move.cmd} />
  {/if}
</section>
