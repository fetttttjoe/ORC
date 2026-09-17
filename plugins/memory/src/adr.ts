// The ADR body layout — the ONE spelling of the three headings the CLI, the MCP tool and the vault
// agree on. Zero imports on purpose (cluster.ts is the model): no store, no schema, no clock, so a
// heading change is one edit here and a round-trip test, not a grep across three doors.
export const ADR_SECTION = { context: 'Context', decision: 'Decision', consequences: 'Consequences' } as const
export interface AdrFields { context: string; decision: string; consequences: string }

const ORDER = [ADR_SECTION.context, ADR_SECTION.decision, ADR_SECTION.consequences] as const
const H2 = '## '
const heading = (name: string): string => `${H2}${name}`

// Throws rather than rendering a body parseAdrBody cannot read back: a section carrying its own H2
// would split into four blocks and the round trip would silently lose text.
export function renderAdrBody(fields: AdrFields): string {
  const parts: [string, string][] = [[ADR_SECTION.context, fields.context], [ADR_SECTION.decision, fields.decision], [ADR_SECTION.consequences, fields.consequences]]
  for (const [name, text] of parts)
    if (text.split('\n').some(l => l.startsWith(H2)))
      throw new Error(`the ${name} section contains a line starting with '${H2}' — that is an ADR heading and cannot round-trip`)
  return parts.map(([name, text]) => `${heading(name)}\n\n${text.trim()}\n`).join('\n')
}

// Exactly the three headings, in order, nothing before the first — anything else is "not an ADR"
// (null), which a reader renders as the raw body rather than as three sections it did not author.
export function parseAdrBody(body: string): AdrFields | null {
  const lines = body.split('\n')
  const marks = lines.map((l, i) => (l.startsWith(H2) ? i : -1)).filter(i => i >= 0)
  if (marks.length !== ORDER.length) return null
  if (lines.slice(0, marks[0]).some(l => l.trim() !== '')) return null
  const names = marks.map(i => lines[i]?.slice(H2.length).trim())
  if (names.some((n, k) => n !== ORDER[k])) return null
  const section = (k: number): string => lines.slice((marks[k] ?? 0) + 1, marks[k + 1] ?? lines.length).join('\n').trim()
  return { context: section(0), decision: section(1), consequences: section(2) }
}

// The one-line pointer a listing shows: the decision's first sentence, clipped to the caller's cap
// (MEMORY_LIMITS.summaryChars at the call site — this module imports nothing).
export function adrSummary(decision: string, maxChars: number): string {
  const first = decision.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
  return first.length <= maxChars ? first : `${first.slice(0, Math.max(0, maxChars - 1))}…`
}
