import type { EventKind } from '@orc/contracts'
import { emptyEvidence, foldEvidence, type Evidence } from './evidence'
import { evidenceEventsOf, type EvidenceRecord } from './evidence-events'

export interface EvidenceSource {
  after(seq: number, kinds: readonly EventKind[]): Promise<EvidenceRecord[]>
  earliestSeq(): Promise<number>
}
export interface EvidenceReader { read(): Promise<Evidence> }

interface Folded { evidence: Evidence; cursor: number; earliest: number }

export function createEvidenceReader(source: EvidenceSource, kinds: readonly EventKind[]): EvidenceReader {
  let folded: Folded | null = null
  let last: Promise<unknown> = Promise.resolve()
  const next = async (): Promise<Evidence> => {
    const earliest = await source.earliestSeq()
    const kept = folded !== null && folded.earliest === earliest ? folded : null
    const cursor = kept?.cursor ?? 0
    const records = await source.after(cursor, kinds)
    const evidence = foldEvidence(kept?.evidence ?? emptyEvidence(), evidenceEventsOf(records))
    folded = { evidence, earliest, cursor: records.reduce((highest, r) => Math.max(highest, r.seq), cursor) }
    return evidence
  }
  return {
    read() {
      const fetched = last.then(next, next)
      last = fetched.catch(() => {})
      return fetched
    },
  }
}
