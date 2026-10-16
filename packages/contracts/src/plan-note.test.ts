import { describe, expect, it } from 'bun:test'
import { PlanNote, PlanNoteWrite } from './plan-note'

const full: PlanNote = {
  id: 'masterplan', title: 'Web app', summary: 's', body: 'b', rationale: 'r', uncertainty: ['u'],
  dependsOn: ['db'], zone: ['src/**'], skillRefs: ['web-research'], toolRefs: ['web/search'], modelRef: '', subplans: ['db', 'api'],
}

describe('PlanNote', () => {
  it('parses a full note', () => {
    expect(PlanNote.parse(full)).toEqual(full)
  })

  it('refuses an id with an upper-case letter', () => {
    expect(PlanNote.safeParse({ ...full, id: 'Masterplan' }).success).toBe(false)
    expect(PlanNoteWrite.safeParse({ id: 'Db' }).success).toBe(false)
  })
})

describe('PlanNoteWrite', () => {
  it('accepts an id alone', () => {
    expect(PlanNoteWrite.parse({ id: 'db' })).toEqual({ id: 'db' })
  })
})
