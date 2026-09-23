// The ADR body layout — the ONE spelling of the headings the CLI, the MCP tool and the vault agree
// on. Zero imports on purpose (cluster.ts is the model): no store, no schema, no clock, so a
// heading change is one edit here and a round-trip test, not a grep across three doors.
export enum AdrSection {
  context = 'Context',
  decision = 'Decision',
  consequences = 'Consequences',
  considered = 'Considered',
}
export interface AdrFields { context: string; decision: string; consequences: string; considered: string[] }

const ORDER = [AdrSection.context, AdrSection.decision, AdrSection.consequences] as const
const H2 = '## '
const BULLET = '- '
const INDENT = '  '
const heading = (name: string): string => `${H2}${name}`

const renderConsidered = (options: readonly string[]): string =>
  options.map(o => o.split('\n').map((line, i) => (i === 0 ? `${BULLET}${line}` : `${INDENT}${line}`)).join('\n')).join('\n')

const parseConsidered = (text: string): string[] => {
  const options: string[][] = []
  for (const line of text.split('\n')) {
    const open = options[options.length - 1]
    if (line.startsWith(BULLET) || open === undefined) options.push([line.slice(BULLET.length)])
    else open.push(line.startsWith(INDENT) ? line.slice(INDENT.length) : line)
  }
  return options.map(o => o.join('\n').trim())
}

// Throws rather than rendering a body parseAdrBody cannot read back: a section carrying its own H2
// would split into an extra block and the round trip would silently lose text.
export function renderAdrBody(fields: AdrFields): string {
  const parts: [string, string][] = [
    [AdrSection.context, fields.context],
    [AdrSection.decision, fields.decision],
    [AdrSection.consequences, fields.consequences],
  ]
  if (fields.considered.length > 0) parts.push([AdrSection.considered, renderConsidered(fields.considered)])
  for (const [name, text] of parts)
    if (text.split('\n').some(l => l.startsWith(H2)))
      throw new Error(`the ${name} section contains a line starting with '${H2}' — that is an ADR heading and cannot round-trip`)
  return parts.map(([name, text]) => `${heading(name)}\n\n${text.trim()}\n`).join('\n')
}

// Exactly the three headings, in order, optionally followed by Considered, nothing before the first
// — anything else is "not an ADR" (null), which a reader renders as the raw body rather than as
// sections it did not author.
export function parseAdrBody(body: string): AdrFields | null {
  const lines = body.split('\n')
  const marks = lines.map((l, i) => (l.startsWith(H2) ? i : -1)).filter(i => i >= 0)
  const withConsidered = marks.length === ORDER.length + 1
  if (marks.length !== ORDER.length && !withConsidered) return null
  if (lines.slice(0, marks[0]).some(l => l.trim() !== '')) return null
  const expected: string[] = withConsidered ? [...ORDER, AdrSection.considered] : [...ORDER]
  const names = marks.map(i => lines[i]?.slice(H2.length).trim())
  if (names.some((n, k) => n !== expected[k])) return null
  const section = (k: number): string => lines.slice((marks[k] ?? 0) + 1, marks[k + 1] ?? lines.length).join('\n').trim()
  return {
    context: section(0), decision: section(1), consequences: section(2),
    considered: withConsidered ? parseConsidered(section(3)) : [],
  }
}

// The one-line pointer a listing shows: the decision's first sentence, clipped to the caller's cap
// (MEMORY_LIMITS.summaryChars at the call site — this module imports nothing).
export function adrSummary(decision: string, maxChars: number): string {
  const first = decision.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
  return first.length <= maxChars ? first : `${first.slice(0, Math.max(0, maxChars - 1))}…`
}
