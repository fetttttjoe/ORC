import { afterEach, describe, expect, it } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ClaimClass, DecisionStatus, decisionSlugOf, KNOWLEDGE_LIMITS, KNOWLEDGE_REFUSAL, KnowledgePatch, newKnowledgeId, type KnowledgePatchInput,
} from '@orc/contracts'
import { createGitFilesBackend } from './backend'
import { createBucketLocks } from './bucket-lock'
import { KNOWLEDGE_PROBLEM } from './problems'
import { gitCheckout } from './test-helpers'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const setup = () => {
  const checkout = gitCheckout()
  const lockDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-klock-')))
  dirs.push(checkout, lockDir)
  const locks = { staleMs: 30_000, retryMs: 5, timeoutMs: 10_000, dir: lockDir }
  return { checkout, locks, backend: createGitFilesBackend({}, { locks }) }
}
const patch = (input: KnowledgePatchInput) => KnowledgePatch.parse(input)
const fact = (text: string, ...paths: string[]) => ({ text, class: ClaimClass.fact, anchors: paths.map(p => ({ path: p })) })
const read = (checkout: string, location: string) => readFileSync(path.join(checkout, location), 'utf8')

describe('git-files placement and format', () => {
  it('writes each claim into the bucket of its first anchor, in canonical form', async () => {
    const { checkout, backend } = setup()
    const { added } = await backend.write(checkout, patch({ add: [
      { ...fact('A fact about a.', 'src/a.ts'), tags: ['x'] },
      fact('A fact about c.', 'pkg/src/c.ts'),
      fact('About the package.', 'pkg'),
      fact('About everything.'),
    ] }))
    expect(added.map(r => r.location)).toEqual([
      'knowledge/src/a.ts.md', 'pkg/knowledge/src/c.ts.md', 'pkg/knowledge/README.md', 'knowledge/README.md',
    ])
    expect(read(checkout, 'knowledge/src/a.ts.md')).toBe(`# src/a.ts\n\n## Facts\n- A fact about a. {${added[0]?.id} @src/a.ts #x}\n`)
    expect(read(checkout, 'pkg/knowledge/README.md')).toStartWith('# pkg\n')
    expect(read(checkout, 'knowledge/README.md')).toStartWith('# project\n')
  })

  it('moves a claim whose first anchor changes, and removes the emptied bucket and folders', async () => {
    const { checkout, backend } = setup()
    const [ref] = (await backend.write(checkout, patch({ add: [fact('moves', 'src/a.ts')] }))).added
    await backend.write(checkout, patch({ change: [{ id: ref?.id ?? '', anchors: [{ path: 'pkg/src/c.ts' }] }] }))
    expect(existsSync(path.join(checkout, 'knowledge'))).toBe(false)
    expect(read(checkout, 'pkg/knowledge/src/c.ts.md')).toContain(`{${ref?.id} @pkg/src/c.ts}`)
  })

  it('a write that leaves a bucket over the claim limit warns, and one at the limit does not', async () => {
    const { checkout, backend } = setup()
    const limit = KNOWLEDGE_LIMITS.bucketWarnClaims
    const atLimit = await backend.write(checkout, patch({ add: Array.from({ length: limit }, (_, i) => fact(`claim ${i}`, 'src/a.ts')) }))
    expect(atLimit.warnings).toEqual([])
    const over = await backend.write(checkout, patch({ add: [fact('one more', 'src/a.ts')] }))
    expect(over.warnings).toEqual([KNOWLEDGE_PROBLEM.crowded('knowledge/src/a.ts.md', limit + 1)])
  })

  it('refuses an anchor that resolves outside the checkout through a symlink', async () => {
    const { checkout, backend } = setup()
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-outside-')))
    dirs.push(outside)
    writeFileSync(path.join(outside, 'secret.ts'), '')
    symlinkSync(path.join(outside, 'secret.ts'), path.join(checkout, 'src/link.ts'))
    await expect(backend.write(checkout, patch({ add: [fact('x', 'src/link.ts')] })))
      .rejects.toThrow(KNOWLEDGE_REFUSAL.outsideCheckout('src/link.ts'))
  })

  it('refuses a checkout that does not exist by name, on every call', async () => {
    const { checkout, backend } = setup()
    const gone = path.join(checkout, 'missing')
    const refusal = KNOWLEDGE_REFUSAL.missingCheckout(gone)
    await expect(backend.card(gone, '.', { cursor: null, limit: 10 })).rejects.toThrow(refusal)
    await expect(backend.search(gone, 'x', 10)).rejects.toThrow(refusal)
    await expect(backend.get(gone, ['aaaaaaaa'])).rejects.toThrow(refusal)
    await expect(backend.write(gone, patch({ add: [fact('x', 'src/a.ts')] }))).rejects.toThrow(refusal)
    await expect(backend.check(gone)).rejects.toThrow(refusal)
    await expect(backend.format(gone)).rejects.toThrow(refusal)
  })

  it('a markdown file in a knowledge folder that is not its package root folder is not a bucket', async () => {
    const { checkout, backend } = setup()
    mkdirSync(path.join(checkout, 'docs/knowledge'), { recursive: true })
    writeFileSync(path.join(checkout, 'docs/knowledge/notes.md'), '# notes\n\n## Facts\n- stray {zzzzzzzz}\n')
    expect((await backend.card(checkout, '.', { cursor: null, limit: 10 })).claims).toEqual([])
    expect(await backend.check(checkout)).toEqual([])
  })

  it('does not read buckets that .gitignore excludes', async () => {
    const { checkout, backend } = setup()
    await backend.write(checkout, patch({ add: [fact('visible', 'src/a.ts')] }))
    writeFileSync(path.join(checkout, '.gitignore'), 'knowledge/\n')
    expect((await backend.card(checkout, '.', { cursor: null, limit: 10 })).claims).toEqual([])
  })
})

describe('git-files and human edits', () => {
  const outOfOrder = '# src/a.ts\n\n## Facts\n- second {bbbbbbbb @src/a.ts}\n- first {aaaaaaaa @src/a.ts}\n'
  const writeBucket = (checkout: string, location: string, text: string) => {
    mkdirSync(path.dirname(path.join(checkout, location)), { recursive: true })
    writeFileSync(path.join(checkout, location), text)
  }

  it('check reports a bucket that is not in canonical form', async () => {
    const { checkout, backend } = setup()
    writeBucket(checkout, 'knowledge/src/a.ts.md', outOfOrder)
    expect(await backend.check(checkout)).toEqual([{ location: 'knowledge/src/a.ts.md', line: 0, message: KNOWLEDGE_PROBLEM.notCanonical() }])
  })

  it('fmt restores canonical form in a bucket that has no missing ids', async () => {
    const { checkout, backend } = setup()
    writeBucket(checkout, 'knowledge/src/a.ts.md', outOfOrder)
    expect(await backend.format(checkout)).toEqual({ formatted: ['knowledge/src/a.ts.md'], problems: [] })
    expect(read(checkout, 'knowledge/src/a.ts.md')).toBe('# src/a.ts\n\n## Facts\n- first {aaaaaaaa @src/a.ts}\n- second {bbbbbbbb @src/a.ts}\n')
  })

  it('check names an id that sits in two buckets', async () => {
    const { checkout, backend } = setup()
    writeBucket(checkout, 'knowledge/src/a.ts.md', '# src/a.ts\n\n## Facts\n- one {aaaaaaaa @src/a.ts}\n')
    writeBucket(checkout, 'knowledge/src/b.ts.md', '# src/b.ts\n\n## Facts\n- one {aaaaaaaa @src/b.ts}\n')
    expect(await backend.check(checkout))
      .toEqual([{ location: 'knowledge/src/b.ts.md', line: 4, message: KNOWLEDGE_PROBLEM.alsoIn('aaaaaaaa', 'knowledge/src/a.ts.md') }])
  })

  it('a hand-written line without an id is reported, blocks writes to its bucket, and fmt gives it an id', async () => {
    const { checkout, backend } = setup()
    await backend.write(checkout, patch({ add: [fact('by the tool', 'src/a.ts')] }))
    appendFileSync(path.join(checkout, 'knowledge/src/a.ts.md'), '- By hand. {@src/a.ts}\n')
    const problems = await backend.check(checkout)
    expect(problems).toEqual([expect.objectContaining({ location: 'knowledge/src/a.ts.md', line: 5, message: expect.stringContaining('missing id') })])
    await expect(backend.write(checkout, patch({ add: [fact('another', 'src/a.ts')] })))
      .rejects.toThrow(KNOWLEDGE_REFUSAL.bucketProblems('knowledge/src/a.ts.md', 1))
    const formatted = await backend.format(checkout)
    expect(formatted).toEqual({ formatted: ['knowledge/src/a.ts.md'], problems: [] })
    expect((await backend.card(checkout, 'src/a.ts', { cursor: null, limit: 10 })).claims.map(c => c.text).sort()).toEqual(['By hand.', 'by the tool'])
  })

  it('a malformed line is reported with its line and skipped on read', async () => {
    const { checkout, backend } = setup()
    await backend.write(checkout, patch({ add: [fact('good', 'src/a.ts')] }))
    appendFileSync(path.join(checkout, 'knowledge/src/a.ts.md'), '- broken {aaaaaaaa @}\n')
    expect((await backend.check(checkout)).map(p => p.line)).toEqual([5])
    expect((await backend.card(checkout, 'src/a.ts', { cursor: null, limit: 10 })).claims.map(c => c.text)).toEqual(['good'])
  })

  it('check names a claim filed in the wrong bucket and fmt moves it', async () => {
    const { checkout, backend } = setup()
    const [ref] = (await backend.write(checkout, patch({ add: [fact('misfiled', 'src/b.ts')] }))).added
    const text = read(checkout, 'knowledge/src/b.ts.md')
    rmSync(path.join(checkout, 'knowledge/src/b.ts.md'))
    writeFileSync(path.join(checkout, 'knowledge/src/a.ts.md'), text.replace('# src/b.ts', '# src/a.ts'))
    expect(await backend.check(checkout)).toEqual([expect.objectContaining({ location: 'knowledge/src/a.ts.md', message: expect.stringContaining('knowledge/src/b.ts.md') })])
    await backend.format(checkout)
    expect(await backend.check(checkout)).toEqual([])
    expect(read(checkout, 'knowledge/src/b.ts.md')).toContain(ref?.id ?? 'missing')
  })

  it('fmt moves more misfiled claims than one patch may carry', async () => {
    const { checkout, backend } = setup()
    const count = KNOWLEDGE_LIMITS.patchItems + 1
    const lines = Array.from({ length: count }, (_, i) => `- misfiled ${i} {m${String(i).padStart(7, '0')} @src/b.ts}`)
    mkdirSync(path.join(checkout, 'knowledge/src'), { recursive: true })
    writeFileSync(path.join(checkout, 'knowledge/src/a.ts.md'), `# src/a.ts\n\n## Facts\n${lines.join('\n')}\n`)
    await backend.format(checkout)
    expect(existsSync(path.join(checkout, 'knowledge/src/a.ts.md'))).toBe(false)
    expect((await backend.card(checkout, 'src/b.ts', { cursor: null, limit: count + 1 })).claims.length).toBe(count)
    expect(await backend.check(checkout)).toEqual([])
  })

  it('fmt leaves a misfiled claim in place when its bucket or its target has a malformed line, and reports it', async () => {
    const { checkout, backend } = setup()
    const a = '# src/a.ts\n\n## Facts\n- misfiled x {xxxxxxxx @src/b.ts}\n- broken {aaaaaaaa @}\n'
    const b = '# src/b.ts\n\n## Facts\n- misfiled y {yyyyyyyy @src/a.ts}\n'
    mkdirSync(path.join(checkout, 'knowledge/src'), { recursive: true })
    writeFileSync(path.join(checkout, 'knowledge/src/a.ts.md'), a)
    writeFileSync(path.join(checkout, 'knowledge/src/b.ts.md'), b)
    const result = await backend.format(checkout)
    expect(result.formatted).toEqual([])
    expect(result.problems.map(p => `${p.location}:${p.line}`)).toEqual(['knowledge/src/a.ts.md:5', 'knowledge/src/a.ts.md:4', 'knowledge/src/b.ts.md:4'])
    expect([read(checkout, 'knowledge/src/a.ts.md'), read(checkout, 'knowledge/src/b.ts.md')]).toEqual([a, b])
  })
})

describe('git-files ids', () => {
  it('ids it generates skip ids already in the checkout and ids chosen earlier in the same call, in write and fmt', async () => {
    const { checkout, locks } = setup()
    const script = ['abcd1234', 'bbbbbbbb', 'bbbbbbbb', 'cccccccc', 'abcd1234', 'bbbbbbbb', 'cccccccc', 'dddddddd', 'dddddddd', 'eeeeeeee']
    const backend = createGitFilesBackend({}, { locks, newId: () => script.shift() ?? newKnowledgeId() })
    await backend.write(checkout, patch({ add: [{ ...fact('held', 'src/a.ts'), id: 'abcd1234' }] }))
    const { added } = await backend.write(checkout, patch({ add: [fact('one', 'src/a.ts'), fact('two', 'src/a.ts')] }))
    expect(added.map(r => r.id)).toEqual(['bbbbbbbb', 'cccccccc'])
    appendFileSync(path.join(checkout, 'knowledge/src/a.ts.md'), '- three {@src/a.ts}\n- four {@src/a.ts}\n')
    await backend.format(checkout)
    expect((await backend.card(checkout, 'src/a.ts', { cursor: null, limit: 10 })).claims.map(c => c.id).sort())
      .toEqual(['abcd1234', 'bbbbbbbb', 'cccccccc', 'dddddddd', 'eeeeeeee'])
  })

  it('a generated id taken by another writer while the write waited for its lock is replaced, not refused', async () => {
    const { checkout, locks } = setup()
    const script = ['eeeeeeee']
    const backend = createGitFilesBackend({}, { locks, newId: () => script.shift() ?? newKnowledgeId() })
    const bucket = path.join(checkout, 'knowledge/src/a.ts.md')
    const writer = Promise.withResolvers<void>()
    const held = createBucketLocks(locks).withLocks([bucket], () => writer.promise)
    const writing = backend.write(checkout, patch({ add: [fact('mine', 'src/a.ts')] }))
    await Bun.sleep(300)
    mkdirSync(path.dirname(bucket), { recursive: true })
    writeFileSync(bucket, '# src/a.ts\n\n## Facts\n- theirs {eeeeeeee @src/a.ts}\n')
    writer.resolve()
    const [, result] = await Promise.all([held, writing])
    expect(result.added.map(r => r.id)).not.toContain('eeeeeeee')
    expect((await backend.card(checkout, 'src/a.ts', { cursor: null, limit: 10 })).claims.map(c => c.text).sort()).toEqual(['mine', 'theirs'])
  })
})

describe('git-files write reports the files it changed', () => {
  it('an add names its bucket; a move names both buckets; a retire that empties a bucket names the deleted file', async () => {
    const { checkout, backend } = setup()
    const added = await backend.write(checkout, patch({ add: [fact('about a', 'src/a.ts')] }))
    expect(added.files).toEqual(['knowledge/src/a.ts.md'])
    const id = added.added[0]?.id ?? ''
    const moved = await backend.write(checkout, patch({ change: [{ id, anchors: [{ path: 'src/b.ts' }] }] }))
    expect([...moved.files].sort()).toEqual(['knowledge/src/a.ts.md', 'knowledge/src/b.ts.md'])
    expect(existsSync(path.join(checkout, 'knowledge/src/a.ts.md'))).toBe(false)
    const retired = await backend.write(checkout, patch({ retire: [id] }))
    expect(retired.files).toEqual(['knowledge/src/b.ts.md'])
  })
})

describe('git-files and duplicated ids', () => {
  it('a change or retire of an id that sits in two buckets is refused, and fmt leaves both copies', async () => {
    const { checkout, backend } = setup()
    const [ref] = (await backend.write(checkout, patch({ add: [fact('twice', 'src/a.ts')] }))).added
    const id = ref?.id ?? ''
    const copy = `# project\n\n## Facts\n- twice {${id} @src/a.ts}\n`
    writeFileSync(path.join(checkout, 'knowledge/README.md'), copy)
    const own = read(checkout, 'knowledge/src/a.ts.md')
    await expect(backend.write(checkout, patch({ retire: [id] }))).rejects.toThrow(KNOWLEDGE_REFUSAL.duplicateId(id))
    await expect(backend.write(checkout, patch({ change: [{ id, text: 'changed' }] }))).rejects.toThrow(KNOWLEDGE_REFUSAL.duplicateId(id))
    const result = await backend.format(checkout)
    expect(result.problems.map(p => `${p.location}:${p.line}`)).toEqual(['knowledge/src/a.ts.md:4', 'knowledge/README.md:4'])
    expect([read(checkout, 'knowledge/README.md'), read(checkout, 'knowledge/src/a.ts.md')]).toEqual([copy, own])
  })
})

describe('git-files claims that name a decision', () => {
  it('a claim naming a recorded decision is kept; once the decision file is gone, check names the claim\'s bucket and line', async () => {
    const { checkout, backend } = setup()
    const title = 'Checks report'
    const { recorded } = await backend.recordDecision(checkout, {
      id: decisionSlugOf(title), title, status: DecisionStatus.accepted, date: '2026-09-29', tags: [], supersedes: null,
      context: 'c', decision: 'd', consequences: 'q', considered: [],
    })
    const [ref] = (await backend.write(checkout, patch({ add: [{ ...fact('cites it', 'src/a.ts'), decision: recorded.id }] }))).added
    expect(read(checkout, 'knowledge/src/a.ts.md')).toBe(`# src/a.ts\n\n## Facts\n- cites it {${ref?.id} @src/a.ts adr:${recorded.id}}\n`)
    expect(await backend.check(checkout)).toEqual([])
    rmSync(path.join(checkout, recorded.location))
    expect(await backend.check(checkout)).toEqual([
      { location: 'knowledge/src/a.ts.md', line: 4, message: KNOWLEDGE_PROBLEM.unknownDecision(ref?.id ?? '', recorded.id) },
    ])
  })
})

describe('git-files claim writes and the decisions folder', () => {
  it('a write that names no decision never reads the decisions folder; one that names a decision does', async () => {
    const { checkout, backend } = setup()
    writeFileSync(path.join(checkout, 'docs/decisions'), 'a file where the folder belongs\n')
    expect((await backend.write(checkout, patch({ add: [fact('no decision named', 'src/a.ts')] }))).added.length).toBe(1)
    await expect(backend.write(checkout, patch({ add: [{ ...fact('names one', 'src/a.ts'), decision: 'some-decision' }] }))).rejects.toThrow(/ENOTDIR/)
  })
})

describe('git-files under contention', () => {
  it('two backend instances writing one bucket lose nothing', async () => {
    const { checkout, locks } = setup()
    const one = createGitFilesBackend({}, { locks })
    const two = createGitFilesBackend({}, { locks })
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      (i % 2 === 0 ? one : two).write(checkout, patch({ add: [fact(`claim ${i}`, 'src/a.ts')] }))))
    expect((await one.card(checkout, 'src/a.ts', { cursor: null, limit: 100 })).claims.length).toBe(20)
  })

  it('a bucket git still lists but that is gone when read is absent to card, search, get and check', async () => {
    const { checkout, backend } = setup()
    const [ref] = (await backend.write(checkout, patch({ add: [fact('staged then deleted', 'src/a.ts')] }))).added
    Bun.spawnSync(['git', '-C', checkout, 'add', 'knowledge'])
    rmSync(path.join(checkout, 'knowledge'), { recursive: true })
    expect(Bun.spawnSync(['git', '-C', checkout, 'ls-files', '-z', '--cached']).stdout.toString().split('\0')).toContain('knowledge/src/a.ts.md')
    expect((await backend.card(checkout, '.', { cursor: null, limit: 10 })).claims).toEqual([])
    expect(await backend.search(checkout, 'staged', 10)).toEqual([])
    expect(await backend.get(checkout, [ref?.id ?? ''])).toEqual([])
    expect(await backend.check(checkout)).toEqual([])
  })

  it('fmt moves a claim by its anchors as they are under the lock, so an anchor change made while it waited is kept', async () => {
    const { checkout, locks, backend } = setup()
    const bucket = path.join(checkout, 'knowledge/src/a.ts.md')
    mkdirSync(path.dirname(bucket), { recursive: true })
    writeFileSync(bucket, '# src/a.ts\n\n## Facts\n- moving {xxxxxxxx @src/b.ts}\n')
    const writer = Promise.withResolvers<void>()
    const held = createBucketLocks(locks).withLocks([bucket], () => writer.promise)
    const formatting = backend.format(checkout)
    await Bun.sleep(300)
    writeFileSync(bucket, '# src/a.ts\n\n## Facts\n- moving {xxxxxxxx @src/a.ts}\n')
    writer.resolve()
    await Promise.all([held, formatting])
    expect(await backend.get(checkout, ['xxxxxxxx']))
      .toEqual([expect.objectContaining({ location: 'knowledge/src/a.ts.md', anchors: [{ path: 'src/a.ts', symbol: null }] })])
  })

  it('fmt re-reads a bucket under its lock, so a claim written while it waited survives', async () => {
    const { checkout, locks, backend } = setup()
    await backend.write(checkout, patch({ add: [fact('by the tool', 'src/a.ts')] }))
    const bucket = path.join(checkout, 'knowledge/src/a.ts.md')
    appendFileSync(bucket, '- By hand. {@src/a.ts}\n')
    const writer = Promise.withResolvers<void>()
    const held = createBucketLocks(locks).withLocks([bucket], () => writer.promise)
    const formatting = backend.format(checkout)
    await Bun.sleep(300)
    appendFileSync(bucket, '- Written meanwhile. {abcd1234 @src/a.ts}\n')
    writer.resolve()
    await Promise.all([held, formatting])
    expect((await backend.card(checkout, 'src/a.ts', { cursor: null, limit: 10 })).claims.map(c => c.text).sort())
      .toEqual(['By hand.', 'Written meanwhile.', 'by the tool'])
  })
})
