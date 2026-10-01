import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  ClaimClass, ClaimState, DECISION_REFUSAL, DecisionStatus, decisionSlugOf, DriftFilter, KNOWLEDGE_ID_RE, KNOWLEDGE_REFUSAL, KnowledgePatch,
  type DecisionDraft, type DriftFilterInput, type KnowledgeBackend, type KnowledgePatchInput,
} from '@orc/contracts'
import { driftOf } from './drift-of'

export const CONTRACT_FILES = ['src/a.ts', 'src/b.ts', 'pkg/package.json', 'pkg/src/c.ts', 'docs/guide.md'] as const
const SOURCE_A = 'export function alpha() {}\nexport function outer() {\n  function inner() {}\n}\n'
export const contractSourceOf = (file: string): string => (file === 'src/a.ts' ? SOURCE_A : file.endsWith('package.json') ? '{}\n' : '')
export const CONTRACT_DIRS = ['src', 'pkg', 'pkg/src', 'docs'] as const

export interface ContractFixture {
  backend: KnowledgeBackend
  checkout: string
  other: string
  rewrite(checkout: string, file: string, source: string): void
  commit(checkout: string): void
  cleanup(): Promise<void>
}

const patch = (input: KnowledgePatchInput) => KnowledgePatch.parse(input)
const fact = (text: string, ...paths: string[]): { text: string; class: ClaimClass; anchors: { path: string }[]; tags?: string[]; sources?: string[]; decision?: string } =>
  ({ text, class: ClaimClass.fact, anchors: paths.map(path => ({ path })) })
const PAGE = { cursor: null, limit: 100 }
const draft = (title: string, over: Partial<DecisionDraft> = {}): DecisionDraft => ({
  id: decisionSlugOf(title), title, status: DecisionStatus.accepted, date: '2026-09-29', tags: [], supersedes: null,
  context: 'Why it came up.', decision: 'What we do.', consequences: 'What follows.', considered: [], ...over,
})
const symbolFact = (text: string, file: string, symbol: string, id?: string) =>
  ({ ...fact(text), anchors: [{ path: file, symbol }], ...(id !== undefined && { id }) })
const outsideCheckout = (files: readonly string[]): string[] => files.filter(file => file.startsWith('/') || file.split('/').includes('..'))

export function describeKnowledgeBackend(name: string, make: () => Promise<ContractFixture>): void {
  describe(`${name} honours the knowledge contract`, () => {
    let f: ContractFixture
    beforeEach(async () => { f = await make() })
    afterEach(async () => { await f.cleanup() })

    const add = async (...drafts: ReturnType<typeof fact>[]) => (await f.backend.write(f.checkout, patch({ add: drafts }))).added

    it('an added claim reads back whole, with a fresh id and a location', async () => {
      const [ref] = await add({ ...fact('The store writes events.', 'src/a.ts'), tags: ['events'], sources: ['https://example.com/doc#part'] })
      expect(ref?.id).toMatch(KNOWLEDGE_ID_RE)
      expect(ref?.location.length).toBeGreaterThan(0)
      expect(await f.backend.get(f.checkout, [ref?.id ?? ''])).toEqual([{
        id: ref?.id, location: ref?.location, text: 'The store writes events.', class: ClaimClass.fact,
        anchors: [{ path: 'src/a.ts', symbol: null }], tags: ['events'], sources: ['https://example.com/doc#part'], decision: null,
      }])
    })

    it('two claims in one patch get different ids', async () => {
      const refs = await add(fact('one', 'src/a.ts'), fact('two', 'src/a.ts'))
      expect(new Set(refs.map(r => r.id)).size).toBe(2)
    })

    it('a change keeps the id and the fields it does not name', async () => {
      const [ref] = await add({ ...fact('old', 'src/a.ts'), tags: ['t'] })
      const id = ref?.id ?? ''
      await f.backend.write(f.checkout, patch({ change: [{ id, text: 'new' }] }))
      const [read] = await f.backend.get(f.checkout, [id])
      expect(read).toMatchObject({ id, text: 'new', tags: ['t'], anchors: [{ path: 'src/a.ts', symbol: null }] })
    })

    it('a change to an unknown id is refused, naming it', async () => {
      await expect(f.backend.write(f.checkout, patch({ change: [{ id: 'zzzzzzzz', text: 'x' }] })))
        .rejects.toThrow(KNOWLEDGE_REFUSAL.unknownId('zzzzzzzz'))
    })

    it('a retire removes the claim; an unknown id only warns', async () => {
      const [ref] = await add(fact('gone soon', 'src/a.ts'))
      const id = ref?.id ?? ''
      const result = await f.backend.write(f.checkout, patch({ retire: [id, 'zzzzzzzz'] }))
      expect(result.retired.map(r => r.id)).toEqual([id])
      expect(result.warnings).toContain(KNOWLEDGE_REFUSAL.notRetired('zzzzzzzz'))
      expect(await f.backend.get(f.checkout, [id])).toEqual([])
    })

    it('an anchor to a missing file refuses the whole patch', async () => {
      await expect(f.backend.write(f.checkout, patch({ add: [fact('fine', 'src/a.ts'), fact('bad', 'src/missing.ts')] })))
        .rejects.toThrow(KNOWLEDGE_REFUSAL.missingAnchor('src/missing.ts'))
      expect((await f.backend.card(f.checkout, '.', PAGE)).claims).toEqual([])
    })

    it('a symbol that matches nothing is refused with the closest real names, and nothing is written', async () => {
      await expect(f.backend.write(f.checkout, patch({ add: [symbolFact('typo', 'src/a.ts', 'alpah')] }))).rejects.toThrow('closest: alpha')
      expect((await f.backend.card(f.checkout, '.', PAGE)).claims).toEqual([])
    })

    it('a symbol given by its unique short form is stored by its full qualified name, added or changed', async () => {
      const [added, plain] = await add(symbolFact('short', 'src/a.ts', 'inner'), fact('plain', 'src/b.ts'))
      await f.backend.write(f.checkout, patch({ change: [{ id: plain?.id ?? '', anchors: [{ path: 'src/a.ts', symbol: 'inner' }] }] }))
      const read = await f.backend.get(f.checkout, [added?.id ?? '', plain?.id ?? ''])
      expect(read.map(c => c.anchors)).toEqual([[{ path: 'src/a.ts', symbol: 'outer.inner' }], [{ path: 'src/a.ts', symbol: 'outer.inner' }]])
    })

    it('a retried add with the short form and an explicit id replays instead of clashing', async () => {
      const retried = patch({ add: [symbolFact('short', 'src/a.ts', 'inner', 'abcd1234')] })
      const first = await f.backend.write(f.checkout, retried)
      const second = await f.backend.write(f.checkout, retried)
      expect(second.added).toEqual(first.added)
      expect((await f.backend.card(f.checkout, '.', PAGE)).claims.map(c => c.id)).toEqual(['abcd1234'])
    })

    it('a symbol on a file that cannot be outlined is refused as unsupported; the file itself is accepted', async () => {
      await expect(f.backend.write(f.checkout, patch({ add: [symbolFact('manifest', 'pkg/package.json', 'name')] })))
        .rejects.toThrow(KNOWLEDGE_REFUSAL.symbolUnsupported('pkg/package.json'))
      await expect(f.backend.write(f.checkout, patch({ add: [symbolFact('missing', 'src/missing.ts', 'x')] })))
        .rejects.toThrow(KNOWLEDGE_REFUSAL.missingAnchor('src/missing.ts'))
      expect((await add(fact('manifest file', 'pkg/package.json'))).length).toBe(1)
    })

    it('a change that leaves anchors alone is not blocked by a symbol the file no longer defines', async () => {
      const [ref] = await add(symbolFact('held', 'src/a.ts', 'inner'))
      const id = ref?.id ?? ''
      f.rewrite(f.checkout, 'src/a.ts', 'export function alpha() {}\n')
      await f.backend.write(f.checkout, patch({ change: [{ id, text: 'edited' }] }))
      expect((await f.backend.get(f.checkout, [id]))[0]).toMatchObject({ text: 'edited', anchors: [{ path: 'src/a.ts', symbol: 'outer.inner' }] })
    })

    it('an addition that names an existing id with the same content is a no-op; with other content it is refused', async () => {
      const once = patch({ add: [{ ...fact('same', 'src/a.ts'), id: 'abcd1234' }] })
      await f.backend.write(f.checkout, once)
      await f.backend.write(f.checkout, once)
      expect((await f.backend.card(f.checkout, '.', PAGE)).claims.map(c => c.id)).toEqual(['abcd1234'])
      await expect(f.backend.write(f.checkout, patch({ add: [{ ...fact('other', 'src/a.ts'), id: 'abcd1234' }] })))
        .rejects.toThrow(KNOWLEDGE_REFUSAL.idClash('abcd1234'))
    })

    it('a card lists claims anchored at or under its entity, in both anchors cards, and the root lists all', async () => {
      const [a, both, c, loose] = await add(
        fact('a only', 'src/a.ts'), fact('a and c', 'src/a.ts', 'pkg/src/c.ts'), fact('c only', 'pkg/src/c.ts'), fact('no anchor'),
      )
      const ids = async (entity: string) => (await f.backend.card(f.checkout, entity, PAGE)).claims.map(x => x.id).sort()
      expect(await ids('src/a.ts')).toEqual([a?.id, both?.id].sort())
      expect(await ids('pkg')).toEqual([both?.id, c?.id].sort())
      expect(await ids('pkg/src/c.ts')).toEqual([both?.id, c?.id].sort())
      expect(await ids('.')).toEqual([a?.id, both?.id, c?.id, loose?.id].sort())
    })

    it('pages cover the card once, and the last page has no next cursor', async () => {
      await add(fact('1', 'src/a.ts'), fact('2', 'src/a.ts'), fact('3', 'src/b.ts'))
      const seen: string[] = []
      let cursor: string | null = null
      for (let i = 0; i < 5; i++) {
        const card = await f.backend.card(f.checkout, '.', { cursor, limit: 1 })
        seen.push(...card.claims.map(c => c.id))
        cursor = card.next
        if (cursor === null) break
      }
      expect(seen.length).toBe(3)
      expect(new Set(seen).size).toBe(3)
      expect(cursor).toBeNull()
    })

    it('search finds a distinctive word and a tag, and respects the limit', async () => {
      const [hit] = await add({ ...fact('The projector drains memory events.', 'src/a.ts'), tags: ['replay'] }, fact('Unrelated.', 'src/b.ts'))
      expect((await f.backend.search(f.checkout, 'projector', 10)).map(c => c.id)).toEqual([hit?.id])
      expect((await f.backend.search(f.checkout, 'replay', 10)).map(c => c.id)).toEqual([hit?.id])
      expect(await f.backend.search(f.checkout, 'nothing-matches-this', 10)).toEqual([])
      await add(fact('projector two', 'src/b.ts'))
      expect((await f.backend.search(f.checkout, 'projector', 1)).length).toBe(1)
    })

    it('ten parallel writes all land', async () => {
      await Promise.all(Array.from({ length: 10 }, (_, i) => f.backend.write(f.checkout, patch({ add: [fact(`parallel ${i}`, 'src/a.ts')] }))))
      expect((await f.backend.card(f.checkout, 'src/a.ts', PAGE)).claims.length).toBe(10)
    })

    it('two checkouts do not see each other', async () => {
      await add(fact('only here', 'src/a.ts'))
      expect((await f.backend.card(f.other, '.', PAGE)).claims).toEqual([])
    })

    const statesOf = async (filter: DriftFilterInput = {}): Promise<Record<string, ClaimState>> =>
      Object.fromEntries(driftOf(await f.backend.readings(f.checkout, DriftFilter.parse(filter)), []).map(d => [d.claim.id, d.state]))
    const SOURCE_A_COMMENTED = 'export function alpha() { /* reads the store */ }\nexport function outer() {\n  // the inner helper\n  function inner() {}\n}\n'
    const SOURCE_A_EDITED = 'export function alpha() { return 1 }\nexport function outer() {\n  function inner() {}\n}\n'

    it('a fresh claim reads clean; an edit to its anchored symbol\'s tokens turns it suspect, a comment edit does not', async () => {
      const [ref] = await add(symbolFact('alpha does nothing', 'src/a.ts', 'alpha'))
      const id = ref?.id ?? ''
      expect(await statesOf()).toEqual({ [id]: ClaimState.clean })
      f.commit(f.checkout)
      f.rewrite(f.checkout, 'src/a.ts', SOURCE_A_COMMENTED)
      expect(await statesOf()).toEqual({ [id]: ClaimState.clean })
      f.rewrite(f.checkout, 'src/a.ts', SOURCE_A_EDITED)
      expect(await statesOf()).toEqual({ [id]: ClaimState.suspect })
    })

    it('deleting the anchored symbol turns the claim suspect, and an edit elsewhere in the file leaves a symbol claim clean', async () => {
      const [inner, alpha] = await add(symbolFact('inner helps outer', 'src/a.ts', 'outer.inner'), symbolFact('alpha does nothing', 'src/a.ts', 'alpha'))
      f.commit(f.checkout)
      f.rewrite(f.checkout, 'src/a.ts', 'export function alpha() {}\nexport function outer() {}\n')
      expect(await statesOf()).toEqual({ [inner?.id ?? '']: ClaimState.suspect, [alpha?.id ?? '']: ClaimState.clean })
    })

    it('an unanchored claim reads unanchored', async () => {
      const [ref] = await add(fact('the project has no anchor here'))
      expect(await statesOf()).toEqual({ [ref?.id ?? '']: ClaimState.unanchored })
    })

    it('a symbol anchor the outline cannot read is never clean: unknown, before and after its basis is committed', async () => {
      const [ref] = await add(symbolFact('alpha does nothing', 'src/a.ts', 'alpha'))
      f.rewrite(f.checkout, 'src/a.ts', 'export function beta( {\n')
      expect(await statesOf()).toEqual({ [ref?.id ?? '']: ClaimState.unknown })
      f.commit(f.checkout)
      expect(await statesOf()).toEqual({ [ref?.id ?? '']: ClaimState.unknown })
    })

    it('a drift filter path matches a claim anchored at it, under it, or at a folder above it; ids narrow it; [] matches nothing', async () => {
      const [folder, file, elsewhere, loose] = await add(fact('the package', 'pkg'), fact('c', 'pkg/src/c.ts'), fact('a', 'src/a.ts'), fact('loose'))
      const ids = async (filter: DriftFilterInput) => Object.keys(await statesOf(filter)).sort()
      const [p, c, a, l] = [folder?.id ?? '', file?.id ?? '', elsewhere?.id ?? '', loose?.id ?? '']
      expect(await ids({ paths: ['pkg/src/c.ts'] })).toEqual([p, c].sort())
      expect(await ids({ paths: ['pkg/src'] })).toEqual([p, c].sort())
      expect(await ids({ paths: ['pkg'] })).toEqual([p, c].sort())
      expect(await ids({ paths: ['src/a.ts', 'docs'] })).toEqual([a])
      expect(await ids({ ids: [a, l] })).toEqual([a, l].sort())
      expect(await ids({ paths: ['pkg/src/c.ts'], ids: [p, a] })).toEqual([p])
      expect(await ids({ paths: [] })).toEqual([])
      expect(await ids({})).toEqual([p, c, a, l].sort())
      expect(await statesOf({ ids: [p] })).toEqual({ [p]: ClaimState.clean })
    })

    it('a clean store has nothing to check or format', async () => {
      const cited = draft('Cited decision', { tags: ['kernel'], considered: ['Another way'] })
      await f.backend.recordDecision(f.checkout, cited)
      await add(fact('fine', 'src/a.ts'), { ...fact('cites it', 'src/b.ts'), decision: cited.id })
      expect(await f.backend.check(f.checkout)).toEqual([])
      expect((await f.backend.format(f.checkout)).problems).toEqual([])
    })

    it('the files a write or a decision record reports are checkout-relative', async () => {
      const result = await f.backend.write(f.checkout, patch({ add: [fact('where', 'src/a.ts')] }))
      expect(outsideCheckout(result.files)).toEqual([])
      await f.backend.recordDecision(f.checkout, draft('Placed'))
      const superseding = await f.backend.recordDecision(f.checkout, draft('Placed again', { supersedes: decisionSlugOf('Placed') }))
      expect(outsideCheckout(superseding.files)).toEqual([])
    })

    it('a recorded decision reads back whole, and the list holds it', async () => {
      const d = draft('Finish-gate checks report; they never block', {
        tags: ['checks', 'kernel'], considered: ['Block on a failed check', 'Report and\nlet the human decide'], context: 'Two lines\nof context.',
      })
      const result = await f.backend.recordDecision(f.checkout, d)
      expect(result.recorded.id).toBe(d.id)
      expect(result.recorded.location.length).toBeGreaterThan(0)
      expect(result).toMatchObject({ superseded: null, status: DecisionStatus.accepted, warnings: [] })
      const whole = { ...d, supersededBy: null, location: result.recorded.location }
      expect(await f.backend.decision(f.checkout, d.id)).toEqual(whole)
      expect(await f.backend.decisions(f.checkout)).toEqual([whole])
    })

    it('recording the same title with other content is refused; an identical record is a replay', async () => {
      const d = draft('Recorded once')
      const first = await f.backend.recordDecision(f.checkout, d)
      await expect(f.backend.recordDecision(f.checkout, { ...d, context: 'Other context.' })).rejects.toThrow(DECISION_REFUSAL.exists(d.id))
      const replay = await f.backend.recordDecision(f.checkout, d)
      expect(replay).toEqual(first)
      expect((await f.backend.decisions(f.checkout)).map(x => x.context)).toEqual([d.context])
    })

    it('a supersession marks the old decision superseded and names its successor', async () => {
      const old = draft('The old way')
      await f.backend.recordDecision(f.checkout, old)
      const result = await f.backend.recordDecision(f.checkout, draft('The new way', { supersedes: old.id }))
      expect(result.superseded?.id).toBe(old.id)
      expect(result.status).toBe(DecisionStatus.accepted)
      expect(await f.backend.decision(f.checkout, old.id)).toMatchObject({ status: DecisionStatus.superseded, supersededBy: decisionSlugOf('The new way'), context: old.context })
      expect(await f.backend.decision(f.checkout, decisionSlugOf('The new way'))).toMatchObject({ supersedes: old.id, supersededBy: null })
    })

    it('a replayed supersession reports the same result as the record, and leaves both decisions as they were', async () => {
      await f.backend.recordDecision(f.checkout, draft('The old way'))
      const newer = draft('The new way', { supersedes: 'the-old-way' })
      const first = await f.backend.recordDecision(f.checkout, newer)
      const before = await f.backend.decisions(f.checkout)
      expect(await f.backend.recordDecision(f.checkout, newer)).toEqual(first)
      expect(await f.backend.decisions(f.checkout)).toEqual(before)
    })

    it('superseding an unknown or an already-superseded decision is refused and writes nothing', async () => {
      await f.backend.recordDecision(f.checkout, draft('First'))
      await f.backend.recordDecision(f.checkout, draft('Second', { supersedes: 'first' }))
      const before = await f.backend.decisions(f.checkout)
      await expect(f.backend.recordDecision(f.checkout, draft('Third', { supersedes: 'ghost' }))).rejects.toThrow(DECISION_REFUSAL.noSuchDecision('ghost'))
      expect(await f.backend.decisions(f.checkout)).toEqual(before)
      await expect(f.backend.recordDecision(f.checkout, draft('Fourth', { supersedes: 'first' }))).rejects.toThrow(DECISION_REFUSAL.alreadySuperseded('first'))
      expect(await f.backend.decisions(f.checkout)).toEqual(before)
    })

    it('a claim or a patch naming an unknown decision is refused and writes nothing; naming a recorded one is kept', async () => {
      const [plain] = await add(fact('plain', 'src/a.ts'))
      const id = plain?.id ?? ''
      const refused = KNOWLEDGE_REFUSAL.unknownDecision('ghost')
      await expect(f.backend.write(f.checkout, patch({ add: [{ ...fact('cites a ghost', 'src/a.ts'), decision: 'ghost' }] }))).rejects.toThrow(refused)
      await expect(f.backend.write(f.checkout, patch({ add: [fact('served a ghost', 'src/a.ts')], decision: 'ghost' }))).rejects.toThrow(refused)
      await expect(f.backend.write(f.checkout, patch({ change: [{ id, decision: 'ghost' }] }))).rejects.toThrow(refused)
      expect((await f.backend.card(f.checkout, '.', PAGE)).claims).toEqual(await f.backend.get(f.checkout, [id]))
      expect((await f.backend.get(f.checkout, [id]))[0]?.decision).toBeNull()
      const real = draft('A real decision')
      await f.backend.recordDecision(f.checkout, real)
      const [kept] = await add({ ...fact('cites it', 'src/a.ts'), decision: real.id })
      await f.backend.write(f.checkout, patch({ change: [{ id, decision: real.id }], decision: real.id }))
      expect((await f.backend.get(f.checkout, [kept?.id ?? '', id])).map(c => c.decision)).toEqual([real.id, real.id])
    })

    it('two records of one new title at once: exactly one wins', async () => {
      const settled = await Promise.allSettled([
        f.backend.recordDecision(f.checkout, draft('Raced', { context: 'One writer.' })),
        f.backend.recordDecision(f.checkout, draft('Raced', { context: 'The other writer.' })),
      ])
      expect(settled.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
      expect(settled.flatMap(r => (r.status === 'rejected' ? [String(r.reason)] : []))).toEqual([`Error: ${DECISION_REFUSAL.exists('raced')}`])
      expect((await f.backend.decisions(f.checkout)).length).toBe(1)
    })

    it('decisions in one checkout are invisible in another', async () => {
      await f.backend.recordDecision(f.checkout, draft('Only here'))
      expect(await f.backend.decisions(f.other)).toEqual([])
      expect(await f.backend.decision(f.other, decisionSlugOf('Only here'))).toBeNull()
    })

    it('a proposed decision reads back proposed', async () => {
      const result = await f.backend.recordDecision(f.checkout, draft('Maybe later', { status: DecisionStatus.proposed }))
      expect(result.status).toBe(DecisionStatus.proposed)
      expect((await f.backend.decision(f.checkout, 'maybe-later'))?.status).toBe(DecisionStatus.proposed)
    })
  })
}
