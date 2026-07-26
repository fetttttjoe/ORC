import { NOTE_TIER, RETENTION, foldMemory, noteKey, type EventRecord, type MemoryFold, type NoteTier } from '@orc/contracts'

export interface SweptNote { id: string; scope: string; title: string; summary: string }

// A live note reduced to what a sweep policy needs: its address, what the dry-run report shows,
// and its outbound links — which are what make it a PROTECTOR of the notes it points at.
interface LiveNote extends SweptNote { links: string[]; taskId: string; tier: NoteTier }

const liveNotes = (m: MemoryFold): LiveNote[] =>
  [...m.notes.values()].map(({ note, author }) => ({
    id: note.id, scope: note.scope, title: note.title, summary: note.summary,
    links: note.links.map(l => l.id), taskId: author.taskId ?? '', tier: note.tier,
  }))

// The one topology rule every sweep obeys (docs/IDEAS.md entry 1, design fix 3): a candidate
// survives if any note that ITSELF survives authored a link to it. Traffic is deliberately not
// consulted — three live notes can point at a candidate nobody has walked, and deleting it leaves
// their links[] dangling at a dead id, which nothing repairs (rewriting authored links is a
// non-goal). Candidates linking only to each other protect nobody: they all go together.
function unreferenced<T extends LiveNote>(all: LiveNote[], going: T[]): T[] {
  const doomed = new Set(going.map(n => noteKey(n.scope, n.id)))
  const referenced = new Set(
    all.filter(n => !doomed.has(noteKey(n.scope, n.id)))
      .flatMap(n => n.links.map(id => noteKey(n.scope, id))),
  )
  return going.filter(n => !referenced.has(noteKey(n.scope, n.id)))
}

// Deterministic cancel-time GC — the orchestrator decides what stays vs goes, not an agent.
// A note GOES iff its LAST writer's task is in `cancelled` AND no surviving note links to it.
// Adopted ids (re-written by a live writer) stay; cli/null-authored notes are never swept.
// Deletion is a memory_deleted event, so content stays in the log for audit/replay.
export function orphanedNotes(events: EventRecord[], cancelled: Set<string>): SweptNote[] {
  const all = liveNotes(foldMemory(events))
  const going = unreferenced(all, all.filter(n => cancelled.has(n.taskId)))
  return going.map(({ id, scope, title, summary }) => ({ id, scope, title, summary }))
}

// The TTL sweep's default window. A starting point, not a measurement: calibrate it against the
// observed hit distribution (`orc memory ls` prints hits) once the expirable lane has run long
// enough to show one — the same discipline docs/IDEAS.md entry 1 demands of the half-life.
export const DEFAULT_SWEEP_DAYS = 30

// A note the TTL sweep would retire, with the observed use that justified it — the dry run has to
// show the evidence, not just the verdict, or a human cannot judge whether --apply is safe.
export interface StaleNote { id: string; scope: string; title: string; hits: number; lastTouchedAt: string }

// The "forget" half of the memory lifecycle: retire notes the AUTHOR marked expirable that nobody
// has touched in `days`. Deliberately not automatic (docs/IDEAS.md entry 3) — `orc memory sweep`
// is a dry run until --apply. Three rules, each a recorded design fix:
//  - candidacy is `retention: expirable`, the author's write-time judgment — never a coldness
//    threshold the sweep invents (entry 1, fix 2: activation ranks, it does not filter).
//  - a candidate is protected by an authored inbound link from a survivor (fix 3), via the same
//    `unreferenced` rule the cancel sweep uses.
//  - "untouched" is the later of last written and last read: a note read six months ago is stale,
//    a note re-written yesterday is not. An unusable timestamp fails safe and is never swept.
export function staleNotes(
  events: EventRecord[],
  opts: { now: string; days: number; terminalTaskIds?: ReadonlySet<string> },
): StaleNote[] {
  const terminal = opts.terminalTaskIds ?? new Set<string>()
  const m = foldMemory(events)
  // Candidacy is the author's `expirable` marking, OR the plan tier — a decomposition belongs to
  // one task by construction, and notes written before that tier's default changed still carry
  // `retention: durable` in their payload. Pinning the literal (as the episodic tier does) would
  // make those older payloads fail to parse and vanish from the fold entirely.
  const candidateLane = new Set(
    [...m.notes.values()]
      .filter(({ note }) => note.retention === RETENTION.expirable || note.tier === NOTE_TIER.plan)
      .map(({ note }) => noteKey(note.scope, note.id)),
  )
  const cutoff = Date.parse(opts.now) - opts.days * 86_400_000
  const all = liveNotes(m)
  const candidates = all.flatMap(note => {
    const key = noteKey(note.scope, note.id)
    if (!candidateLane.has(key)) return []
    // an approved decomposition stays while its task can still be retried or audited
    if (note.tier === NOTE_TIER.plan && !terminal.has(note.taskId)) return []
    const lastTouchedAt = latestStamp([m.writes.get(key), m.access.get(key)?.lastAccessedAt])
    // an unusable/absent timestamp means unknown age — fail safe and keep the note
    if (lastTouchedAt === null || Date.parse(lastTouchedAt) > cutoff) return []
    return [{ ...note, lastTouchedAt, hits: m.access.get(key)?.hits ?? 0 }]
  })
  return unreferenced(all, candidates)
    .map(({ id, scope, title, hits, lastTouchedAt }) => ({ id, scope, title, hits, lastTouchedAt }))
}

// The most recent of a set of maybe-timestamps, or null when none of them is a usable instant.
const latestStamp = (stamps: Array<string | null | undefined>): string | null =>
  stamps.reduce<string | null>((latest, ts) => {
    if (typeof ts !== 'string' || !Number.isFinite(Date.parse(ts))) return latest
    return latest === null || Date.parse(ts) > Date.parse(latest) ? ts : latest
  }, null)
