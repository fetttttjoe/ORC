import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'
import { parseModelRef, type ModelProvider } from '@orc/contracts'
import type { ConsolidationDistiller, ConsolidationInput } from '@orc/memory'

// Providers are ModelProvider<unknown> by design (extensions may register anything) — narrow to a
// usable LanguageModel at the boundary with a runtime shape check (the same guard main.ts uses for
// the copilot), never a cast.
const isLanguageModel = (m: unknown): m is LanguageModel =>
  typeof m === 'string' || (typeof m === 'object' && m !== null && 'specificationVersion' in m)

// Bounded so a distilled note still fits the note limits (title 200, summary 500) and search stays
// legible; the model is told to be concise. Parsed by generateObject, so a malformed reply retries.
const DistilledSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(500),
  body: z.string().max(4000),
})

function distillPrompt(input: ConsolidationInput): string {
  const steps = input.steps.map(s => `- ${s.title}: ${s.summary}`).join('\n') || '(no step notes)'
  return `A task titled "${input.taskTitle}" just finished. Distil its step outcomes into ONE durable,`
    + ` reusable project-knowledge note a future agent would want to find. Capture the decision or`
    + ` finding, not the narration; be concise and factual; invent nothing beyond the outcomes below.`
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
  return async input => (await generateObject({ model, schema: DistilledSchema, prompt: distillPrompt(input) })).object
}
