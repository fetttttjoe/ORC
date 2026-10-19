import { describe, expect, it } from 'bun:test'
import { CommitRecordedPayload, EventEnvelope, EventKind, PAYLOAD_SCHEMAS, type EventInput } from './events'
import { EVENT_KIND } from './event-kinds'
import { ChatKind } from './chat'
import { DeliveryMode } from './knowledge'
import { Door, NO_CHAT } from './origin'
import { TASK_STATUS } from './task'
import { authorFixture, eventFixture, TEST_WORKSPACE_ID } from './fixtures'

const STAMP = { ...NO_CHAT(Door.cli), taskId: 't1', stepId: null, runToken: null }
// @ts-expect-error an artifact_produced payload under a task_status_changed kind
const wrongKind: EventInput = { ...STAMP, kind: EVENT_KIND.task_status_changed, payload: { path: 'r.md', sha256: 'a'.repeat(64), size: 1 } }
// @ts-expect-error task_status_changed names a `to` status and this payload has none
const missingField: EventInput = { ...STAMP, kind: EVENT_KIND.task_status_changed, payload: { taskId: 't1', from: TASK_STATUS.draft } }
// @ts-expect-error artifact_produced spells the digest `sha256`, and the schema has no `sha`
const strayField: EventInput = { ...STAMP, kind: EVENT_KIND.artifact_produced, payload: { path: 'r.md', sha: 'a', size: 1 } }
void [wrongKind, missingField, strayField]

describe('events', () => {
  it('has a payload schema for every kind', () => {
    for (const kind of Object.values(EventKind)) {
      expect(PAYLOAD_SCHEMAS[kind]).toBeDefined()
    }
  })
  it('parses a valid input envelope', () => {
    const input: EventInput = {
      taskId: 't1', stepId: null, runToken: null, chatId: null, door: Door.cli,
      kind: EVENT_KIND.task_status_changed,
      payload: { taskId: 't1', from: TASK_STATUS.draft, to: TASK_STATUS.awaiting_approval },
    }
    expect(EventEnvelope.parse(input)).toEqual({ ...input, idempotencyKey: null })
  })
  it('requires chatId as a key — unlike idempotencyKey it has no default', () => {
    const base = {
      taskId: 't1', stepId: null, runToken: null, door: Door.cli,
      kind: EVENT_KIND.task_status_changed,
      payload: { taskId: 't1', from: TASK_STATUS.draft, to: TASK_STATUS.awaiting_approval },
    }
    expect(EventEnvelope.safeParse(base).success).toBe(false)
    expect(EventEnvelope.parse({ ...base, chatId: null }).chatId).toBeNull()
    expect(EventEnvelope.parse({ ...base, chatId: 'c1' }).chatId).toBe('c1')
    expect(EventEnvelope.safeParse({ ...base, chatId: '' }).success).toBe(false)
  })
  it('requires door as a key — where a call entered is a per-event fact, never defaulted', () => {
    const base = {
      taskId: 't1', stepId: null, runToken: null, chatId: null,
      kind: EVENT_KIND.task_status_changed,
      payload: { taskId: 't1', from: TASK_STATUS.draft, to: TASK_STATUS.awaiting_approval },
    }
    expect(() => EventEnvelope.parse(base)).toThrow()
    expect(() => EventEnvelope.parse({ ...base, door: 'terminal' })).toThrow()
  })
  it('keeps the door of a chatless event — a null chat is still a known entry point', () => {
    const parsed = EventEnvelope.parse({
      taskId: null, stepId: null, runToken: null, chatId: null, door: Door.hook,
      kind: EVENT_KIND.commit_recorded,
      payload: { sha: 'abc123', paths: [], workspaceId: null },
    })
    expect(parsed.chatId).toBeNull()
    expect(parsed.door).toBe(Door.hook)
  })
  it('eventFixture stamps a door, so a stored envelope always names one', () => {
    expect(eventFixture().door).toBe(Door.cli)
  })
  it('chat lifecycle payloads validate', () => {
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.chat_opened].safeParse({
      chatId: 'run:t1:v1', kind: ChatKind.run, workspaceId: TEST_WORKSPACE_ID, taskId: 't1',
      title: 'run t1', parent: { chatId: 'copilot:1', seq: 3 }, externalRef: null,
    }).success).toBe(true)
  })
  // A chat has one lifecycle event. A second, writer-declared ending would disagree with the task
  // status the readers already derive an end from, and nothing would say which of the two is right.
  it('has no chat_closed kind and no payload row for one', () => {
    expect(Object.values(EventKind)).not.toContain('chat_closed')
    expect(Object.keys(PAYLOAD_SCHEMAS)).not.toContain('chat_closed')
  })
  it('payload schemas reject wrong shapes', () => {
    expect(() => PAYLOAD_SCHEMAS.plan_approved.parse({})).toThrow()
    expect(() =>
      PAYLOAD_SCHEMAS.task_status_changed.parse({ taskId: 't1', from: 'draft', to: 'not_a_status' }),
    ).toThrow()
  })
  it('validates skill_loaded payloads', () => {
    const good = { stepId: 's1', runToken: 'step:t:s1:a1', name: 'my-skill', hash: 'abc123' }
    expect(() => PAYLOAD_SCHEMAS.skill_loaded.parse(good)).not.toThrow()
    expect(() => PAYLOAD_SCHEMAS.skill_loaded.parse({ ...good, hash: '' })).toThrow()
  })
  it('knowledge_written rejects a malformed claim id (no poison event)', () => {
    const good = {
      added: [{ id: 'abcd1234', location: 'knowledge/a.md' }], changed: [], retired: [], files: [], why: null, decision: null,
      decisionsRecorded: [], decisionsSuperseded: [], asserted: [], author: authorFixture(),
    }
    expect(() => PAYLOAD_SCHEMAS.knowledge_written.parse(good)).not.toThrow()
    expect(() => PAYLOAD_SCHEMAS.knowledge_written.parse({ ...good, added: [{ id: '../x', location: 'knowledge/a.md' }] })).toThrow()
  })
  it('copilot_exchange carries the full conversation record, tool summaries bounded', () => {
    const ok = PAYLOAD_SCHEMAS.copilot_exchange.safeParse({
      user: 'run it', assistant: 'which of the two runnable tasks?', modelRef: 'anthropic/x',
      toolCalls: [{ toolName: 'project_status', summary: '{}' }],
      taskId: null, workspaceId: TEST_WORKSPACE_ID,
    })
    expect(ok.success).toBe(true)
    expect(PAYLOAD_SCHEMAS.copilot_exchange.safeParse({
      user: 'x', assistant: 'y', modelRef: '', toolCalls: [], taskId: null, workspaceId: null,
    }).success).toBe(false)
  })

  it('knowledge_delivered rejects a malformed id and an unknown mode', () => {
    const good = { ids: ['abcd1234'], mode: DeliveryMode.card, subject: 'src/a.ts', author: authorFixture() }
    expect(() => PAYLOAD_SCHEMAS.knowledge_delivered.parse(good)).not.toThrow()
    expect(() => PAYLOAD_SCHEMAS.knowledge_delivered.parse({ ...good, ids: ['../x'] })).toThrow()
    expect(() => PAYLOAD_SCHEMAS.knowledge_delivered.parse({ ...good, mode: 'write' })).toThrow()
  })
  it('split_proposed and split_resolved payloads validate; split_resolved pins RunOutcome + claim refs', () => {
    expect(PAYLOAD_SCHEMAS.split_proposed.safeParse({
      splitId: 'split:step:t1:s1:a1:call_1', taskId: 't1', stepId: 's1',
      runToken: 'step:t1:s1:a1', childTaskId: 't1.s1.call_1',
    }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.split_resolved.safeParse({
      splitId: 'x', childTaskId: 'c', outcome: 'done', summary: 's',
      claims: [{ id: 'aaaaaaaa', location: 'knowledge/a.md' }],
    }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.split_resolved.safeParse({
      splitId: 'x', childTaskId: 'c', outcome: 'success', summary: 's', claims: [],
    }).success).toBe(false) // SignalOutcome is NOT a RunOutcome
    expect(PAYLOAD_SCHEMAS.split_resolved.safeParse({
      splitId: 'x', childTaskId: 'c', outcome: 'done', summary: 's', claims: ['finding-a'],
    }).success).toBe(false) // bare claim ids rejected — claims are (id, location) refs
  })

  it('plan_approved requires approval provenance', () => {
    const base = { taskId: 't1', version: 1, approvedAt: '2026-07-19T00:00:00Z' }
    expect(PAYLOAD_SCHEMAS.plan_approved.safeParse(base).success).toBe(false)
    expect(PAYLOAD_SCHEMAS.plan_approved.safeParse({ ...base, approvedBy: 'human' }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.plan_approved.safeParse({ ...base, approvedBy: 'policy', ruleIndex: 0 }).success).toBe(true)
  })

  it('idempotency key defaults to null, accepts a non-empty key, rejects empty', () => {
    const base: EventInput = {
      taskId: 't1', stepId: null, runToken: null, chatId: null, door: Door.cli,
      kind: EVENT_KIND.task_status_changed,
      payload: { taskId: 't1', from: TASK_STATUS.draft, to: TASK_STATUS.awaiting_approval },
    }
    expect(EventEnvelope.parse(base).idempotencyKey).toBeNull()
    expect(EventEnvelope.parse({ ...base, idempotencyKey: 'r1:finish:0' }).idempotencyKey).toBe('r1:finish:0')
    expect(EventEnvelope.safeParse({ ...base, idempotencyKey: '' }).success).toBe(false)
  })

  it('artifact_produced requires path, full sha256 digest, and byte size', () => {
    const good = { path: 'report.md', sha256: 'a'.repeat(64), size: 12 }
    expect(PAYLOAD_SCHEMAS.artifact_produced.safeParse(good).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.artifact_produced.safeParse({ ...good, sha256: 'abc' }).success).toBe(false)
    expect(PAYLOAD_SCHEMAS.artifact_produced.safeParse({ ...good, size: -1 }).success).toBe(false)
  })

  it('run_requested carries the cwd override and the retry flag — what only the caller knows', () => {
    const parsed = PAYLOAD_SCHEMAS.run_requested.parse({ taskId: 't1', cwd: null, retry: false })
    expect(parsed).toEqual({ taskId: 't1', cwd: null, retry: false })
    expect(PAYLOAD_SCHEMAS.run_requested.safeParse({ taskId: 't1' }).success).toBe(false)
  })

  it('commit_recorded parses valid sha and paths, rejects missing sha or non-hex', () => {
    const good = { sha: '0123456789abcdef0123456789abcdef01234567', paths: ['file.ts', 'dir/other.md'], workspaceId: TEST_WORKSPACE_ID }
    expect(PAYLOAD_SCHEMAS.commit_recorded.safeParse(good).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.commit_recorded.safeParse({ sha: 'abc123', paths: [], workspaceId: null }).success).toBe(true) // paths MAY be empty
    expect(PAYLOAD_SCHEMAS.commit_recorded.safeParse({ paths: ['file.ts'], workspaceId: null }).success).toBe(false) // missing sha
    expect(PAYLOAD_SCHEMAS.commit_recorded.safeParse({ sha: 'not-hex!', paths: [], workspaceId: null }).success).toBe(false) // non-hex sha
    expect(PAYLOAD_SCHEMAS.commit_recorded.safeParse({ sha: '', paths: [], workspaceId: null }).success).toBe(false) // empty sha
  })

  it('commit_recorded requires the workspace key — a commit is attributed to one checkout', () => {
    expect(CommitRecordedPayload.safeParse({ sha: 'abc123', paths: [] }).success).toBe(false)
  })
})
