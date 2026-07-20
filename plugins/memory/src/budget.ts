import type { MemoryNote } from '@orc/contracts'

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
const variableChars = (note: MemoryNote): number =>
  note.summary.length + note.body.length + note.rationale.length
  + [...note.categories, ...note.tags, ...note.paths, ...note.rules, ...note.uncertainty]
    .reduce((sum, value) => sum + value.length, 0)
  + note.links.reduce((sum, link) => sum + JSON.stringify(link).length, 0)

export function fitMemoryNoteToBudget(note: MemoryNote, budget: number):
  { note: MemoryNote; truncated: boolean; next?: string } {
  const contentLimit = budget * 4
  const responseLimit = Math.max(1_024, contentLimit)
  const full = { note, truncated: false }
  if (variableChars(note) <= contentLimit && JSON.stringify(full).length <= responseLimit) return full

  const fitted: MemoryNote = {
    ...note,
    id: note.id.slice(0, 128),
    scope: note.scope.slice(0, 128),
    title: note.title.slice(0, 200),
    sourceRevision: note.sourceRevision?.slice(0, 128) ?? null,
    createdAt: note.createdAt.slice(0, 128),
    createdBy: note.createdBy.slice(0, 200),
    updatedAt: note.updatedAt.slice(0, 128),
    updatedBy: note.updatedBy.slice(0, 200),
    summary: '', categories: [], tags: [], links: [], paths: [], rules: [],
    uncertainty: [], rationale: '', body: '',
  }
  const result = { note: fitted, truncated: true, next: READ_NEXT }
  let contentUsed = 0
  const fits = () => JSON.stringify(result).length <= responseLimit
  // id and scope are NOT on this ladder: they are bounded at 128 chars each and are the only
  // fields that make the response actionable. Discarding them emits `next: memory_read with a
  // larger budget` alongside no id to read — a hint the agent cannot follow — and yields an
  // object that no longer satisfies MemoryNote (id regex, title.min(1)).
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
  const addString = (key: 'summary' | 'rationale' | 'body', value: string): void => {
    let low = 0
    let high = Math.min(value.length, contentLimit - contentUsed)
    while (low < high) {
      const length = Math.ceil((low + high) / 2)
      fitted[key] = value.slice(0, length)
      if (fits()) low = length
      else high = length - 1
    }
    fitted[key] = value.slice(0, low)
    contentUsed += low
  }

  addString('summary', note.summary)
  for (const key of ['categories', 'tags', 'links', 'paths', 'rules', 'uncertainty'] as const) {
    for (const value of note[key]) {
      const cost = typeof value === 'string' ? value.length : JSON.stringify(value).length
      if (contentUsed + cost > contentLimit) break
      ;(fitted[key] as unknown[]).push(value)
      if (!fits()) { (fitted[key] as unknown[]).pop(); break }
      contentUsed += cost
    }
  }
  addString('rationale', note.rationale)
  addString('body', note.body)
  return result
}
