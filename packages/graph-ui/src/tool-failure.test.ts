import { describe, expect, it } from 'bun:test'
import { EVENT_KIND, type EventKind, type EventRecord } from '@orc/contracts'
import { eventFixture } from '@orc/contracts/fixtures'
import { toolFailure } from './tool-failure'

const event = (kind: EventKind, payload: Record<string, unknown>): EventRecord => eventFixture({
  projectId: 'p', stepId: 'plan', runToken: 'r1', kind, payload, ts: new Date().toISOString(),
})

const result = (over: Record<string, unknown>): EventRecord => event(EVENT_KIND.tool_result, {
  stepId: 'plan', runToken: 'r1', iteration: 1, toolCallId: 'c1',
  toolName: 'finalize_plan', output: 'ok', isError: false, ...over,
})

describe('toolFailure — the one tool result the conversation pane must render', () => {
  it('lifts toolName and error text off a failed result', () => {
    expect(toolFailure(result({ isError: true, output: 'plan graph changed since approval' })))
      .toEqual({ toolName: 'finalize_plan', error: 'plan graph changed since approval' })
  })

  it('is null for a successful result — every tool result on screen would drown the pane', () => {
    expect(toolFailure(result({}))).toBeNull()
  })

  it('is null for any other event kind, and for no event at all', () => {
    expect(toolFailure(event(EVENT_KIND.tool_call, { toolName: 'x', isError: true }))).toBeNull()
    expect(toolFailure(null)).toBeNull()
  })

  it('renders a structured output rather than dropping it — an agent tool may return an object', () => {
    expect(toolFailure(result({ isError: true, output: { error: 'not approved' } })))
      .toEqual({ toolName: 'finalize_plan', error: '{"error":"not approved"}' })
  })

  it('is null for a malformed payload', () => {
    expect(toolFailure(event(EVENT_KIND.tool_result, { isError: true }))).toBeNull()
  })

  it('caps the error text — a tool that returns a megabyte must not become the pane', () => {
    const failure = toolFailure(result({ isError: true, output: 'x'.repeat(5_000) }))
    expect(failure?.error.length).toBeLessThan(1_000)
  })
})
