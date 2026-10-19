import { Command } from 'commander'
import { Door, NO_CHAT, type WorkspaceWithHealth } from '@orc/contracts'
import type { WorkspaceDoor } from './door-kernel'
import { HEAD_REF, type WorkspaceConfig } from './workspace-ops'
import { findCwdWorkspace } from './cwd-workspace'
import { AGE_UNKNOWN, relativeAge } from './relative-age'

// The `orc ws` command surface: commander option parsing and the lines a terminal prints, and
// nothing else. What the subcommands DO lives in workspace-ops.ts, which the MCP/web door calls
// without pulling commander in behind it.

// Every `orc ws` mutation entered through this terminal: the door names it once, here.
const CLI_ORIGIN = NO_CHAT(Door.cli)

export const WS_NEEDS_PROJECT = 'ws commands need a project context'

export const WS_SUBCOMMAND = { new: 'new', ls: 'ls', current: 'current', retitle: 'retitle', archive: 'archive', restore: 'restore', merge: 'merge', finalize: 'finalize' } as const

/**
 * The `ws ls` table, as lines — pure, so the rendering is testable against health values that no
 * checkout on this machine could produce.
 *
 * `now` is a PARAMETER for the reason relativeAge takes one: one clock for the whole listing, so two
 * rows read a tick apart cannot disagree about "today".
 */
export function renderWorkspaceList(rows: readonly WorkspaceWithHealth[], now: Date): string[] {
  if (rows.length === 0) return ['_no workspaces_']
  return rows.map(({ workspace: w, health: h }) => {
    const age = h.lastActivityAt === null ? AGE_UNKNOWN : relativeAge(h.lastActivityAt, now)
    // `[dirty]` is uncommitted work — what a merge of this workspace would NOT carry. Shown
    // beside the state rather than folded into it: it is the operator's own work, not a verdict.
    //
    // `[merged]` is here rather than in the state column because the column cannot hold it: every
    // rung above `merged` shadows that state, so a landed workspace that is running again prints
    // `active` and the terminal would say nothing at all about whether the work reached trunk.
    const flags = `${w.archivedAt ? '[archived] ' : ''}${h.merged ? '[merged] ' : ''}${h.clean === false ? '[dirty] ' : ''}`
    return `${w.id}  ${h.state.padEnd(9)} ${age.padStart(7)}  ${w.kind.padEnd(8)} ${(w.branch ?? '-').padEnd(28)} ${String(h.taskCount).padStart(3)} tasks  ${flags}${w.title}  ${w.cwd}`
  })
}

export function wsCommand(deps: {
  // A thunk lets help register commands without a kernel. The returned door exposes workspace
  // mutations that require an origin, withholding the raw kernel from this adapter.
  requireDoor: () => WorkspaceDoor
}): Command {
  const ws = new Command('ws').description('workspaces: one checkout per request (a plain git checkout, or an orc-created worktree)')
  const needConfig = (): WorkspaceConfig => deps.requireDoor().config()

  ws.command(`${WS_SUBCOMMAND.new} <title>`)
    .description('create a git worktree + branch for one request under .orc/worktrees, record it as a workspace, and draft the request as its first task')
    .option('--spec <text>', 'the request itself (goal, constraints, outputs); the title is a label', '')
    .option('--base <ref>', 'start point for the branch (default: HEAD of this checkout)', HEAD_REF)
    .option('--no-task', 'create only the workspace')
    .action(async (title: string, o: { spec: string; base: string; task: boolean }) => {
      const r = await deps.requireDoor().workspaces.create({ title, ...o }, CLI_ORIGIN)
      console.log(`workspace ${r.workspace.id}  ${r.branch} ← ${r.base}\n${r.taskId ? `task ${r.taskId}` : 'no task (--no-task)'}\ncd ${r.workspace.cwd}`)
    })

  ws.command(WS_SUBCOMMAND.ls).description('list workspaces with their state (dangling/waiting/active/idle/merged), age and task counts').option('--all', 'include archived')
    .action(async (o: { all?: boolean }) => {
      // The verdict is DERIVED ONCE, by the same call the MCP door and the console make — this
      // command only prints it. A second reading here of "does the directory still exist" is how
      // three surfaces end up telling an operator three different things about one checkout.
      const rows = await deps.requireDoor().listWorkspaces(o.all === true)
      for (const line of renderWorkspaceList(rows, new Date())) console.log(line)
    })

  ws.command(WS_SUBCOMMAND.current).description('the workspace this directory is')
    .action(async () => {
      // Through the shared cwd lookup, never a second `workspaceByCwd(..., realpathSync(dir))` here:
      // the realpath policy IS the match (the fold keys on the resolved string), and a command file
      // with its own copy is how `ws current` and the task-creating doors end up disagreeing about
      // which record this directory is.
      const w = await findCwdWorkspace(deps.requireDoor().reads, needConfig().dir)
      // Boot adoption records this checkout before any handler runs, so the miss is reachable only
      // while the fold is still behind the log — which one more command settles.
      console.log(w ? `${w.id}  ${w.title}  (${w.kind}, ${w.branch ?? 'detached'})` : '_not adopted yet — rerun any orc command_')
    })

  ws.command(`${WS_SUBCOMMAND.retitle} <id> <title>`).description('rename a workspace (the label only — never its branch or directory)')
    .action(async (id: string, title: string) => {
      const w = await deps.requireDoor().workspaces.retitle(id, title, CLI_ORIGIN)
      console.log(`${w.id}  ${w.title}`)
    })

  ws.command(`${WS_SUBCOMMAND.archive} <id>`).description('archive a workspace; --remove also deletes an orc-managed, clean worktree')
    .option('--remove', 'git worktree remove (managed + clean only)')
    .action(async (id: string, o: { remove?: boolean }) => {
      // needConfig() only on the --remove path: archiving the RECORD works in a checkout-less
      // context today, and asking for a project root up here would take that away.
      const r = await deps.requireDoor().workspaces.archive(id,
        o.remove === true ? { remove: true, projectRoot: needConfig().projectRoot } : { remove: false }, CLI_ORIGIN)
      const out = [`archived ${r.workspaceId}${r.removedWorktree === null ? '' : ' and removed its worktree'}`]
      if (r.leftoverBranch !== null)
        out.push(`branch ${r.leftoverBranch} is left behind (orc never deletes a branch) — drop it with: git branch -D ${r.leftoverBranch}`)
      console.log(out.join('\n'))
    })

  ws.command(`${WS_SUBCOMMAND.merge} <id>`)
    .description('merge the workspace\'s branch into trunk (--no-ff), record the merge, archive it and remove its orc-managed worktree')
    .action(async (id: string) => {
      const r = await deps.requireDoor().workspaces.merge(id, CLI_ORIGIN)
      const out = [`merged ${r.branch} into ${r.trunk} as ${r.mergeCommit}`, `archived workspace ${r.workspaceId}`]
      if (r.removedWorktree !== null) out.push(`removed the worktree at ${r.removedWorktree}`)
      console.log([...out, ...r.warnings].join('\n'))
    })

  ws.command(`${WS_SUBCOMMAND.finalize} <id>`)
    .description('record a merge that happened outside orc — the workspace\'s branch must already be contained in trunk')
    .action(async (id: string) => {
      const r = await deps.requireDoor().workspaces.finalize(id, CLI_ORIGIN)
      console.log(`recorded ${r.branch} merged into ${r.trunk} at ${r.mergeCommit}\narchived workspace ${r.workspaceId}`)
    })

  ws.command(`${WS_SUBCOMMAND.restore} <id>`).description('un-archive a workspace (the record only — a removed worktree is gone)')
    .action(async (id: string) => {
      await deps.requireDoor().workspaces.restore(id, CLI_ORIGIN)
      console.log(`restored ${id}`)
    })
  return ws
}
