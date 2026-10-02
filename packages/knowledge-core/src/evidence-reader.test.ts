import { describe, expect, it } from 'bun:test'
import { CheckVerdict, EVENT_KIND, type EventKind } from '@orc/contracts'
import { authorFixture } from '@orc/contracts/fixtures'
import { anchorEvidence } from './evidence'
import { BASIS_EVIDENCE_KINDS, type EvidenceRecord } from './evidence-events'
import { createEvidenceReader } from './evidence-reader'

const holds = (seq: number, digest: string): EvidenceRecord => ({
  seq, kind: EVENT_KIND.knowledge_checked, runToken: null,
  payload: { id: 'aaaa0001', verdict: CheckVerdict.holds, text: 'a writes', anchors: [{ path: 'src/a.ts', symbol: null, digest }], why: 'read it', author: authorFixture() },
})
const undecodable = (seq: number): EvidenceRecord => ({ seq, kind: EVENT_KIND.knowledge_checked, runToken: null, payload: {} })

const fakeSource = (records: EvidenceRecord[]) => {
  const asked: Array<[number, readonly EventKind[]]> = []
  let failNext = false
  let gate: Promise<void> | null = null
  return {
    asked,
    failOnce: () => { failNext = true },
    holdNext: (): (() => void) => {
      let release = () => {}
      gate = new Promise<void>(resolve => { release = resolve })
      return () => release()
    },
    source: {
      earliestSeq: async (): Promise<number> => (records.length === 0 ? 0 : Math.min(...records.map(r => r.seq))),
      after: async (seq: number, kinds: readonly EventKind[]): Promise<EvidenceRecord[]> => {
        asked.push([seq, kinds])
        if (failNext) { failNext = false; throw new Error('log down') }
        const answer = records.filter(r => r.seq > seq)
        const held = gate
        gate = null
        if (held !== null) await held
        return answer
      },
    },
  }
}
const heldOf = async (reader: ReturnType<typeof createEvidenceReader>) => anchorEvidence(await reader.read(), 'aaaa0001', 'a writes', 'src/a.ts', null).held

describe('createEvidenceReader', () => {
  it('the second read asks after the last seq it was given, and both return the same evidence', async () => {
    const records = [holds(1, 'd1'), undecodable(2)]
    const { asked, source } = fakeSource(records)
    const reader = createEvidenceReader(source, BASIS_EVIDENCE_KINDS)
    const first = await reader.read()
    records.push(holds(3, 'd3'))
    const second = await reader.read()
    expect(second).toBe(first)
    expect(asked).toEqual([[0, BASIS_EVIDENCE_KINDS], [2, BASIS_EVIDENCE_KINDS]])
    expect(await heldOf(reader)).toEqual(['d1', 'd3'])
  })

  it('a read that arrives while a fetch is in flight waits for it, then fetches what was appended meanwhile', async () => {
    const records = [holds(1, 'd1')]
    const { asked, source, holdNext } = fakeSource(records)
    const reader = createEvidenceReader(source, BASIS_EVIDENCE_KINDS)
    const release = holdNext()
    const first = reader.read()
    while (asked.length === 0) await Bun.sleep(1)
    records.push(holds(2, 'd2'))
    const second = reader.read()
    await Bun.sleep(5)
    expect(asked.length).toBe(1)
    release()
    expect(anchorEvidence(await first, 'aaaa0001', 'a writes', 'src/a.ts', null).held).toEqual(['d1'])
    expect(anchorEvidence(await second, 'aaaa0001', 'a writes', 'src/a.ts', null).held).toEqual(['d1', 'd2'])
    expect(asked.map(([seq]) => seq)).toEqual([0, 1])
  })

  it('a purge of the oldest records starts the evidence over, so a purged check no longer clears anything', async () => {
    const records = [holds(1, 'd1'), holds(2, 'd2')]
    const { source } = fakeSource(records)
    const reader = createEvidenceReader(source, BASIS_EVIDENCE_KINDS)
    expect(await heldOf(reader)).toEqual(['d1', 'd2'])
    records.splice(0, 1)
    expect(await heldOf(reader)).toEqual(['d2'])
  })

  it('a log whose seqs restart below the cursor, from another earliest seq, is read again from its start', async () => {
    const records = [holds(5, 'd5'), holds(6, 'd6')]
    const { source } = fakeSource(records)
    const reader = createEvidenceReader(source, BASIS_EVIDENCE_KINDS)
    expect(await heldOf(reader)).toEqual(['d5', 'd6'])
    records.splice(0, records.length, holds(1, 'n1'))
    expect(await heldOf(reader)).toEqual(['n1'])
  })

  it('a failed fetch rejects and leaves the cursor, so the next read fetches the same records', async () => {
    const { asked, source, failOnce } = fakeSource([holds(1, 'd1')])
    const reader = createEvidenceReader(source, BASIS_EVIDENCE_KINDS)
    failOnce()
    await expect(reader.read()).rejects.toThrow('log down')
    expect(await heldOf(reader)).toEqual(['d1'])
    expect(asked.map(([seq]) => seq)).toEqual([0, 0])
  })
})
