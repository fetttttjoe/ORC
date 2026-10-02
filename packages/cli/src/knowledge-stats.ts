import { z } from 'zod'
import { CheckVerdict, ClaimState, DeliveryMode, underEntity, type ClaimDrift } from '@orc/contracts'
import { anchorReadsAfterDelivery, type Evidence } from '@orc/knowledge-core'

export const STATS_DEFAULT_TOP = 15
export const NO_EXTENSION = '(none)'
export const GONE_LOCATION = '(no longer in the corpus)'

export type ByMode = Partial<Record<DeliveryMode, number>>
export interface HotClaim { id: string; claimDeliveries: number; location: string | null }
export interface HotPath { path: string; claimDeliveries: number }
export interface GapPath { path: string; runs: number; reads: number }
export interface FollowedByMode { deliveryEvents: number; followedByAnchorRead: number }

export interface KnowledgeStats {
  corpus: Record<ClaimState, number>
  claimDeliveries: { total: number; distinctClaims: number; byMode: ByMode }
  runDeliveryEvents: { events: number; claimDeliveries: number; followedByAnchorRead: number; byMode: Partial<Record<DeliveryMode, FollowedByMode>> }
  hotClaims: HotClaim[]
  hotAnchorPaths: HotPath[]
  retiredAfterDelivery: number
  verdicts: Partial<Record<CheckVerdict, number>>
  gaps: { total: number; top: GapPath[]; byExtension: Record<string, number>; folderCovered: number }
}

const sum = (values: Iterable<number>): number => { let total = 0; for (const v of values) total += v; return total }
const bump = <K extends string>(counts: Partial<Record<K, number>>, key: K, by = 1): void => { counts[key] = (counts[key] ?? 0) + by }
const byCountThen = (a: { claimDeliveries: number }, b: { claimDeliveries: number }): number => b.claimDeliveries - a.claimDeliveries
const Mode = z.enum(DeliveryMode)
const Verdict = z.enum(CheckVerdict)

export const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? NO_EXTENSION : name.slice(dot)
}

export function knowledgeStats(evidence: Evidence, drifts: readonly ClaimDrift[], top: number): KnowledgeStats {
  const corpus: Record<ClaimState, number> = { [ClaimState.clean]: 0, [ClaimState.suspect]: 0, [ClaimState.unknown]: 0, [ClaimState.unanchored]: 0 }
  const anchorPaths = new Map<string, string[]>()
  const locations = new Map<string, string>()
  const anchored = new Set<string>()
  for (const d of drifts) {
    corpus[d.state]++
    locations.set(d.claim.id, d.claim.location)
    const paths = [...new Set(d.anchors.map(a => a.path))]
    anchorPaths.set(d.claim.id, paths)
    for (const p of paths) anchored.add(p)
  }

  const byMode: ByMode = {}
  const verdicts: Partial<Record<CheckVerdict, number>> = {}
  const hotPaths = new Map<string, number>()
  const hotClaims: HotClaim[] = []
  let retiredAfterDelivery = 0
  for (const [id, claim] of evidence.claims) {
    for (const [mode, n] of Object.entries(claim.modes)) { const parsed = Mode.safeParse(mode); if (parsed.success) bump(byMode, parsed.data, n) }
    for (const [verdict, n] of Object.entries(claim.verdicts)) { const parsed = Verdict.safeParse(verdict); if (parsed.success) bump(verdicts, parsed.data, n) }
    if (claim.deliveries === 0) continue
    if (claim.retiredAfterDelivery) retiredAfterDelivery++
    hotClaims.push({ id, claimDeliveries: claim.deliveries, location: locations.get(id) ?? null })
    for (const p of anchorPaths.get(id) ?? []) hotPaths.set(p, (hotPaths.get(p) ?? 0) + claim.deliveries)
  }

  const gapPaths: GapPath[] = []
  let folderCovered = 0
  for (const [path, reads] of evidence.paths) {
    if (anchored.has(path)) continue
    if ([...anchored].some(a => underEntity(a, path))) { folderCovered++; continue }
    gapPaths.push({ path, runs: reads.runs.size, reads: reads.reads })
  }
  gapPaths.sort((a, b) => b.runs - a.runs || b.reads - a.reads || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const byExtension: Record<string, number> = {}
  for (const g of gapPaths) bump(byExtension, extensionOf(g.path))

  const reads = anchorReadsAfterDelivery(evidence, id => anchorPaths.get(id) ?? null, (path, anchor) => underEntity(anchor, path))
  const followed: Partial<Record<DeliveryMode, FollowedByMode>> = {}
  for (const [mode, v] of Object.entries(reads.byMode)) {
    const parsed = Mode.safeParse(mode)
    if (parsed.success) followed[parsed.data] = { deliveryEvents: v.deliveries, followedByAnchorRead: v.followedByAnchorRead }
  }
  const runDeliveries = [...evidence.runs.values()].flatMap(r => r.delivered)

  return {
    corpus,
    claimDeliveries: { total: sum(Object.values(byMode)), distinctClaims: hotClaims.length, byMode },
    runDeliveryEvents: {
      events: reads.deliveries, claimDeliveries: sum(runDeliveries.map(d => d.ids.length)), followedByAnchorRead: reads.followedByAnchorRead, byMode: followed,
    },
    hotClaims: hotClaims.sort(byCountThen).slice(0, top),
    hotAnchorPaths: [...hotPaths].map(([path, claimDeliveries]) => ({ path, claimDeliveries })).sort(byCountThen).slice(0, top),
    retiredAfterDelivery,
    verdicts,
    gaps: { total: gapPaths.length, top: gapPaths.slice(0, top), byExtension, folderCovered },
  }
}

const countsLine = (counts: Partial<Record<string, number>>): string =>
  Object.entries(counts).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).map(([k, n]) => `${k} ${n}`).join(' · ') || '-'

export function renderStats(s: KnowledgeStats): string[] {
  const d = s.runDeliveryEvents
  const modes = Object.entries(d.byMode).map(([m, v]) => `${m} ${v.followedByAnchorRead}/${v.deliveryEvents}`).join(' · ') || '-'
  return [
    `claims: ${Object.values(ClaimState).map(state => `${state} ${s.corpus[state]}`).join(' · ')}`,
    `claim-deliveries: ${s.claimDeliveries.total} to ${s.claimDeliveries.distinctClaims} claims (${countsLine(s.claimDeliveries.byMode)})`,
    `delivery events in runs: ${d.events} carrying ${d.claimDeliveries} claim-deliveries`,
    'hot claims (claim-deliveries):',
    ...(s.hotClaims.length === 0 ? ['  -'] : s.hotClaims.map(c => `  ${c.claimDeliveries}  ${c.id}  ${c.location ?? GONE_LOCATION}`)),
    'hot anchor paths (claim-deliveries):',
    ...(s.hotAnchorPaths.length === 0 ? ['  -'] : s.hotAnchorPaths.map(p => `  ${p.claimDeliveries}  ${p.path}`)),
    `claims retired after delivery: ${s.retiredAfterDelivery}`,
    `delivery events in runs followed by an anchor read: ${d.followedByAnchorRead}/${d.events} (${modes})`,
    `check verdicts: ${countsLine(s.verdicts)}`,
    `gaps: ${s.gaps.total} files read with no claim (${s.gaps.folderCovered} covered by a folder claim alone)`,
    ...s.gaps.top.map(g => `  ${g.runs} runs  ${g.reads} reads  ${g.path}`),
    `gap extensions: ${countsLine(s.gaps.byExtension)}`,
  ]
}
