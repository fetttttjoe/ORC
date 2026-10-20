import { BRIEF_LIMITS, BRIEF_TASK_STATUSES, TASK_STATUS, WORKSPACE_STATE, type Brief, type BriefTask, type BriefTaskStatus, type TaskNode, type TaskStatus, type WorkspaceWithHealth } from '@orc/contracts'
import { knowledgeHealthLine } from './knowledge-health-line'
import { AGE_UNKNOWN, relativeAge } from './relative-age'

// pure: no database, git or clock, so every selection rule is testable against any state

export interface BriefInput {
  project: string
  // The workspace this directory is, or null when the fold holds none for it.
  cwdWorkspaceId: string | null
  // every workspace, archived included: a task still names its workspace after archiving
  workspaces: readonly WorkspaceWithHealth[]
  tasks: readonly Pick<TaskNode, 'id' | 'title' | 'status' | 'workspaceId'>[]
  // null = decision files unreadable, kept apart from [] to the text: opposite reader behaviour
  decisions: readonly { id: string; title: string; summary: string }[] | null
  knowledge: Brief['knowledge']
}

const isBriefStatus = (s: TaskStatus): s is BriefTaskStatus => BRIEF_TASK_STATUSES.some(b => b === s)

export function buildBrief(input: BriefInput): Brief {
  const titles = new Map(input.workspaces.map(r => [r.workspace.id, r.workspace.title]))
  const here = input.cwdWorkspaceId
  const listed: BriefTask[] = input.tasks.flatMap(t => isBriefStatus(t.status)
    ? [{ id: t.id, title: t.title, status: t.status, workspaceId: t.workspaceId, workspaceTitle: titles.get(t.workspaceId) ?? null }]
    : [])
  const away = (t: BriefTask): number => (t.workspaceId === here ? 0 : 1)
  // capped per status: one cap would let running work push the plan awaiting approval off the end
  const ranked = (status: BriefTaskStatus): BriefTask[] => listed
    .filter(t => t.status === status)
    .sort((a, b) => away(a) - away(b) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
  const tasks = BRIEF_TASK_STATUSES.flatMap(status => ranked(status).slice(0, BRIEF_LIMITS.tasksPerStatus))
  const hidden = (status: BriefTaskStatus): number => Math.max(0, ranked(status).length - BRIEF_LIMITS.tasksPerStatus)

  const others = input.workspaces.filter(r => r.workspace.id !== here && r.workspace.archivedAt === null)
  const inState = (state: WorkspaceWithHealth['health']['state']): number => others.filter(r => r.health.state === state).length

  return {
    project: input.project,
    workspace: input.workspaces.find(r => r.workspace.id === here) ?? null,
    elsewhere: { dangling: inState(WORKSPACE_STATE.dangling), waiting: inState(WORKSPACE_STATE.waiting) },
    tasks,
    // spelled per key: Object.fromEntries loses the exhaustive record type and only a cast restores it
    hiddenTasks: {
      [TASK_STATUS.awaiting_approval]: hidden(TASK_STATUS.awaiting_approval),
      [TASK_STATUS.running]: hidden(TASK_STATUS.running),
      [TASK_STATUS.blocked]: hidden(TASK_STATUS.blocked),
    },
    decisions: input.decisions === null ? null : {
      shown: input.decisions.slice(0, BRIEF_LIMITS.decisions).map(d => ({ id: d.id, title: d.title, summary: d.summary })),
      total: input.decisions.length,
    },
    knowledge: input.knowledge,
  }
}

export interface RenderBriefOptions {
  // A PARAMETER for relativeAge's reason: one clock for the whole block.
  now: Date
  oneLine: (text: string, maxChars: number) => string
  // built by the command module: importing the constants here would pull commander in
  hints: { workspaces: string; decisions: string }
}

function workspaceLine({ workspace: w, health: h }: WorkspaceWithHealth, now: Date): string {
  // An unknown age in WORDS rather than `ws ls`'s '-' cell: a line read by a model has no legend.
  const age = h.lastActivityAt === null ? AGE_UNKNOWN : relativeAge(h.lastActivityAt, now)
  const facts = [h.state, `last activity ${age === AGE_UNKNOWN ? 'unknown' : age}`, ...(h.clean === false ? ['uncommitted changes'] : []), ...(h.merged ? ['merged'] : [])]
  return `workspace: ${w.title} (${w.kind}, ${w.branch ?? 'detached'}) — ${facts.join(', ')}`
}

export function renderBrief(brief: Brief, opts: RenderBriefOptions): string[] {
  const lines = [`# orc — ${brief.project}`]
  lines.push(brief.workspace === null
    ? 'workspace: this directory is not a recorded workspace yet — any orc command here records it'
    : workspaceLine(brief.workspace, opts.now))

  const elsewhere = [
    ...(brief.elsewhere.dangling > 0 ? [`${brief.elsewhere.dangling} ${WORKSPACE_STATE.dangling}`] : []),
    ...(brief.elsewhere.waiting > 0 ? [`${brief.elsewhere.waiting} ${WORKSPACE_STATE.waiting}`] : []),
  ]
  if (elsewhere.length > 0) lines.push(`elsewhere: ${elsewhere.join(', ')} — ${opts.hints.workspaces}`)

  // stated, not omitted: a brief with no task section reads like a failed task read
  if (brief.tasks.length === 0) lines.push(`tasks: none ${BRIEF_TASK_STATUSES.join(', ')}`)
  const here = brief.workspace?.workspace.id
  for (const status of BRIEF_TASK_STATUSES) {
    const group = brief.tasks.filter(t => t.status === status)
    if (group.length === 0) continue
    lines.push(`tasks ${status}:`)
    for (const t of group)
      lines.push(`  ${t.id}  ${t.title}${t.workspaceId === here || t.workspaceTitle === null ? '' : `  [${t.workspaceTitle}]`}`)
    if (brief.hiddenTasks[status] > 0) lines.push(`  +${brief.hiddenTasks[status]} more not shown`)
  }

  if (brief.decisions === null) lines.push('decisions: unknown — the decision files could not be read')
  else if (brief.decisions.shown.length > 0) {
    lines.push(`decisions in force (${brief.decisions.shown.length} of ${brief.decisions.total} — ${opts.hints.decisions}):`)
    for (const d of brief.decisions.shown) {
      const line = opts.oneLine(d.summary, BRIEF_LIMITS.decisionLineChars)
      lines.push(line === '' ? `  ${d.title}` : `  ${d.title} — ${line}`)
    }
  }

  lines.push(knowledgeHealthLine(brief.knowledge))
  return lines
}
