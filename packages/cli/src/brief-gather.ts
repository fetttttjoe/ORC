import { AUTHOR_SOURCE, decisionSummaryOf, DecisionStatus, Door, errorMessage, MEMORY_HEALTH, NO_CHAT, type Brief, type DecisionSummary } from '@orc/contracts'
import type { EventLog, ProjectConfig } from '@orc/kernel'
import { needsReground, probeMemory } from '@orc/memory'
import { buildBrief } from './brief'
import { cwdAuthor, findCwdWorkspace, type WorkspaceFold } from './cwd-workspace'
import { knowledgeAccess, openKnowledge, type KnowledgeOpening } from './knowledge-open'
import { projectHealth } from './workspace-health'

export async function gatherBrief(opts: { log: EventLog; config: ProjectConfig; opening?: KnowledgeOpening }): Promise<Brief> {
  const health = await probeMemory(opts.config, opts.log)
  const reachable = health.state !== MEMORY_HEALTH.unreachable
  const { state, rows } = await projectHealth({
    ...opts,
    includeArchived: true,
    ...(!reachable && { counts: () => Promise.resolve(null) }),
  })
  const fold = { state: () => Promise.resolve(state) }
  const decisions = await decisionsInForce(opts, fold)
  const here = await findCwdWorkspace(fold, opts.config.dir)
  return buildBrief({
    project: opts.config.projectName,
    cwdWorkspaceId: here?.id ?? null,
    workspaces: rows,
    tasks: [...state.tasks.values()],
    decisions,
    drift: health.drift !== undefined && needsReground(health.drift) ? health.drift : null,
  })
}

/** Accepted decisions, or null when they could not be read — never an empty list, which would say the project has decided nothing. */
async function decisionsInForce(opts: { log: EventLog; config: ProjectConfig; opening?: KnowledgeOpening }, fold: WorkspaceFold): Promise<DecisionSummary[] | null> {
  try {
    const access = knowledgeAccess(opts.opening ?? openKnowledge(opts.config), opts.log, opts.config.dir)
    if ('unavailable' in access) throw new Error(access.unavailable)
    const author = await cwdAuthor(fold, opts.config.dir, AUTHOR_SOURCE.cli, NO_CHAT(Door.cli))
    return (await access.port.decisions({ author, idempotencyKey: null }, { status: DecisionStatus.accepted })).map(decisionSummaryOf)
  } catch (err) {
    console.error(`decisions could not be listed: ${errorMessage(err)}`)
    return null
  }
}
