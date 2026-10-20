<script lang="ts">
  import { slide } from 'svelte/transition'
  import { APPROVAL_ANSWER } from '@orc/contracts/approval-answer'
  import { STEP_ID } from '@orc/contracts/step-ids'
  import CopyChip from '$lib/components/CopyChip.svelte'
  import TaskChip from '$lib/components/TaskChip.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Textarea } from '$lib/components/ui/textarea'
  import { actions, replyReceipt } from '$lib/api/actions'
  import { notify } from '$lib/notify'
  import { session } from '$lib/stores/session.svelte'
  import type { OpenQuestion } from '@orc/ui-core/wire'

  let { gate }: { gate: OpenQuestion } = $props()

  let text = $state('')
  let busy = $state(false)

  // The plan and finish steps' questions get one-click approve: the kernel reads it as approval
  const isApprovalGate = $derived(gate.stepId === STEP_ID.plan || gate.stepId === STEP_ID.finish)

  async function send(answer: string): Promise<void> {
    if (!answer || busy) return
    busy = true
    try {
      const receipt = replyReceipt(await actions.reply(gate.taskId, answer))
      notify(receipt.text, receipt.tone)
      text = ''
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      busy = false
    }
  }
</script>

<section class="border-y border-human/45 bg-human/8 px-4 py-3" aria-label="open question" transition:slide={{ duration: 180 }}>
  <div class="mb-1.5 flex items-center gap-2">
    <span class="font-mono text-label tracking-widest text-human uppercase">waiting on you</span>
    <TaskChip taskId={gate.taskId} />
    <span class="grow"></span>
    <span class="font-mono text-label text-human/70">#{gate.seq}</span>
  </div>

  <!-- gate.question is the agent's verbatim text from the view registry, not the ledger summary -->
  <p class="mb-2.5 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-paper">{gate.question}</p>

  {#if session.canAnswer()}
    <div class="flex items-start gap-2">
      <Textarea
        bind:value={text}
        rows={1}
        disabled={busy}
        placeholder="answer the agent…"
        class="min-h-8 grow resize-y border-human/35 bg-ink/60 text-xs focus-visible:border-human"
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void send(text.trim())
          }
        }}
      />
      {#if isApprovalGate}
        <Button size="sm" disabled={busy} onclick={() => void send(APPROVAL_ANSWER)}>approve</Button>
      {/if}
      <Button variant="outline" size="sm" disabled={busy || text.trim() === ''} onclick={() => void send(text.trim())}>answer</Button>
    </div>
  {:else}
    <div class="flex flex-wrap items-center gap-2 text-row text-mist">
      <span>this server cannot write — answer it from the project's own directory:</span>
      <CopyChip text={`orc reply ${gate.taskId} "your answer"`} />
    </div>
  {/if}
</section>
