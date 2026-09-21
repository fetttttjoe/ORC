import { afterAll, describe, expect, it } from 'bun:test'
import { AUTHOR_SOURCE, DECISION_STATUS, LINK_KIND, MemoryScope, NOTE_KIND, NOTE_TIER, planScope, type DecisionInput, type MemoryAuthor } from '@orc/contracts'
import { authorFixture } from '@orc/contracts/fixtures'
import { ADR_SECTION } from './adr'
import { DECISION_REFUSAL, getDecision, listDecisions, recordDecision, type DecisionDoor } from './decisions'
import { STORE_REFUSAL } from './store'
import { createLiveMemory, type LiveMemory } from './test-helpers'

const lives: LiveMemory[] = []
afterAll(async () => { await Promise.all(lives.map(l => l.close())) }, 30_000)

// A human recording a decision with `orc decide` is not talking in a chat, so the origin is the
// CLI door with no chat.
const human: MemoryAuthor = authorFixture({ source: AUTHOR_SOURCE.human })
async function door(): Promise<DecisionDoor & { live: LiveMemory }> {
  const live = await createLiveMemory()
  lives.push(live)
  return { live, store: live.store, catchUp: () => live.projector.catchUp() }
}
// Partial<DecisionInput>, not a `Record<string, unknown>` bag: an override that is not a field of
// the schema — a typo'd `supercedes`, a dropped rename — is then a compile error here rather than a
// silently ignored key that leaves the test asserting the default path.
const input = (title: string, over: Partial<DecisionInput> = {}): DecisionInput =>
  ({ title, context: 'ctx', decision: `we do ${title}`, consequences: 'cons', tags: [], ...over })

describe('recording a decision', () => {
  it('writes a semantic decision note with an explicit status, the ADR body and the human author', async () => {
    const d = await door()
    const r = await recordDecision(d, human, input('Event log is truth'))
    expect(r.status).toBe(DECISION_STATUS.accepted)
    const n = await d.store.get('event-log-is-truth')
    if (!n || n.tier !== NOTE_TIER.semantic) throw new Error('no semantic note stored')
    expect(n.kind).toBe(NOTE_KIND.decision)
    expect(n.status).toBe(DECISION_STATUS.accepted) // stamped, not left to the reader
    expect(n.body).toContain(`## ${ADR_SECTION.decision}`)
    expect(n.summary).toBe('we do Event log is truth')
    expect(n.createdBy).toBe('human')
  }, 20_000)

  it('keeps an explicit proposed status', async () => {
    const d = await door()
    expect((await recordDecision(d, human, input('Maybe', { status: DECISION_STATUS.proposed }))).status).toBe(DECISION_STATUS.proposed)
  }, 20_000)

  // Both events are committed by the time the trailing drain runs, so a read-model hiccup there must
  // not report a recorded decision as a failure: BOTH doors would print an error for a decision that
  // IS in the log, and the operator's retry would meet DECISION_REFUSAL.exists. The SECOND call is
  // the one that fails here — the pre-check drain must keep working, or the refusals would be read
  // off a lagging read model.
  it('resolves when the read-model drain fails AFTER the events are committed', async () => {
    const d = await door()
    let drains = 0
    const flaky: DecisionDoor = {
      store: d.store,
      catchUp: async () => { if (++drains > 1) throw new Error('read model unreachable'); await d.catchUp() },
    }
    expect((await recordDecision(flaky, human, input('Committed anyway'))).note.id).toBe('committed-anyway')
    expect(drains).toBe(2) // the trailing drain was attempted, not skipped
    // the log is what holds the decision; the read model heals on the next drain
    await d.catchUp()
    expect((await d.store.get('committed-anyway'))?.title).toBe('Committed anyway')
  }, 20_000)

  // Recording is not an upsert: the only way a decision's text moves is a supersession.
  it('refuses an id that already exists, naming supersession for a decision and the kind (with advice) otherwise', async () => {
    const d = await door()
    await recordDecision(d, human, input('Dup'))
    await expect(recordDecision(d, human, input('Dup'))).rejects.toThrow(DECISION_REFUSAL.exists('dup'))
    await d.store.write({ id: 'a-fact', title: 'A fact' }, human)
    await d.catchUp()
    // notADecisionTitle: recording is the one call site where "pick another title" is right advice
    // — the note in the way IS what the writer's title collided with.
    await expect(recordDecision(d, human, input('A fact'))).rejects.toThrow(DECISION_REFUSAL.notADecisionTitle('a-fact', 'a fact'))
  }, 20_000)

  // ARCHIVED counts as "already exists": archiving deletes the projected row (store.get sees
  // nothing), so a check against the read model alone would let this title be re-recorded and
  // silently resurrect the archived decision under a write it never asked for. mustCreate on the
  // store write is what actually refuses it — see decisions.ts and store.ts's mustCreate comments.
  it("refuses to re-record an archived decision's title, and does not resurrect it", async () => {
    const d = await door()
    await recordDecision(d, human, input('Ghost'))
    await d.live.store.setArchived('ghost', MemoryScope.project, true, human)
    await d.catchUp()
    // the STORE's refusal, word for word: a bare `rejects.toThrow()` accepted any failure at all —
    // including the read-model pre-check passing and something else breaking — which is exactly the
    // distinction this test exists to make (mustCreate refuses it, store.get cannot see it)
    await expect(recordDecision(d, human, input('Ghost'))).rejects.toThrow(STORE_REFUSAL.exists('ghost', MemoryScope.project))
    expect(await d.store.get('ghost')).toBeNull() // nothing resurrected
  }, 20_000)
})

describe('superseding', () => {
  it('links the new note to the old with supersedes and flips the old to superseded', async () => {
    const d = await door()
    await recordDecision(d, human, input('Old way'))
    const r = await recordDecision(d, human, input('New way', { supersedes: 'old-way' }))
    expect(r.superseded).toBe('old-way')
    expect(r.note.links).toEqual([{ id: 'old-way', kind: LINK_KIND.supersedes }])
    const old = await d.store.get('old-way')
    if (!old || old.tier !== NOTE_TIER.semantic) throw new Error('old note gone')
    expect(old.status).toBe(DECISION_STATUS.superseded)
    expect(old.title).toBe('Old way') // merge-on-omit kept everything but the status
    expect(old.kind).toBe(NOTE_KIND.decision)
  }, 20_000)

  it('refuses to supersede a missing note, a non-decision, or an already-superseded decision, leaving nothing behind', async () => {
    const d = await door()
    await expect(recordDecision(d, human, input('X', { supersedes: 'ghost' }))).rejects.toThrow(DECISION_REFUSAL.noSuchDecision('ghost'))
    expect(await d.store.get('x')).toBeNull() // a bad `supersedes` leaves nothing behind
    await d.store.write({ id: 'plain', title: 'Plain' }, human)
    await d.catchUp()
    // notADecision (no advice): this refusal comes from asDecision validating the SUPERSEDES
    // target, not from recording a title — "pick another title" would make no sense here.
    await expect(recordDecision(d, human, input('Y', { supersedes: 'plain' }))).rejects.toThrow(DECISION_REFUSAL.notADecision('plain', 'a fact'))
    expect(await d.store.get('y')).toBeNull()
    await recordDecision(d, human, input('First'))
    await recordDecision(d, human, input('Second', { supersedes: 'first' }))
    await expect(recordDecision(d, human, input('Third', { supersedes: 'first' }))).rejects.toThrow(DECISION_REFUSAL.alreadySuperseded('first'))
    expect(await d.store.get('third')).toBeNull()
  }, 20_000)
})

describe('listing and showing', () => {
  it('lists decisions attention-first with the derived status and who superseded whom; filters by status', async () => {
    const d = await door()
    await recordDecision(d, human, input('Old'))
    await recordDecision(d, human, input('Replacement', { supersedes: 'old' }))
    await recordDecision(d, human, input('Idea', { status: DECISION_STATUS.proposed }))
    // written outside the lifecycle, with no status: must read as accepted, never as missing.
    // Named 'zulu', not 'bare': 'zulu' sorts AFTER 'replacement' alphabetically even though it is
    // written LATER, so only the `updatedAt` (recency) tie-break — not an id fallback — can put it
    // first. ('bare' < 'replacement' alphabetically, which let a prior version of this test pass
    // even with the recency comparison deleted.)
    await d.store.write({ id: 'zulu', title: 'Zulu', kind: NOTE_KIND.decision }, human)
    await d.store.write({ id: 'not-a-decision', title: 'Fact' }, human)
    await d.catchUp()
    const rows = await listDecisions(d)
    expect(rows.map(r => r.id)).toEqual(['idea', 'zulu', 'replacement', 'old']) // proposed, then accepted (newest first), then superseded
    expect(rows.find(r => r.id === 'zulu')?.status).toBe(DECISION_STATUS.accepted)
    expect(rows.find(r => r.id === 'old')).toMatchObject({ status: DECISION_STATUS.superseded, supersededBy: 'replacement' })
    expect((await listDecisions(d, { status: DECISION_STATUS.proposed })).map(r => r.id)).toEqual(['idea'])
  }, 20_000)

  // Decisions are project-scope knowledge: a plan-scoped `kind: decision` note is one
  // task's own scratch note under that kind, not an ADR the project made.
  it('does not list a plan-scoped decision note', async () => {
    const d = await door()
    await recordDecision(d, human, input('Real decision'))
    await d.store.write({ id: 'scratch', title: 'Scratch', kind: NOTE_KIND.decision, scope: planScope('t1') }, human)
    await d.catchUp()
    expect((await listDecisions(d)).map(r => r.id)).toEqual(['real-decision'])
  }, 20_000)

  it('shows a decision with parsed sections, and null sections for a body not in ADR layout', async () => {
    const d = await door()
    await recordDecision(d, human, input('Shaped'))
    await d.store.write({ id: 'loose', title: 'Loose', kind: NOTE_KIND.decision, body: 'free prose' }, human)
    await d.catchUp()
    expect((await getDecision(d, 'shaped')).fields).toEqual({ context: 'ctx', decision: 'we do Shaped', consequences: 'cons' })
    const loose = await getDecision(d, 'loose')
    expect(loose.fields).toBeNull()
    expect(loose.status).toBe(DECISION_STATUS.accepted)
    await expect(getDecision(d, 'nope')).rejects.toThrow(DECISION_REFUSAL.noSuchDecision('nope'))
  }, 20_000)
})
