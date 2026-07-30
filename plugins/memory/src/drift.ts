// Has the code a note describes moved since the note was written?
//
// Distinct from sweep.ts's `staleNotes`, which retires EXPIRABLE notes nobody has touched in N days
// — that axis is age and access. This one is correctness: a six-month-old note about an untouched
// file is still true, a ten-minute-old note about a file just refactored is not. Age would rank
// both backwards, which is why this reads `sourceRevision` (the commit each note was stamped with
// at write time) instead of a timestamp.
//
// Detection alone would only make the graph bigger and less trustworthy, so the loop closes on the
// write side: memory_write is an upsert and the store re-stamps sourceRevision from current HEAD,
// so an agent that re-grounds a drifted note and writes it back under the SAME id clears the drift.
// Correcting a note is the same call as writing one.

// Every check fails toward "not drifted". A note we cannot check is not evidence of rot, and
// treating unknown as drifted collapses the graph back into re-read-everything — the exact cost
// the graph exists to avoid.
export interface NoteDrift { sourceRevision: string | null; paths: readonly string[] }

// `changed` is null when the comparison could not be made at all (no repo, unreachable revision).
export function noteHasDrifted(note: NoteDrift, changed: ReadonlySet<string> | null): boolean {
  if (changed === null || note.sourceRevision === null || note.paths.length === 0) return false
  for (const p of note.paths) {
    // linear scan rather than /\/+$/, which CodeQL flags as polynomial on agent-authored input.
    // A note may declare 'packages/kernel/' or 'packages/kernel'.
    let end = p.length
    while (end > 0 && p[end - 1] === '/') end -= 1
    const declared = p.slice(0, end)
    if (declared === '') continue
    for (const f of changed)
      // a note may point at a FILE or a directory; a directory drifts when anything under it does
      if (f === declared || f.startsWith(`${declared}/`)) return true
  }
  return false
}

// Files differing between `rev` and the working tree — the working tree, not HEAD, because a note
// describes what was on disk when it was written and an uncommitted edit has already invalidated it.
export type ChangedSince = (rev: string) => Promise<ReadonlySet<string> | null>

// The EITHER-CLEAN rule, and the one function every drift verdict should go through.
//
// A note carries two INDEPENDENT answers to "when was this last known true": `sourceRevision`, which
// the store stamps at write time, and `verified.revision`, which an auditor declared by calling
// memory_verify. The fresher one governs — a note whose code moved after it was written but before
// an auditor read it against the tree is not stale, and flagging it sends the next agent to re-derive
// knowledge that was just confirmed. That was the observed loop: the heal pass re-verified notes
// nothing had changed, because a verification could not clear anything.
//
// Composed HERE rather than inside noteHasDrifted so that stays the single-set primitive both terms
// call — and every rule it already commits to carries through unchanged. In particular the
// fail-toward-not-drifted rule applies to the verified stamp too: an unreachable verified revision
// (changedSince → null) is UNKNOWN, and unknown is never evidence of rot.
export async function noteDrifted(
  note: NoteDrift & { verified?: { revision: string } },
  changedSince: ChangedSince,
): Promise<boolean> {
  if (note.sourceRevision === null || note.paths.length === 0) return false
  if (!noteHasDrifted(note, await changedSince(note.sourceRevision))) return false
  if (!note.verified) return true
  const v = note.verified.revision
  // one git diff per DISTINCT revision — createDriftProbe caches, so the second probe is free
  // whenever a run's notes share a verification revision (they do: one commit, one auditor pass)
  return noteHasDrifted({ sourceRevision: v, paths: note.paths }, await changedSince(v))
}

// One `git diff` per distinct revision per process. Notes written in the same run share a revision,
// so this collapses to a single call in practice.
export function createDriftProbe(dir: string): ChangedSince {
  const cache = new Map<string, Promise<ReadonlySet<string> | null>>()
  return rev => {
    let hit = cache.get(rev)
    if (!hit) {
      hit = (async () => {
        try {
          const proc = Bun.spawn(['git', '-C', dir, 'diff', '--name-only', rev, '--'], { stdout: 'pipe', stderr: 'ignore' })
          const out = await new Response(proc.stdout).text()
          // a revision git cannot reach (rebased away, shallow clone) is UNKNOWN, never "drifted"
          if ((await proc.exited) !== 0) return null
          return new Set(out.split('\n').map(l => l.trim()).filter(l => l !== ''))
        } catch {
          return null
        }
      })()
      cache.set(rev, hit)
    }
    return hit
  }
}

// ─── corpus-level drift ──────────────────────────────────────────────────────────────────────
//
// `noteHasDrifted` answers "is THIS note stale" for a reader pulling one. It cannot say that the
// GRAPH has fallen behind — when the repo moves without orc (another editor, a merge, a refactor
// landed elsewhere) every affected note is flagged individually, an agent works around them one at
// a time, and nothing ever suggests re-grounding.
//
// UNDERCOUNTS by construction: `paths` are DECLARED, so a note naming none is uncheckable and
// counts as not-drifted (the module's "fail toward not drifted" rule). Report "at least".
export interface CorpusDrift {
  checkable: number // notes carrying both a sourceRevision and at least one declared path
  drifted: number
  total: number
  /** drifted / checkable, or null when nothing could be checked — never a fabricated 0. */
  ratio: number | null
}

// Past this share of checkable notes, the graph has fallen far enough behind the tree that
// re-grounding beats patching it one note at a time. A guess, and labelled as one: it is a prompt
// for a human decision, never a trigger — a rebuild firing on its own because someone rebased would
// cost more than the staleness it cures.
export const CORPUS_DRIFT_ADVISORY = 0.34

export async function corpusDrift(
  notes: ReadonlyArray<{ sourceRevision: string | null; paths?: readonly string[]; verified?: { revision: string } }>,
  changedSince: ChangedSince,
): Promise<CorpusDrift> {
  let checkable = 0
  let drifted = 0
  for (const n of notes) {
    const paths = n.paths ?? []
    if (n.sourceRevision === null || paths.length === 0) continue
    checkable += 1
    // one git diff per DISTINCT revision — notes from one run share theirs, so this collapses
    const changed = await changedSince(n.sourceRevision)
    if (changed === null) { checkable -= 1; continue } // unreachable revision is unknown, not drifted
    // the SOURCE stamp alone decides CHECKABILITY (a verification cannot make an unstamped or
    // path-less note checkable), then noteDrifted's either-clean rule decides the verdict — one
    // spelling of that rule, so the corpus ratio and the per-note flag cannot answer differently
    if (await noteDrifted({ sourceRevision: n.sourceRevision, paths, ...(n.verified && { verified: n.verified }) }, changedSince)) drifted += 1
  }
  return { checkable, drifted, total: notes.length, ratio: checkable === 0 ? null : drifted / checkable }
}

// Has the graph fallen far enough behind to be worth re-grounding wholesale? A verdict, not a
// sentence: what to SAY about it, and which command to name, belongs to whoever is talking to a
// human. This module measures.
// Takes only what it reads, so a caller holding a narrower shape (MemoryHealth's drift field, which
// has no use for `total`) does not have to fabricate the rest.
export const needsReground = (d: Pick<CorpusDrift, 'ratio'>): boolean =>
  d.ratio !== null && d.ratio >= CORPUS_DRIFT_ADVISORY

// ─── citation: which notes are ABOUT the paths a change touched ───────────────────────────────────
//
// Drift answers "has this note fallen behind", measured against the note's stamped revision — so it
// is blind to uncommitted work by construction (a diff against a committed revision cannot see an
// edit that has not landed) and it only ever speaks about notes that carry both a stamp and a path.
// CITATION is the other question: which notes DECLARE a path this change touched, whoever wrote them
// and whatever their flags say. That set is the heal-or-confirm candidate list.
//
// WHY the distinction is worth a second query: post-commit drift read 4/7 twice in one day. Heal
// candidates were taken from the drift flags — lagging the very work just audited — while the commit
// restamp is scoped to the notes the task itself wrote. A note authored by someone else that cites a
// changed path was in neither set, so it was never healed and never confirmed, and kept reading
// drifted forever.
export interface CitingNote { id: string; scope: string; title: string; sourceRevision: string | null }

// Structural, deliberately: the store handle satisfies it, and this module stays pure — no DB import,
// no connection to test against. `corpusDrift`/`restampableNotes` above take plain note arrays for
// the same reason; the ONE thing this needs that they do not is a query, so it asks for exactly that.
export interface CitingSource {
  notesCitingPaths(paths: readonly string[]): Promise<readonly CitingNote[]>
}

export async function notesCiting(k: CitingSource, paths: readonly string[]): Promise<CitingNote[]> {
  // Empty in, empty out, WITHOUT a query: a commit that created nothing has no committed paths, and
  // "no paths" must never widen into "every note in the corpus".
  if (paths.length === 0) return []
  return [...(await k.notesCitingPaths(paths))]
}

// ─── restamp: catch a HEALED note's revision up to HEAD once its change is committed ──────────────
//
// The heal fixes a note's CONTENT (memory_write against the working tree, re-stamped at write-time
// HEAD). But while its declared paths differ from that stamp — including after a COMMIT moves HEAD
// past it — the gate keeps reading it drifted, so it re-heals on every consumption and never settles.
// A note here is CAUGHT UP to HEAD when its paths (a) CHANGED in commits since its stamp — it is
// behind — and (b) have NO uncommitted change left — the commit is their final state — so stamping it
// at HEAD makes it read current. Run it right after committing a change whose notes were healed.
//
// CEILING: this verifies the REVISION, not the prose — it TRUSTS the content was refreshed to match
// the committed code. A note whose committed code changed but was never re-written would be wrongly
// marked current. Safe pattern: heal → commit → restamp. The stricter version exists: the autoCommit
// pipeline's commit step stamps only the notes the log shows the task actually wrote. This
// corpus-wide guess remains the MANUAL-commit fallback.
export async function restampableNotes(
  notes: ReadonlyArray<{ id: string; scope: string; sourceRevision: string | null; paths?: readonly string[] }>,
  dir: string,
): Promise<{ id: string; scope: string }[]> {
  const head = await gitRun(dir, ['rev-parse', 'HEAD'])
  if (head === null) return []
  const out: { id: string; scope: string }[] = []
  for (const n of notes) {
    const paths = n.paths ?? []
    const rev = n.sourceRevision
    if (rev === null || paths.length === 0 || rev === head) continue
    if (!(await isAncestor(dir, rev, head))) continue // only move a note FORWARD from an ancestor
    const committed = await gitDiffNames(dir, `${rev}..${head}`, paths)   // (a) behind on commits?
    const uncommitted = await gitDiffNames(dir, head, paths)              // (b) nothing left unstaged?
    if (committed === null || uncommitted === null) continue // git could not answer → leave it
    if (committed.length > 0 && uncommitted.length === 0) out.push({ id: n.id, scope: n.scope })
  }
  return out
}

const gitRun = async (dir: string, args: string[]): Promise<string | null> => {
  try {
    const proc = Bun.spawn(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()
    return (await proc.exited) === 0 ? out.trim() : null
  } catch { return null }
}

const isAncestor = async (dir: string, rev: string, head: string): Promise<boolean> => {
  try {
    const proc = Bun.spawn(['git', '-C', dir, 'merge-base', '--is-ancestor', rev, head], { stdout: 'ignore', stderr: 'ignore' })
    return (await proc.exited) === 0
  } catch { return false }
}

// `range` is a git diff spec: `rev..HEAD` (committed history) or `HEAD` (HEAD vs working tree).
const gitDiffNames = async (dir: string, range: string, paths: readonly string[]): Promise<string[] | null> => {
  try {
    const proc = Bun.spawn(['git', '-C', dir, 'diff', '--name-only', range, '--', ...paths], { stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()
    if ((await proc.exited) !== 0) return null
    return out.split('\n').map(l => l.trim()).filter(l => l !== '')
  } catch { return null }
}
