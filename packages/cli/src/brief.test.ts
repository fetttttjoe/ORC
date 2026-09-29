import { describe, expect, it } from 'bun:test'
import { Brief, BRIEF_LIMITS, TASK_STATUS, WORKSPACE_KIND, WORKSPACE_STATE, type WorkspaceHealth, type WorkspaceState, type WorkspaceWithHealth } from '@orc/contracts'
import { must, taskFixture } from '@orc/contracts/fixtures'
import { buildBrief, renderBrief, type BriefInput, type RenderBriefOptions } from './brief'

const HERE = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-09-17T12:00:00.000Z')

const row = (id: string, title: string, state: WorkspaceState, over: Partial<WorkspaceHealth> = {}, archivedAt: string | null = null): WorkspaceWithHealth => ({
  workspace: {
    id, title, cwd: `/repo/${title}`, branch: `orc/${title}`, baseBranch: 'main', kind: WORKSPACE_KIND.worktree,
    managed: true, onTrunk: false, createdAt: '2026-09-14T00:00:00.000Z', archivedAt,
  },
  health: {
    state, lastActivityAt: '2026-09-17T09:00:00.000Z', taskCount: 0, openTaskCount: 0, merged: false,
    provisionalNotes: 0, dirExists: true, clean: true, ...over,
  },
})

const input = (over: Partial<BriefInput> = {}): BriefInput => ({
  project: 'recipes', cwdWorkspaceId: HERE,
  workspaces: [row(HERE, 'search', WORKSPACE_STATE.idle), row(OTHER, 'import', WORKSPACE_STATE.idle)],
  tasks: [], decisions: [], drift: null, ...over,
})

const opts: RenderBriefOptions = {
  now: NOW,
  driftText: d => `DRIFT ${d.drifted}/${d.checkable}`,
  oneLine: (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`),
  hints: { workspaces: 'orc ws ls', decisions: 'orc adr ls' },
}
const text = (over: Partial<BriefInput> = {}): string => renderBrief(buildBrief(input(over)), opts).join('\n')

describe('buildBrief', () => {
  it('produces a value the contract accepts', () => {
    expect(Brief.safeParse(buildBrief(input())).success).toBe(true)
  })

  it('keeps only tasks that ask something of a reader, what needs a human first, this checkout before others', () => {
    const tasks = [
      taskFixture({ id: 'done', status: TASK_STATUS.done, workspaceId: HERE }),
      taskFixture({ id: 'draft', status: TASK_STATUS.draft, workspaceId: HERE }),
      taskFixture({ id: 'run-there', title: 'a', status: TASK_STATUS.running, workspaceId: OTHER }),
      taskFixture({ id: 'blocked', title: 'a', status: TASK_STATUS.blocked, workspaceId: HERE }),
      taskFixture({ id: 'gate-there', title: 'a', status: TASK_STATUS.awaiting_approval, workspaceId: OTHER }),
      taskFixture({ id: 'gate-here', title: 'z', status: TASK_STATUS.awaiting_approval, workspaceId: HERE }),
    ]
    const b = buildBrief(input({ tasks }))
    expect(b.tasks.map(t => t.id)).toEqual(['gate-here', 'gate-there', 'run-there', 'blocked'])
    expect(must(b.tasks.find(t => t.id === 'gate-there'), 'gate-there').workspaceTitle).toBe('import')
    expect(b.hiddenTasks).toEqual({ [TASK_STATUS.awaiting_approval]: 0, [TASK_STATUS.running]: 0, [TASK_STATUS.blocked]: 0 })
  })

  it('caps each status on its own and counts what it dropped', () => {
    const many = Array.from({ length: BRIEF_LIMITS.tasksPerStatus + 2 }, (_, i) =>
      taskFixture({ id: `r${i}`, title: `t${i}`, status: TASK_STATUS.running, workspaceId: HERE }))
    const gate = taskFixture({ id: 'gate', status: TASK_STATUS.awaiting_approval, workspaceId: HERE })
    const b = buildBrief(input({ tasks: [...many, gate] }))
    expect(b.tasks.filter(t => t.status === TASK_STATUS.running)).toHaveLength(BRIEF_LIMITS.tasksPerStatus)
    expect(b.tasks.map(t => t.id)).toContain('gate') // a flood of running work cannot push the gate out
    expect(b.hiddenTasks).toEqual({ [TASK_STATUS.awaiting_approval]: 0, [TASK_STATUS.running]: 2, [TASK_STATUS.blocked]: 0 })
  })

  it('a task whose workspace the fold never saw is still listed, unlabelled', () => {
    const b = buildBrief(input({ tasks: [taskFixture({ id: 'orphan', status: TASK_STATUS.blocked, workspaceId: '33333333-3333-4333-8333-333333333333' })] }))
    expect(must(b.tasks[0], 'orphan task').workspaceTitle).toBeNull()
  })

  // gatherBrief hands over archived workspaces for exactly this: a task outlives the archiving of
  // its workspace, and without the row its label would read as a log defect.
  it('a task in an archived workspace keeps its label', () => {
    const b = buildBrief(input({
      workspaces: [row(HERE, 'search', WORKSPACE_STATE.idle), row(OTHER, 'import', WORKSPACE_STATE.idle, {}, '2026-09-01T00:00:00.000Z')],
      tasks: [taskFixture({ id: 'late', status: TASK_STATUS.blocked, workspaceId: OTHER })],
    }))
    expect(must(b.tasks[0], 'task in archived workspace').workspaceTitle).toBe('import')
  })

  it('counts other workspaces that carry an action — never this one, never an archived one', () => {
    const b = buildBrief(input({ workspaces: [
      row(HERE, 'search', WORKSPACE_STATE.dangling),
      row(OTHER, 'import', WORKSPACE_STATE.dangling),
      row('44444444-4444-4444-8444-444444444444', 'wait', WORKSPACE_STATE.waiting),
      row('55555555-5555-4555-8555-555555555555', 'old', WORKSPACE_STATE.dangling, {}, '2026-09-01T00:00:00.000Z'),
      row('66666666-6666-4666-8666-666666666666', 'busy', WORKSPACE_STATE.active),
    ] }))
    expect(b.elsewhere).toEqual({ dangling: 1, waiting: 1 })
    expect(b.workspace?.workspace.id).toBe(HERE)
  })

  it('caps decisions but reports how many are in force; unreachable stays unreachable', () => {
    const decisions = Array.from({ length: BRIEF_LIMITS.decisions + 3 }, (_, i) => ({ id: `d${i}`, title: `D${i}`, summary: `s${i}` }))
    const b = buildBrief(input({ decisions }))
    expect(b.decisions?.shown.map(d => d.id)).toEqual(decisions.slice(0, BRIEF_LIMITS.decisions).map(d => d.id))
    expect(b.decisions?.total).toBe(decisions.length)
    expect(buildBrief(input({ decisions: null })).decisions).toBeNull()
  })

  it('a directory that is no recorded workspace yields no workspace and counts every other one', () => {
    const b = buildBrief(input({ cwdWorkspaceId: null, workspaces: [row(OTHER, 'import', WORKSPACE_STATE.waiting)] }))
    expect(b.workspace).toBeNull()
    expect(b.elsewhere.waiting).toBe(1)
  })
})

describe('renderBrief', () => {
  it('names the project and describes this checkout in one line', () => {
    const out = text({ workspaces: [row(HERE, 'search', WORKSPACE_STATE.idle, { provisionalNotes: 3, clean: false, merged: true })] })
    expect(out).toContain('# orc — recipes')
    expect(out).toContain('workspace: search (worktree, orc/search) — idle, last activity 3h ago, 3 provisional notes, uncommitted changes, merged')
  })

  it('a workspace the log shows nothing for has an unknown age, in words', () => {
    const out = text({ workspaces: [row(HERE, 'search', WORKSPACE_STATE.idle, { lastActivityAt: null })] })
    expect(out).toContain('— idle, last activity unknown, 0 provisional notes')
  })

  it('an uncounted provisional total is said in words, never printed as zero', () => {
    const out = text({ workspaces: [row(HERE, 'search', WORKSPACE_STATE.idle, { provisionalNotes: null })] })
    expect(out).toContain('provisional notes unknown')
    expect(out).not.toContain('0 provisional')
  })

  it('says so when this directory is no recorded workspace', () => {
    expect(text({ cwdWorkspaceId: null })).toContain('workspace: this directory is not a recorded workspace')
  })

  it('groups tasks under their status and labels only the ones from another checkout', () => {
    const out = text({ tasks: [
      taskFixture({ id: 'gate-here', title: 'Add search', status: TASK_STATUS.awaiting_approval, workspaceId: HERE }),
      taskFixture({ id: 'run-there', title: 'Import CSV', status: TASK_STATUS.running, workspaceId: OTHER }),
    ] })
    const lines = out.split('\n')
    const gate = lines.indexOf(`tasks ${TASK_STATUS.awaiting_approval}:`)
    expect(gate).toBeGreaterThan(-1)
    expect(lines[gate + 1]).toBe('  gate-here  Add search')
    expect(lines[lines.indexOf(`tasks ${TASK_STATUS.running}:`) + 1]).toBe('  run-there  Import CSV  [import]')
    expect(out).not.toContain(`tasks ${TASK_STATUS.blocked}:`)
  })

  it('an empty task list is stated, and a capped one admits it', () => {
    expect(text()).toContain('tasks: none awaiting_approval, running, blocked')
    const many = Array.from({ length: BRIEF_LIMITS.tasksPerStatus + 2 }, (_, i) =>
      taskFixture({ id: `r${i}`, title: `t${i}`, status: TASK_STATUS.running, workspaceId: HERE }))
    expect(text({ tasks: many })).toContain('+2 more not shown')
  })

  it('what the cap hid is admitted under the status it was hidden from', () => {
    const many = Array.from({ length: BRIEF_LIMITS.tasksPerStatus + 2 }, (_, i) =>
      taskFixture({ id: `r${i}`, title: `t${i}`, status: TASK_STATUS.running, workspaceId: HERE }))
    const blocked = taskFixture({ id: 'stuck', title: 'Stuck', status: TASK_STATUS.blocked, workspaceId: HERE })
    const lines = text({ tasks: [...many, blocked] }).split('\n')
    const more = lines.indexOf('  +2 more not shown')
    expect(more).toBeGreaterThan(lines.indexOf(`tasks ${TASK_STATUS.running}:`))
    expect(more).toBeLessThan(lines.indexOf(`tasks ${TASK_STATUS.blocked}:`))
    expect(lines.filter(l => l.includes('more not shown'))).toHaveLength(1)
  })

  it('points at the listing only when another workspace needs someone', () => {
    expect(text()).not.toContain('elsewhere')
    const out = text({ workspaces: [row(HERE, 'search', WORKSPACE_STATE.idle), row(OTHER, 'import', WORKSPACE_STATE.dangling)] })
    expect(out).toContain('elsewhere: 1 dangling — orc ws ls')
  })

  it('decisions: unreachable is said, none is silent, some are listed with a clipped line', () => {
    expect(text({ decisions: null })).toContain('decisions: unknown — the decision files could not be read')
    expect(text({ decisions: [] })).not.toContain('decisions')
    const long = 'x'.repeat(BRIEF_LIMITS.decisionLineChars + 50)
    const out = text({ decisions: [{ id: 'a', title: 'Use Postgres', summary: long }, { id: 'b', title: 'No summary', summary: '' }] })
    expect(out).toContain('decisions in force (2 of 2 — orc adr ls):')
    const line = must(out.split('\n').find(l => l.startsWith('  Use Postgres — ')), 'decision line')
    expect(line.length).toBe('  Use Postgres — '.length + BRIEF_LIMITS.decisionLineChars)
    expect(line.endsWith('…')).toBe(true)
    expect(out.split('\n')).toContain('  No summary')
  })

  it('the drift advisory is the last line, in the caller\'s words', () => {
    const lines = text({ drift: { checkable: 10, drifted: 4, ratio: 0.4 } }).split('\n')
    expect(lines.at(-1)).toBe('DRIFT 4/10')
    expect(text()).not.toContain('DRIFT')
  })
})
