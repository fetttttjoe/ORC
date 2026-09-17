import { MemoryScope, NOTE_TIER, nonEmptyLines, type MemoryStore, type NoteSummary } from '@orc/contracts'
import { gitRevision } from '@orc/kernel'

// The read-only store+git side of the kernel's grounding-freshness probe. The kernel declares the
// GroundingSource shape (grounding-freshness.ts); this satisfies it STRUCTURALLY and does not import
// it, so this subplan typechecks on its own — the composition root (packages/cli) wires the two.
//
// HARD READ-ONLY: nothing here writes a note, an event, or a file. head()/commitsSince() spawn git
// IN PROCESS (never through the exec tool — `git rev-list` is deliberately absent from the exec
// allowlist), and notes() reads NoteSummary rows off the store, so no note body is ever opened.

// The durable grounding family: the arch overview and the per-area semantic notes a grounded task
// re-reads. `area-` requires the dash so a note literally called 'area' or 'areaxyz' is excluded —
// the family is `arch-overview` and `area-<something>`, matched by id since MemoryFilter cannot
// filter by id prefix (it filters scope/category/tag/tier only).
const isGroundingFamily = (id: string): boolean => id === 'arch-overview' || id.startsWith('area-')

export function createGroundingSource(opts: { store: Pick<MemoryStore, 'list'>; dir: string }): {
  head(): Promise<string | null>
  notes(): Promise<{ id: string; sourceRevision: string | null; paths: string[] }[]>
  commitsSince(rev: string, paths: string[]): Promise<number | null>
  changedPaths(rev: string, paths: string[]): Promise<string[] | null>
} {
  const { store, dir } = opts

  // One `git diff --name-only` per DISTINCT (rev, paths) per process, exactly as drift.ts caches per
  // revision — one freshness verdict must not spawn N duplicate gits. Keyed on rev + the ordered
  // path list; two callers asking the same question share the single in-flight promise. Returns
  // only paths within the declared set that changed; [] = nothing changed; null = git could not
  // answer (no repo, unknown revision, non-zero exit, throw). commitsSince is this count, so both
  // probes share the one spawn and the one cache.
  const changedCache = new Map<string, Promise<string[] | null>>()

  return {
    // the runtime's actual HEAD — reuse the package's one git helper rather than a second spawn
    head: () => gitRevision(dir),

    async notes() {
      // PROJECT scope, SEMANTIC tier: the durable knowledge lane. NoteSummary already carries
      // sourceRevision and paths, so this reads the retrieval surface — never a note body.
      const rows: NoteSummary[] = await store.list({ scope: MemoryScope.project, tier: NOTE_TIER.semantic })
      // re-assert the tier locally too: the store applies the filter at the query, but a
      // grounding verdict must never be built on a plan/episodic note that shares an `area-` id.
      return rows
        .filter(n => n.tier === NOTE_TIER.semantic && isGroundingFamily(n.id))
        .map(n => ({ id: n.id, sourceRevision: n.sourceRevision, paths: n.paths }))
    },

    async commitsSince(rev, paths) {
      const changed = await this.changedPaths(rev, paths)
      return changed === null ? null : changed.length
    },

    changedPaths(rev, paths) {
      const key = `${rev}\u0000${paths.join('\u0000')}`
      let hit = changedCache.get(key)
      if (!hit) {
        hit = (async () => {
          try {
            // files under `paths` that differ between `rev` and the WORKING TREE (committed or
            // unstaged) — same working-tree probe as commitsSince above and as drift.ts. NOT
            // `rev..HEAD`, which sees only commits and misses orc's uncommitted edits.
            const proc = Bun.spawn(['git', '-C', dir, 'diff', '--name-only', `${rev}`, '--', ...paths], { stdout: 'pipe', stderr: 'ignore' })
            const out = await new Response(proc.stdout).text()
            // no repo, unknown revision, non-zero exit → null ("cannot answer"; caller falls back to declared paths)
            if ((await proc.exited) !== 0) return null
            return nonEmptyLines(out)
          } catch {
            return null
          }
        })()
        changedCache.set(key, hit)
      }
      return hit
    },
  }
}
