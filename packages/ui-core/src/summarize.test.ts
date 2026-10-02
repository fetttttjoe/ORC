import { describe, expect, it } from 'bun:test'
import { AUTHOR_SOURCE, CheckVerdict, Confidence, DeliveryMode, EVENT_KIND } from '@orc/contracts'
import { TEST_WORKSPACE_ID, authorFixture, eventFixture, planFixture, stepFixture, taskFixture } from '@orc/contracts/fixtures'
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

  it('any kind whose payload fails its schema falls back to the exact generic snip of the raw payload', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.task_created,
      payload: { oops: 'not a task' },
    }))
    expect(row.line).toBe('{"oops":"not a task"}')
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

  it('knowledge_delivered and knowledge_written surface payload.author.taskId as authorTaskId', () => {
    const author = authorFixture({ source: AUTHOR_SOURCE.agent, taskId: 'task-K' })
    const delivered = summarizeEvent(eventFixture({
      kind: EVENT_KIND.knowledge_delivered, taskId: null,
      payload: { ids: ['abcd1234'], mode: DeliveryMode.card, subject: 'src/a.ts', author },
    }))
    const written = summarizeEvent(eventFixture({
      kind: EVENT_KIND.knowledge_written, taskId: null,
      payload: { added: [{ id: 'abcd1234', location: 'knowledge/src/a.ts.md' }], changed: [], retired: [], files: ['knowledge/src/a.ts.md'], why: 'because', decision: null, decisionsRecorded: [], decisionsSuperseded: [], asserted: [], author },
    }))
    expect([delivered.line, written.line]).toEqual(['card 1 claim(s) · src/a.ts', '+1 ~0 -0 · because'])
    expect([delivered.authorTaskId, written.authorTaskId]).toEqual(['task-K', 'task-K'])
  })

  it('a knowledge_checked reads as the check of the claim and its verdict, attributed to the checking task', () => {
    const author = authorFixture({ source: AUTHOR_SOURCE.agent, taskId: 'task-C' })
    const lines = Object.values(CheckVerdict).map(verdict => summarizeEvent(eventFixture({
      kind: EVENT_KIND.knowledge_checked, taskId: null,
      payload: { id: 'abcd1234', verdict, text: 'The store writes events.', anchors: [{ path: 'src/a.ts', symbol: 'alpha', digest: 'd1' }], why: 'read it', author },
    })))
    expect(lines.map(r => [r.line, r.authorTaskId])).toEqual([
      ['check abcd1234 holds', 'task-C'], ['check abcd1234 false', 'task-C'], ['check abcd1234 unknown', 'task-C'],
    ])
  })

  it('a knowledge_written that recorded a decision reads as the decision, with what it superseded', () => {
    const author = authorFixture({ source: AUTHOR_SOURCE.cli })
    const base = { added: [], changed: [], retired: [], files: ['docs/decisions/2026-09-29-use-files.md'], why: null, decision: null, asserted: [], author }
    const recorded = summarizeEvent(eventFixture({
      kind: EVENT_KIND.knowledge_written, taskId: null,
      payload: { ...base, decisionsRecorded: [{ id: 'use-files', location: 'docs/decisions/2026-09-29-use-files.md' }], decisionsSuperseded: [] },
    }))
    const superseding = summarizeEvent(eventFixture({
      kind: EVENT_KIND.knowledge_written, taskId: null,
      payload: { ...base, decisionsRecorded: [{ id: 'use-files', location: 'docs/decisions/2026-09-29-use-files.md' }], decisionsSuperseded: [{ id: 'use-surreal', location: 'docs/decisions/2026-01-01-use-surreal.md' }] },
    }))
    expect([recorded.line, superseding.line]).toEqual(['decision use-files', 'decision use-files supersedes use-surreal'])
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

  // ── kinds that previously had no summarizer and fell back to a raw JSON snip ──────────────────

  it('task_created names the task, its type and status', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.task_created,
      payload: { task: taskFixture({ title: 'Add ledger summaries', type: 'feature' }) },
    }))
    expect(row.line).toBe('Add ledger summaries (feature) status=draft')
  })

  it('plan_proposed names the version, step count and strategy', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.plan_proposed,
      payload: { plan: planFixture({ version: 2, strategyRef: 'grounded-plan', steps: [stepFixture(), stepFixture({ id: 's2' })] }) },
    }))
    expect(row.line).toBe('v2 · 2 steps · grounded-plan')
  })

  it('plan_edited names the version, step count and strategy', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.plan_edited,
      payload: { plan: planFixture({ version: 3, strategyRef: 'template:single', steps: [stepFixture()] }) },
    }))
    expect(row.line).toBe('v3 · 1 step · template:single')
  })

  it('plan_approved names the version, approver and matched rule', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.plan_approved,
      payload: { taskId: 't1', version: 3, approvedAt: '2026-07-18T00:00:00.000Z', approvedBy: 'human', ruleIndex: 2 },
    }))
    expect(row.line).toBe('v3 approved by human (rule 2)')
  })

  it('run_requested says retry vs run and the cwd override', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.run_requested,
      payload: { taskId: 't1', cwd: '/repo/work', retry: true },
    }))
    expect(row.line).toBe('retry in /repo/work')
  })

  it('run_started names the plan version and the workflow it started', () => {
    const row = summarizeEvent(eventFixture({ kind: EVENT_KIND.run_started, payload: { workflowId: 'w1', planVersion: 1, retryIndex: 0, taskId: 't1', cwd: null } }))
    expect(row.line).toBe('plan v1 · workflow w1')
  })

  it('run_started shows a nonzero retryIndex', () => {
    const row = summarizeEvent(eventFixture({ kind: EVENT_KIND.run_started, payload: { workflowId: 'w2', planVersion: 4, retryIndex: 2, taskId: 't1', cwd: null } }))
    expect(row.line).toBe('plan v4 · workflow w2 (retry 2)')
  })

  it('skill_loaded names the skill and a short hash', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.skill_loaded,
      payload: { stepId: 's1', runToken: 'r1', name: 'systematic-debugging', hash: 'abcdef1234567890' },
    }))
    expect(row.line).toBe('systematic-debugging (abcdef12)')
  })

  it('rate_limit_wait names the wait and snips the provider message', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.rate_limit_wait,
      payload: { stepId: 's1', runToken: 'r1', waitMs: 30_000, waitsSoFar: 0, errorMessage: 'rate limit exceeded' },
    }))
    expect(row.line).toBe('waiting 30s — rate limit exceeded')
  })

  it('split_proposed names the child task and the parent step', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.split_proposed,
      payload: { splitId: 'sp1', taskId: 't1', stepId: 's1', runToken: 'r1', childTaskId: 't1.s1.c1' },
    }))
    expect(row.line).toBe('child t1.s1.c1 from s1')
  })

  it('split_resolved names the child, its outcome and the join summary', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.split_resolved,
      payload: { splitId: 'sp1', childTaskId: 't1.s1.c1', outcome: 'done', summary: 'fixed the bug', claims: [{ id: 'aaaaaaaa', location: 'knowledge/a.md' }] },
    }))
    expect(row.line).toBe('t1.s1.c1 → done: fixed the bug')
  })

  it('memory_topic_accessed names the topic label and key', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.memory_topic_accessed,
      payload: { topicKey: 'a1b2c3d4e5f6', label: 'Auth patterns', author: authorFixture() },
    }))
    expect(row.line).toBe('Auth patterns (a1b2c3d4e5f6)')
  })

  it('memory_verified names the note, the verified revision and who verified it', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.memory_verified,
      payload: { id: 'auth-map', scope: 'project', stamp: { revision: 'abc123def456', at: '2026-07-18T00:00:00.000Z', by: 'auditor' }, author: authorFixture() },
    }))
    expect(row.line).toBe('auth-map verified @ abc123de by auditor')
  })

  it('memory_outcome names the note and the reported outcome', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.memory_outcome,
      payload: { id: 'auth-map', scope: 'project', outcome: 'useful', author: authorFixture() },
    }))
    expect(row.line).toBe('auth-map → useful')
  })

  it('plan_annotated names the target note, plan version and annotation text', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.plan_annotated,
      payload: { planVersion: 1, targetNote: 'auth-map', refs: [], text: 'looks solid' },
    }))
    expect(row.line).toBe('on auth-map (v1): looks solid')
  })

  it('analysis_completed reports coverage, confidence and gaps', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.analysis_completed,
      payload: { analyzed: true, scope: ['src/'], gaps: ['edge case'], confidence: Confidence.medium, claimsWritten: 2 },
    }))
    expect(row.line).toBe('analyzed=true confidence=medium gaps=1 claims=2')
  })

  it('models_discovered names the provider and how many models it now offers', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.models_discovered,
      payload: { providerId: 'anthropic', models: ['claude-a', 'claude-b'] },
    }))
    expect(row.line).toBe('anthropic: 2 models')
  })

  it('reaction_failed names the reaction and its error message', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.reaction_failed,
      payload: { reaction: 'run_requested', taskId: 't1', message: 'workflow spawn failed', causeSeq: 5 },
    }))
    expect(row.line).toBe('run_requested failed: workflow spawn failed')
  })

  it('commit_recorded names the short sha, file count and workspace', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.commit_recorded,
      payload: { sha: 'abc123def4567890abc123def4567890abc123d', paths: ['a.ts', 'b.ts'], workspaceId: 'ws-1' },
    }))
    expect(row.line).toBe('abc123de · 2 files in ws-1')
  })

  it('commit_recorded outside any workspace omits the workspace clause', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.commit_recorded,
      payload: { sha: 'abc123def4567890abc123def4567890abc123d', paths: [], workspaceId: null },
    }))
    expect(row.line).toBe('abc123de · 0 files')
  })

  it('workspace_created names the workspace, its branch and its directory', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.workspace_created,
      payload: {
        workspace: {
          id: '11111111-1111-4111-8111-111111111111', title: 'debt sweep', cwd: '/repo/.orc/worktrees/debt-sweep',
          branch: 'orc/debt-sweep', baseBranch: 'main', kind: 'worktree', managed: true, onTrunk: false,
          createdAt: '2026-09-20T00:00:00.000Z', archivedAt: null,
        },
      },
    }))
    expect(row.line).toBe('debt sweep · orc/debt-sweep · /repo/.orc/worktrees/debt-sweep')
  })

  it('workspace_retitled names the workspace and its new title', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.workspace_retitled,
      payload: { workspaceId: 'ws-1', title: 'renamed workspace' },
    }))
    expect(row.line).toBe('ws-1 → "renamed workspace"')
  })

  it('workspace_archived says archived or restored', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.workspace_archived,
      payload: { workspaceId: 'ws-1', archived: true, at: '2026-09-20T00:00:00.000Z' },
    }))
    expect(row.line).toBe('ws-1 archived')
  })

  it('workspace_merged names the workspace, the merge commit and the trunk it landed on', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.workspace_merged,
      payload: { workspaceId: 'ws-1', mergeCommit: 'deadbeef1234567890', trunk: 'main', at: '2026-09-20T00:00:00.000Z' },
    }))
    expect(row.line).toBe('ws-1 merged deadbeef → main')
  })

  it('chat_opened names the chat kind, its title and the task it is about', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.chat_opened,
      payload: { chatId: 'c1', kind: 'copilot', workspaceId: null, taskId: 't1', title: 'debugging session', parent: null, externalRef: null },
    }))
    expect(row.line).toBe('copilot "debugging session" on t1')
  })

  it('operation_completed names the operation, its attempt and its result', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.operation_completed,
      payload: { operationId: 'op1', attempt: 1, after: { ok: true } },
    }))
    expect(row.line).toBe('op1 attempt 1 → {"ok":true}')
  })

  it('operation_failed names the operation, its attempt and the error', () => {
    const row = summarizeEvent(eventFixture({
      kind: EVENT_KIND.operation_failed,
      payload: { operationId: 'op1', attempt: 2, error: 'boom' },
    }))
    expect(row.line).toBe('op1 attempt 2 FAILED: boom')
  })
})
