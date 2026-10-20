import type { LanguageModel } from 'ai'

// providers are ModelProvider<unknown>: narrow by a runtime shape check, never a cast
export const isLanguageModel = (m: unknown): m is LanguageModel =>
  typeof m === 'string' || (typeof m === 'object' && m !== null && 'specificationVersion' in m)
