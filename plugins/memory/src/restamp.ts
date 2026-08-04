// The FREE half of the heal loop, as one callable: restamp every note whose declared paths are
// fully committed up to HEAD. One spelling shared by `orc memory restamp` (the manual-commit
// fallback) and the auto-heal reactor (the commit_recorded reaction) — proven live 2026-08-03:
// after a commit whose heals preceded it, this pass alone took drift 16→0 with zero LLM calls.
import { NOTE_TIER, type MemoryStore } from '@orc/contracts'
import { restampableNotes } from './drift'

export async function restampToHead(store: MemoryStore, dir: string): Promise<{ id: string; scope: string }[]> {
  // NoteSummary already carries {id, scope, sourceRevision, paths} — exactly restampableNotes' shape
  const targets = await restampableNotes(await store.list({ tier: NOTE_TIER.semantic }), dir)
  // a plain re-write re-stamps the note at current HEAD (store.ts: sourceRevision resolved per write)
  for (const t of targets) await store.write({ id: t.id, scope: t.scope }, { source: 'cli' })
  return targets
}
