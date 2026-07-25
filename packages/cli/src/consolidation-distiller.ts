import { generateObject } from 'ai'
import { z } from 'zod'
import { parseModelRef, type ModelProvider } from '@orc/contracts'
import type { ConsolidationDistiller, ConsolidationInput } from '@orc/memory'
import { isLanguageModel } from './model-guard'

// Bounded so a distilled note still fits the note limits (title 200, summary 500) and search stays
// legible; the model is told to be concise. Parsed by generateObject, so a malformed reply retries.
const DistilledSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(500),
  body: z.string().max(4000),
})

export function distillPrompt(input: ConsolidationInput): string {
  const steps = input.steps.map(s => `- ${s.title}: ${s.summary}`).join('\n') || '(no step notes)'
  // A step summary may describe work the step PLANNED for others, not work that happened. Without
  // this the distiller promoted a plan into an accomplishment — "implemented, with test coverage and
  // requirement verification" for a run whose test step crashed and whose verify step never ran.
  const outcome = input.unfinished.length > 0
    ? `\n\nIMPORTANT: this task's work is NOT complete — ${input.unfinished.length} sub-task(s) did not finish`
      + ` (${input.unfinished.join(', ')}). Write what was decided, planned or learned. Do NOT state that`
      + ` anything was implemented, tested or verified unless a summary below says it was DONE.`
    : ''
  return `A task titled "${input.taskTitle}" just finished. Distil its step outcomes into ONE durable,`
    + ` reusable project-knowledge note a future agent would want to find. Capture the decision or`
    + ` finding, not the narration; be concise and factual; invent nothing beyond the outcomes below.`
    + ` A summary describing intended work is a PLAN, not a result — never restate it as completed.`
    + outcome
    + `\n\ntitle: a short noun phrase naming the finding.`
    + `\nsummary: 1-2 sentences, the retrieval surface.`
    + `\nbody: the key points as terse bullets.`
    + `\n\nStep outcomes:\n${steps}`
}

// Build the configured consolidation distiller, or undefined for extractive (no ref / unresolvable
// provider / non-language model). The runtime and the manual command share this, so distillation is
// on-or-off by one setting and both paths behave identically.
export function buildDistiller(
  providers: Map<string, ModelProvider<unknown>>,
  modelRef: string,
): ConsolidationDistiller | undefined {
  const ref = modelRef.trim()
  if (!ref) return undefined
  const { providerId, modelId } = parseModelRef(ref)
  const model: unknown = providers.get(providerId)?.languageModel(modelId)
  if (!isLanguageModel(model)) {
    console.warn(`consolidation model '${ref}': not a resolvable language model — staying extractive`)
    return undefined
  }
  // AbortSignal.timeout bounds a hung/slow model so it can't wedge shutdown (the lifecycle awaits
  // the in-flight consolidation on close); a timeout rejects → consolidateTask's catch → extractive.
  return async input => (await generateObject({
    model, schema: DistilledSchema, prompt: distillPrompt(input), abortSignal: AbortSignal.timeout(30_000),
  })).object
}
