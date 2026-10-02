import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  anchorState, ClaimClass, ClaimState, claimState, DriftFilter, KnowledgePatch, NO_ANCHOR_EVIDENCE,
  type ClaimReading, type DriftFilterInput, type KnowledgePatchInput,
} from '@orc/contracts'
import { createGitFilesBackend } from './backend'
import { BasisKind, createDrift, DRIFT_REFUSAL, parseBlame, runGit, type GitRun } from './drift'
import { createOutlineCache } from './outline-cache'
import { commitAll, commitPaths, git, gitCheckout, structure } from './test-helpers'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const SOURCE = 'export function alpha() {}\nexport function outer() {\n  function inner() {}\n}\n'
const ALPHA_EDITED = 'export function alpha() { return 1 }\nexport function outer() {\n  function inner() {}\n}\n'
const BUCKET = 'knowledge/src/a.ts.md'

const setup = (git: GitRun = runGit) => {
  const checkout = gitCheckout()
  const lockDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-klock-')))
  dirs.push(checkout, lockDir)
  const backend = createGitFilesBackend({}, { structure, git, locks: { staleMs: 30_000, retryMs: 5, timeoutMs: 10_000, dir: lockDir } })
  const put = (file: string, source: string) => writeFileSync(path.join(checkout, file), source)
  put('src/a.ts', SOURCE)
  const write = async (input: KnowledgePatchInput) => backend.write(checkout, KnowledgePatch.parse(input))
  const readings = async (filter: DriftFilterInput = {}) => backend.readings(checkout, DriftFilter.parse(filter))
  const stateOf = (r: ClaimReading | undefined): ClaimState | undefined => r && claimState(r.anchors.map(a => anchorState(a, NO_ANCHOR_EVIDENCE)))
  const head = (): string => Bun.spawnSync(['git', '-C', checkout, 'rev-parse', 'HEAD']).stdout.toString().trim()
  return { checkout, backend, put, write, readings, stateOf, head }
}
const symbolClaim = (text: string, symbol: string, file = 'src/a.ts') => ({ text, class: ClaimClass.fact, anchors: [{ path: file, symbol }] })
const fileClaim = (text: string, file: string) => ({ text, class: ClaimClass.fact, anchors: [{ path: file }] })

describe('git-files claim state from blame', () => {
  it('a claim line with no commit is clean whatever its anchor does: no commit yet, staged, then an untracked bucket', async () => {
    const { checkout, put, write, readings, stateOf } = setup()
    await write({ add: [symbolClaim('alpha does nothing at all', 'alpha')] })
    put('src/a.ts', ALPHA_EDITED)
    const uncommitted = async () => { const [r] = await readings(); return [stateOf(r), r?.basis] }
    expect(await uncommitted()).toEqual([ClaimState.clean, null])
    git(checkout, 'add', '--', 'knowledge')
    expect(await uncommitted()).toEqual([ClaimState.clean, null])
    git(checkout, 'add', '--', 'src')
    git(checkout, 'commit', '-q', '-m', 'source only', '--', 'src')
    put('src/a.ts', SOURCE)
    expect(await uncommitted()).toEqual([ClaimState.clean, null])
    git(checkout, 'rm', '-q', '-r', '--cached', '--', 'knowledge')
    put('src/a.ts', ALPHA_EDITED)
    expect(await uncommitted()).toEqual([ClaimState.clean, null])
  })

  it('committed, then a later commit edits its symbol: suspect at the claim\'s commit; a fmt re-sort keeps that basis; a text change re-asserts it clean', async () => {
    const { checkout, backend, put, write, readings, stateOf, head } = setup()
    const { added } = await write({ add: [
      symbolClaim('alpha returns nothing to its caller', 'alpha'), symbolClaim('inner is a helper local to outer', 'outer.inner'),
      symbolClaim('outer only declares its inner helper', 'outer'),
    ] })
    const [alpha, inner] = added
    const bucket = path.join(checkout, BUCKET)
    const [title, blank, heading, first, ...rest] = readFileSync(bucket, 'utf8').trimEnd().split('\n')
    expect(first).toContain(`{${alpha?.id} @src/a.ts#alpha}`)
    writeFileSync(bucket, `${[title, blank, heading, ...rest, first].join('\n')}\n`)
    commitAll(checkout, 'claims, out of canonical order')
    const asserted = head()
    put('src/a.ts', ALPHA_EDITED)
    commitAll(checkout, 'alpha returns one')
    const byId = async () => new Map((await readings()).map(r => [r.claim.id, r]))
    const edited = await byId()
    expect([stateOf(edited.get(alpha?.id ?? '')), edited.get(alpha?.id ?? '')?.basis]).toEqual([ClaimState.suspect, asserted])
    expect(stateOf(edited.get(inner?.id ?? ''))).toBe(ClaimState.clean)
    expect((await backend.format(checkout)).formatted).toEqual([BUCKET])
    commitAll(checkout, 'fmt')
    const resorted = await byId()
    expect([stateOf(resorted.get(alpha?.id ?? '')), resorted.get(alpha?.id ?? '')?.basis]).toEqual([ClaimState.suspect, asserted])
    await write({ change: [{ id: alpha?.id ?? '', text: 'alpha returns one to its caller' }] })
    const pending = (await byId()).get(alpha?.id ?? '')
    expect([stateOf(pending), pending?.basis]).toEqual([ClaimState.clean, null])
    commitAll(checkout, 'claim re-asserted')
    const reasserted = (await byId()).get(alpha?.id ?? '')
    expect([stateOf(reasserted), reasserted?.basis]).toEqual([ClaimState.clean, head()])
  })

  it('a short claim keeps its basis through a committed re-sort of its bucket', async () => {
    const { checkout, backend, put, write, readings, stateOf, head } = setup()
    const ids = ['aaaa0001', 'aaaa0002', 'aaaa0003']
    await write({ add: ids.map((id, i) => ({ ...fileClaim(['a', 'b', 'c'][i] ?? '', 'src/a.ts'), id })) })
    const bucket = path.join(checkout, BUCKET)
    const [title, blank, heading, ...lines] = readFileSync(bucket, 'utf8').trimEnd().split('\n')
    writeFileSync(bucket, `${[title, blank, heading, ...lines.reverse()].join('\n')}\n`)
    commitAll(checkout, 'short claims, reversed')
    const asserted = head()
    put('src/a.ts', ALPHA_EDITED)
    commitAll(checkout, 'alpha returns one')
    expect((await backend.format(checkout)).formatted).toEqual([BUCKET])
    commitAll(checkout, 'fmt')
    expect((await readings()).map(r => [r.claim.id, stateOf(r), r.basis])).toEqual(ids.map(id => [id, ClaimState.suspect, asserted]))
  })

  it('a short claim keeps its basis when fmt moves it to the bucket its anchor belongs in', async () => {
    const { checkout, backend, put, readings, stateOf, head } = setup()
    const misplaced = path.join(checkout, 'knowledge/src/b.ts.md')
    mkdirSync(path.dirname(misplaced), { recursive: true })
    writeFileSync(misplaced, '# src/b.ts\n\n## Facts\n- a runs {abcd1234 @src/a.ts#alpha}\n- b is {bbbb1234 @src/b.ts}\n')
    commitAll(checkout, 'a short claim in the wrong bucket')
    const asserted = head()
    put('src/a.ts', ALPHA_EDITED)
    commitAll(checkout, 'alpha returns one')
    expect((await backend.format(checkout)).formatted).toEqual([BUCKET, 'knowledge/src/b.ts.md'])
    commitAll(checkout, 'fmt moves it')
    const [moved] = await readings({ ids: ['abcd1234'] })
    expect([moved?.claim.location, stateOf(moved), moved?.basis]).toEqual([BUCKET, ClaimState.suspect, asserted])
  })

  it('a bucket rewritten between the snapshot and the blame still maps each claim to its own line', async () => {
    let racing = ''
    const racer: GitRun = async (root, args, stdin) => {
      if (args[0] === 'blame' && racing !== '') {
        const bucket = path.join(root, BUCKET)
        writeFileSync(bucket, readFileSync(bucket, 'utf8').replace('## Facts\n', `## Facts\n${racing}\n`))
        racing = ''
      }
      return runGit(root, args, stdin)
    }
    const { checkout, put, write, readings, stateOf, head } = setup(racer)
    const [ref] = (await write({ add: [symbolClaim('alpha returns nothing to its caller', 'alpha')] })).added
    commitAll(checkout, 'claim')
    const asserted = head()
    put('src/a.ts', ALPHA_EDITED)
    commitAll(checkout, 'alpha returns one')
    racing = '- written while the drift read ran {zzzz0000 @src/a.ts}'
    const [raced] = await readings({ ids: [ref?.id ?? ''] })
    expect([stateOf(raced), raced?.basis]).toEqual([ClaimState.suspect, asserted])
  })

  it('object lookups git answers with neither an object nor missing fail the read instead of reading clean', async () => {
    let garbled = false
    const garbling: GitRun = async (root, args, stdin) => (garbled && args[0] === 'cat-file' && args[1]?.startsWith('--batch-check') ? Buffer.from('fatal: not what we asked\n') : runGit(root, args, stdin))
    const { checkout, put, write, readings } = setup(garbling)
    await write({ add: [symbolClaim('alpha returns nothing to its caller', 'alpha')] })
    commitAll(checkout, 'claim')
    put('src/a.ts', ALPHA_EDITED)
    garbled = true
    await expect(readings()).rejects.toThrow(DRIFT_REFUSAL.unreadable('fatal: not what we asked'))
  })

  it('a staged pure move of a bucket keeps the basis of its lines', async () => {
    const { checkout, put, write, readings, stateOf, head } = setup()
    await write({ add: [symbolClaim('alpha returns nothing to its caller', 'alpha')] })
    commitAll(checkout, 'claim')
    const asserted = head()
    put('src/a.ts', ALPHA_EDITED)
    commitAll(checkout, 'alpha returns one')
    git(checkout, 'mv', BUCKET, 'knowledge/src/moved.md')
    const [moved] = await readings()
    expect([moved?.claim.location, stateOf(moved), moved?.basis]).toEqual(['knowledge/src/moved.md', ClaimState.suspect, asserted])
  })

  it('a claim committed before its anchored symbol or file was committed reads suspect, and a deleted anchored file reads suspect', async () => {
    const { checkout, put, write, readings, stateOf } = setup()
    commitAll(checkout, 'source without beta')
    put('src/a.ts', `${SOURCE}export function beta() {}\n`)
    put('src/new.ts', 'export const fresh = true\n')
    const [early, newer] = (await write({ add: [symbolClaim('beta came later than its claim', 'beta'), fileClaim('new arrived after its claim', 'src/new.ts')] })).added
    commitPaths(checkout, 'claims only', ['knowledge'])
    const [gone] = (await write({ add: [fileClaim('b is a module of its own', 'src/b.ts')] })).added
    commitAll(checkout, 'b claim')
    rmSync(path.join(checkout, 'src/b.ts'))
    const states = new Map((await readings()).map(r => [r.claim.id, r]))
    expect(states.get(early?.id ?? '')?.anchors[0]).toMatchObject({ basis: null, readable: true })
    expect(stateOf(states.get(early?.id ?? ''))).toBe(ClaimState.suspect)
    expect(states.get(newer?.id ?? '')?.anchors[0]).toMatchObject({ basis: null, readable: true })
    expect(stateOf(states.get(newer?.id ?? ''))).toBe(ClaimState.suspect)
    expect(states.get(gone?.id ?? '')?.anchors[0]).toMatchObject({ current: null })
    expect(stateOf(states.get(gone?.id ?? ''))).toBe(ClaimState.suspect)
  })

  it('a committed file that starts with a byte-order mark reads the same digest at its basis as in the tree', async () => {
    const { checkout, put, write, readings, stateOf } = setup()
    put('pkg/package.json', '\uFEFF{ "name": "pkg" }\n')
    await write({ add: [fileClaim('the manifest names the package', 'pkg/package.json')] })
    commitAll(checkout, 'manifest with a bom')
    expect(stateOf((await readings())[0])).toBe(ClaimState.clean)
  })

  it('a file with no outline is digested by its bytes: an edit between two bytes that decode alike turns its claim suspect', async () => {
    const { checkout, write, readings, stateOf } = setup()
    const blob = path.join(checkout, 'pkg/blob.bin')
    writeFileSync(blob, Uint8Array.of(0x7b, 0x80, 0x7d))
    await write({ add: [fileClaim('the blob holds one byte between braces', 'pkg/blob.bin')] })
    commitAll(checkout, 'blob')
    expect(stateOf((await readings())[0])).toBe(ClaimState.clean)
    writeFileSync(blob, Uint8Array.of(0x7b, 0x81, 0x7d))
    expect(stateOf((await readings())[0])).toBe(ClaimState.suspect)
  })

  it('a directory anchor flags when a file under it is added or deleted, not when one is edited', async () => {
    const { checkout, put, write, readings, stateOf } = setup()
    await write({ add: [fileClaim('pkg holds the package manifest and c', 'pkg')] })
    commitAll(checkout, 'pkg claim')
    put('pkg/src/c.ts', 'export const c = 1\n')
    expect(stateOf((await readings())[0])).toBe(ClaimState.clean)
    commitAll(checkout, 'c edited')
    expect(stateOf((await readings())[0])).toBe(ClaimState.clean)
    rmSync(path.join(checkout, 'pkg/src/c.ts'))
    expect(stateOf((await readings())[0])).toBe(ClaimState.suspect)
    put('pkg/src/c.ts', 'export const c = 2\n')
    expect(stateOf((await readings())[0])).toBe(ClaimState.clean)
    put('pkg/src/d.ts', 'export const d = 1\n')
    expect(stateOf((await readings())[0])).toBe(ClaimState.suspect)
    commitAll(checkout, 'd added')
    expect(stateOf((await readings())[0])).toBe(ClaimState.suspect)
  })

  it('a symbol anchor on a file type that has no outline is never clean, committed or not', async () => {
    const { checkout, readings, stateOf } = setup()
    const bucket = path.join(checkout, 'pkg/knowledge/README.md')
    mkdirSync(path.dirname(bucket), { recursive: true })
    writeFileSync(bucket, '# pkg\n\n## Facts\n- The manifest names the package after its folder. {abcd1234 @pkg/package.json#name}\n')
    expect(stateOf((await readings())[0])).toBe(ClaimState.unknown)
    commitAll(checkout, 'hand-written claim')
    expect(stateOf((await readings())[0])).toBe(ClaimState.unknown)
  })

  it('reads each basis blob once across readings, and two claims on one file at one basis share it', async () => {
    const asked: string[][] = []
    const counting: GitRun = (root, args, stdin) => { asked.push([...args]); return runGit(root, args, stdin) }
    const { checkout, put, write, readings } = setup(counting)
    await write({ add: [symbolClaim('alpha returns nothing to its caller', 'alpha'), symbolClaim('inner is a helper local to outer', 'outer.inner')] })
    commitAll(checkout, 'claims')
    put('src/a.ts', ALPHA_EDITED)
    const blobReads = () => asked.filter(args => args[0] === 'cat-file' && args[1] === 'blob').length
    asked.splice(0)
    await readings()
    expect(blobReads()).toBe(1)
    await readings()
    expect(blobReads()).toBe(1)
  })
})

describe('the blame parser and the digest seam', () => {
  it('maps each claim id on a blamed line to its commit, the all-zero commit to uncommitted, and an id on two lines to lost', () => {
    const sha = 'f07a6bcfcd8a7bd5c700f6e0a4b054ec696685a3'
    const zero = '0'.repeat(40)
    const porcelain = [
      `${sha} 7 1 2`, 'author t', 'summary one', 'filename a.md', '\t# src/a.ts',
      `${sha} 8 2`, '\t- first {aaaa0001 @src/a.ts}',
      `${zero} 3 3 3`, 'author Not Committed Yet', `previous ${sha} a.md`, 'filename a.md', '\t- third {aaaa0003 @src/a.ts #tag}',
      `${zero} 4 4`, '\t- twice {aaaa0004 @src/a.ts}',
      `${zero} 5 5`, '\t- twice again {aaaa0004 @src/b.ts}',
    ].join('\n')
    expect([...parseBlame(porcelain)]).toEqual([
      ['aaaa0001', { kind: BasisKind.commit, commit: sha }], ['aaaa0003', { kind: BasisKind.uncommitted }], ['aaaa0004', { kind: BasisKind.lost }],
    ])
  })

  it('anchorDigestAt reads the working tree for no revision and the committed code for a revision', async () => {
    const { checkout, put, head } = setup()
    commitAll(checkout, 'source')
    const committed = head()
    put('src/a.ts', ALPHA_EDITED)
    const { anchorDigestAt } = createDrift({ outlineOf: createOutlineCache(structure) })
    const anchor = { path: 'src/a.ts', symbol: 'alpha' }
    const [now, then, inner, innerThen] = await Promise.all([
      anchorDigestAt(checkout, null, anchor), anchorDigestAt(checkout, committed, anchor),
      anchorDigestAt(checkout, null, { path: 'src/a.ts', symbol: 'outer.inner' }), anchorDigestAt(checkout, committed, { path: 'src/a.ts', symbol: 'outer.inner' }),
    ])
    expect(now.digest).not.toBeNull()
    expect(then.digest).not.toBeNull()
    expect(now.digest).not.toBe(then.digest)
    expect(inner).toEqual(innerThen)
    expect(await anchorDigestAt(checkout, committed, { path: 'src/missing.ts', symbol: null })).toEqual({ digest: null, readable: true })
  })
})
