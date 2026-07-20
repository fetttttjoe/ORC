import { describe, expect, it } from 'bun:test'
import { CoverageReport, PlanAnnotatedPayload } from './analysis'
import { LINK_KINDS, NOTE_KINDS, MemoryNoteInput } from './memory'
import { PAYLOAD_SCHEMAS } from './events'

describe('M5b contracts', () => {
  it('CoverageReport parses full + no-access shapes', () => {
    expect(CoverageReport.parse({ analyzed: true, scope: ['src'], gaps: [], confidence: 'high', notesWritten: 3 }).analyzed).toBe(true)
    expect(CoverageReport.parse({ analyzed: false }).confidence).toBe('none') // defaults
  })
  it('adds decomposes_into link kind and plan note kind', () => {
    expect(LINK_KINDS).toContain('decomposes_into')
    expect(NOTE_KINDS).toContain('plan')
  })
  it('plan-note carries rationale + uncertainty with safe defaults', () => {
    const n = MemoryNoteInput.parse({ id: 'masterplan', title: 'build web app', kind: 'plan' })
    expect(n.rationale).toBe('')
    expect(n.uncertainty).toEqual([])
    expect(MemoryNoteInput.parse({ id: 'db', title: 'DB', kind: 'plan', uncertainty: ['schema unknown'] }).uncertainty).toEqual(['schema unknown'])
  })
  it('the 4 new event payloads validate; plan_annotated rejects a non-slug targetNote', () => {
    expect(PAYLOAD_SCHEMAS.plan_annotated.safeParse({ planVersion: 1, targetNote: 'db', refs: ['api'], text: 'use bcrypt' }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.feedback_requested.safeParse({ question: 'analyze?', topic: 't-1' }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.feedback_provided.safeParse({ topic: 't-1', text: 'yes', author: { source: 'cli' } }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.feedback_provided.safeParse({
      topic: 't-1', text: 'approve', author: { source: 'cli' }, planHash: 'a'.repeat(64),
    }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.feedback_provided.safeParse({
      topic: 't-1', text: 'approve', author: { source: 'cli' }, planHash: 'not-a-sha256',
    }).success).toBe(false)
    expect(PAYLOAD_SCHEMAS.analysis_completed.safeParse({ analyzed: true }).success).toBe(true)
    expect(PlanAnnotatedPayload.safeParse({ planVersion: 1, targetNote: '../x', refs: [], text: 'x' }).success).toBe(false)
  })
})
