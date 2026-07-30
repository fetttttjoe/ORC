import { LINK_KIND } from './memory'

// ONE spelling of each plan-note misuse rule, for the two moments that enforce it: memory_write
// warns the instant the note is authored, and the freeze refuses the plan at the approval gate.
// A validation rule spelled twice drifts worse than a literal does — the two would disagree about
// what is wrong while both claim to describe it. Two rules live here now, same shape both times:
// ordering written as a link (siblingOrderingMisuse) and a zone entry that is not one glob
// (zoneEntryMisuse).
//
// THE RULE: ordering is the `dependsOn` FIELD. A `depends_on` LINK is knowledge ("this subplan
// builds on that finding") and never schedules — a link is a durable statement about how facts
// relate, and ordering stops meaning anything the moment the plan is frozen into steps.
//
// Observed TWICE, in two independent runs of the same task on the same model: the plan-authoring
// agent gave its 'verify' subplan a depends_on LINK to a sibling ('synthesize-map' in one run,
// 'generate-doc' in the other) where scheduling reads the field. Both writes succeeded and the
// mistake only surfaced at finalize_plan, costing a rejection, a re-read and a rewrite each —
// iterations charged against maxIterations in a grounded run. Not model noise: same mistake, two
// different sibling names, so the authoring path leads there.
//
// Pure and IO-free. The CALLER decides who the siblings are — the freeze reads the masterplan's
// decomposes_into children, memory_write resolves each link target inside the plan scope — and this
// decides whether the edge is the misuse and says so in wording neither side restates.
// Returns null when the note is fine, so the caller picks the severity: a warning where the write is
// still worth keeping, a throw where the plan is about to be frozen wrong.
export function siblingOrderingMisuse(
  noteId: string,
  links: ReadonlyArray<{ id: string; kind: string }>,
  siblings: readonly string[],
): string | null {
  for (const l of links)
    if (l.kind === LINK_KIND.depends_on && siblings.includes(l.id))
      return `plan-note '${noteId}' links depends_on '${l.id}', which is a sibling — ordering is the \`dependsOn\` FIELD, not a link. Write dependsOn: ["${l.id}"] on '${noteId}' and remove the link (a depends_on link means knowledge, and never affects scheduling).`
  return null
}

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

// THE OTHER RULE this file owns, at the same two moments: whether each `zone` entry is ONE glob.
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
// Pure and IO-free, like the rule above, and the CALLER picks the severity: memory_write warns while
// still storing the note (a plan note is a long step's entire output), the plan freeze refuses —
// authorable, warned at write, refused at the gate. Returns the FIRST offending entry's message
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
