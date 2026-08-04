import { MemoryNote, type NoteView } from '@orc/contracts'

export const approxTokens = (s: string): number => Math.ceil(s.length / 4) // ponytail: chars/4; swap for a real tokenizer only if it misbudgets

// `used` is what the kept items cost, returned so a caller splitting one budget across two arms
// (search's claims-then-notes, the preload's same split) subtracts the number this loop counted
// rather than re-deriving it — two spellings of the sum drift.
export function applyBudget<T>(items: T[], text: (t: T) => string, opts: { limit: number; budget: number }):
  { items: T[]; used: number; truncated: boolean; omitted: number } {
  const kept: T[] = []
  let used = 0
  for (const it of items) {
    if (kept.length >= opts.limit) break
    const cost = approxTokens(text(it))
    if (kept.length > 0 && used + cost > opts.budget) break // always allow at least one
    used += cost
    kept.push(it)
  }
  return { items: kept, used, truncated: kept.length < items.length, omitted: items.length - kept.length }
}

const READ_NEXT = 'memory_read with a larger budget for the full note'
// Makes a bisected cut visible INSIDE the field, so a reader of a trimmed body can tell prose
// was dropped mid-note rather than mistaking the cut for the note's actual ending.
export const TRIM_MARKER = '… [trimmed]'

// The fitted view of a note, plus whether anything was dropped. `next` tells the reader how to get
// the rest. NoteView, not MemoryNote: trimming can empty fields a valid note requires.
export interface FittedNote { note: NoteView; truncated: boolean; next?: string }

const itemChars = (value: unknown): number =>
  typeof value === 'string' ? value.length : JSON.stringify(value).length

// Every key of a note, grouped by HOW this fitter bounds it. A field added to a tier but forgotten
// here is a compile error rather than a response that quietly blows its budget — the same guard
// MemoryNoteDraftInput's `DraftCoversTiers` applies to the write surface, applied to the thing that
// actually enforces the read cap. Every leak this file has had (a retired `rules[]`, the plan
// tier's skillRefs/toolRefs/modelRef, then its dependsOn) was a field the blank-and-refill ladder
// below skipped. The guard only proves each field is ENUMERATED here — dependsOn was listed and
// still leaked, because nothing had blanked or refilled it — so each group member also needs a
// blank + refill pair, and a test that feeds it oversized.
type BoundedField =
  | 'id' | 'scope' | 'title' | 'sourceRevision'                        // clamped building `fitted`
  | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy' | 'verified' // dropped by the discard ladder
  | 'tier' | 'kind' | 'retention' | 'revision' | 'archived'            // fixed width, nothing to trim
  | 'summary' | 'rationale' | 'body'                                   // bisected, cut marked
  | 'modelRef'                                                         // kept whole or not at all
  | 'categories' | 'tags' | 'links' | 'paths' | 'claims'               // refilled item by item
  | 'uncertainty' | 'zone' | 'sources' | 'skillRefs' | 'toolRefs' | 'dependsOn'
type FitterCoversNote = Exclude<keyof NoteView, BoundedField> extends never ? true : never
const fitterCoversNote: FitterCoversNote = true
void fitterCoversNote

// The variable-cost fields of every tier. A field the note's tier does not have reads as
// undefined and costs nothing, so one expression covers all three lanes.
function variableChars(note: MemoryNote): number {
  const n: NoteView = note
  const text = [n.summary, n.rationale, n.body, n.modelRef].reduce((sum, s) => sum + (s ?? '').length, 0)
  const lists: Array<ReadonlyArray<unknown> | undefined> =
    [n.categories, n.tags, n.links, n.paths, n.claims, n.uncertainty, n.zone, n.sources, n.skillRefs, n.toolRefs, n.dependsOn]
  return text + lists.reduce(
    (sum, values) => sum + (values ?? []).reduce<number>((inner, value) => inner + itemChars(value), 0), 0)
}

export function fitMemoryNoteToBudget(stored: MemoryNote, budget: number): FittedNote {
  // Re-parse before anything is measured or spread. The tier schema is the authority on which keys
  // a note HAS, so this is what strips what history left behind — and `{...note}` below would
  // otherwise carry an older schema's key through untouched: the fitter blanks only the fields it
  // knows, so a retired unbounded array (`rules[]`, once) rode every discard out into the very
  // response this exists to bound.
  const note = MemoryNote.safeParse(stored).data ?? stored
  const contentLimit = budget * 4
  const responseLimit = Math.max(1_024, contentLimit)
  const full = { note, truncated: false }
  if (variableChars(note) <= contentLimit && JSON.stringify(full).length <= responseLimit) return full

  const source: NoteView = note
  const fitted: NoteView = {
    ...note,
    id: note.id.slice(0, 128),
    scope: note.scope.slice(0, 128),
    title: note.title.slice(0, 200),
    sourceRevision: note.sourceRevision?.slice(0, 128) ?? null,
    createdAt: note.createdAt.slice(0, 128),
    createdBy: note.createdBy.slice(0, 200),
    updatedAt: note.updatedAt.slice(0, 128),
    updatedBy: note.updatedBy.slice(0, 200),
    // clamped like the identity fields it sits beside — `by` is a composed author string and
    // `revision` a git rev, both agent-adjacent input, so neither is trusted to be short
    ...(note.verified && { verified: {
      revision: note.verified.revision.slice(0, 128),
      at: note.verified.at.slice(0, 128),
      by: note.verified.by.slice(0, 200),
    } }),
  }
  // Every variable field starts empty and is refilled in priority order, so the fields that matter
  // most get the budget. Only fields the tier actually has are touched — an `undefined` source
  // field stays absent rather than appearing as a hollow key the tier does not own.
  const blankText = (key: 'summary' | 'rationale' | 'body' | 'modelRef'): void => {
    if (source[key] !== undefined) fitted[key] = ''
  }
  blankText('summary'); blankText('rationale'); blankText('body'); blankText('modelRef')
  if (source.categories) fitted.categories = []
  if (source.tags) fitted.tags = []
  if (source.links) fitted.links = []
  if (source.paths) fitted.paths = []
  if (source.claims) fitted.claims = []
  if (source.uncertainty) fitted.uncertainty = []
  if (source.zone) fitted.zone = []
  if (source.sources) fitted.sources = []
  if (source.skillRefs) fitted.skillRefs = []
  if (source.toolRefs) fitted.toolRefs = []
  if (source.dependsOn) fitted.dependsOn = []
  const result = { note: fitted, truncated: true, next: READ_NEXT }
  let contentUsed = 0
  const fits = () => JSON.stringify(result).length <= responseLimit
  // id and scope are NOT on this ladder: they are bounded at 128 chars each and are the only
  // fields that make the response actionable. Discarding them emits `next: memory_read with a
  // larger budget` alongside no id to read — a hint the agent cannot follow.
  for (const discard of [
    // First off the ladder: it is provenance ABOUT the note, and a reader who blew the budget needs
    // the note's words before it needs to know who last checked them. `delete`, not `= undefined`:
    // a hollow `verified: undefined` would serialize away anyway but reads as a field the note has.
    () => { delete fitted.verified },
    () => { fitted.updatedBy = '' },
    () => { fitted.createdBy = '' },
    () => { fitted.sourceRevision = null },
    () => { fitted.updatedAt = '' },
    () => { fitted.createdAt = '' },
    () => { fitted.title = '' },
  ]) {
    if (fits()) break
    discard()
  }
  const addString = (key: 'summary' | 'rationale' | 'body', value: string | undefined): void => {
    if (value === undefined) return
    let low = 0
    let high = Math.min(value.length, contentLimit - contentUsed)
    while (low < high) {
      const length = Math.ceil((low + high) / 2)
      fitted[key] = value.slice(0, length)
      if (fits()) low = length
      else high = length - 1
    }
    if (low >= value.length) { // whole field fit — byte-identical, no marker
      fitted[key] = value.slice(0, low)
      contentUsed += low
      return
    }
    // a cut happened: reserve room for TRIM_MARKER against both the per-field content limit
    // and the whole-response byte limit, shrinking `low` until both hold with the marker on.
    while (low > 0 && low + TRIM_MARKER.length > contentLimit - contentUsed) low--
    while (low > 0) {
      fitted[key] = value.slice(0, low).trimEnd() + TRIM_MARKER
      if (fits()) break
      low--
    }
    if (low > 0) {
      // whitespace backoff, bounded to the trailing 30 chars of the kept slice — code/URL
      // blobs with no nearby whitespace keep the mid-word cut instead of collapsing.
      const windowStart = Math.max(0, low - 30)
      const wsInWindow = value.slice(windowStart, low).search(/\s\S*$/)
      if (wsInWindow !== -1) low = windowStart + wsInWindow
    }
    fitted[key] = low > 0 ? value.slice(0, low).trimEnd() + TRIM_MARKER : ''
    contentUsed += low > 0 ? low + TRIM_MARKER.length : 0
  }

  // Generic over the ELEMENT type so each list keeps its own: the setter closes over one concrete
  // field, which is what makes this type-safe without a cast on a union-keyed index.
  const addList = <T>(values: T[] | undefined, set: (kept: T[]) => void): void => {
    if (values === undefined) return
    const kept: T[] = []
    for (const value of values) {
      const cost = itemChars(value)
      if (contentUsed + cost > contentLimit) break
      kept.push(value)
      set(kept)
      if (!fits()) { kept.pop(); set(kept); break }
      contentUsed += cost
    }
  }

  // A scalar that must not be half-kept: 'provider/model' cut in two is a wrong value, not a short
  // one, and TRIM_MARKER inside it would be worse. Whole or absent — it is 64 chars either way.
  const addWhole = (value: string | undefined, set: (v: string) => void): void => {
    if (value === undefined || contentUsed + value.length > contentLimit) return
    set(value)
    if (!fits()) { set(''); return }
    contentUsed += value.length
  }

  // summary first — it is the retrieval surface — then the labels, then the long prose
  addString('summary', source.summary)
  addList(source.categories, kept => { fitted.categories = kept })
  addList(source.tags, kept => { fitted.tags = kept })
  addList(source.links, kept => { fitted.links = kept })
  addList(source.paths, kept => { fitted.paths = kept })
  addList(source.claims, kept => { fitted.claims = kept })
  addList(source.uncertainty, kept => { fitted.uncertainty = kept })
  addList(source.zone, kept => { fitted.zone = kept })
  addList(source.sources, kept => { fitted.sources = kept })
  // execution plumbing last of the lists: a budgeted READ is for a human or a recall step, and
  // neither dispatches from it — the step that runs this subplan reads the note in full.
  addList(source.skillRefs, kept => { fitted.skillRefs = kept })
  addList(source.toolRefs, kept => { fitted.toolRefs = kept })
  addList(source.dependsOn, kept => { fitted.dependsOn = kept })
  addWhole(source.modelRef, v => { fitted.modelRef = v })
  addString('rationale', source.rationale)
  addString('body', source.body)
  return result
}
