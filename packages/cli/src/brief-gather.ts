import { decisionSummaryOf, DecisionStatus, errorMessage, type Brief, type DecisionSummary } from '@orc/contracts'
import type { EventLog, ProjectConfig } from '@orc/kernel'
import { buildBrief } from './brief'
import { findCwdWorkspace, knowledgeAuthor, type WorkspaceFold } from './cwd-workspace'
import { knowledgeHealthOf } from './knowledge-health-of'
import { knowledgeAccess, openKnowledge, type KnowledgeOpening } from './knowledge-open'
import { projectHealth } from './workspace-health'

type BriefOptions = { log: EventLog; config: ProjectConfig; opening?: KnowledgeOpening }
type OpenedBrief = BriefOptions & { opening: KnowledgeOpening }

export async function gatherBrief(given: BriefOptions): Promise<Brief> {
  const opts = { ...given, opening: given.opening ?? openKnowledge(given.config) }
  const { state, rows } = await projectHealth({ ...opts, includeArchived: true })
  const fold = { state: () => Promise.resolve(state) }
  const [knowledge, decisions, here] = await Promise.all([knowledgeHealthOf(opts, fold), decisionsInForce(opts, fold), findCwdWorkspace(fold, opts.config.dir)])
  return buildBrief({
    project: opts.config.projectName,
    cwdWorkspaceId: here?.id ?? null,
    workspaces: rows,
    tasks: [...state.tasks.values()],
    decisions,
    knowledge,
  })
}

const readCall = async (opts: OpenedBrief, fold: WorkspaceFold) => ({
  access: knowledgeAccess(opts.opening, opts.log, opts.config.dir),
  author: await knowledgeAuthor(fold, opts.config.dir),
})

/** Accepted decisions, or null when they could not be read — never an empty list, which would say the project has decided nothing. */
async function decisionsInForce(opts: OpenedBrief, fold: WorkspaceFold): Promise<DecisionSummary[] | null> {
  try {
    const { access, author } = await readCall(opts, fold)
    if ('unavailable' in access) throw new Error(access.unavailable)
    return (await access.port.decisions({ author, idempotencyKey: null }, { status: DecisionStatus.accepted })).map(decisionSummaryOf)
  } catch (err) {
    console.error(`decisions could not be listed: ${errorMessage(err)}`)
    return null
  }
}
