import { describe, expect, it } from 'bun:test'
import { AUTHOR_SOURCE, DECISION_STATUS, Door, EVENT_KIND, type EventRecord, type Origin } from '@orc/contracts'
import { authorFixture } from '@orc/contracts/fixtures'
import { notesWrittenBy } from './task-notes'

// A task's agent writes inside its run's chat; MemoryAuthor.origin is required, and the untyped
// payload lets an author without it compile and then fail the parse at author.origin.
const RUN: Origin = { chatId: 'run:t1:v1', door: Door.supervisor }

// the task rides on the AUTHOR: the store appends every memory event with a null envelope task
// (store.ts:64, :133 — measured 2026-09-15), so a fold keyed on the envelope would return nothing.
const authorOf = (taskId: string | null) => authorFixture({ source: AUTHOR_SOURCE.agent, origin: RUN, ...(taskId !== null && { taskId }) })
const written = (taskId: string | null, note: Record<string, unknown>) =>
  ({ taskId: null, kind: EVENT_KIND.memory_written, payload: { note, author: authorOf(taskId) } })
const deleted = (taskId: string | null, id: string, scope = 'project') =>
  ({ taskId: null, kind: EVENT_KIND.memory_deleted, payload: { id, scope, author: authorOf(taskId) } })

describe('notesWrittenBy', () => {
  it('lists the latest write of every note this task wrote, plan and project scope alike', () => {
    const rows = notesWrittenBy([
      written('t1', { id: 'a', title: 'A v1', summary: 's1' }),
      written('t1', { id: 'a', title: 'A v2', summary: 's2' }),
      written('t1', { id: 'step-x', scope: 'plan-t1', title: 'Step X', summary: '', retention: 'expirable' }),
      written('t2', { id: 'b', title: 'B', summary: '' }),
      written(null, { id: 'c', title: 'C', summary: '' }),
    ], 't1')
    expect(rows.map(r => [r.scope, r.id, r.title])).toEqual([['plan-t1', 'step-x', 'Step X'], ['project', 'a', 'A v2']])
  })

  // The delete is unconditional on its author: a note ANOTHER task removed is gone, and leaving it
  // listed would send the finisher to memory_read a ghost id.
  it('drops a note the task deleted — and one another task deleted — and reports a decision\'s kind and status', () => {
    const rows = notesWrittenBy([
      written('t1', { id: 'gone', title: 'Gone', summary: '' }),
      deleted('t1', 'gone'),
      written('t1', { id: 'swept', title: 'Swept', summary: '' }),
      deleted('t2', 'swept'),
      written('t1', { id: 'd', title: 'D', summary: '', kind: 'decision', status: 'accepted' }),
    ], 't1')
    expect(rows).toEqual([{ id: 'd', scope: 'project', title: 'D', summary: '', kind: 'decision', status: DECISION_STATUS.accepted, archived: false }])
  })

  // LAST WRITER WINS, and archiving IS a write (a memory_written carrying archived: true). Both
  // halves matter to the finish step: an archived note's row is DELETED from the read model, so the
  // finisher's prescribed memory_read of every listed id would hit a ghost; and a note another task
  // has since rewritten no longer says what this task reported, so listing this task's stale title
  // would have it reconcile text nobody holds.
  it('drops a note another task has since archived or rewritten', () => {
    const rows = notesWrittenBy([
      written('t1', { id: 'retired-elsewhere', title: 'Mine', summary: '' }),
      written('t2', { id: 'retired-elsewhere', title: 'Mine', summary: '', archived: true }),
      written('t1', { id: 'taken-over', title: 'My words', summary: 'mine' }),
      written('t2', { id: 'taken-over', title: 'Their words', summary: 'theirs' }),
      written('t1', { id: 'still-mine', title: 'Still mine', summary: '' }),
    ], 't1')
    expect(rows.map(r => r.id)).toEqual(['still-mine'])
  })

  // The task's OWN archive stays listed, flagged: it is still this task's note to report on, and the
  // flag is the whole reason the finisher must not try to memory_read it. A hardcoded `archived:
  // false` would pass every other case in this file.
  it('lists a note this task archived itself, carrying the flag', () => {
    const rows = notesWrittenBy([
      written('t1', { id: 'retired', title: 'Retired', summary: '' }),
      written('t1', { id: 'retired', title: 'Retired', summary: '', archived: true }),
    ], 't1')
    expect(rows).toEqual([{ id: 'retired', scope: 'project', title: 'Retired', summary: '', kind: 'fact', archived: true }])
  })

  // Typed through this alias rather than written inline: the parameter is Pick<EventRecord, 'kind' |
  // 'payload'>, and a fresh literal carrying the extra envelope key is an excess-property error — yet
  // the envelope task is exactly what this case must spell, to show the fold ignores it even when it
  // names the right task.
  it('skips an unparseable payload instead of throwing — a fold, not a validator', () => {
    const rogue: Array<Pick<EventRecord, 'taskId' | 'kind' | 'payload'>> =
      [{ taskId: 't1', kind: EVENT_KIND.memory_written, payload: { nope: true } }]
    expect(notesWrittenBy(rogue, 't1')).toEqual([])
  })
})
