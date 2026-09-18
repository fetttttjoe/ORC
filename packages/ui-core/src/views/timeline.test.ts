import { describe, expect, it } from 'bun:test'
import { EVENT_KIND, type EventRecord } from '@orc/contracts'
import { eventFixture } from '@orc/contracts/fixtures'
import { modelOf } from '../test-helpers'
import { timeline } from './timeline'

const ev = (seq: number, kind: EventRecord['kind'], taskId: string | null, payload: Record<string, unknown> = {}): EventRecord =>
  eventFixture({ seq, kind, taskId, payload })
const exchange = { user: 'q', assistant: 'a', toolCalls: [], modelRef: 'x/y' }

describe('timeline view', () => {
  const events = [ev(1, EVENT_KIND.copilot_exchange, null, exchange), ...Array.from({ length: 500 }, (_, i) => ev(i + 2, EVENT_KIND.tool_call, 't1', { toolName: 'x', input: {} }))]

  it('finds an exchange buried under 500 later events, because the kind filter runs before the limit', () => {
    const rows = timeline.read(modelOf(events), { kinds: [EVENT_KIND.copilot_exchange], limit: 20 })
    expect(rows?.map(r => r.seq)).toEqual([1])
  })

  it('pages backward exclusively', () => {
    expect(timeline.read(modelOf(events), { beforeSeq: 3, limit: 10 })?.map(r => r.seq)).toEqual([1, 2])
  })

  it('touches every timeline query for any event', () => {
    expect(timeline.touches(ev(9, EVENT_KIND.tool_call, 't1'), modelOf(events))).toEqual([{}])
  })
})
