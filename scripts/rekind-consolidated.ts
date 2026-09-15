// ONE-SHOT (2026-08-04): re-kind historical task consolidations from `decision` to `outcome`.
//
// Consolidations were written `kind: 'decision'` until `outcome` existed. Measured on the live
// vault the day this was written: ALL 42 notes carrying `decision` were outcome-<uuid>
// consolidations, and not one was an architectural choice — so "which decisions has this project
// made" returned 42 task outcomes and zero decisions. plugins/memory/src/consolidate.ts now writes
// `outcome`, but changing the writer does not re-kind history: every prior note still claims the
// kind, and a decision query stays unusable until they are moved.
//
// Run inside a project:
//   bun scripts/rekind-consolidated.ts           # dry run — lists what WOULD move
//   bun scripts/rekind-consolidated.ts --apply   # writes
//
// Dry-run by default, matching `orc memory recheck`'s --apply convention: a bulk rewrite of the
// knowledge graph is not something to discover you have done.
//
// SAFE TO RE-RUN. Idempotent (a second pass matches nothing), and non-destructive: a write is an
// append, merge-on-omit carries every unrestated field forward untouched, and every prior revision
// stays in the event log. Modelled on plugins/memory/src/restamp.ts, the established shape for a
// bulk re-write through the store gateway.
import { Kernel, loadConfig, openStorage, requireProject } from '../packages/kernel/src/index'
import { cwdAuthor } from '../packages/cli/src/cwd-workspace'
import { createMemory } from '../plugins/memory/src/index'
import { CONSOLIDATED_TAG } from '../plugins/memory/src/consolidate'
import { AUTHOR_SOURCE, NOTE_KIND } from '../packages/contracts/src/index'

const apply = process.argv.includes('--apply')

const config = requireProject(loadConfig())
const storage = await openStorage(config.databaseUrl, { projectId: config.projectId })
const memory = await createMemory({ log: storage.events, config })

try {
  // The exact selector, not a guess: CONSOLIDATED_TAG is what consolidatedNote stamps and nothing
  // else uses, and the `kind` filter narrows to the ones that have not moved yet. Filtering here
  // rather than in TS because NoteSummary carries no `kind` — the filter reaches the row, which does.
  const stale = await memory.store.list({ tag: CONSOLIDATED_TAG, kind: NOTE_KIND.decision })

  if (stale.length === 0) {
    console.log(`nothing to do — no '${CONSOLIDATED_TAG}' note still claims kind '${NOTE_KIND.decision}'`)
  } else {
    for (const n of stale) console.log(`  ${n.scope}/${n.id} — ${n.title}`)
    console.log(`\n${stale.length} consolidation(s) claiming '${NOTE_KIND.decision}'`)

    if (!apply) {
      console.log(`dry run — re-run with --apply to move them to '${NOTE_KIND.outcome}'`)
    } else {
      // id + scope + kind ONLY. Every other field is omitted so the store gateway's merge-on-omit
      // carries the stored value forward; naming them would risk writing back a stale copy.
      // The workspace this script is being run from, resolved ONCE: a bulk re-write is still a
      // write, and MemoryAuthor.workspaceId has no default to fall back on.
      const author = await cwdAuthor(new Kernel(storage.events), config.dir, AUTHOR_SOURCE.cli)
      for (const n of stale)
        await memory.store.write({ id: n.id, scope: n.scope, kind: NOTE_KIND.outcome }, author)
      await memory.projector.catchUp()
      console.log(`re-kinded ${stale.length} note(s) to '${NOTE_KIND.outcome}'`)
    }
  }
} finally {
  // unconditional: a throw mid-body must not leak the Surreal connection for the life of the process
  await memory.close()
  await storage.close()
}
