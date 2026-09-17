import { Command } from 'commander'
import type { EventLog, ProjectConfig } from '@orc/kernel'
import { adrSummary } from '@orc/memory'
import { ADR_SUBCOMMAND } from './adr-commands'
import { renderBrief } from './brief'
import { gatherBrief } from './brief-gather'
import { driftLine } from './drift-line'
import { WS_SUBCOMMAND } from './ws-commands'

// The `orc brief` command surface: commander option parsing and what a terminal prints, nothing
// else. What the brief SAYS is brief.ts; where it reads from is brief-gather.ts.

export const BRIEF_COMMAND = 'brief'

// The commands the text sends a reader to, from the constants the commands themselves are
// registered under — a renamed subcommand then changes the brief in the same edit.
const HINTS = { workspaces: `orc ws ${WS_SUBCOMMAND.ls}`, decisions: `orc adr ${ADR_SUBCOMMAND.ls}` } as const

export function briefCommand(deps: {
  // ONE optional dep (wsCommand's rule): the brief reads the log and the read model the config
  // names, and two independently optional fields would let a caller wire half a project.
  project?: { config: ProjectConfig; log: EventLog }
}): Command {
  return new Command(BRIEF_COMMAND)
    .description('what a new session should know: this workspace, tasks waiting on someone, decisions in force, knowledge drift')
    .option('--json', 'the same facts as one JSON value')
    .action(async (o: { json?: boolean }) => {
      if (!deps.project) throw new Error('brief needs a project context')
      const brief = await gatherBrief(deps.project)
      if (o.json) console.log(JSON.stringify(brief, null, 2))
      else for (const line of renderBrief(brief, { now: new Date(), driftText: driftLine, oneLine: adrSummary, hints: HINTS })) console.log(line)
    })
}
