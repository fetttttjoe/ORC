import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { sha256, type Outline, type SymbolSpan } from '@orc/contracts'
import { createTreeSitterStructure } from './index'

const structure = createTreeSitterStructure()
const repoRoot = join(import.meta.dir, '../../..')

const outlineOf = async (source: string, path = 'probe.ts'): Promise<Outline> => {
  const outline = await structure.outline(source, path)
  if (outline === null) throw new Error(`no outline for ${path}`)
  return outline
}

const only = (outline: Outline, name: string): SymbolSpan => {
  const found = outline.symbols.filter(s => s.name === name)
  if (found.length !== 1) throw new Error(`${found.length} spans named ${name}`)
  return found[0]
}

const withoutDigest = ({ digest: _, ...span }: SymbolSpan) => span

const lines = (...source: string[]) => source.join('\n')

describe('outline of repository files', () => {
  it.each([
    ['packages/kernel/src/execution/dbos-port.ts', [['createDbosPort', 'function_declaration'], ['createDbosPort.makeCheckpoint', 'variable_declarator']]],
    ['packages/kernel/src/kernel.ts', [['Kernel', 'class_declaration'], ['Kernel.listTaskKnowledgeWrites', 'method_definition']]],
    ['packages/cli/src/runtime.ts', [['buildRuntime.port.stepTools', 'pair']]],
    ['packages/kernel/src/storage/event-log.ts', [['makeOps.append', 'method_definition']]],
  ])('%s lists %j', async (path, wanted) => {
    const outline = await outlineOf(await Bun.file(join(repoRoot, path)).text(), path)
    expect(outline.partial).toBe(false)
    expect(wanted.map(([name]) => [name, only(outline, name).kind])).toEqual(wanted)
  })
})

describe('digests', () => {
  const original = lines(
    'export function total(items: number[]): number {',
    '  let sum = 0',
    '  for (const item of items) sum += item',
    '  return sum',
    '}',
    'const other = 1',
  )

  it('ignore an added comment and re-indentation inside a function', async () => {
    const edited = lines(
      'export function total(items: number[]): number {',
      '    // running sum',
      '    let sum = 0',
      '      for (const item of items) sum += item /* add */',
      '    return sum',
      '}',
      'const other = 1',
    )
    const [before, after] = [await outlineOf(original), await outlineOf(edited)]
    expect(only(after, 'total').digest).toBe(only(before, 'total').digest)
    expect(after.digest).toBe(before.digest)
  })

  it('change when a local variable inside the function is renamed', async () => {
    const renamed = original.replaceAll('sum', 'acc')
    const [before, after] = [await outlineOf(original), await outlineOf(renamed)]
    expect(only(after, 'total').digest).not.toBe(only(before, 'total').digest)
    expect(after.digest).not.toBe(before.digest)
  })

  it('hash the leaf tokens joined by one space, comments dropped, an exported const spanning its statement', async () => {
    const outline = await outlineOf(lines('/** doc */', 'export const answer = (n: number) => n + 1 // trailing'))
    const tokens = sha256('export const answer = ( n : number ) => n + 1')
    expect(only(outline, 'answer')).toEqual({ name: 'answer', kind: 'variable_declarator', startLine: 2, endLine: 2, digest: tokens })
    expect(outline.digest).toBe(tokens)
  })
})

describe('names', () => {
  it('give one span per occurrence of a name in sibling blocks', async () => {
    const outline = await outlineOf(lines(
      'function f(flag: boolean): number {',
      '  if (flag) {',
      '    const x = 1',
      '    return x',
      '  } else {',
      '    const x = 2',
      '    return x',
      '  }',
      '}',
    ))
    expect(outline.symbols.map(withoutDigest)).toEqual([
      { name: 'f', kind: 'function_declaration', startLine: 1, endLine: 9 },
      { name: 'f.x', kind: 'variable_declarator', startLine: 3, endLine: 3 },
      { name: 'f.x', kind: 'variable_declarator', startLine: 6, endLine: 6 },
    ])
  })

  it('survive a syntax error elsewhere in the file, marked partial', async () => {
    const clean = 'function f() { return 1 }\n'
    const [before, after] = [await outlineOf(clean), await outlineOf(`${clean}const broken = (\n`)]
    expect(before.partial).toBe(false)
    expect(after.partial).toBe(true)
    expect(only(after, 'f').digest).toBe(only(before, 'f').digest)
  })
})

describe('grammars', () => {
  it.each(['.tsx', '.jsx'])('%s parses JSX', async extension => {
    expect((await outlineOf('const v = <div/>\n', `view${extension}`)).partial).toBe(false)
  })

  it.each(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'])('%s parses without JSX', async extension => {
    expect((await outlineOf('const v = <div/>\n', `view${extension}`)).partial).toBe(true)
  })

  it.each(['package.json', 'App.svelte'])('%s has no outline', async path => {
    expect(await structure.outline('{}', path)).toBeNull()
  })
})
