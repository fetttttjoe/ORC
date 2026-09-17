import { DECISION_STATUS, decisionStatusOf, LINK_KIND, MemoryScope, MEMORY_LIMITS, NOTE_KIND, NOTE_TIER, slugId, type DecisionInput, type DecisionStatus, type MemoryAuthor, type MemoryNote, type MemoryStore, type SemanticNote } from '@orc/contracts'
import { adrSummary, parseAdrBody, renderAdrBody, type AdrFields } from './adr'

// The decision lifecycle — record, supersede, list, show — as plain async functions returning
// values. Nothing here prints: the terminal (packages/cli/src/adr-commands.ts) and the MCP/web door
// (OrcActions.recordDecision) render these their own way, and a console.log in the middle of an
// operation is how two doors end up describing one lifecycle differently (workspace-ops.ts is the
// precedent and the reason).

export type DecisionStore = Pick<MemoryStore, 'write' | 'get' | 'list'>
// The store slice plus ONE projector capability: draining before an existence check, so a refusal
// reads the log's present rather than a lagging read model (`orc memory add` drains for the same
// reason). Taken as a function, not a projector, so a test can hand in a live projector's catchUp
// and a door can hand in a no-op if it already drained.
export interface DecisionDoor { store: DecisionStore; catchUp: () => Promise<void> }

// The ONE way a memory instance becomes this module's door. Both doors (`orc adr` and the actions
// layer the web/MCP surfaces call) spelled `{ store, catchUp: () => projector.catchUp() }` by hand,
// and a third would drift on which projector method drains — the very thing DecisionDoor exists to
// pin. Takes the narrow slice rather than a whole memory, so the seam stays satisfiable by a test.
export const decisionDoor = (memory: { store: MemoryStore; projector: { catchUp(): Promise<void> } }): DecisionDoor =>
  ({ store: memory.store, catchUp: () => memory.projector.catchUp() })

// `summary` is the note's own one-line pointer (adrSummary of the Decision section at recording
// time; whatever the writer gave at any other door, possibly empty). Carried so a surface that
// lists decisions as "title — what was decided" does not have to fetch every body again.
export interface DecisionRecord { id: string; title: string; summary: string; status: DecisionStatus; updatedAt: string; createdBy: string; supersededBy: string | null }
// Narrowed to SemanticNote, not the whole MemoryNote union: both callers only ever hand this a note
// that has already passed asDecision, so the type states what is already known rather than making
// every reader re-narrow a union asDecision already collapsed.
export interface DecisionView { note: SemanticNote; status: DecisionStatus; fields: AdrFields | null }
export interface RecordedDecision { note: SemanticNote; status: DecisionStatus; superseded: string | null }

// Refusals as exported sentence factories, so the tests assert the words the doors actually print
// rather than a re-spelled copy that pins the wrong sentence the moment the real one is reworded
// (workspace-ops.ts's archivedRefusal precedent). Door-neutral wording: this module serves the
// terminal AND the MCP tool, so naming `orc adr supersede` here would be wrong at one of them.
export const DECISION_REFUSAL = {
  exists: (id: string): string => `decision '${id}' already exists — a changed decision is a supersession: record the new one with supersedes '${id}'`,
  // Bare fact, no advice: shared by asDecision, which answers "is this a live decision" for BOTH a
  // `supersedes` target and getDecision — neither of those is the writer picking a title, so
  // "pick another title" was wrong at both, and it named the note's bare TIER for a non-semantic
  // note ("is a episodic": ungrammatical, and not even a kind). `what` comes from describeNote.
  notADecision: (id: string, what: string): string => `note '${id}' is ${what}, not a decision`,
  // The ONE call site where "pick another title" is the right advice: recordDecision's own
  // existence check, where the note in the way IS what the writer's title collided with. Composes
  // notADecision rather than re-spelling it, so the two can never drift on the base sentence.
  notADecisionTitle: (id: string, what: string): string => `${DECISION_REFUSAL.notADecision(id, what)} — pick another title`,
  noSuchDecision: (id: string): string => `no decision '${id}'`,
  alreadySuperseded: (id: string): string => `decision '${id}' is already superseded — supersede the decision that replaced it`,
} as const

// What a note IS, articled correctly — shared by every refusal that names one instead of each call
// site re-deriving its own tier/kind expression (the bug this replaces: one call site returned the
// bare TIER for a non-semantic note, "is a episodic", wrong article and not even a kind). `fact` and
// `outcome` read as bare nouns ("a fact"); every other kind, and every non-semantic TIER, needs
// " note" appended to read as English ("a research note", "an episodic note", "a plan note").
const BARE_NOUN_KINDS = new Set<string>([NOTE_KIND.fact, NOTE_KIND.outcome])
const article = (word: string): string => (['a', 'e', 'i', 'o', 'u'].includes(word[0]?.toLowerCase() ?? '') ? 'an' : 'a')
const describeNote = (note: MemoryNote): string => {
  const word: string = note.tier === NOTE_TIER.semantic ? note.kind : note.tier
  const noun = note.tier === NOTE_TIER.semantic && BARE_NOUN_KINDS.has(note.kind) ? word : `${word} note`
  return `${article(word)} ${noun}`
}

const asDecision = (note: MemoryNote | null, id: string): SemanticNote => {
  if (note === null) throw new Error(DECISION_REFUSAL.noSuchDecision(id))
  if (note.tier !== NOTE_TIER.semantic || note.kind !== NOTE_KIND.decision)
    throw new Error(DECISION_REFUSAL.notADecision(id, describeNote(note)))
  return note
}

// Recording is NOT an upsert. The id is the slugged title (orc note's rule — the title is the
// writer's evidence of which decision they mean), and an id that already exists is refused whatever
// it is: a decision changes only by supersession, and a fact under that slug is a different subject.
export async function recordDecision(door: DecisionDoor, author: MemoryAuthor, input: DecisionInput): Promise<RecordedDecision> {
  await door.catchUp()
  const id = slugId(input.title)
  // Read-model pre-check, kept ONLY for the two TAILORED sentences (supersession advice for an
  // existing decision; "pick another title" for a note under a different kind) — a plain read of
  // the projected row is enough for that. It is NOT what enforces "must not exist": an archived
  // note's row is DELETED from the read model (store.get returns null for it), so this check alone
  // would let an archived decision's title be re-recorded and silently resurrect it under a new
  // write. `mustCreate` below is what actually refuses that — checked against the LOG, inside
  // store.write's own transaction, which also closes the race two callers racing one new title
  // would otherwise hit against this read-model check.
  const existing = await door.store.get(id)
  if (existing !== null) {
    if (existing.tier === NOTE_TIER.semantic && existing.kind === NOTE_KIND.decision) throw new Error(DECISION_REFUSAL.exists(id))
    throw new Error(DECISION_REFUSAL.notADecisionTitle(id, describeNote(existing)))
  }
  // Checked BEFORE the new note is written, so a bad `supersedes` leaves nothing behind.
  if (input.supersedes !== undefined) {
    const old = asDecision(await door.store.get(input.supersedes), input.supersedes)
    if (old.status === DECISION_STATUS.superseded) throw new Error(DECISION_REFUSAL.alreadySuperseded(input.supersedes))
  }
  const status = decisionStatusOf(input.status)
  const written = await door.store.write({
    id, title: input.title, kind: NOTE_KIND.decision, status, tags: input.tags,
    summary: adrSummary(input.decision, MEMORY_LIMITS.summaryChars),
    body: renderAdrBody(input),
    links: input.supersedes !== undefined ? [{ id: input.supersedes, kind: LINK_KIND.supersedes }] : [],
  }, author, { mustCreate: true })
  // Narrows the write result to SemanticNote with the SAME helper every other reader uses, rather
  // than a cast or a `!`: this note was just written with kind: decision, so the narrowing cannot
  // fail — asDecision states that as a checked fact instead of an assumed one.
  const note = asDecision(written, id)
  // New note first, then the old one's status. A crash between the two leaves the old decision
  // reading `accepted` with a `supersededBy` in `listDecisions` (the link is on the new note), and
  // archive.ts already treats it as retired through that same link — a detectable state, not a lie.
  // The other order would leave a superseded decision with nothing superseding it.
  if (input.supersedes !== undefined)
    await door.store.write({ id: input.supersedes, status: DECISION_STATUS.superseded }, author)
  // SWALLOWED, unlike the pre-check drain above: both events are committed by the time we get here,
  // so a read-model hiccup must not report a recorded decision as a failure. It would fail at BOTH
  // doors — `orc adr new` and record_decision — for a decision that is in the log, and the obvious
  // retry then meets DECISION_REFUSAL.exists, which reads as a contradiction. The read model heals
  // on the next drain (every op here starts with one). Same posture as actions.ts's writeNote.
  await door.catchUp().catch(() => {})
  return { note, status, superseded: input.supersedes ?? null }
}

// proposed first (it needs a person), then accepted, deprecated, superseded — attention-first like
// `orc ws ls`; within a rung newest first.
//
// By spec: a superseded row stays listed here — nothing here retires it. It leaves the working
// set through the EXISTING lifecycle only: `orc memory recheck --apply` archives a note with a live
// supersedes/contradicts link against it UNLESS another surviving note links to it — archive.ts's
// protector rule outranks `retiredBy`, because retiring a note something still points at leaves that
// link dangling at a dead id. That is the same mechanism every other retired note goes through.
// Once archived the row drops out of listDecisions (list reads the projected
// row, and archiving deletes it) and getDecision refuses it with DECISION_REFUSAL.noSuchDecision —
// the log still holds the full history, only the read model stops showing it.
const RUNG: Record<DecisionStatus, number> = {
  [DECISION_STATUS.proposed]: 0, [DECISION_STATUS.accepted]: 1, [DECISION_STATUS.deprecated]: 2, [DECISION_STATUS.superseded]: 3,
}

// Full notes, not summaries: NoteSummary carries neither kind nor status, and a decision set is
// small by construction (the kind exists to name a short, human-approved set — see NOTE_KINDS'
// comment). CEILING: one get per decision; if a project ever holds hundreds, carry `status` on the
// summary row (surreal.ts toSummary) and drop the gets.
export async function listDecisions(door: DecisionDoor, filter: { status?: DecisionStatus } = {}): Promise<DecisionRecord[]> {
  await door.catchUp()
  // Project scope only — decisions are project-level ADRs. A plan-scoped `kind: decision`
  // note is one task's own scratch note under that kind, not an architectural decision the project
  // made, and getDecision/recordDecision already only ever address a project-scope id (store.get's
  // scope default): listing must not show a wider set than the two doors that read one row of it.
  const summaries = await door.store.list({ kind: NOTE_KIND.decision, scope: MemoryScope.project })
  const notes: SemanticNote[] = []
  for (const s of summaries) {
    const n = await door.store.get(s.id, s.scope)
    if (n !== null && n.tier === NOTE_TIER.semantic && n.kind === NOTE_KIND.decision) notes.push(n)
  }
  const supersededBy = new Map<string, string>()
  for (const n of notes) for (const l of n.links) if (l.kind === LINK_KIND.supersedes) supersededBy.set(l.id, n.id)
  return notes
    .map(n => ({ id: n.id, title: n.title, summary: n.summary, status: decisionStatusOf(n.status), updatedAt: n.updatedAt, createdBy: n.createdBy, supersededBy: supersededBy.get(n.id) ?? null }))
    .filter(r => filter.status === undefined || r.status === filter.status)
    .sort((a, b) => RUNG[a.status] - RUNG[b.status] || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
}

export async function getDecision(door: DecisionDoor, id: string): Promise<DecisionView> {
  await door.catchUp()
  const note = asDecision(await door.store.get(id), id)
  return { note, status: decisionStatusOf(note.status), fields: parseAdrBody(note.body) }
}
