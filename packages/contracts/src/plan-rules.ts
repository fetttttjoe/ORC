// One spelling of each plan-field rule, shared by the authoring write and the freeze.

// rejects all of C0 and DEL: the named four would wave through \v, \f and ESC
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

// one glob per entry, refused at both boundaries; reports only the first offender
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
