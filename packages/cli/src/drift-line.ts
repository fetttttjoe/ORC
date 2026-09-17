import { needsReground } from '@orc/memory'
import type { MemoryHealth } from '@orc/contracts'

// How a drift reading reads at the terminal, and the two plan files it points at. Its own file
// because two command modules print it (`orc status` and the supervisor banner in main.ts, the
// session brief in brief-commands.ts) and a command module importing main.ts would import the
// program that imports it.

// The committed plan that re-grounds a drifted graph. ONE spelling: the status line and the
// supervisor banner both name it, and it is a real path a reader will paste. Exported so
// shipped-skills.test.ts's driftLine pins assert against the same string driftLine actually
// prints, rather than a second copy of the path that could drift from this one.
export const REGROUND_PLAN = 'docs/kb-build-parallel.plan.json'

// The targeted instrument, for a graph with a handful of stale notes: one auditor step that walks
// the notes memory_search already flags drifted and heals or confirms each via
// memory_write/memory_verify, writing no source files. Below the re-ground threshold
// (needsReground) this is what the advisory names — ~10 drifted notes do not justify re-deriving
// every area note from scratch, which is all REGROUND_PLAN can do.
// Exported for the same reason as REGROUND_PLAN: shipped-skills.test.ts reads the tracked plan
// file at this path and pins driftLine's below-threshold wording against it — one spelling, so a
// rename here cannot leave either check pointed at a path that no longer exists.
export const REGROUND_HEAL_PLAN = 'docs/reground-heal.plan.json'

// How a drift reading reads to a human. Lives here, not in the memory plugin: which command to
// recommend is a CLI concern, and a measurement module that builds prose ends up shipping a
// hardcoded path inside a pure function. Exported so shipped-skills.test.ts can pin each branch's
// wording without re-typing REGROUND_PLAN/REGROUND_HEAL_PLAN as a second literal.
export const driftLine = (d: NonNullable<MemoryHealth['drift']>): string => {
  const pct = Math.round(d.ratio * 100)
  return needsReground(d)
    ? `knowledge drift: at least ${d.drifted}/${d.checkable} checkable notes (${pct}%) describe code changed since they were written — something moved this repo without going through orc. Re-ground: orc propose <task> --file ${REGROUND_PLAN}`
    : `knowledge drift: ${d.drifted}/${d.checkable} checkable notes (${pct}%) describe code that has since changed — heal: orc propose <task> --file ${REGROUND_HEAL_PLAN}`
}
