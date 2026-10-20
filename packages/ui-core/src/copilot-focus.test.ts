import { describe, expect, it } from 'bun:test'
import { EVENT_KIND, TASK_STATUS, WORKSPACE_KIND, type EventRecord, type TaskNode, type Workspace } from '@orc/contracts'
import { eventFixture, taskFixture } from '@orc/contracts/fixtures'
import { ScopeType } from '@orc/contracts/scope'
import { copilotFocus } from './copilot-focus'
import { modelOf } from './test-helpers'

const WS_A = '11111111-1111-4111-8111-111111111111'
const WS_B = '22222222-2222-4222-8222-222222222222'

const workspace = (id: string, title: string): Workspace => ({
  id, title, cwd: `/repo/${title}`, branch: 'main', baseBranch: null,
  kind: WORKSPACE_KIND.checkout, managed: false, onTrunk: true,
  createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null,
})
const opened = (seq: number, w: Workspace): EventRecord =>
  eventFixture({ seq, taskId: null, kind: EVENT_KIND.workspace_created, payload: { workspace: w } })
const created = (seq: number, over: Partial<TaskNode>): EventRecord =>
  eventFixture({ seq, taskId: over.id ?? 't1', kind: EVENT_KIND.task_created, payload: { task: taskFixture(over) } })

// one log behind every case: a selection is only handed shapes the fold produces
const state = modelOf([
  opened(1, workspace(WS_A, 'Alpha')),
  opened(2, workspace(WS_B, 'Beta')),
  created(3, { id: 't1', workspaceId: WS_A, title: 'build it', spec: 'the whole spec' }),
  created(4, { id: 't2', workspaceId: WS_A, parentId: 't1', depth: 1, title: 'child', status: TASK_STATUS.running }),
  created(5, { id: 't3', workspaceId: WS_A, parentId: 't2', depth: 2, title: 'grandchild' }),
  created(6, { id: 't9', workspaceId: WS_B, title: 'elsewhere' }),
]).state

describe('copilotFocus', () => {
  it('nothing selected → null', () => {
    expect(copilotFocus(state, { taskId: null, workspaceId: null })).toBeNull()
  })

  it('a task selection carries title/spec/status and its DIRECT children only', () => {
    expect(copilotFocus(state, { taskId: 't1', workspaceId: null })).toEqual({
      type: ScopeType.task,
      title: 'build it',
      spec: 'the whole spec',
      status: TASK_STATUS.draft,
      // t3 is a grandchild: the copilot is told what this request decomposes into, not its whole tree
      subtasks: [{ id: 't2', title: 'child', status: TASK_STATUS.running }],
    })
  })

  it('a workspace-only selection lists that workspace’s ROOT tasks', () => {
    expect(copilotFocus(state, { taskId: null, workspaceId: WS_A })).toEqual({
      type: ScopeType.workspace,
      title: 'Alpha',
      tasks: [{ id: 't1', title: 'build it', status: TASK_STATUS.draft }],
    })
    expect(copilotFocus(state, { taskId: null, workspaceId: WS_B })).toEqual({
      type: ScopeType.workspace,
      title: 'Beta',
      tasks: [{ id: 't9', title: 'elsewhere', status: TASK_STATUS.draft }],
    })
  })

  it('a task selection wins over a workspace selection', () => {
    const focus = copilotFocus(state, { taskId: 't1', workspaceId: WS_B })
    expect(focus).toMatchObject({ type: ScopeType.task, title: 'build it' })
  })

  it('an id the state does not hold → null', () => {
    expect(copilotFocus(state, { taskId: 'nope', workspaceId: null })).toBeNull()
    expect(copilotFocus(state, { taskId: null, workspaceId: 'nope' })).toBeNull()
    // the task selection still wins: an unknown task is "nothing to look at"
    expect(copilotFocus(state, { taskId: 'nope', workspaceId: WS_A })).toBeNull()
  })
})
