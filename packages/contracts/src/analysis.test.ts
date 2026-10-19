import { describe, expect, it } from 'bun:test'
import { Confidence, CoverageReport, PlanAnnotatedPayload } from './analysis'
import { PAYLOAD_SCHEMAS } from './events'
import { authorFixture } from './fixtures'

describe('M5b contracts', () => {
  it('CoverageReport parses full + no-access shapes', () => {
    expect(CoverageReport.parse({ analyzed: true, scope: ['src'], gaps: [], confidence: Confidence.high, claimsWritten: 3 }).analyzed).toBe(true)
    expect(CoverageReport.parse({ analyzed: false }).confidence).toBe(Confidence.none) // defaults
  })
  it('the 4 new event payloads validate; plan_annotated rejects a non-slug targetNote', () => {
    expect(PAYLOAD_SCHEMAS.plan_annotated.safeParse({ planVersion: 1, targetNote: 'db', refs: ['api'], text: 'use bcrypt' }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.feedback_requested.safeParse({ question: 'analyze?', topic: 't-1' }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.feedback_provided.safeParse({ topic: 't-1', text: 'yes', author: authorFixture() }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.feedback_provided.safeParse({
      topic: 't-1', text: 'approve', author: authorFixture(), planHash: 'a'.repeat(64),
    }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.feedback_provided.safeParse({
      topic: 't-1', text: 'approve', author: authorFixture(), planHash: 'not-a-sha256',
    }).success).toBe(false)
    expect(PAYLOAD_SCHEMAS.analysis_completed.safeParse({ analyzed: true }).success).toBe(true)
    expect(PlanAnnotatedPayload.safeParse({ planVersion: 1, targetNote: '../x', refs: [], text: 'x' }).success).toBe(false)
  })
})
