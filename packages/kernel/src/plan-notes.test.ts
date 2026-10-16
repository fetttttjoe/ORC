import { describe, expect, it } from 'bun:test'
import { EVENT_KIND, type EventRecord, type PlanNote } from '@orc/contracts'
import { eventFixture, planNoteFixture } from '@orc/contracts/fixtures'
import { PlanNoteRefusal, mergePlanNote, planNotesOf, planNotesWrittenAfter } from './plan-notes'

let seq = 0
const written = (taskId: string, note: PlanNote | Record<string, unknown>): EventRecord =>
  eventFixture({ seq: ++seq, taskId, kind: EVENT_KIND.plan_note_written, payload: { note } })

describe('planNotesOf', () => {
  it('keeps the latest write per id', () => {
    const notes = planNotesOf([
      written('t1', planNoteFixture({ id: 'db', title: 'DB v1' })),
      written('t1', planNoteFixture({ id: 'db', title: 'DB v2' })),
    ], 't1')
    expect(notes.map(n => n.title)).toEqual(['DB v2'])
  })

  it("ignores another task's note", () => {
    const notes = planNotesOf([
      written('t1', planNoteFixture({ title: 'Mine' })),
      written('t2', planNoteFixture({ id: 'other', title: 'Theirs' })),
    ], 't1')
    expect(notes.map(n => n.title)).toEqual(['Mine'])
  })

  it('drops a payload that fails its schema', () => {
    const notes = planNotesOf([
      written('t1', { id: 'BAD ID', title: 'x' }),
      written('t1', planNoteFixture({ id: 'db', title: 'DB' })),
    ], 't1')
    expect(notes.map(n => n.id)).toEqual(['db'])
  })

  it('keeps first-write order across rewrites', () => {
    const notes = planNotesOf([
      written('t1', planNoteFixture({ id: 'masterplan' })),
      written('t1', planNoteFixture({ id: 'db' })),
      written('t1', planNoteFixture({ id: 'masterplan', title: 'Plan v2' })),
    ], 't1')
    expect(notes.map(n => n.id)).toEqual(['masterplan', 'db'])
  })
})

describe('planNotesWrittenAfter', () => {
  it("names each id this task wrote after the seq, once, and never another task's", () => {
    const events = [
      written('t1', planNoteFixture({ id: 'masterplan' })),
      written('t1', planNoteFixture({ id: 'db' })),
      written('t2', planNoteFixture({ id: 'api' })),
      written('t1', planNoteFixture({ id: 'db', body: 'b2' })),
    ]
    expect(planNotesWrittenAfter(events, 't1', events[0]?.seq ?? 0)).toEqual(['db'])
  })
})

describe('mergePlanNote', () => {
  const prev = planNoteFixture({ id: 'a', title: 'A', body: 'b1', dependsOn: ['x'], zone: ['src/**'], subplans: ['s1', 's2'] })

  it('refuses a new note without a title, as untitled', () => {
    const merged = mergePlanNote(undefined, { id: 'a' })
    expect(merged).toMatchObject({ code: PlanNoteRefusal.untitled })
    expect(JSON.stringify(merged)).toContain('title')
  })

  it('a partial revise keeps dependsOn, zone and subplans', () => {
    expect(mergePlanNote(prev, { id: 'a', body: 'b2' })).toEqual({ ...prev, body: 'b2' })
  })

  it('an explicit empty zone clears it', () => {
    expect(mergePlanNote(prev, { id: 'a', zone: [] })).toEqual({ ...prev, zone: [] })
  })

  it('a field set to undefined is left out, never written', () => {
    expect(mergePlanNote(prev, { id: 'a', zone: undefined })).toEqual(prev)
  })

  it('refuses a zone entry holding a newline with the zone-entry-wellformed message', () => {
    const merged = mergePlanNote(prev, { id: 'a', zone: ['a/**\nb.ts'] })
    expect(merged).toMatchObject({ code: PlanNoteRefusal.shape })
    expect(JSON.stringify(merged)).toContain('one glob per array entry')
  })

  it('a schema refusal reads as the field to fix, not as raw issue JSON', () => {
    const merged = mergePlanNote(prev, { id: 'a', title: '' })
    expect(merged).toMatchObject({ code: PlanNoteRefusal.shape })
    const refusal = 'refusal' in merged ? merged.refusal : ''
    expect(refusal).toContain('→ at title')
    expect(refusal).not.toContain('"code"')
  })

  it('a new note starts from the empty note', () => {
    expect(mergePlanNote(undefined, { id: 'a', title: 'A' })).toEqual(planNoteFixture({ id: 'a', title: 'A' }))
  })
})
