import { describe, expect, it } from 'bun:test'
import { ChatKind } from './chat'
import { chatDigests } from './chat-digest-fold'
import { EVENT_KIND, type EventRecord } from './event-kinds'
import { authorFixture, eventFixture, must, planFixture, taskFixture, TEST_WORKSPACE_ID } from './fixtures'
import { CheckVerdict } from './knowledge'
import { Door } from './origin'
import { TASK_STATUS } from './task'

const SHA256 = 'a'.repeat(64)

const open = (
  seq: number, chatId: string, kind: ChatKind, over: Record<string, unknown> = {}, door: Door = Door.web,
): EventRecord => eventFixture({
  seq, chatId, door, taskId: null, kind: EVENT_KIND.chat_opened,
  payload: {
    chatId, kind, workspaceId: TEST_WORKSPACE_ID, taskId: null, title: `chat ${chatId}`,
    parent: null, externalRef: null, ...over,
  },
})

const byId = (chatId: string, events: EventRecord[]) =>
  must(chatDigests(events).find((d) => d.chatId === chatId), `digest ${chatId}`)

describe('chatDigests — shape and ordering', () => {
  it('reports newest-opened first and skips events that belong to no chat', () => {
    const events = [
      open(1, 'c1', ChatKind.copilot),
      eventFixture({ seq: 2, chatId: null, kind: EVENT_KIND.commit_recorded, taskId: null,
        payload: { sha: 'dead', paths: [], workspaceId: TEST_WORKSPACE_ID } }),
      open(3, 'c2', ChatKind.copilot),
    ]
    const digests = chatDigests(events)
    expect(digests.map((d) => d.chatId)).toEqual(['c2', 'c1'])
    expect(digests.flatMap((d) => d.commits)).toEqual([])
  })

  it('yields no digest for a chatId that was never opened', () => {
    const events = [eventFixture({ seq: 1, chatId: 'ghost', kind: EVENT_KIND.tool_call, payload: {} })]
    expect(chatDigests(events)).toEqual([])
  })

  it('carries the chat_opened envelope door and payload identity', () => {
    const events = [open(1, 'c1', ChatKind.external, { taskId: 't1', externalRef: 'ext-9' }, Door.mcp)]
    const d = byId('c1', events)
    expect(d.door).toBe(Door.mcp)
    expect(d.kind).toBe(ChatKind.external)
    expect(d.taskId).toBe('t1')
    expect(d.externalRef).toBe('ext-9')
    expect(d.workspaceId).toBe(TEST_WORKSPACE_ID)
    expect(d.openedSeq).toBe(1)
    expect(d.lastSeq).toBe(1)
  })
})

describe('chatDigests — a copilot chat', () => {
  // The open and the first exchange are appended together AFTER the exchange, so the chat's own
  // tool events sit at lower seqs than its chat_opened.
  const events: EventRecord[] = [
    eventFixture({ seq: 1, chatId: 'c1', door: Door.web, taskId: null, kind: EVENT_KIND.tool_call,
      payload: { stepId: 's', runToken: 'r', iteration: 1, toolCallId: 'x', toolName: 'task_create', input: {} } }),
    eventFixture({ seq: 2, chatId: 'c1', door: Door.web, taskId: null, kind: EVENT_KIND.task_created,
      payload: { task: taskFixture({ id: 't5' }) } }),
    open(3, 'c1', ChatKind.copilot),
    eventFixture({ seq: 4, chatId: 'c1', door: Door.web, taskId: null, kind: EVENT_KIND.copilot_exchange,
      usage: { inputTokens: 10, outputTokens: 2, costUSD: 0.5, estimated: false },
      payload: { user: 'first ask', assistant: 'sure', toolCalls: [], modelRef: 'm', taskId: null, workspaceId: TEST_WORKSPACE_ID } }),
    eventFixture({ seq: 5, chatId: 'c1', door: Door.web, taskId: null, kind: EVENT_KIND.copilot_exchange,
      payload: { user: 'second ask', assistant: 'ok', toolCalls: [], modelRef: 'm', taskId: null, workspaceId: TEST_WORKSPACE_ID } }),
    eventFixture({ seq: 6, chatId: 'c1', door: Door.web, taskId: 't5', kind: EVENT_KIND.task_status_changed,
      payload: { taskId: 't5', from: TASK_STATUS.draft, to: TASK_STATUS.cancelled } }),
  ]

  it('counts events that precede its chat_opened', () => {
    expect(byId('c1', events).caused.tasks).toEqual(['t5'])
  })

  it('asks with the FIRST exchange user text and spans to its newest seq', () => {
    const d = byId('c1', events)
    expect(d.asked).toBe('first ask')
    expect(d.openedSeq).toBe(3)
    expect(d.lastSeq).toBe(6)
  })

  it('never ends: a status change inside a copilot chat is not that chat ending', () => {
    const d = byId('c1', events)
    expect(d.endedSeq).toBeNull()
    expect(d.outcome).toBeNull()
    expect(d.summary).toBeNull()
  })

  it('sums only its own events usage', () => {
    expect(byId('c1', events).usage).toEqual({ inputTokens: 10, outputTokens: 2, costUSD: 0.5, estimated: false })
  })
})

describe('chatDigests — a run chat under a copilot parent', () => {
  const events: EventRecord[] = [
    open(1, 'c1', ChatKind.copilot),
    eventFixture({ seq: 2, chatId: 'c1', door: Door.web, taskId: 't7', kind: EVENT_KIND.run_requested,
      usage: { inputTokens: 1, outputTokens: 1, costUSD: 0.01, estimated: false },
      payload: { taskId: 't7', cwd: null, retry: false } }),
    open(3, 'r1', ChatKind.run, { taskId: 't7', parent: { chatId: 'c1', seq: 2 } }, Door.supervisor),
    eventFixture({ seq: 4, chatId: 'r1', door: Door.supervisor, taskId: 't7', kind: EVENT_KIND.task_status_changed,
      payload: { taskId: 't7', from: TASK_STATUS.approved, to: TASK_STATUS.running } }),
    eventFixture({ seq: 5, chatId: 'r1', door: Door.supervisor, taskId: 't7', kind: EVENT_KIND.step_completed,
      usage: { inputTokens: 100, outputTokens: 20, costUSD: 1, estimated: false },
      payload: { stepId: 's1', runToken: 'r', summary: 'step one done' } }),
    eventFixture({ seq: 6, chatId: 'r1', door: Door.supervisor, taskId: 't7', kind: EVENT_KIND.step_completed,
      payload: { stepId: 's2', runToken: 'r', summary: 'all done' } }),
    eventFixture({ seq: 7, chatId: 'r1', door: Door.supervisor, taskId: 't7', kind: EVENT_KIND.task_status_changed,
      payload: { taskId: 't7', from: TASK_STATUS.running, to: TASK_STATUS.done } }),
  ]

  it('ends at the non-running status event, with that status as the outcome', () => {
    const d = byId('r1', events)
    expect(d.endedSeq).toBe(7)
    expect(d.outcome).toBe(TASK_STATUS.done)
    expect(d.lastSeq).toBe(7)
  })

  it('summarises with the LAST step_completed carrying its chatId', () => {
    expect(byId('r1', events).summary).toBe('all done')
  })

  it('names the child in the parent caused.runs, and keeps the child usage out of the parent', () => {
    const parent = byId('c1', events)
    expect(parent.caused.runs).toEqual(['r1'])
    expect(parent.usage).toEqual({ inputTokens: 1, outputTokens: 1, costUSD: 0.01, estimated: false })
    expect(byId('r1', events).usage).toEqual({ inputTokens: 100, outputTokens: 20, costUSD: 1, estimated: false })
    expect(byId('r1', events).parent).toEqual({ chatId: 'c1', seq: 2 })
  })
})

describe('chatDigests — a run chat whose split children stamp under it', () => {
  // A split child's draft/awaiting_approval/approved stamps carry the PARENT run's chatId, and one
  // of them lands after the parent's own end.
  const events: EventRecord[] = [
    open(1, 'r1', ChatKind.run, { taskId: 't7' }, Door.supervisor),
    eventFixture({ seq: 2, chatId: 'r1', door: Door.supervisor, taskId: 't7', kind: EVENT_KIND.task_status_changed,
      payload: { taskId: 't7', from: TASK_STATUS.approved, to: TASK_STATUS.running } }),
    eventFixture({ seq: 3, chatId: 'r1', door: Door.supervisor, taskId: 't7', kind: EVENT_KIND.task_status_changed,
      payload: { taskId: 't7', from: TASK_STATUS.running, to: TASK_STATUS.done } }),
    eventFixture({ seq: 4, chatId: 'r1', door: Door.supervisor, taskId: 't8', kind: EVENT_KIND.task_status_changed,
      payload: { taskId: 't8', from: TASK_STATUS.draft, to: TASK_STATUS.awaiting_approval } }),
  ]

  it('keeps its OWN end when another task changes status after it', () => {
    const d = byId('r1', events)
    expect(d.endedSeq).toBe(3)
    expect(d.outcome).toBe(TASK_STATUS.done)
    expect(d.lastSeq).toBe(4)
  })

  it('does not end at a child status change that arrives before its own chat_opened', () => {
    const d = byId('r1', [
      eventFixture({ seq: 1, chatId: 'r1', door: Door.supervisor, taskId: 't8', kind: EVENT_KIND.task_status_changed,
        payload: { taskId: 't8', from: TASK_STATUS.draft, to: TASK_STATUS.awaiting_approval } }),
      open(2, 'r1', ChatKind.run, { taskId: 't7' }, Door.supervisor),
    ])
    expect(d.endedSeq).toBeNull()
    expect(d.outcome).toBeNull()
  })
})

const author = authorFixture({ taskId: 't1' })
const ref = (id: string) => ({ id, location: `knowledge/src/${id}.md` })
const claimsWritten = (seq: number, chatId: string, added: string[], changed: string[], retired: string[]): EventRecord =>
  eventFixture({ seq, chatId, taskId: null, kind: EVENT_KIND.knowledge_written, payload: {
    added: added.map(ref), changed: changed.map(ref), retired: retired.map(ref), files: [], why: null, decision: null,
    decisionsRecorded: [], decisionsSuperseded: [], asserted: [], author,
  } })
const claimChecked = (seq: number, chatId: string, id: string): EventRecord =>
  eventFixture({ seq, chatId, taskId: null, kind: EVENT_KIND.knowledge_checked,
    payload: { id, verdict: CheckVerdict.holds, text: 'the claim', anchors: [], why: 'read the code', author } })

describe('chatDigests — what a chat produced', () => {
  it('names the claims it wrote, checked and retired', () => {
    const events = [open(1, 'c1', ChatKind.copilot),
      claimsWritten(2, 'c1', ['aaaaaaaa'], ['bbbbbbbb'], ['cccccccc']), claimChecked(3, 'c1', 'dddddddd')]
    expect(byId('c1', events).claims).toEqual({ written: ['aaaaaaaa', 'bbbbbbbb'], checked: ['dddddddd'], retired: ['cccccccc'] })
  })

  it('ignores a knowledge write outside the chat', () => {
    const events = [open(1, 'c1', ChatKind.copilot), claimsWritten(2, 'c2', ['aaaaaaaa'], [], [])]
    expect(byId('c1', events).claims).toEqual({ written: [], checked: [], retired: [] })
  })

  it('collects commits, artifacts, created tasks and proposed plans', () => {
    const events = [
      open(1, 'c1', ChatKind.copilot),
      eventFixture({ seq: 2, chatId: 'c1', taskId: null, kind: EVENT_KIND.commit_recorded,
        payload: { sha: 'abc123', paths: ['a.ts'], workspaceId: TEST_WORKSPACE_ID } }),
      eventFixture({ seq: 3, chatId: 'c1', kind: EVENT_KIND.artifact_produced,
        payload: { path: 'out/report.md', sha256: SHA256, size: 12 } }),
      eventFixture({ seq: 4, chatId: 'c1', kind: EVENT_KIND.task_created, payload: { task: taskFixture({ id: 't5' }) } }),
      eventFixture({ seq: 5, chatId: 'c1', kind: EVENT_KIND.plan_proposed, payload: { plan: planFixture({ taskId: 't5' }) } }),
    ]
    const d = byId('c1', events)
    expect(d.commits).toEqual(['abc123'])
    expect(d.artifacts).toEqual(['out/report.md'])
    expect(d.caused).toEqual({ tasks: ['t5'], plans: ['t5'], runs: [] })
  })
})

const ask = (seq: number, topic: string, taskId = 't1'): EventRecord =>
  eventFixture({ seq, chatId: 'c1', taskId, kind: EVENT_KIND.feedback_requested, payload: { topic, question: `${topic}?` } })
const answer = (seq: number, topic: string, taskId = 't1'): EventRecord =>
  eventFixture({ seq, chatId: 'c1', taskId, kind: EVENT_KIND.feedback_provided,
    payload: { topic, text: 'yes', author: authorFixture({ taskId }) } })

describe('chatDigests — questions', () => {
  it('counts a re-ask after an answer as ONE open question', () => {
    const d = byId('c1', [open(1, 'c1', ChatKind.copilot), ask(2, 'cwd'), answer(3, 'cwd'), ask(4, 'cwd')])
    expect(d.questions).toEqual({ asked: 1, open: 1 })
  })

  it('closes an answered topic', () => {
    const d = byId('c1', [open(1, 'c1', ChatKind.copilot), ask(2, 'cwd'), ask(3, 'cwd'), answer(4, 'cwd')])
    expect(d.questions).toEqual({ asked: 1, open: 0 })
  })

  it('counts two topics on one task as two questions', () => {
    const d = byId('c1', [open(1, 'c1', ChatKind.copilot), ask(2, 'cwd'), ask(3, 'budget')])
    expect(d.questions).toEqual({ asked: 2, open: 2 })
  })
})
