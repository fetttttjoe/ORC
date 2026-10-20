import { describe, expect, it } from 'bun:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// static edges incl. re-exports; dynamic import() is not matched: the bundler splits it
const STATIC_EDGE = /^\s*(?:import|export)\s+(?:([\w$*,{}\s]+?)\s+from\s+)?['"]([^'"]+)['"]/gm

// type-qualified edges are erased before bundling; a bare export * is always runtime
const typeOnly = (clause: string | undefined): boolean => {
  if (clause === undefined) return false
  if (clause.startsWith('type ')) return true
  const braced = clause.match(/^\{([\s\S]*)\}$/)
  if (braced === null) return false
  const names = (braced[1] ?? '').split(',').map((name) => name.trim()).filter((name) => name.length > 0)
  return names.length > 0 && names.every((name) => name.startsWith('type '))
}

const runtimeEdges = (source: string): string[] =>
  [...source.matchAll(STATIC_EDGE)].flatMap(match =>
    typeOnly(match[1]) || match[2] === undefined ? [] : [match[2]])

const resolveModule = (specifier: string, from: URL): URL =>
  pathToFileURL(Bun.resolveSync(specifier, fileURLToPath(new URL('.', from))))

// derived from consumers: a hand-kept list silently leaves new browser imports unguarded
const browserLeaves = async (): Promise<{ leaves: Map<string, URL>; scanned: number }> => {
  const leaves = new Map<string, URL>()
  let scanned = 0
  const seen = new Set<string>()
  const collect = async (module: URL): Promise<void> => {
    if (seen.has(module.href)) return
    seen.add(module.href)
    for (const specifier of runtimeEdges(await Bun.file(module).text())) {
      if (specifier === '@orc/contracts' || specifier.startsWith('@orc/contracts/')) {
        leaves.set(specifier, resolveModule(specifier, module))
      } else if (specifier.startsWith('.') || specifier === '@orc/ui-core' || specifier.startsWith('@orc/ui-core/')) {
        await collect(resolveModule(specifier, module))
      }
    }
  }
  const browser = new URL('../../graph-ui/web/src/', import.meta.url)
  for await (const path of new Bun.Glob('**/*.{ts,svelte}').scan(fileURLToPath(browser))) {
    if (path.endsWith('.test.ts') || path.endsWith('.d.ts')) continue
    scanned++
    await collect(new URL(path, browser))
  }
  await collect(new URL('../../ui-core/src/wire.ts', import.meta.url))
  return { leaves, scanned }
}

// every node: specifier reachable over runtime edges, with the file that has it
const nodeImportsReachedFrom = async (entry: URL): Promise<string[]> => {
  const seen = new Set<string>()
  const found: string[] = []
  const visit = async (module: URL): Promise<void> => {
    if (seen.has(module.href)) return
    seen.add(module.href)
    for (const specifier of runtimeEdges(await Bun.file(module).text())) {
      if (specifier.startsWith('node:')) {
        found.push(`${module.pathname} imports ${specifier}`)
        continue
      }
      if (specifier.startsWith('.') || specifier.startsWith('@orc/contracts/'))
        await visit(resolveModule(specifier, module))
    }
  }
  await visit(entry)
  return found
}

const { leaves, scanned } = await browserLeaves()

describe('the browser leaves of @orc/contracts', () => {
  // generated cases: an empty derivation would generate no tests and report no failure
  it('finds the browser sources and derives leaves from them', () => {
    expect(scanned).toBeGreaterThan(0)
    expect(leaves.size).toBeGreaterThan(0)
  })
  for (const [leaf, entry] of [...leaves].sort(([a], [b]) => a.localeCompare(b))) {
    it(`${leaf} reaches no node: builtin`, async () => {
      expect(await nodeImportsReachedFrom(entry)).toEqual([])
    })
  }
})
