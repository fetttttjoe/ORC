import { describe, expect, it } from 'bun:test'
import { AUTHOR_SOURCE, EVENT_KIND } from '@orc/contracts'
import { TEST_WORKSPACE_ID, authorFixture, eventFixture } from '@orc/contracts/fixtures'
import { summarizeEvent } from './summarize'

describe('summarizeEvent', () => {
  it('agent_call carries iteration + tool names', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.agent_call, seq: 9,
      payload: { stepId: 's1', runToken: 'r1', iteration: 3, request: {}, response: { text: 'working on it', toolCalls: [{ toolName: 'fs_write' }, { toolName: 'signal' }] } },
    }))
    expect(row.line).toContain('iter 3')
    expect(row.line).toContain('fs_write,signal')
    expect(row.seq).toBe(9)
    expect(row.noteRef).toBeNull()
  })

  it('memory events resolve a noteRef for direct navigation', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.memory_written,
      payload: { note: { id: 'auth-map', title: 'Auth map', scope: 'project', kind: 'fact', links: [{ id: 'other-note' }], sources: [] }, author: authorFixture() },
    }))
    expect(row.line).toContain('auth-map')
    expect(row.noteRef).toBe('note:project\u0000auth-map')
  })

  it('a payload that fails its contract schema degrades to the generic snip — no noteRef', () => {
    // the note lacks a title and the payload lacks its author: the store refuses such an append
    // today, so this shape only exists as pre-schema history — it must render as a snip, not as
    // "undefined"-laced fields with a noteRef pointing at a note the fold also refused
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.memory_written,
      payload: { note: { id: 'half-a-note' } },
    }))
    expect(row.noteRef).toBeNull()
    expect(row.line).toContain('half-a-note')
  })

  it('copilot_exchange summarizes the turn and side-channels the full record', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.copilot_exchange,
      payload: { user: 'run it', assistant: 'which task?', toolCalls: [{ toolName: 'list_tasks', summary: '{}' }], modelRef: 'anthropic/x', taskId: null, workspaceId: TEST_WORKSPACE_ID },
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

  it('memory_written surfaces payload.author.taskId as authorTaskId (the writing task)', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.memory_written, taskId: null,
      payload: { note: { id: 'auth-map', title: 'Auth map', scope: 'project', kind: 'fact', links: [], sources: [] }, author: authorFixture({ source: AUTHOR_SOURCE.agent, taskId: 'task-A' }) },
    }))
    expect(row.authorTaskId).toBe('task-A')
  })

  it('memory_deleted surfaces payload.author.taskId as authorTaskId', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.memory_deleted, taskId: null,
      payload: { id: 'gone', scope: 'project', author: authorFixture({ source: AUTHOR_SOURCE.agent, taskId: 'task-B' }) },
    }))
    expect(row.authorTaskId).toBe('task-B')
  })

  it('an ownerless (cli/human) memory row has authorTaskId null', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.memory_written, taskId: null,
      payload: { note: { id: 'global', title: 'Global', scope: 'project', kind: 'fact', links: [], sources: [] }, author: authorFixture() },
    }))
    expect(row.authorTaskId).toBeNull()
  })

  it('a non-memory (step) row has authorTaskId null — it is attributed by the envelope taskId', () => {
    const row = summarizeEvent(eventFixture({ kind: EVENT_KIND.step_started, taskId: 'task-A', stepId: 's1', payload: { stepId: 's1', attempt: 1 } }))
    expect(row.authorTaskId).toBeNull()
    expect(row.taskId).toBe('task-A')
  })
})
