import type { z } from 'zod'

/**
 * Parse with a schema and REPORT what failed.
 *
 * A `safeParse` whose failure branch renders a fallback is a silent bug: the pane shows something
 * plausible ("unrecognised shape", an empty list) while the real cause — one renamed or nullable
 * field — stays invisible. Measured repeatedly on this app. Every fallback path goes through here
 * so the console names the schema and the exact field path that did not match.
 *
 * Returns null on failure; callers still render their fallback, but never silently.
 */
export function parseOrReport<T>(schema: z.ZodType<T>, value: unknown, what: string): T | null {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const where = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
  console.warn(`[shape] ${what} did not match its schema — ${where}`, value)
  return null
}
