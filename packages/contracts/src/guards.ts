import { z } from 'zod'

// runtime-checked narrowing for values from external boundaries (JSON, YAML, wire input)
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// prettifies ZodError, whose .message is a raw issue-JSON dump
export const errorMessage = (err: unknown): string =>
  err instanceof z.ZodError ? z.prettifyError(err)
  : err instanceof Error ? err.message
  : String(err)

// PATH: MESSAGE, (root) when the path is empty (a whole-value miss)
export const issueLine = (issue: { path: PropertyKey[]; message: string }): string =>
  `${issue.path.join('.') || '(root)'}: ${issue.message}`

// the one tool-result error envelope; the LLM greps the inner error key by convention
export const toolError = (err: unknown): { output: { error: string }; isError: true } =>
  ({ output: { error: errorMessage(err) }, isError: true })

export const NO_INPUT_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} }

// a tool's input schema as the model reads it: the zod schema's input side, without `$schema`
export const toolSchemaOf = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _dropped, ...json } = z.toJSONSchema(schema, { io: 'input' })
  return json
}

// trimmed non-blank lines of git/CLI stdout
export const nonEmptyLines = (text: string): string[] =>
  text.split('\n').map(l => l.trim()).filter(l => l !== '')

// double quotes end a label, a newline ends the statement: one escaper for every mermaid view
export const mermaidLabel = (s: string): string => s.replaceAll('"', "'").replaceAll(/[\r\n]+/g, ' ')
