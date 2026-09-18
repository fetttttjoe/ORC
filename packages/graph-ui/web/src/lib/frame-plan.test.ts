import { describe, expect, it } from 'bun:test'
import type { GraphPatch, LogRow } from './api/types'
import type { OperatorState, Touch } from '@orc/ui-core/wire'
import { planFrame } from './frame-plan'

const PATCH: GraphPatch = { addNodes: [], updateNodes: [], removeNodeIds: [], addLinks: [], removeLinks: [], updateLinks: [] }
const ROW: LogRow = { seq: 11, ts: '2026-09-18T00:00:00.000Z', kind: 'step_started', line: 'x', taskId: null, stepId: null, noteRef: null, authorTaskId: null }
const OP: OperatorState = { openQuestions: [], retryable: [], planned: [] }
const TOUCH: Touch = { name: 'node', params: { id: 'a' } }

const envelope = (over: { patch?: GraphPatch | null; summary?: LogRow | null; projects?: Array<{ id: string; name: string | null }>; touched?: Touch[]; operator?: OperatorState | null } = {}) => ({
  patch: over.patch ?? null,
  summary: over.summary ?? null,
  projects: over.projects,
  touched: over.touched ?? [],
  operator: over.operator ?? null,
})

describe('planFrame', () => {
  it('advances seq and applies patch+summary when envSeq is ahead of what is held', () => {
    const plan = planFrame(10, 11, envelope({ patch: PATCH, summary: ROW }))
    expect(plan.regression).toBe(false)
    expect(plan.seq).toBe(11)
    expect(plan.patch).toBe(PATCH)
    expect(plan.summary).toBe(ROW)
    expect(plan.backfill).toBe(false)
  })

  it('a catch-up frame (patch, no summary) asks for a backfill', () => {
    const plan = planFrame(10, 11, envelope({ patch: PATCH }))
    expect(plan.backfill).toBe(true)
  })

  it('a regressed-seq frame still delivers operator and touched', () => {
    const plan = planFrame(50, 10, envelope({ operator: OP, touched: [TOUCH], patch: PATCH, summary: ROW }))
    expect(plan.regression).toBe(true)
    expect(plan.operator).toBe(OP)
    expect(plan.touched).toEqual([TOUCH])
  })

  it('a regressed-seq frame withholds seq, patch and summary — the caller resyncs instead', () => {
    const plan = planFrame(50, 10, envelope({ patch: PATCH, summary: ROW }))
    expect(plan.regression).toBe(true)
    expect(plan.seq).toBeNull()
    expect(plan.patch).toBeNull()
    expect(plan.summary).toBeNull()
    expect(plan.backfill).toBe(false)
  })

  it('an id-less frame (envSeq 0) applies its operator without advancing seq or regressing', () => {
    const plan = planFrame(50, 0, envelope({ operator: OP }))
    expect(plan.regression).toBe(false)
    expect(plan.operator).toBe(OP)
    expect(plan.seq).toBeNull()
  })

  // sse.ts never tells a fresh id-less frame apart from a LATER one whose `ev.lastEventId` merely
  // inherited the previous id-bearing frame's value (the SSE last-event-id buffer persists across
  // id-less messages — see frame-plan.ts's docblock). This pins why that is harmless: by the time
  // such a frame arrives, `heldSeq` already equals the inherited value, so re-assigning it is a
  // no-op rather than a real advance.
  it('an inherited (non-zero) envSeq equal to heldSeq is a safe no-op, not a regression', () => {
    const plan = planFrame(11, 11, envelope({ operator: OP }))
    expect(plan.regression).toBe(false)
    expect(plan.seq).toBe(11)
  })

  it('the chats-list push rides independent of seq and regression', () => {
    const plan = planFrame(50, 10, envelope({ projects: [{ id: 'p', name: null }] }))
    expect(plan.projects).toEqual([{ id: 'p', name: null }])
  })
})
