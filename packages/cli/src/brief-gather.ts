import { DECISION_STATUS, errorMessage, MEMORY_HEALTH, type Brief } from '@orc/contracts'
import type { EventLog, ProjectConfig } from '@orc/kernel'
import { listDecisions, needsReground, probeMemory, type DecisionRecord } from '@orc/memory'
import { buildBrief } from './brief'
import { findCwdWorkspace } from './cwd-workspace'
import { withMemory } from './memory-open'
import { projectHealth } from './workspace-health'

/**
 * Reads everything the brief is built from — READS, and nothing else: the brief never drains the
 * projector. Every other decision listing catches the read model up first; here that would make a
 * command that opens every session print the projector's progress lines to stdout (past 50 pending
 * events — observed corrupting `--json`), and on a wiped read model block for as long as the
 * embedder takes, about an hour by the projector's own measurement. So the read model is taken as
 * it stands and the brief carries how far behind it is (`pendingKnowledge`).
 *
 * ONE READ AT A TIME.
 *
 * Sequential on purpose. All three reads open their own Surreal connection, and every open sends
 * the schema batch (`DEFINE … IF NOT EXISTS`, surreal.ts). Run together against a database that did
 * not exist yet, two of the three were refused — "Transaction conflict: Resource busy" — and the
 * fail-soft arms below turned that into a brief reading `decisions: unknown` on a healthy system.
 * Observed on a throwaway test database; the same race is open to the first session of any new
 * project, which is the one brief that most needs to be right.
 *
 * THE PROBE GOES FIRST, and an unreachable read model ends the Surreal reads there. Each open waits
 * out its own 5 s connect timeout, so asking all three of a database that is down held a session's
 * start for 15 s (observed) to learn the same thing three times. One timeout is the ceiling now;
 * the session hook's own timeout is set above it.
 *
 * ponytail: three connections, ~68 ms each by probeMemory's own measurement. The upgrade is one
 * connection serving all three, which removes the race AND the cost, and needs something with a
 * lifecycle to own the handle — the change probeMemory's comment already names.
 */
export async function gatherBrief(opts: { log: EventLog; config: ProjectConfig }): Promise<Brief> {
  // Never throws: an unreachable read model is a MemoryHealth state, not an exception.
  const health = await probeMemory(opts.config, opts.log)
  const reachable = health.state !== MEMORY_HEALTH.unreachable
  const { state, rows } = await projectHealth({
    ...opts,
    // Archived workspaces included: a task outlives the archiving of its workspace and its label
    // still has to resolve. buildBrief keeps them out of the counts.
    includeArchived: true,
    // The seam projectHealth offers for exactly this: a caller that already knows the answer is
    // "could not be counted" says so, and the listing renders it as unknown rather than as zero.
    ...(!reachable && { counts: () => Promise.resolve(null) }),
  })
  const decisions = reachable ? await decisionsInForce(opts) : null
  // The fold above answers "which workspace is this directory" — findCwdWorkspace takes a fold, not
  // a Kernel, so no second read of the log is needed to ask.
  const here = await findCwdWorkspace({ state: () => Promise.resolve(state) }, opts.config.dir)
  return buildBrief({
    project: opts.config.projectName,
    cwdWorkspaceId: here?.id ?? null,
    workspaces: rows,
    tasks: [...state.tasks.values()],
    decisions,
    pendingKnowledge: health.pending,
    drift: health.drift !== undefined && needsReground(health.drift) ? health.drift : null,
  })
}

/**
 * Accepted decisions, or null when the read model could not be asked.
 *
 * NULL, NEVER AN EMPTY LIST — workspace-health.ts's rule for the note count, for the same reason
 * with higher stakes: "this project has decided nothing" tells a session every question is open,
 * and an outage must not be able to say that.
 *
 * REPORTED, then swallowed: the catch has to be blanket (Surreal down, a schema the projector has
 * not migrated, a defect in the listing itself all have to end in a brief rather than a failed
 * session hook), but silent it would report our own bug to the operator as an outage.
 */
async function decisionsInForce(opts: { log: EventLog; config: ProjectConfig }): Promise<DecisionRecord[] | null> {
  // A door whose catch-up is a no-op, where decisionDoor(memory) would wire the projector's: the
  // DecisionDoor seam names exactly the two things a listing touches, so "read it as it stands" is
  // a different door rather than a flag on listDecisions.
  return withMemory(opts, memory => listDecisions({ store: memory.store, catchUp: () => Promise.resolve() }, { status: DECISION_STATUS.accepted }))
    .catch((err: unknown) => {
      console.error(`decisions could not be listed: ${errorMessage(err)}`)
      return null
    })
}
