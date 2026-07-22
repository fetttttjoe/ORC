import { describe, expect, it } from 'bun:test'
import { EVENT_KIND } from '@orc/contracts'
import { eventFixture } from '@orc/contracts/fixtures'
import { summarizeEvent } from './summarize'

describe('summarizeEvent', () => {
  it('agent_call carries iteration + tool names', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.agent_call, seq: 9,
      payload: { iteration: 3, response: { text: 'working on it', toolCalls: [{ toolName: 'fs_write' }, { toolName: 'signal' }] } },
    }))
    expect(row.line).toContain('iter 3')
    expect(row.line).toContain('fs_write,signal')
    expect(row.seq).toBe(9)
    expect(row.noteRef).toBeNull()
  })

  it('memory events resolve a noteRef for direct navigation', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.memory_written,
      payload: { note: { id: 'auth-map', scope: 'project', kind: 'fact', links: [{}], sources: [] } },
    }))
    expect(row.line).toContain('auth-map')
    expect(row.noteRef).toBe('note:project\u0000auth-map')
  })

  it('copilot_exchange summarizes the turn and side-channels the full record', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.copilot_exchange,
      payload: { user: 'run it', assistant: 'which task?', toolCalls: [{ toolName: 'list_tasks', summary: '{}' }], modelRef: 'anthropic/x' },
    }))
    expect(row.line).toContain('run it')
    expect(row.line).toContain('(1 tools)')
    expect(row.exchange?.assistant).toBe('which task?')
  })

  it('unknown kinds fall back to a snipped payload', () => {
    const row = summarizeEvent(eventFixture({ kind: EVENT_KIND.run_started, payload: { workflowId: 'w1', planVersion: 1 } }))
    expect(row.line).toContain('w1')
    expect(row.line.length).toBeLessThan(120)
  })
})
