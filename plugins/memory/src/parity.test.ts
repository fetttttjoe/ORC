import { afterAll, describe, expect, it } from 'bun:test'
import { EVENT_KIND, MemoryScope, foldMemory, noteContentKey, noteKey, type VerifiedStamp } from '@orc/contracts'
import { createLiveMemory, type LiveMemory } from './test-helpers'
import { TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'

/**
 * The log has TWO independent interpreters — `foldMemoryInto` (contracts) and `applyEvent` (the
 * Surreal projector) — and each decodes the same four event kinds separately. They diverged once
 * already: the fold dropped `memory_verified` entirely, discarding 14 verification events, so
 * `orc memory recheck` reported 30 drifted where health reported 29 on the same corpus at the same
 * instant. This pins the class, not that instance.
 *
 * The comparison is DERIVED, never hand-listed: `noteContentKey` is built from the tier schemas'
 * own shapes, so a field added to a note is covered here the day it exists. `verified` and
 * `archived` are compared separately because the content key deliberately excludes them — one is a
 * provenance stamp, the other a lifecycle flag.
 */
const cleanup: LiveMemory[] = []
afterAll(async () => { for (const m of cleanup) await m.close() }, 30_000)

const author = { source: 'cli', workspaceId: TEST_WORKSPACE_ID } as const

describe('fold and read model agree on every knowledge event kind', () => {
  it('projects the same live notes, with the same content, verification and lifecycle', async () => {
    const m = await createLiveMemory()
    cleanup.push(m)

    // every KNOWLEDGE_KINDS member, plus an access (which must move neither side's note content)
    await m.store.write({ id: 'kept', title: 'Kept', summary: 's', body: 'b', paths: ['src/a.ts'], tags: ['x'] }, author)
    await m.store.write({ id: 'updated', title: 'Updated', summary: 'first', body: 'one' }, author)
    await m.store.write({ id: 'updated', summary: 'second', body: 'two' }, author)      // merge-on-omit
    await m.store.write({ id: 'retired', title: 'Retired', summary: 'r', body: 'r' }, author)
    await m.store.write({ id: 'removed', title: 'Removed', summary: 'x', body: 'x' }, author)
    // appended directly: store.verify refuses without a readable Git HEAD (a stamp nothing can be
    // diffed against is worse than none), and this test is about the EVENT, not that guard
    await m.log.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_verified,
      payload: { id: 'kept', scope: MemoryScope.project, stamp: { revision: 'c0ffee1', at: '2026-08-02T00:00:00.000Z', by: 'cli' }, author },
    })
    await m.store.setArchived('retired', MemoryScope.project, true, author)
    await m.store.remove('removed', MemoryScope.project, author)
    await m.log.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_accessed,
      payload: { id: 'kept', scope: MemoryScope.project, mode: 'read', author },
    })
    await m.projector.catchUp()

    // the FOLD's view of what is live
    const fold = foldMemory(await m.log.all())
    const folded = new Map(
      [...fold.notes.values()]
        .filter(({ note }) => note.archived !== true)
        .map(({ note }) => [noteKey(note.scope, note.id), note]),
    )

    // a deleted note leaves the fold entirely; an archived one stays in it but is not live
    expect([...folded.keys()].sort()).toEqual([
      noteKey(MemoryScope.project, 'kept'),
      noteKey(MemoryScope.project, 'updated'),
    ])

    for (const [key, foldNote] of folded) {
      const projected = await m.store.get(foldNote.id, foldNote.scope)
      expect(projected, `${key} is live in the fold but absent from the read model`).not.toBeNull()
      // content: derived from the tier schemas, so a new field is covered the day it is added
      expect(noteContentKey(projected), `${key} content`).toBe(noteContentKey(foldNote))
      // the two the content key deliberately excludes
      const w: { verified?: VerifiedStamp } = foldNote
      expect(projected?.verified, `${key} verification`).toEqual(w.verified)
    }

    // and the read model agrees about what is NOT live
    expect(await m.store.get('retired', MemoryScope.project)).toBeNull()
    expect(await m.store.get('removed', MemoryScope.project)).toBeNull()
  }, 60_000)
})
