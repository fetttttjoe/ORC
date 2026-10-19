import { describe, expect, it } from 'bun:test'
import { ScopeType } from './scope'
import { EVENT_KIND } from './event-kinds'
import { Door } from './origin'
import { authorFixture, eventFixture, TEST_WORKSPACE_ID } from './fixtures'
import { inScope } from './in-scope'
import { CheckVerdict } from './knowledge'
import { Scope, type ScopeIndex } from './scope'

// t1 and t1-child both live in TEST_WORKSPACE_ID; t9 is a task the caller knows nothing about, so
// the index answers null rather than guessing.
const index: ScopeIndex = {
  workspaceOfTask: (taskId) => (taskId === 't1' || taskId === 't1-child' ? TEST_WORKSPACE_ID : null),
  inSubtree: (taskId, rootId) => taskId === rootId || taskId.startsWith(`${rootId}-`),
}

const commit = eventFixture({
  seq: 4, taskId: null, chatId: 'c1', door: Door.hook, kind: EVENT_KIND.commit_recorded,
  payload: { sha: 'abc123', paths: ['a.ts'], workspaceId: TEST_WORKSPACE_ID },
})
const childStep = eventFixture({ seq: 5, taskId: 't1-child', chatId: 'c2', kind: EVENT_KIND.task_created })
const claimChecked = eventFixture({
  seq: 6, taskId: null, chatId: 'c1', kind: EVENT_KIND.knowledge_checked,
  payload: { id: 'abcd1234', verdict: CheckVerdict.holds, text: 'T.', anchors: [], why: 'read it', author: authorFixture({ taskId: 't1' }) },
})

describe('inScope', () => {
  it('project matches every event, including one outside any task or chat', () => {
    const anonymous = eventFixture({ seq: 1, taskId: null, chatId: null })
    expect(inScope(anonymous, Scope.parse({ type: ScopeType.project }), index)).toBe(true)
    expect(inScope(commit, Scope.parse({ type: ScopeType.project }), index)).toBe(true)
  })

  it('a taskless commit_recorded is in its payload workspace', () => {
    const scope = Scope.parse({ type: ScopeType.workspace, id: TEST_WORKSPACE_ID })
    expect(inScope(commit, scope, index)).toBe(true)
    expect(inScope(commit, Scope.parse({ type: ScopeType.workspace, id: 'other' }), index)).toBe(false)
  })

  it('a task event takes its workspace from the index', () => {
    const scope = Scope.parse({ type: ScopeType.workspace, id: TEST_WORKSPACE_ID })
    expect(inScope(childStep, scope, index)).toBe(true)
    const unknown = eventFixture({ seq: 7, taskId: 't9' })
    expect(inScope(unknown, scope, index)).toBe(false)
  })

  it('subtree:false excludes a child task, subtree:true includes it', () => {
    const flat = Scope.parse({ type: ScopeType.task, id: 't1', subtree: false })
    const deep = Scope.parse({ type: ScopeType.task, id: 't1', subtree: true })
    expect(inScope(childStep, flat, index)).toBe(false)
    expect(inScope(childStep, deep, index)).toBe(true)
    expect(inScope(eventFixture({ taskId: 't1' }), flat, index)).toBe(true)
  })

  it('a knowledge event is in its author task scope, not in another task scope', () => {
    expect(inScope(claimChecked, Scope.parse({ type: ScopeType.task, id: 't1', subtree: false }), index)).toBe(true)
    expect(inScope(claimChecked, Scope.parse({ type: ScopeType.task, id: 't2', subtree: false }), index)).toBe(false)
    // and so reaches the workspace through that task
    expect(inScope(claimChecked, Scope.parse({ type: ScopeType.workspace, id: TEST_WORKSPACE_ID }), index)).toBe(true)
  })

  it('a taskless knowledge event belongs to its author\'s workspace', () => {
    const written = eventFixture({
      seq: 8, taskId: null, kind: EVENT_KIND.knowledge_written,
      payload: { added: [], changed: [], retired: [], files: [], why: null, decision: null, decisionsRecorded: [], decisionsSuperseded: [], asserted: [], author: authorFixture({ workspaceId: 'ws-cli' }) },
    })
    expect(inScope(written, Scope.parse({ type: ScopeType.workspace, id: 'ws-cli' }), index)).toBe(true)
    expect(inScope(written, Scope.parse({ type: ScopeType.workspace, id: TEST_WORKSPACE_ID }), index)).toBe(false)
  })

  it('chat matches only that chatId, and never a chatless event', () => {
    expect(inScope(commit, Scope.parse({ type: ScopeType.chat, id: 'c1' }), index)).toBe(true)
    expect(inScope(commit, Scope.parse({ type: ScopeType.chat, id: 'c2' }), index)).toBe(false)
    const anonymous = eventFixture({ chatId: null })
    expect(inScope(anonymous, Scope.parse({ type: ScopeType.chat, id: 'c1' }), index)).toBe(false)
  })
})
