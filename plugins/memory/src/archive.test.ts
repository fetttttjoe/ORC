import { describe, expect, it } from 'bun:test'
import { ARCHIVE_REASON, KEPT_BECAUSE, archiveCandidates, rule, type NoteFacts } from './archive'
import { MemoryNoteInput } from '@orc/contracts'

const note = (over: Partial<NoteFacts> & { key: string }): NoteFacts => ({
  verdict: 'clean', subjectMissing: false, retiredBy: [], inboundFrom: [], taskSettled: false, ...over,
})

describe('rule — obsolescence is evidence, never age', () => {
  /**
   * The case the whole design turns on. A config note ("Postgres listens on :5433") is correct for
   * years, read rarely, and never changes. A day-bound TTL retires it BECAUSE it is stable. Here
   * an unchanged path is proof it is still true, so no amount of elapsed time can touch it — and
   * there is no clock in the module to elapse.
   */
  it('never retires a note whose paths have not moved, however old or cold', () => {
    expect(rule(note({ key: 'config', verdict: 'clean' }))).toEqual({ archive: false, kept: KEPT_BECAUSE.current })
  })

  it('fails safe when currency could not be determined', () => {
    expect(rule(note({ key: 'n', verdict: 'unknown' }))).toEqual({ archive: false, kept: KEPT_BECAUSE.unknown })
  })

  /**
   * Drift is the INPUT to self-healing, never grounds for retirement. The auditor's Heal rule reads
   * each drifted note against the tree and rewrites or confirms it — so a drifted note holds
   * recoverable knowledge about a subject that still exists. An earlier draft of this file archived
   * them, which would have made the corpus shed knowledge instead of correcting it.
   */
  it('NEVER retires a note merely because it drifted — that is the heal loop\'s work', () => {
    expect(rule(note({ key: 'n', verdict: 'drifted' }))).toEqual({ archive: false, kept: KEPT_BECAUSE.healable })
  })

  it('retires a note whose subject was deleted, even while its currency reads clean', () => {
    const r = rule(note({ key: 'n', verdict: 'clean', subjectMissing: true }))
    expect(r).toMatchObject({ archive: true, reason: ARCHIVE_REASON.subjectDeleted })
  })

  it('retires a note a live note explicitly superseded, and names which', () => {
    const r = rule(note({ key: 'old', retiredBy: ['new-note'] }))
    expect(r).toMatchObject({ archive: true, reason: ARCHIVE_REASON.superseded })
    expect(r).toHaveProperty('evidence', 'retired by new-note')
  })

  it('retires a task-bound note once its task has settled', () => {
    expect(rule(note({ key: 'n', taskSettled: true }))).toMatchObject({ archive: true, reason: ARCHIVE_REASON.taskSettled })
  })

  /**
   * Protection outranks even an explicit supersedes: dropping a linked-to note leaves the linker's
   * links[] pointing at a dead id, and repairing authored links is a stated non-goal.
   */
  it('keeps ANY note a surviving note links to, even a superseded one', () => {
    expect(rule(note({ key: 'old', retiredBy: ['new'], inboundFrom: ['live'] })))
      .toEqual({ archive: false, kept: KEPT_BECAUSE.protected })
  })

  it('does not treat coldness as evidence — there is no hits or recency input at all', () => {
    // the whole NoteFacts surface, spelled out: nothing here can express "cold"
    expect(Object.keys(note({ key: 'n' })).sort())
      .toEqual(['inboundFrom', 'key', 'retiredBy', 'subjectMissing', 'taskSettled', 'verdict'])
  })
})

describe('archiveCandidates — protection resolves against SURVIVORS', () => {
  it('leaves a clean corpus entirely alone', () => {
    expect(archiveCandidates([note({ key: 'a' }), note({ key: 'b' })])).toEqual([])
  })

  /**
   * The fixed point. `tail` is protected only by `head`; once `head` is itself retired it protects
   * nothing, so `tail` must fall in a later pass. A single pass would leave it guarded by a corpse.
   */
  it('retires a note whose only protector was itself retired', () => {
    const out = archiveCandidates([
      note({ key: 'head', taskSettled: true }),
      note({ key: 'tail', taskSettled: true, inboundFrom: ['head'] }),
    ])
    expect(out.map(c => c.key)).toEqual(['head', 'tail'])
  })

  it('stops at a LIVE protector rather than cascading through it', () => {
    const out = archiveCandidates([
      note({ key: 'alive', verdict: 'clean' }),
      note({ key: 'guarded', taskSettled: true, inboundFrom: ['alive'] }),
    ])
    expect(out).toEqual([])
  })

  it('reports candidates in input order, so one corpus always reads the same way', () => {
    const out = archiveCandidates([
      note({ key: 'z', taskSettled: true }),
      note({ key: 'a', taskSettled: true }),
    ])
    expect(out.map(c => c.key)).toEqual(['z', 'a'])
  })

  it('terminates on a mutual-protection cycle instead of looping', () => {
    const out = archiveCandidates([
      note({ key: 'x', taskSettled: true, inboundFrom: ['y'] }),
      note({ key: 'y', taskSettled: true, inboundFrom: ['x'] }),
    ])
    expect(out).toEqual([]) // each protects the other; neither is ever exposed
  })
})

/**
 * The archive is a WRITE, not a delete — so the round-trip has to hold at the schema level: the
 * flag must survive a parse, default to false on every note ever written before it existed, and be
 * carried forward by merge-on-omit so an unrelated update cannot silently un-archive a note.
 */
describe('the archived flag on the note schema', () => {
  it('defaults to false, so every pre-existing note parses as live', () => {
    const n = MemoryNoteInput.parse({ id: 'n', title: 't', tier: 'semantic' })
    expect(n.archived).toBe(false)
  })

  it('round-trips true', () => {
    expect(MemoryNoteInput.parse({ id: 'n', title: 't', tier: 'semantic', archived: true }).archived).toBe(true)
  })

  // That agents CANNOT archive is enforced by tools.ts's WriteSchemaCoversInput guard, which lists
  // `archived` in UnadvertisedByDesign — a compile error if it ever reaches WRITE_PROPERTIES. No
  // runtime assertion here: it would only restate a check the build already fails on.
})
