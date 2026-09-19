import { test, expect } from 'bun:test'
import type { EventRecord, Origin } from '@orc/contracts'
import { authorFixture, eventFixture } from '@orc/contracts/fixtures'
import { orphanedNotes } from './sweep'
import { AUTHOR_SOURCE, Door, EVENT_KIND } from '@orc/contracts'

// A task's agent writes inside its run's chat. MemoryAuthor.origin is required, and the payload is
// untyped, so an author without it compiles and then fails the parse at author.origin.
const RUN: Origin = { chatId: 'run:t1:v1', door: Door.supervisor }

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'

// orphanedNotes reads only e.kind + e.payload; eventFixture fills the rest of the record honestly.
const wrote = (taskId: string, id: string, links: string[] = []): EventRecord =>
  eventFixture({ kind: EVENT_KIND.memory_written, payload: { note: { id, title: id, links: links.map(t => ({ id: t })) }, author: authorFixture({ source: AUTHOR_SOURCE.agent, origin: RUN, taskId }) } })
const cli = (id: string): EventRecord =>
  eventFixture({ kind: EVENT_KIND.memory_written, payload: { note: { id, title: id, links: [] }, author: authorFixture() } })
const deleted = (id: string): EventRecord =>
  eventFixture({ kind: EVENT_KIND.memory_deleted, payload: { id, scope: 'project', author: authorFixture() } })

test('owned+unreferenced goes; adopted and referenced stay', () => {
  const events = [
    wrote(A, 'n1'),
    wrote(A, 'n2'),
    wrote(A, 'n4'),
    wrote(B, 'n2'),          // a live task re-wrote n2 -> adopted
    wrote(B, 'n3', ['n1']),  // a survivor links to n1 -> keep it
  ]
  expect(orphanedNotes(events, new Set([A])).map(n => n.id).sort()).toEqual(['n4'])
})

test('unparseable payloads are skipped, not fatal', () => {
  const events = [eventFixture({ kind: EVENT_KIND.memory_written, payload: { garbage: true } }), wrote(A, 'n1')]
  expect(orphanedNotes(events, new Set([A])).map(n => n.id)).toEqual(['n1'])
})

test('already-deleted notes are not re-swept; cli/null-authored notes are never swept', () => {
  const events = [wrote(A, 'g1'), deleted('g1'), cli('c1')]
  expect(orphanedNotes(events, new Set([A]))).toEqual([])
})
