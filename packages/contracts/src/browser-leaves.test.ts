import { describe, expect, it } from 'bun:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// One static module edge: `import … from 'x'`, a side-effect `import 'x'`, and `export … from 'x'`
// — a re-export is a RUNTIME edge just like an import, so both forms are walked. The clause before
// `from` may span lines, so it is matched over `[\s\S]`-ish characters rather than `.`; it is held
// to the characters a clause can actually contain (names, `*`, braces, commas, whitespace) so a
// non-greedy match cannot run past the end of its own statement — `^` with the `m` flag anchors
// each match to the start of a statement. Dynamic import() is not matched — it is a runtime edge
// the bundler splits out.
const STATIC_EDGE = /^\s*(?:import|export)\s+(?:([\w$*,{}\s]+?)\s+from\s+)?['"]([^'"]+)['"]/gm

// `import type X` / `export type { X } from …`, and a specifier list where EVERY name is
// `type`-qualified, are erased before the bundler ever resolves them, so none of them reaches
// anything. The rule is the same for both forms. A bare `export * from 'x'` is ALWAYS a runtime
// edge — its clause is `*`, which is not type-qualified, so it is always followed.
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

// Derive the entry points from consumers: a hand-kept list silently leaves a new browser import
// unguarded. Test fixtures are not bundled; ui-core runtime dependencies are followed transitively.
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

/** every `node:` specifier reachable from `entry` over runtime edges (import AND re-export), named
 * with the file that has it */
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
  // The cases below are generated from what was derived: a moved browser tree or a glob that
  // matches nothing generates none, and a file with zero tests reports no failure.
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
