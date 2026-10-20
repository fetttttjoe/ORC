import { describe, expect, test } from 'bun:test'
import { Door } from '@orc/contracts/origin'
import type { LogRow } from '$lib/api/types'
import { EVENT_KIND, WORKING } from '$lib/event-kinds'
import { dropTicker, mergeOlder } from './ledger-merge'

const row = (seq: number, kind: string = EVENT_KIND.step_started, failure?: { toolName: string; error: string }): LogRow => ({
  seq,
  ts: `2026-08-03T00:00:${String(seq).padStart(2, '0')}Z`,
  kind,
  line: `row ${seq}`,
  taskId: null,
  stepId: null,
  chatId: null,
  door: Door.supervisor,
  authorTaskId: null,
  ...(failure && { failure }),
})

describe('mergeOlder', () => {
  test('prepends older rows in seq order', () => {
    expect(mergeOlder([row(10), row(11)], [row(7), row(8)]).map(r => r.seq)).toEqual([7, 8, 10, 11])
  })

  test('drops rows at or past the current head — a racing fetch must not duplicate the screen', () => {
    expect(mergeOlder([row(10), row(11)], [row(9), row(10), row(11)]).map(r => r.seq)).toEqual([9, 10, 11])
  })

  test('dedupes within the fetched page and sorts it', () => {
    expect(mergeOlder([row(10)], [row(8), row(7), row(8)]).map(r => r.seq)).toEqual([7, 8, 10])
  })

  test('an empty ledger accepts the whole page', () => {
    expect(mergeOlder([], [row(1), row(2)]).map(r => r.seq)).toEqual([1, 2])
  })
})

describe('dropTicker', () => {
  test('drops ticker kinds from a fetched page — paged history must read like the live feed', () => {
    expect(dropTicker([row(1, EVENT_KIND.tool_call), row(2), row(3, EVENT_KIND.operation_started)], WORKING).map(r => r.seq)).toEqual([2])
  })

  test('keeps a FAILED ticker row — an answer that did not take must say why, in history too', () => {
    const failed = row(4, EVENT_KIND.tool_call, { toolName: 'exec', error: 'refused' })
    expect(dropTicker([failed, row(5, EVENT_KIND.tool_call)], WORKING)).toEqual([failed])
  })

  test('an empty ticker set keeps everything', () => {
    expect(dropTicker([row(1, EVENT_KIND.tool_call)], new Set()).map(r => r.seq)).toEqual([1])
  })
})
