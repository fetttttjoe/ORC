import { readFileSync } from 'node:fs'
import path from 'node:path'
import { KNOWLEDGE_REFUSAL, type KnowledgeAnchor, type KnowledgeClaim } from '@orc/contracts'
import { judgeSymbol, SymbolVerdict, textOf, type OutlineOf } from '@orc/knowledge-core'
import { codeOf, Errno } from './error-code'
import type { SourceOutline } from './outline-cache'
import { KNOWLEDGE_PROBLEM } from './problems'

export type AnchorKindOf = (anchorPath: string) => unknown

export function readBytes(file: string): Uint8Array | null {
  try { return readFileSync(file) } catch (err) {
    if (codeOf(err) === Errno.ENOENT || codeOf(err) === Errno.EISDIR) return null
    throw err
  }
}

const readSource = (file: string): string | null => { const raw = readBytes(file); return raw === null ? null : textOf(raw) }

export function createAnchorOutlines(outlineOf: SourceOutline) {
  return (root: string, kindOf: AnchorKindOf): OutlineOf => async anchorPath => {
    kindOf(anchorPath)
    const source = readSource(path.join(root, anchorPath))
    return source === null ? null : outlineOf(anchorPath, source)
  }
}

export interface SymbolReport { problems: string[]; canonical: KnowledgeAnchor[] | null }

export async function reportSymbols(claim: KnowledgeClaim, outlineOf: OutlineOf, resolves: (anchorPath: string) => boolean): Promise<SymbolReport> {
  const problems: string[] = []
  let shortened = false
  let blocked = false
  const canonical: KnowledgeAnchor[] = []
  for (const anchor of claim.anchors) {
    if (anchor.symbol === null) { canonical.push(anchor); continue }
    if (!resolves(anchor.path)) { canonical.push(anchor); continue }
    const outline = await outlineOf(anchor.path)
    const judged = judgeSymbol(outline, anchor.symbol)
    switch (judged.verdict) {
      case SymbolVerdict.exact: canonical.push(anchor); break
      case SymbolVerdict.short:
        shortened = true
        canonical.push({ path: anchor.path, symbol: judged.full })
        problems.push(KNOWLEDGE_PROBLEM.shortSymbol(claim.id, anchor.symbol, judged.full))
        break
      case SymbolVerdict.unknown:
        blocked = true
        canonical.push(anchor)
        problems.push(KNOWLEDGE_PROBLEM.unknownSymbol(claim.id, anchor.path, anchor.symbol, judged.closest))
        break
      case SymbolVerdict.unsupported:
        blocked = true
        canonical.push(anchor)
        problems.push(KNOWLEDGE_PROBLEM.badAnchor(claim.id, KNOWLEDGE_REFUSAL.symbolUnsupported(anchor.path)))
        break
    }
  }
  return { problems, canonical: shortened && !blocked ? canonical : null }
}
