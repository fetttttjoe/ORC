// One spelling of each plan-field rule, shared by the authoring write and the freeze.

// Control characters, rendered so a message can NAME the bad entry without the entry breaking the
// message it appears in: `a/**\nb.ts` has to read as backslash-n, or the report reproduces the very
// defect it is describing. C0 (0x00-0x1F) and DEL (0x7F) are the rejected set — the FULL range, not
// just the four escapes anyone thinks of. Nothing in glob syntax is a control character (`*`, `?`,
// `[]`, `{}`, `!`, `/` and ordinary path characters are all printable), so a wider net costs no
// legitimate zone and catches the shell-mangled variants (\v, \f, ESC from a pasted terminal line)
// that the named four would wave through.
const NAMED_ESCAPE: Record<string, string> = {
  '\0': '\\0', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\v': '\\v', '\f': '\\f', '\r': '\\r',
}
const isControlChar = (c: string): boolean => {
  const code = c.charCodeAt(0)
  return code <= 0x1f || code === 0x7f
}
const renderEntry = (entry: string): string =>
  `"${[...entry].map(c => NAMED_ESCAPE[c]
    ?? (isControlChar(c) ? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}` : c)).join('')}"`

// Whether each `zone` entry is ONE glob.
//
// A planner authored a zone whose single entry was several globs joined with newlines — one string
// holding `a/**`, a line break, then `b.ts`. Nothing objected: the schema takes any non-empty
// string, and the freeze only checked entries against each OTHER (overlap between concurrent steps),
// never whether an entry could match anything at all. So the fence was frozen into the steps, and a
// glob containing a line break matches no real path: two steps were refused every write to their own
// files, could not fix the fence that was refusing them, and had no repair path. The slice's whole
// pipeline was cancelled. The same hole swallows a whitespace-only entry, which fences a step out of
// every file just as completely while looking like a declaration.
//
// Pure and IO-free, and `shape` in the table below: a fence that can match no
// path is refused at both boundaries, so a broken one never reaches a frozen step in the first
// place — the incident above needed no repair path, it needed the write refused. Returns the FIRST
// offending entry's message
// only: the author fixes one entry, rewrites, and hears about the next — a list of five would be
// read as one wall of text and repaired no faster.
export function zoneEntryMisuse(zone: readonly string[]): string | null {
  for (const entry of zone) {
    const control = [...entry].find(isControlChar)
    if (control !== undefined)
      return `zone entry ${renderEntry(entry)} contains a control character (${NAMED_ESCAPE[control] ?? `\\x${control.charCodeAt(0).toString(16).padStart(2, '0')}`}), so it can match no real path and would fence the step out of every file it must write — a zone is one glob per array entry: split it, e.g. zone: ["a/**", "b.ts"], never one string holding several globs.`
    if (entry.trim() === '')
      return `zone entry ${renderEntry(entry)} is empty or whitespace-only, so it can match no real path and would fence the step out of every file it must write — a zone is one glob per array entry: drop it, or write the glob you meant.`
  }
  return null
}

export interface PlanFieldInput {
  id: string
  zone: readonly string[]
}

// shape refuses at both boundaries; judgment warns and stores (no row is one yet).
export const RULE_SEVERITY = { shape: 'shape', judgment: 'judgment' } as const
export type RuleSeverity = (typeof RULE_SEVERITY)[keyof typeof RULE_SEVERITY]

export interface PlanFieldRule {
  id: string
  severity: RuleSeverity
  check(n: PlanFieldInput): string | null
}

// One row per misuse: adding a rule is adding a row, never touching a caller.
export const PLAN_FIELD_RULES: readonly PlanFieldRule[] = [
  {
    id: 'zone-entry-wellformed',
    severity: RULE_SEVERITY.shape,
    check: n => zoneEntryMisuse(n.zone),
  },
]

export function planFieldViolations(n: PlanFieldInput): { shape: string[]; judgment: string[] } {
  const out = { shape: [] as string[], judgment: [] as string[] }
  for (const r of PLAN_FIELD_RULES) {
    const msg = r.check(n)
    if (msg !== null) out[r.severity].push(msg)
  }
  return out
}
