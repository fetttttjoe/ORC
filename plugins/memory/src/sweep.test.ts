import { test, expect } from 'bun:test'
import type { EventRecord } from '@orc/contracts'
import { eventFixture } from '@orc/contracts/fixtures'
import { orphanedNotes } from './sweep'

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'

// orphanedNotes reads only e.kind + e.payload; eventFixture fills the rest of the record honestly.
const wrote = (taskId: string, id: string, links: string[] = []): EventRecord =>
  eventFixture({ kind: 'memory_written', payload: { note: { id, title: id, links: links.map(t => ({ id: t })) }, author: { source: 'agent', taskId } } })
const cli = (id: string): EventRecord =>
  eventFixture({ kind: 'memory_written', payload: { note: { id, title: id, links: [] }, author: { source: 'cli' } } })
const deleted = (id: string): EventRecord =>
  eventFixture({ kind: 'memory_deleted', payload: { id, scope: 'project', author: { source: 'cli' } } })

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
  const events = [eventFixture({ kind: 'memory_written', payload: { garbage: true } }), wrote(A, 'n1')]
  expect(orphanedNotes(events, new Set([A])).map(n => n.id)).toEqual(['n1'])
})

test('already-deleted notes are not re-swept; cli/null-authored notes are never swept', () => {
  const events = [wrote(A, 'g1'), deleted('g1'), cli('c1')]
  expect(orphanedNotes(events, new Set([A]))).toEqual([])
})
