import { Command } from 'commander'
import { AdrSection, AUTHOR_SOURCE, decisionSummaryOf, DecisionStatus, Door, NO_CHAT, type Decision, type DecisionInputRaw, type KnowledgePort } from '@orc/contracts'
import type { EventLog, Kernel, ProjectConfig } from '@orc/kernel'
import { cwdAuthor, knowledgeAuthor } from './cwd-workspace'
import { enumArg } from './enum-arg'
import { NO_PROJECT_ERROR } from './exit'
import { knowledgeAccess, openKnowledge, type KnowledgeOpening } from './knowledge-open'

export const ADR_SUBCOMMAND = { new: 'new', ls: 'ls', show: 'show', supersede: 'supersede' } as const
const RECORDABLE_STATUSES = Object.values(DecisionStatus).filter(s => s !== DecisionStatus.superseded)
const parseAnyStatus = enumArg<DecisionStatus>('status', Object.values(DecisionStatus))
const parseStatus = enumArg<DecisionStatus>('status', RECORDABLE_STATUSES)

export function renderDecisionList(rows: readonly Decision[]): string[] {
  if (rows.length === 0) return ['_no decisions_']
  const width = Math.max(...rows.map(d => d.id.length))
  return rows.map(d => `${d.id.padEnd(width)} ${d.status.padEnd(10)} ${d.date}  ${d.title}${d.supersededBy ? `  → ${d.supersededBy}` : ''}`)
}

const factLine = (key: string, value: string | null): string[] => (value === null || value === '' ? [] : [`${key}: ${value}`])

export function renderDecision(d: Decision): string[] {
  const considered = d.considered.map(o => `- ${o}`).join('\n')
  const sections: Array<readonly [AdrSection, string]> = [
    [AdrSection.context, d.context], [AdrSection.decision, d.decision], [AdrSection.consequences, d.consequences],
    ...(d.considered.length > 0 ? [[AdrSection.considered, considered] as const] : []),
  ]
  return [
    `# ${d.title}`,
    ...factLine('id', d.id), ...factLine('status', d.status), ...factLine('date', d.date),
    ...factLine('tags', d.tags.join(', ')), ...factLine('supersedes', d.supersedes), ...factLine('superseded by', d.supersededBy),
    ...factLine('file', d.location),
    ...sections.map(([name, text]) => `\n## ${name}\n\n${text}`),
  ]
}

interface SectionOpts { context: string; decision: string; consequences: string; considered?: string[]; status?: DecisionStatus; tags?: string[] }

const sectionOptions = (c: Command): Command => c
  .requiredOption('--context <text>', 'why this decision was needed (the forces at play)')
  .requiredOption('--decision <text>', 'what was decided, as a statement another agent can act on')
  .requiredOption('--consequences <text>', 'what follows — what becomes easier, harder, or forbidden')
  .option('--considered <options...>', 'the alternatives weighed and not taken, one per argument')
  .option('--status <s>', `${RECORDABLE_STATUSES.join(' | ')} (default accepted: a recorded decision is presumed in force)`, parseStatus)
  .option('--tags <tags...>', 'tags')

export function adrCommand(deps: {
  requireKernel: () => Kernel
  project?: { config: ProjectConfig; log: EventLog }
  opening?: KnowledgeOpening
  noProject?: (message: string) => unknown
}): Command {
  const adr = new Command('adr').description('architectural decisions as files in the repo: record, list, show, supersede')
  const needProject = () => {
    if (!deps.project) throw (deps.noProject ?? NO_PROJECT_ERROR)('adr commands need a project context')
    return deps.project
  }
  const port = (): KnowledgePort => {
    const { config, log } = needProject()
    const access = knowledgeAccess(deps.opening ?? openKnowledge(config), log, config.dir)
    if ('unavailable' in access) throw new Error(access.unavailable)
    return access.port
  }
  const readCall = async () => ({ author: await knowledgeAuthor(deps.requireKernel(), needProject().config.dir), idempotencyKey: null })
  const record = async (title: string, o: SectionOpts, supersedes?: string): Promise<void> => {
    const input: DecisionInputRaw = { title, context: o.context, decision: o.decision, consequences: o.consequences, ...(o.considered !== undefined && { considered: o.considered }), ...(o.status !== undefined && { status: o.status }), ...(o.tags !== undefined && { tags: o.tags }), ...(supersedes !== undefined && { supersedes }) }
    const knowledge = port()
    const author = await cwdAuthor(deps.requireKernel(), needProject().config.dir, AUTHOR_SOURCE.human, NO_CHAT(Door.cli))
    const r = await knowledge.recordDecision({ author, idempotencyKey: null }, input)
    console.log(`recorded decision '${r.recorded.id}' (${r.status}) — ${r.recorded.location}`)
    if (r.superseded !== null) console.log(`superseded '${r.superseded.id}'`)
  }

  sectionOptions(adr.command(`${ADR_SUBCOMMAND.new} <title>`).description('record a decision (id = slugged title)'))
    .action((title: string, o: SectionOpts) => record(title, o))
  sectionOptions(adr.command(`${ADR_SUBCOMMAND.supersede} <oldId> <title>`).description('record a decision that replaces an existing one; the old decision is marked superseded'))
    .action((oldId: string, title: string, o: SectionOpts) => record(title, o, oldId))
  adr.command(ADR_SUBCOMMAND.ls).description('list decisions, attention-first (proposed → accepted → deprecated → superseded)')
    .option('--status <s>', `only: ${Object.values(DecisionStatus).join(' | ')}`, parseAnyStatus)
    .option('--json', 'machine-readable rows')
    .action(async (o: { status?: DecisionStatus; json?: boolean }) => {
      const rows = await port().decisions(await readCall(), { ...(o.status !== undefined && { status: o.status }) })
      if (o.json) console.log(JSON.stringify(rows.map(decisionSummaryOf), null, 2))
      else for (const line of renderDecisionList(rows)) console.log(line)
    })
  adr.command(`${ADR_SUBCOMMAND.show} <id>`).description('print one decision: status, date, file, and its Context / Decision / Consequences')
    .action(async (id: string) => {
      for (const line of renderDecision(await port().decision(await readCall(), id))) console.log(line)
    })
  return adr
}
