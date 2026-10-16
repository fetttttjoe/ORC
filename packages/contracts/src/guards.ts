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

// One issue, as the field a caller has to fix: PATH: MESSAGE, `(root)` when the path is empty (a
// whole-value miss, e.g. a number where an object belongs, not a named field). Independently
// re-spelled at three call sites across ui-core and the web/e2e layers — only two of the three
// agreed on the `(root)` fallback — before this existed.
export const issueLine = (issue: { path: PropertyKey[]; message: string }): string =>
  `${issue.path.join('.') || '(root)'}: ${issue.message}`

// The one tool-result error envelope. `output` is `unknown` in the tool contract, so the inner
// `error` key is protocol only by convention — the LLM reading the result greps for it, and it
// was hand-spelled at 12 catch sites across 6 workspaces where a drifted key would fail silently.
export const toolError = (err: unknown): { output: { error: string }; isError: true } =>
  ({ output: { error: errorMessage(err) }, isError: true })

export const NO_INPUT_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} }

// a tool's input schema as the model reads it: the zod schema's input side, without `$schema`
export const toolSchemaOf = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _dropped, ...json } = z.toJSONSchema(schema, { io: 'input' })
  return json
}

// Trimmed, non-blank lines out of a git/CLI stdout blob — the one splitter every process-output
// reader needs, re-spelled five times (commit-tool, drift, grounding-source) before this existed.
export const nonEmptyLines = (text: string): string[] =>
  text.split('\n').map(l => l.trim()).filter(l => l !== '')

// mermaid labels: double quotes end the label, a newline ends the STATEMENT — an agent-authored
// title carrying one escapes the graph and renders as live markdown in human-facing views.
// The ONE escaper for every mermaid-producing view (vault, ui-core diagrams, memory index).
export const mermaidLabel = (s: string): string => s.replaceAll('"', "'").replaceAll(/[\r\n]+/g, ' ')
