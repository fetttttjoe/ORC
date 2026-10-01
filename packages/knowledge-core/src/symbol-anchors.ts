import {
  KNOWLEDGE_REFUSAL, STRUCTURE_LIMITS,
  type KnowledgeAddition, type KnowledgeAnchor, type KnowledgeChange, type KnowledgePatch, type Outline,
} from '@orc/contracts'
import { matchSymbol } from './symbol-match'

export enum SymbolVerdict { exact = 'exact', short = 'short', unknown = 'unknown', unsupported = 'unsupported' }

export type SymbolJudgement =
  | { verdict: SymbolVerdict.exact }
  | { verdict: SymbolVerdict.short; full: string }
  | { verdict: SymbolVerdict.unknown; closest: string[] }
  | { verdict: SymbolVerdict.unsupported }

export type OutlineOf = (anchorPath: string) => Promise<Outline | null>

export function judgeSymbol(outline: Outline | null, symbol: string): SymbolJudgement {
  if (outline === null) return { verdict: SymbolVerdict.unsupported }
  const match = matchSymbol(outline.symbols.map(s => s.name), symbol, STRUCTURE_LIMITS.closestNames)
  if ('closest' in match) return { verdict: SymbolVerdict.unknown, closest: match.closest }
  return match.name === symbol ? { verdict: SymbolVerdict.exact } : { verdict: SymbolVerdict.short, full: match.name }
}

async function canonicalAnchor(anchor: KnowledgeAnchor, outlineOf: OutlineOf): Promise<KnowledgeAnchor> {
  if (anchor.symbol === null) return anchor
  const judged = judgeSymbol(await outlineOf(anchor.path), anchor.symbol)
  switch (judged.verdict) {
    case SymbolVerdict.exact: return anchor
    case SymbolVerdict.short: return { path: anchor.path, symbol: judged.full }
    case SymbolVerdict.unknown: throw new Error(KNOWLEDGE_REFUSAL.unknownSymbol(anchor.path, anchor.symbol, judged.closest))
    case SymbolVerdict.unsupported: throw new Error(KNOWLEDGE_REFUSAL.symbolUnsupported(anchor.path))
  }
}

const canonicalAnchors = (anchors: readonly KnowledgeAnchor[], outlineOf: OutlineOf): Promise<KnowledgeAnchor[]> =>
  Promise.all(anchors.map(a => canonicalAnchor(a, outlineOf)))

export async function canonicalizePatch(patch: KnowledgePatch, outlineOf: OutlineOf): Promise<KnowledgePatch> {
  const add: KnowledgeAddition[] = []
  for (const a of patch.add) add.push({ ...a, anchors: await canonicalAnchors(a.anchors, outlineOf) })
  const change: KnowledgeChange[] = []
  for (const c of patch.change) change.push(c.anchors === undefined ? c : { ...c, anchors: await canonicalAnchors(c.anchors, outlineOf) })
  return { ...patch, add, change }
}
