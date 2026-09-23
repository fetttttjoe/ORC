import { Command } from 'commander'
import { AUTHOR_SOURCE, DecisionInput, DecisionStatus, Door, NO_CHAT } from '@orc/contracts'
import type { EventLog, Kernel, ProjectConfig } from '@orc/kernel'
import { AdrSection, decisionDoor, getDecision, listDecisions, recordDecision, type DecisionDoor, type DecisionRecord } from '@orc/memory'
import { cwdAuthor } from './cwd-workspace'
import { enumArg } from './enum-arg'
import { withMemory } from './memory-open'

// The `orc adr` command surface: commander option parsing and the lines a terminal prints, nothing
// else. What the subcommands DO lives in @orc/memory's decisions.ts, which the MCP/web door calls
// without pulling commander in behind it (ws-commands.ts / workspace-ops.ts precedent).

export const ADR_SUBCOMMAND = { new: 'new', ls: 'ls', show: 'show', supersede: 'supersede' } as const
const parseStatus = enumArg<DecisionStatus>('status', Object.values(DecisionStatus))

// Pure, so the rendering is testable without a store. `→ <id>` names the superseding decision: an
// operator reading a superseded row wants the replacement, not just the verdict.
export function renderDecisionList(rows: readonly DecisionRecord[]): string[] {
  if (rows.length === 0) return ['_no decisions_']
  return rows.map(r => `${r.id.padEnd(40)} ${r.status.padEnd(10)} ${r.updatedAt.slice(0, 10)}  ${r.createdBy.padEnd(12)} ${r.title}${r.supersededBy ? `  → ${r.supersededBy}` : ''}`)
}

interface SectionOpts { context: string; decision: string; consequences: string; considered?: string[]; status?: DecisionStatus; tags?: string[] }

// The three ADR sections plus the two fields a human decides at recording time, shared by `new` and
// `supersede` — the two differ only in whether an old id is named, and a second spelling of the
// flags is how the two subcommands end up accepting different vocabularies for one input schema.
const sectionOptions = (c: Command): Command => c
  .requiredOption('--context <text>', 'why this decision was needed (the forces at play)')
  .requiredOption('--decision <text>', 'what was decided, as a statement another agent can act on')
  .requiredOption('--consequences <text>', 'what follows — what becomes easier, harder, or forbidden')
  .option('--considered <options...>', 'the alternatives weighed and not taken, one per argument')
  .option('--status <s>', `${Object.values(DecisionStatus).join(' | ')} (default accepted: a recorded decision is presumed in force)`, parseStatus)
  .option('--tags <tags...>', 'tags')

export function adrCommand(deps: {
  requireKernel: () => Kernel
  // ONE optional dep, not a config and a log that are independently optional (wsCommand's rule):
  // every subcommand needs both — the log the store appends to and the config naming the read model
  // it lists out of — so two half-present fields would let a caller wire half a project context
  // that fails one subcommand deep instead of at the door.
  project?: { config: ProjectConfig; log: EventLog }
}): Command {
  const adr = new Command('adr').description('architectural decisions: record, list, show, supersede (human-authored)')
  // Same shape as main.ts's needPlugin: a handler that reached a project-less context says so
  // instead of failing on an undefined config one call deeper.
  const needProject = () => {
    if (!deps.project) throw new Error('adr commands need a project context')
    return deps.project
  }
  // One open → work → close bracket per invocation, and the door the ops need: the store plus the
  // projector's drain. NO author — an author is a WRITE-side fact, and resolving one here coupled
  // `ls` and `show` to workspace adoption: cwdAuthor throws in a checkout no workspace claims, so
  // reading the decisions would have failed where writing one legitimately cannot.
  const withDoor = <T>(body: (door: DecisionDoor) => Promise<T>): Promise<T> => {
    const { config, log } = needProject()
    return withMemory({ log, config }, memory => body(decisionDoor(memory)))
  }
  const record = async (title: string, o: SectionOpts, supersedes?: string): Promise<void> => {
    // Conditional spread, not a bare `status: o.status`: DecisionInput leaves `status` optional so
    // that "no status" stays absent all the way to decisionStatusOf, and an explicit undefined here
    // would be a field the schema then has to distinguish from a real one.
    const input = DecisionInput.parse({ title, context: o.context, decision: o.decision, consequences: o.consequences, ...(o.considered !== undefined && { considered: o.considered }), ...(o.status !== undefined && { status: o.status }), ...(o.tags !== undefined && { tags: o.tags }), ...(supersedes !== undefined && { supersedes }) })
    // `human`, unconditionally: a person typed this decision (contracts ids.ts). Resolved BEFORE the
    // door opens, so a checkout with no workspace refuses without a Surreal connection to close.
    const author = await cwdAuthor(deps.requireKernel(), needProject().config.dir, AUTHOR_SOURCE.human, NO_CHAT(Door.cli))
    const r = await withDoor(door => recordDecision(door, author, input))
    console.log(`recorded decision '${r.note.id}' (${r.status}) — read it back: orc adr ${ADR_SUBCOMMAND.show} ${r.note.id}`)
    if (r.superseded !== null) console.log(`superseded '${r.superseded}'`)
  }

  sectionOptions(adr.command(`${ADR_SUBCOMMAND.new} <title>`).description('record a decision (id = slugged title)'))
    .action((title: string, o: SectionOpts) => record(title, o))
  sectionOptions(adr.command(`${ADR_SUBCOMMAND.supersede} <oldId> <title>`).description('record a decision that replaces an existing one; the old decision is marked superseded'))
    .action((oldId: string, title: string, o: SectionOpts) => record(title, o, oldId))
  adr.command(ADR_SUBCOMMAND.ls).description('list decisions, attention-first (proposed → accepted → deprecated → superseded)')
    .option('--status <s>', `only: ${Object.values(DecisionStatus).join(' | ')}`, parseStatus)
    .option('--json', 'machine-readable rows')
    .action(async (o: { status?: DecisionStatus; json?: boolean }) => {
      const rows = await withDoor(door => listDecisions(door, { ...(o.status !== undefined && { status: o.status }) }))
      if (o.json) console.log(JSON.stringify(rows, null, 2))
      else for (const line of renderDecisionList(rows)) console.log(line)
    })
  adr.command(`${ADR_SUBCOMMAND.show} <id>`).description('print one decision: status, provenance, and its Context / Decision / Consequences')
    .action(async (id: string) => {
      const v = await withDoor(door => getDecision(door, id))
      console.log(`# ${v.note.title}`)
      console.log(`id: ${v.note.id}\nstatus: ${v.status}\ncreatedBy: ${v.note.createdBy}\nupdatedAt: ${v.note.updatedAt}\ntags: ${v.note.tags.join(', ')}`)
      // A decision note can be written at doors that never saw the ADR layout (`orc memory add
      // --kind decision`, an agent's memory_write), and parseAdrBody answers null for those.
      // Printing the raw body beats inventing three sections the writer did not author.
      if (v.fields === null) {
        console.log('(body is not in ADR layout — written outside orc adr; printed verbatim)')
        console.log(v.note.body)
        return
      }
      const sections: [string, string][] = [[AdrSection.context, v.fields.context], [AdrSection.decision, v.fields.decision], [AdrSection.consequences, v.fields.consequences]]
      if (v.fields.considered.length > 0) sections.push([AdrSection.considered, v.fields.considered.map(o => `- ${o}`).join('\n')])
      for (const [name, text] of sections)
        console.log(`\n## ${name}\n\n${text}`)
    })
  return adr
}
