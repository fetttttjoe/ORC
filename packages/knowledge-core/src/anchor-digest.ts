import { createHash } from 'node:crypto'
import { sha256, type AnchorReading, type KnowledgeAnchor, type Outline } from '@orc/contracts'
import { judgeSymbol, SymbolVerdict } from './symbol-anchors'

export interface SourceView { outline: Outline | null; bytes: string }
export interface AnchorDigest { digest: string | null; readable: boolean }

export const GONE: AnchorDigest = { digest: null, readable: true }
export const UNREADABLE: AnchorDigest = { digest: null, readable: false }

export const textOf = (raw: Uint8Array): string => Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
export const sourceView = (raw: Uint8Array, outline: Outline | null): SourceView => ({ outline, bytes: createHash('sha256').update(raw).digest('hex') })

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export const directoryDigest = (files: readonly string[]): string => sha256([...files].sort(byCodeUnit).join('\n'))

const spansDigest = (outline: Outline, name: string): AnchorDigest =>
  ({ digest: sha256(outline.symbols.filter(s => s.name === name).map(s => s.digest).join(' ')), readable: true })

export function digestIn(view: SourceView, symbol: string | null): AnchorDigest {
  const { outline } = view
  if (symbol === null) return { digest: outline === null ? view.bytes : outline.digest, readable: true }
  if (outline === null) return UNREADABLE
  const judged = judgeSymbol(outline, symbol)
  switch (judged.verdict) {
    case SymbolVerdict.exact: return spansDigest(outline, symbol)
    case SymbolVerdict.short: return spansDigest(outline, judged.full)
    case SymbolVerdict.unknown: return outline.partial ? UNREADABLE : GONE
    case SymbolVerdict.unsupported: return UNREADABLE
  }
}

export const readingOf = (anchor: KnowledgeAnchor, basis: AnchorDigest, current: AnchorDigest): AnchorReading =>
  ({ path: anchor.path, symbol: anchor.symbol, basis: basis.digest, current: current.digest, readable: basis.readable && current.readable })
