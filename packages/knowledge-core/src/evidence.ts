export enum EvidenceKind { delivered = 'delivered', asserted = 'asserted', retired = 'retired', checked = 'checked', read = 'read' }

export interface EvidenceDigest { path: string; symbol: string | null; digest: string | null }

export type EvidenceEvent =
  | { kind: EvidenceKind.delivered; seq: number; run: string | null; ids: readonly string[]; mode: string }
  | { kind: EvidenceKind.asserted; seq: number; run: string | null; id: string; text: string; anchors: readonly EvidenceDigest[] }
  | { kind: EvidenceKind.retired; seq: number; run: string | null; id: string }
  | { kind: EvidenceKind.checked; seq: number; run: string | null; id: string; text: string; verdict: string; accepts: boolean; anchors: readonly EvidenceDigest[] }
  | { kind: EvidenceKind.read; seq: number; run: string | null; path: string }

export interface ClaimEvidence { deliveries: number; lastDeliveredSeq: number | null; modes: Record<string, number>; retiredAfterDelivery: boolean; verdicts: Record<string, number> }
export interface RunEvidence { delivered: Array<{ seq: number; ids: readonly string[]; mode: string }>; reads: Array<{ seq: number; path: string }> }
export interface AnchorDigests { asserted: string[]; held: string[] }
export interface PathReads { reads: number; runs: Set<string> }

export interface Evidence {
  cursor: number
  claims: Map<string, ClaimEvidence>
  anchors: Map<string, AnchorDigests>
  runs: Map<string, RunEvidence>
  paths: Map<string, PathReads>
}

export interface AnchorReadSummary {
  deliveries: number
  followedByAnchorRead: number
  byMode: Record<string, { deliveries: number; followedByAnchorRead: number }>
}

export const anchorKey = (id: string, text: string, path: string, symbol: string | null): string => JSON.stringify([id, text, path, symbol])

export function emptyEvidence(): Evidence {
  return { cursor: 0, claims: new Map(), anchors: new Map(), runs: new Map(), paths: new Map() }
}

const NO_DIGESTS: { asserted: readonly string[]; held: readonly string[] } = { asserted: [], held: [] }

const entry = <V>(map: Map<string, V>, key: string, make: () => V): V => {
  const held = map.get(key)
  if (held !== undefined) return held
  const made = make()
  map.set(key, made)
  return made
}

const claimOf = (e: Evidence, id: string): ClaimEvidence =>
  entry(e.claims, id, () => ({ deliveries: 0, lastDeliveredSeq: null, modes: {}, retiredAfterDelivery: false, verdicts: {} }))
const runOf = (e: Evidence, run: string): RunEvidence => entry(e.runs, run, () => ({ delivered: [], reads: [] }))
const digestsOf = (e: Evidence, key: string): AnchorDigests => entry(e.anchors, key, () => ({ asserted: [], held: [] }))

const bump = (counts: Record<string, number>, key: string): void => { counts[key] = (counts[key] ?? 0) + 1 }

const remember = (e: Evidence, id: string, text: string, anchors: readonly EvidenceDigest[], side: (d: AnchorDigests) => string[]): void => {
  for (const a of anchors) {
    if (a.digest === null) continue
    const digests = side(digestsOf(e, anchorKey(id, text, a.path, a.symbol)))
    if (!digests.includes(a.digest)) digests.push(a.digest)
  }
}

const foldOne = (e: Evidence, event: EvidenceEvent): void => {
  switch (event.kind) {
    case EvidenceKind.delivered:
      for (const id of event.ids) {
        const claim = claimOf(e, id)
        claim.deliveries++
        claim.lastDeliveredSeq = event.seq
        bump(claim.modes, event.mode)
      }
      if (event.run !== null) runOf(e, event.run).delivered.push({ seq: event.seq, ids: event.ids, mode: event.mode })
      return
    case EvidenceKind.asserted:
      remember(e, event.id, event.text, event.anchors, d => d.asserted)
      return
    case EvidenceKind.retired: {
      const claim = e.claims.get(event.id)
      if (claim !== undefined && claim.deliveries > 0) claim.retiredAfterDelivery = true
      return
    }
    case EvidenceKind.checked:
      bump(claimOf(e, event.id).verdicts, event.verdict)
      if (event.accepts) remember(e, event.id, event.text, event.anchors, d => d.held)
      return
    case EvidenceKind.read: {
      const path = entry(e.paths, event.path, () => ({ reads: 0, runs: new Set<string>() }))
      path.reads++
      if (event.run === null) return
      path.runs.add(event.run)
      runOf(e, event.run).reads.push({ seq: event.seq, path: event.path })
    }
  }
}

export function foldEvidence(into: Evidence, events: readonly EvidenceEvent[]): Evidence {
  for (const event of events) {
    foldOne(into, event)
    into.cursor = Math.max(into.cursor, event.seq)
  }
  return into
}

export function anchorEvidence(e: Evidence, id: string, text: string, path: string, symbol: string | null): { asserted: readonly string[]; held: readonly string[] } {
  return e.anchors.get(anchorKey(id, text, path, symbol)) ?? NO_DIGESTS
}

export function anchorReadsAfterDelivery(
  e: Evidence,
  anchorPathsOf: (id: string) => readonly string[] | null,
  reaches: (path: string, anchorPath: string) => boolean,
): AnchorReadSummary {
  const summary: AnchorReadSummary = { deliveries: 0, followedByAnchorRead: 0, byMode: {} }
  for (const run of e.runs.values()) {
    for (const delivery of run.delivered) {
      const anchors = delivery.ids.flatMap(id => anchorPathsOf(id) ?? [])
      const followed = run.reads.some(r => r.seq > delivery.seq && anchors.some(a => reaches(r.path, a)))
      const mode = (summary.byMode[delivery.mode] ??= { deliveries: 0, followedByAnchorRead: 0 })
      summary.deliveries++
      mode.deliveries++
      if (!followed) continue
      summary.followedByAnchorRead++
      mode.followedByAnchorRead++
    }
  }
  return summary
}
