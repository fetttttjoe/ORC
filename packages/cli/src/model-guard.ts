import type { LanguageModel } from 'ai'

// Providers are ModelProvider<unknown> by design (extensions may register anything) — narrow one to a
// usable LanguageModel at the boundary with a runtime shape check, never a cast. The ONE place this
// guard lives; both the copilot config (main.ts) and the consolidation distiller consume it.
export const isLanguageModel = (m: unknown): m is LanguageModel =>
  typeof m === 'string' || (typeof m === 'object' && m !== null && 'specificationVersion' in m)
