import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CheckVerdict, ClaimClass, ClaimState, type KnowledgePatchInput, type KnowledgePort } from '@orc/contracts'
import { authorFixture } from '@orc/contracts/fixtures'
import { BASIS_EVIDENCE_KINDS, createEvidenceReader, createKnowledgePort, type EvidenceRecord } from '@orc/knowledge-core'
import { createGitFilesBackend } from './backend'
import { commitAll, gitCheckout, structure } from './test-helpers'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const SOURCE = 'export function alpha() {}\nexport function outer() {\n  function inner() {}\n}\n'
const OUTER_EDITED = 'export function alpha() {}\nexport function outer() {\n  function inner() { return 1 }\n}\n'
const OUTER_EDITED_AGAIN = 'export function alpha() {}\nexport function outer() {\n  function inner() { return 2 }\n}\n'
const BUCKET = 'knowledge/src/a.ts.md'
const call = { author: authorFixture(), idempotencyKey: null }

const setup = () => {
  const checkout = gitCheckout()
  const lockDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-klock-')))
  dirs.push(checkout, lockDir)
  const backend = createGitFilesBackend({}, { structure, locks: { staleMs: 30_000, retryMs: 5, timeoutMs: 10_000, dir: lockDir } })
  const records: EvidenceRecord[] = []
  const reader = createEvidenceReader({
    after: async (seq, kinds) => records.filter(r => r.seq > seq && kinds.some(k => k === r.kind)),
    earliestSeq: async () => records[0]?.seq ?? 0,
  }, BASIS_EVIDENCE_KINDS)
  const port = createKnowledgePort({
    backend,
    checkoutOf: async () => checkout,
    append: async e => { records.push({ seq: records.length + 1, kind: e.kind, runToken: e.runToken ?? null, payload: e.payload }) },
    evidence: () => reader.read(),
  })
  const blameOnly = createKnowledgePort({ backend, checkoutOf: async () => checkout, append: async () => {} })
  const put = (source: string) => writeFileSync(path.join(checkout, 'src/a.ts'), source)
  const write = async (patch: KnowledgePatchInput): Promise<string[]> => (await port.write(call, patch)).added.map(r => r.id)
  const stateIn = async (p: KnowledgePort, id: string) => (await p.drift(call, { ids: [id] }))[0]?.state
  const states = async (id: string) => [await stateIn(port, id), await stateIn(blameOnly, id)]
  put(SOURCE)
  return { checkout, backend, put, write, port, states }
}
const onOuter = (text: string) => ({ text, class: ClaimClass.fact, anchors: [{ path: 'src/a.ts', symbol: 'outer' }] })
const onAlpha = (text: string) => ({ text, class: ClaimClass.fact, anchors: [{ path: 'src/a.ts', symbol: 'alpha' }] })

describe('a port-written claim keeps the code its writer saw as its basis', () => {
  it('a claim written before its symbol changed reads suspect after both are committed together, until its text is re-asserted', async () => {
    const { checkout, put, write, port, states } = setup()
    commitAll(checkout, 'source')
    const [id = ''] = await write({ add: [onOuter('outer only declares its inner helper')] })
    put(OUTER_EDITED)
    commitAll(checkout, 'the claim and an edit to outer, together')
    expect(await states(id)).toEqual([ClaimState.suspect, ClaimState.clean])
    await port.write(call, { change: [{ id, text: 'outer declares an inner helper that returns one' }] })
    expect((await states(id))[0]).toBe(ClaimState.clean)
  })

  it('a corrective false check asserts the code it read: a later edit committed together with the correction reads suspect', async () => {
    const { checkout, put, write, port, states } = setup()
    commitAll(checkout, 'source')
    const [id = ''] = await write({ add: [onOuter('outer only declares its inner helper')] })
    put(OUTER_EDITED)
    commitAll(checkout, 'the claim and an edit to outer, together')
    expect(await states(id)).toEqual([ClaimState.suspect, ClaimState.clean])
    await port.check(call, { id, verdict: CheckVerdict.false, why: 'inner returns one now', patch: { change: [{ id, text: 'outer declares an inner helper that returns one' }] } })
    expect((await states(id))[0]).toBe(ClaimState.clean)
    put(OUTER_EDITED_AGAIN)
    commitAll(checkout, 'the correction and another edit to outer, together')
    expect(await states(id)).toEqual([ClaimState.suspect, ClaimState.clean])
  })

  it('a hand-added tag on a committed claim\'s line does not clear it, and a committed fmt re-sort changes no state', async () => {
    const { checkout, backend, put, write, states } = setup()
    const [id = '', other = ''] = await write({ add: [onOuter('outer only declares its inner helper'), onAlpha('alpha returns nothing to its caller')] })
    const bucket = path.join(checkout, BUCKET)
    const [title, blank, heading, ...lines] = readFileSync(bucket, 'utf8').trimEnd().split('\n')
    writeFileSync(bucket, `${[title, blank, heading, ...lines.reverse()].join('\n')}\n`)
    commitAll(checkout, 'claims, out of canonical order')
    put(OUTER_EDITED)
    commitAll(checkout, 'outer changes')
    expect(await states(id)).toEqual([ClaimState.suspect, ClaimState.suspect])
    writeFileSync(bucket, readFileSync(bucket, 'utf8').replace(new RegExp(`(\\{${id} [^}]*)\\}`), '$1 #reviewed}'))
    commitAll(checkout, 'a tag added by hand')
    expect(await states(id)).toEqual([ClaimState.suspect, ClaimState.clean])
    expect((await backend.format(checkout)).formatted).toEqual([BUCKET])
    commitAll(checkout, 'fmt')
    expect(await states(id)).toEqual([ClaimState.suspect, ClaimState.clean])
    expect(await states(other)).toEqual([ClaimState.clean, ClaimState.clean])
  })
})
