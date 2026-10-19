import { describe, expect, it } from 'bun:test'
import { Brief, BRIEF_TASK_STATUSES } from './brief'
import { KnowledgeHealthState } from './health'
import { TASK_STATUS, TERMINAL_TASK_STATUS } from './task'
import { WORKSPACE_KIND, WORKSPACE_STATE } from './workspace-entity'

const WS_ID = '11111111-1111-4111-8111-111111111111'
const row = {
  workspace: {
    id: WS_ID, title: 'Add ingredient search', cwd: '/repo/.orc/worktrees/add-ingredient-search',
    branch: 'orc/add-ingredient-search', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: true, onTrunk: false,
    createdAt: '2026-09-14T00:00:00.000Z', archivedAt: null,
  },
  health: {
    state: WORKSPACE_STATE.waiting, lastActivityAt: '2026-09-14T00:00:00.000Z', taskCount: 1, openTaskCount: 1,
    merged: false, dirExists: true, clean: true,
  },
}
const brief = {
  project: 'recipes',
  workspace: row,
  elsewhere: { dangling: 0, waiting: 1 },
  tasks: [{ id: 't1', title: 'Add search', status: TASK_STATUS.awaiting_approval, workspaceId: WS_ID, workspaceTitle: row.workspace.title }],
  hiddenTasks: { [TASK_STATUS.awaiting_approval]: 0, [TASK_STATUS.running]: 0, [TASK_STATUS.blocked]: 0 },
  decisions: { shown: [{ id: 'use-postgres', title: 'Use Postgres', summary: 'The event log lives in Postgres.' }], total: 1 },
  knowledge: { state: KnowledgeHealthState.ok, claims: 5, suspect: 0 },
}

describe('Brief', () => {
  it('parses a full brief, and one with nothing known about this directory', () => {
    expect(Brief.parse(brief).tasks).toHaveLength(1)
    expect(Brief.parse({ ...brief, workspace: null, decisions: null }).workspace).toBeNull()
  })
  it('lists only the statuses that ask something of a reader — never a finished task', () => {
    for (const status of TERMINAL_TASK_STATUS)
      expect(Brief.safeParse({ ...brief, tasks: [{ ...brief.tasks[0], status }] }).success).toBe(false)
    expect(BRIEF_TASK_STATUSES.some(s => TERMINAL_TASK_STATUS.has(s))).toBe(false)
  })
  it('what the cap hid is stated for every listed status — a missing status is not a zero', () => {
    const { [TASK_STATUS.blocked]: _b, ...partial } = brief.hiddenTasks
    expect(Brief.safeParse({ ...brief, hiddenTasks: partial }).success).toBe(false)
  })
  it('decisions and knowledge are required keys: "could not be read" is null, never an absent field', () => {
    const { decisions: _d, ...noDecisions } = brief
    expect(Brief.safeParse(noDecisions).success).toBe(false)
    const { knowledge: _k, ...noKnowledge } = brief
    expect(Brief.safeParse(noKnowledge).success).toBe(false)
  })
})
