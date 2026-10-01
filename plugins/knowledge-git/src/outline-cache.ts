import path from 'node:path'
import { sha256, type Outline, type StructureProvider } from '@orc/contracts'

export type SourceOutline = (anchorPath: string, source: string) => Promise<Outline | null>

export function createOutlineCache(structure: StructureProvider): SourceOutline {
  const cache = new Map<string, Promise<Outline | null>>()
  return (anchorPath, source) => {
    const key = sha256(`${path.extname(anchorPath)}\0${source}`)
    const held = cache.get(key)
    if (held) return held
    const outline = structure.outline(source, anchorPath)
    cache.set(key, outline)
    return outline
  }
}
