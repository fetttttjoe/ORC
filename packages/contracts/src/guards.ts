import { z } from 'zod'

// runtime-checked narrowing for values from external boundaries (JSON, YAML, wire input)
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// the one error→string shape — every catch block used to hand-roll this ternary (50 copies).
// ZodError's own .message is the raw issue-JSON dump; prettify it here so every tool-result
// boundary hands the model (and the human reading the transcript) "✖ expected array → at paths"
// instead of a page of JSON it has to re-parse.
export const errorMessage = (err: unknown): string =>
  err instanceof z.ZodError ? z.prettifyError(err)
  : err instanceof Error ? err.message
  : String(err)

// mermaid labels: double quotes end the label, a newline ends the STATEMENT — an agent-authored
// title carrying one escapes the graph and renders as live markdown in human-facing views.
// The ONE escaper for every mermaid-producing view (vault, ui-core diagrams, memory index).
export const mermaidLabel = (s: string): string => s.replaceAll('"', "'").replaceAll(/[\r\n]+/g, ' ')
