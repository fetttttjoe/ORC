import type { MemoryNote, NoteView } from '@orc/contracts'

export const approxTokens = (s: string): number => Math.ceil(s.length / 4) // ponytail: chars/4; swap for a real tokenizer only if it misbudgets

export function applyBudget<T>(items: T[], text: (t: T) => string, opts: { limit: number; budget: number }):
  { items: T[]; truncated: boolean; omitted: number } {
  const kept: T[] = []
  let used = 0
  for (const it of items) {
    if (kept.length >= opts.limit) break
    const cost = approxTokens(text(it))
    if (kept.length > 0 && used + cost > opts.budget) break // always allow at least one
    used += cost
    kept.push(it)
  }
  return { items: kept, truncated: kept.length < items.length, omitted: items.length - kept.length }
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

// The variable-cost fields of every tier. A field the note's tier does not have reads as
// undefined and costs nothing, so one expression covers all three lanes. `sources` and `zone`
// are counted here for the first time — before the tiers they escaped the cap entirely.
function variableChars(note: MemoryNote): number {
  const n: NoteView = note
  const text = [n.summary, n.rationale, n.body].reduce((sum, s) => sum + (s ?? '').length, 0)
  const lists: Array<ReadonlyArray<unknown> | undefined> =
    [n.categories, n.tags, n.links, n.paths, n.rules, n.uncertainty, n.zone, n.sources]
  return text + lists.reduce(
    (sum, values) => sum + (values ?? []).reduce<number>((inner, value) => inner + itemChars(value), 0), 0)
}

export function fitMemoryNoteToBudget(note: MemoryNote, budget: number): FittedNote {
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
  }
  // Every variable field starts empty and is refilled in priority order, so the fields that matter
  // most get the budget. Only fields the tier actually has are touched — an `undefined` source
  // field stays absent rather than appearing as a hollow key the tier does not own.
  const blankText = (key: 'summary' | 'rationale' | 'body'): void => {
    if (source[key] !== undefined) fitted[key] = ''
  }
  blankText('summary'); blankText('rationale'); blankText('body')
  if (source.categories) fitted.categories = []
  if (source.tags) fitted.tags = []
  if (source.links) fitted.links = []
  if (source.paths) fitted.paths = []
  if (source.rules) fitted.rules = []
  if (source.uncertainty) fitted.uncertainty = []
  if (source.zone) fitted.zone = []
  if (source.sources) fitted.sources = []
  const result = { note: fitted, truncated: true, next: READ_NEXT }
  let contentUsed = 0
  const fits = () => JSON.stringify(result).length <= responseLimit
  // id and scope are NOT on this ladder: they are bounded at 128 chars each and are the only
  // fields that make the response actionable. Discarding them emits `next: memory_read with a
  // larger budget` alongside no id to read — a hint the agent cannot follow.
  for (const discard of [
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

  // summary first — it is the retrieval surface — then the labels, then the long prose
  addString('summary', source.summary)
  addList(source.categories, kept => { fitted.categories = kept })
  addList(source.tags, kept => { fitted.tags = kept })
  addList(source.links, kept => { fitted.links = kept })
  addList(source.paths, kept => { fitted.paths = kept })
  addList(source.rules, kept => { fitted.rules = kept })
  addList(source.uncertainty, kept => { fitted.uncertainty = kept })
  addList(source.zone, kept => { fitted.zone = kept })
  addList(source.sources, kept => { fitted.sources = kept })
  addString('rationale', source.rationale)
  addString('body', source.body)
  return result
}
