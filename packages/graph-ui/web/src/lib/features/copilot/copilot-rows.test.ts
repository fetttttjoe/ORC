import { describe, expect, test } from 'bun:test'
import { restoredRows, type ExchangeRecord } from './copilot-rows'

const exchange = (seq: number, toolCalls = 0): ExchangeRecord => ({
  seq,
  user: `q${seq}`,
  assistant: `a${seq}`,
  toolCalls: Array.from({ length: toolCalls }, (_, i) => ({ toolName: `tool${i}`, summary: `s${i}` })),
})

const ids = (rows: ReturnType<typeof restoredRows>): string[] => rows.map(r => r.id)

describe('restoredRows', () => {
  test('adjacent-seq exchanges never share a key', () => {
    const rows = restoredRows([exchange(79327), exchange(79328)], 40)
    expect(new Set(ids(rows)).size).toBe(rows.length)
  })

  test('every tool call in one exchange gets its own key', () => {
    const rows = restoredRows([exchange(5, 3)], 40)
    expect(new Set(ids(rows)).size).toBe(rows.length)
    expect(rows.filter(r => r.kind === 'tool')).toHaveLength(3)
  })

  test('rows keep journal order: user, tools, assistant', () => {
    const rows = restoredRows([exchange(7, 1)], 40)
    expect(rows.map(r => r.kind)).toEqual(['message', 'tool', 'message'])
    expect(rows[0]).toMatchObject({ role: 'user', text: 'q7' })
    expect(rows[2]).toMatchObject({ role: 'assistant', text: 'a7' })
  })

  test('an exchange with no assistant text renders no empty bubble', () => {
    const rows = restoredRows([{ ...exchange(9), assistant: '' }], 40)
    expect(rows.filter(r => r.kind === 'message')).toHaveLength(1)
  })

  test('the cap keeps the newest rows', () => {
    const rows = restoredRows([exchange(1), exchange(2), exchange(3)], 2)
    expect(rows).toHaveLength(2)
    expect(rows.at(-1)).toMatchObject({ role: 'assistant', text: 'a3' })
  })
})
