import { BRIEF_LIMITS, BRIEF_TASK_STATUSES, TASK_STATUS, WORKSPACE_STATE, type Brief, type BriefTask, type BriefTaskStatus, type TaskNode, type TaskStatus, type WorkspaceWithHealth } from '@orc/contracts'
import { AGE_UNKNOWN, relativeAge } from './relative-age'

// The brief: what a session is told about a project before it has asked anything, and how that
// reads as text. No database, no git, no clock — brief-gather.ts reads, this decides what is worth a
// line. Split that way so every selection rule (what is capped, what outranks what, what an outage
// looks like) is testable against states no machine could be put into on demand.

export interface BriefInput {
  project: string
  // The workspace this directory is, or null when the fold holds none for it.
  cwdWorkspaceId: string | null
  // EVERY workspace, archived included: a task still names its workspace after the operator
  // archives it, and the label has to resolve. The `elsewhere` counts leave archived rows out.
  workspaces: readonly WorkspaceWithHealth[]
  tasks: readonly Pick<TaskNode, 'id' | 'title' | 'status' | 'workspaceId'>[]
  // Decisions in force, in listing order. null = the read model could not be asked — kept apart
  // from [] all the way to the text, because the two call for opposite behaviour from a reader.
  decisions: readonly { id: string; title: string; summary: string }[] | null
  // Knowledge events the read model has not applied yet (MemoryHealth.pending).
  pendingKnowledge: number
  // Already gated by the caller: non-null only when the re-ground advisory fires.
  drift: NonNullable<Brief['drift']> | null
}

const isBriefStatus = (s: TaskStatus): s is BriefTaskStatus => BRIEF_TASK_STATUSES.some(b => b === s)

export function buildBrief(input: BriefInput): Brief {
  const titles = new Map(input.workspaces.map(r => [r.workspace.id, r.workspace.title]))
  const here = input.cwdWorkspaceId
  const listed: BriefTask[] = input.tasks.flatMap(t => isBriefStatus(t.status)
    ? [{ id: t.id, title: t.title, status: t.status, workspaceId: t.workspaceId, workspaceTitle: titles.get(t.workspaceId) ?? null }]
    : [])
  // This checkout's tasks lead within a status: they are what the session most likely opened for.
  // Title then id below that, so two runs over one log print the same brief.
  const away = (t: BriefTask): number => (t.workspaceId === here ? 0 : 1)
  // Capped PER STATUS, not over the whole list: one cap would let a burst of running work push the
  // single plan awaiting approval off the end, and that is the line a human most needs to see.
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
    // Spelled per key, not built with Object.fromEntries: that returns `{ [k: string]: number }`,
    // and only a cast would turn it back into the exhaustive record the contract requires.
    hiddenTasks: {
      [TASK_STATUS.awaiting_approval]: hidden(TASK_STATUS.awaiting_approval),
      [TASK_STATUS.running]: hidden(TASK_STATUS.running),
      [TASK_STATUS.blocked]: hidden(TASK_STATUS.blocked),
    },
    decisions: input.decisions === null ? null : {
      shown: input.decisions.slice(0, BRIEF_LIMITS.decisions).map(d => ({ id: d.id, title: d.title, summary: d.summary })),
      total: input.decisions.length,
    },
    pendingKnowledge: input.pendingKnowledge,
    drift: input.drift,
  }
}

export interface RenderBriefOptions {
  // A PARAMETER for relativeAge's reason: one clock for the whole block.
  now: Date
  // How a drift reading reads to a human is the CLI's vocabulary (it names plan files and commands),
  // and `orc status` prints the same sentence. Passed in so there is one spelling of it and this
  // module never learns what a plan file is.
  driftText: (d: NonNullable<Brief['drift']>) => string
  // A decision's summary cut to one line of at most `maxChars`. The rule is the memory plugin's
  // (adrSummary — the same one that wrote the summary when the decision was recorded); passed in
  // for driftText's reason, so this file's imports stay at contracts and one clock helper.
  oneLine: (text: string, maxChars: number) => string
  // The commands the text points at, built by the command module from the subcommand constants —
  // importing them here would pull commander into a file that prints nothing.
  hints: { workspaces: string; decisions: string }
}

function workspaceLine({ workspace: w, health: h }: WorkspaceWithHealth, now: Date): string {
  // Both unknowns in WORDS rather than `ws ls`'s '-' and '?' cells: that table explains its marks
  // in a footnote, and a line read by a model has no footnote — "0" and "could not count" must
  // differ in the sentence itself. relativeAge answers AGE_UNKNOWN for a stamp it cannot read.
  const age = h.lastActivityAt === null ? AGE_UNKNOWN : relativeAge(h.lastActivityAt, now)
  const prov = h.provisionalNotes === null ? 'provisional notes unknown' : `${h.provisionalNotes} provisional notes`
  const facts = [h.state, `last activity ${age === AGE_UNKNOWN ? 'unknown' : age}`, prov, ...(h.clean === false ? ['uncommitted changes'] : []), ...(h.merged ? ['merged'] : [])]
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

  // Stated rather than omitted: a brief with no task section reads the same as one whose task read
  // failed, and "nothing is waiting on you" is the single most useful thing it can say.
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

  if (brief.decisions === null) lines.push('decisions: unknown — the memory read model could not be reached')
  else if (brief.decisions.shown.length > 0) {
    lines.push(`decisions in force (${brief.decisions.shown.length} of ${brief.decisions.total} — ${opts.hints.decisions}):`)
    for (const d of brief.decisions.shown) {
      const line = opts.oneLine(d.summary, BRIEF_LIMITS.decisionLineChars)
      lines.push(line === '' ? `  ${d.title}` : `  ${d.title} — ${line}`)
    }
  }
  // Only beside decisions that WERE read: when they could not be, the line above already says the
  // whole section is unknown, and "may be behind" would understate that.
  if (brief.decisions !== null && brief.pendingKnowledge > 0)
    lines.push(`decisions may be behind: ${brief.pendingKnowledge} knowledge events are not in the read model yet — ${opts.hints.decisions} catches up`)

  if (brief.drift !== null) lines.push(opts.driftText(brief.drift))
  return lines
}
