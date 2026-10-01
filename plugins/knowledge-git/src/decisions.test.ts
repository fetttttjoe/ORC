import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DECISION_REFUSAL, DecisionStatus, decisionSlugOf, type DecisionDraft } from '@orc/contracts'
import { createGitFilesBackend } from './backend'
import { createBucketLocks } from './bucket-lock'
import { DECISION_FORMAT_PROBLEM } from './decision-format'
import { OPTIONS_REFUSAL } from './options'
import { DECISION_PROBLEM } from './problems'
import { gitCheckout, structure } from './test-helpers'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const setup = (options: Record<string, unknown> = {}) => {
  const checkout = gitCheckout()
  const lockDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-klock-')))
  dirs.push(checkout, lockDir)
  const locks = { staleMs: 30_000, retryMs: 5, timeoutMs: 10_000, dir: lockDir }
  return { checkout, locks, backend: createGitFilesBackend(options, { locks, structure }) }
}
const draft = (title: string, over: Partial<DecisionDraft> = {}): DecisionDraft => ({
  id: decisionSlugOf(title), title, status: DecisionStatus.accepted, date: '2026-09-29', tags: [], supersedes: null,
  context: 'Why it came up.', decision: 'What we do.', consequences: 'What follows.', considered: [], ...over,
})
const read = (checkout: string, location: string): string => readFileSync(path.join(checkout, location), 'utf8')
const writeDecision = (checkout: string, location: string, text: string): void => {
  mkdirSync(path.dirname(path.join(checkout, location)), { recursive: true })
  writeFileSync(path.join(checkout, location), text)
}
const canonical = (front: string[], title: string): string =>
  ['---', ...front, '---', '', `# ${title}`, '', '## Context', '', 'c', '', '## Decision', '', 'd', '', '## Consequences', '', 'q', ''].join('\n')

describe('git-files decision files', () => {
  it('a record lands at docs/decisions/<date>-<slug>.md in canonical form', async () => {
    const { checkout, backend } = setup()
    const result = await backend.recordDecision(checkout, draft('Finish-gate checks report; they never block', {
      tags: ['checks', 'kernel'], context: 'Checks blocked merges.', decision: 'Checks report.\nThey never block.', consequences: 'A human decides.',
      considered: ['Block on failure', 'Report and\nlet the human decide'],
    }))
    const location = 'docs/decisions/2026-09-29-finish-gate-checks-report-they-never-block.md'
    expect(result.files).toEqual([location])
    expect(read(checkout, location)).toBe([
      '---', 'status: accepted', 'tags: checks, kernel', '---', '',
      '# Finish-gate checks report; they never block', '',
      '## Context', '', 'Checks blocked merges.', '',
      '## Decision', '', 'Checks report.', 'They never block.', '',
      '## Consequences', '', 'A human decides.', '',
      '## Considered', '', '- Block on failure', '- Report and', '  let the human decide', '',
    ].join('\n'))
  })

  it('honours decisionsDir, and refuses one that is absolute, climbs out, or sits inside the knowledge folder', async () => {
    const { checkout, backend } = setup({ decisionsDir: 'adr' })
    const result = await backend.recordDecision(checkout, draft('Elsewhere'))
    expect(result.recorded.location).toBe('adr/2026-09-29-elsewhere.md')
    expect(existsSync(path.join(checkout, 'adr/2026-09-29-elsewhere.md'))).toBe(true)
    expect(existsSync(path.join(checkout, 'docs/decisions'))).toBe(false)
    expect((await backend.decisions(checkout)).map(d => d.id)).toEqual(['elsewhere'])
    for (const decisionsDir of ['/abs/adr', '../adr', 'docs/../adr', 'docs/', ''])
      expect(() => createGitFilesBackend({ decisionsDir }, { structure })).toThrow(OPTIONS_REFUSAL.decisionsPath())
    expect(() => createGitFilesBackend({ decisionsDir: 'docs/knowledge/adr' }, { structure })).toThrow(OPTIONS_REFUSAL.decisionsInKnowledge('knowledge'))
    expect(() => createGitFilesBackend({ dirName: 'kb', decisionsDir: 'kb' }, { structure })).toThrow(OPTIONS_REFUSAL.decisionsInKnowledge('kb'))
  })

  it('a supersession rewrites only the old file\'s frontmatter, and reports the new file first', async () => {
    const { checkout, backend } = setup()
    const old = await backend.recordDecision(checkout, draft('The old way', { tags: ['kernel'], considered: ['Something else'] }))
    const before = read(checkout, old.recorded.location)
    const result = await backend.recordDecision(checkout, draft('The new way', { supersedes: 'the-old-way', date: '2026-10-01' }))
    expect(result.files).toEqual(['docs/decisions/2026-10-01-the-new-way.md', old.recorded.location])
    const after = read(checkout, old.recorded.location)
    const bodyOf = (text: string): string => text.slice(text.indexOf('\n---\n'))
    expect(bodyOf(after)).toBe(bodyOf(before))
    expect(after.slice(0, after.indexOf('\n---\n'))).toBe(['---', 'status: superseded', 'tags: kernel', 'supersededBy: the-new-way'].join('\n'))
    expect(read(checkout, result.recorded.location)).toStartWith(['---', 'status: accepted', 'supersedes: the-old-way', '---'].join('\n'))
    expect(await backend.check(checkout)).toEqual([])
  })

  it('a half-done supersession is never silent: the pair is reported, and both are still read', async () => {
    const { checkout, backend } = setup()
    const old = await backend.recordDecision(checkout, draft('The old way'))
    const unmarked = read(checkout, old.recorded.location)
    await backend.recordDecision(checkout, draft('The new way', { supersedes: 'the-old-way' }))
    writeFileSync(path.join(checkout, old.recorded.location), unmarked)
    expect(await backend.check(checkout)).toEqual([{ location: old.recorded.location, line: 2, message: DECISION_PROBLEM.notReciprocal('the-new-way', 'the-old-way') }])
    expect((await backend.decisions(checkout)).map(d => d.id).sort()).toEqual(['the-new-way', 'the-old-way'])
  })

  it('recording a half-done supersession again marks the old decision, reports both files, and leaves check clean', async () => {
    const { checkout, backend } = setup()
    const old = await backend.recordDecision(checkout, draft('The old way'))
    const unmarked = read(checkout, old.recorded.location)
    const newer = draft('The new way', { supersedes: 'the-old-way' })
    const first = await backend.recordDecision(checkout, newer)
    const marked = read(checkout, old.recorded.location)
    writeFileSync(path.join(checkout, old.recorded.location), unmarked)
    expect(await backend.recordDecision(checkout, newer)).toEqual(first)
    expect(read(checkout, old.recorded.location)).toBe(marked)
    expect(await backend.check(checkout)).toEqual([])
  })

  it('an old file whose status and supersededBy lines were deleted by hand is reported, and so is the dangling supersedes', async () => {
    const { checkout, backend } = setup()
    const old = await backend.recordDecision(checkout, draft('The old way'))
    const recorded = await backend.recordDecision(checkout, draft('The new way', { supersedes: 'the-old-way' }))
    const text = read(checkout, old.recorded.location).split('\n').filter(line => !line.startsWith('status:') && !line.startsWith('supersededBy:')).join('\n')
    writeFileSync(path.join(checkout, old.recorded.location), text)
    expect(await backend.check(checkout)).toEqual([
      { location: old.recorded.location, line: 2, message: DECISION_FORMAT_PROBLEM.noStatus() },
      { location: recorded.recorded.location, line: 3, message: DECISION_PROBLEM.danglingSupersedes('the-new-way', 'the-old-way') },
    ])
  })

  it('a decision file broken by hand leaves the list, is named with its line, and its slug is refused', async () => {
    const { checkout, backend } = setup()
    const { recorded } = await backend.recordDecision(checkout, draft('Hand edited'))
    writeFileSync(path.join(checkout, recorded.location), read(checkout, recorded.location).replace('status: accepted', 'status: final'))
    expect(await backend.decisions(checkout)).toEqual([])
    expect(await backend.decision(checkout, 'hand-edited')).toBeNull()
    expect(await backend.check(checkout)).toEqual([{ location: recorded.location, line: 2, message: expect.stringMatching(/^status: /) }])
    await expect(backend.recordDecision(checkout, draft('Hand edited'))).rejects.toThrow(DECISION_REFUSAL.exists('hand-edited'))
    await expect(backend.recordDecision(checkout, draft('Hand edited', { context: 'Other.' }))).rejects.toThrow(DECISION_REFUSAL.exists('hand-edited'))
  })

  it('one slug under two dates is a problem on each file, and neither is read', async () => {
    const { checkout, backend } = setup()
    writeDecision(checkout, 'docs/decisions/2026-09-01-twice.md', canonical(['status: accepted'], 'Twice'))
    writeDecision(checkout, 'docs/decisions/2026-09-02-twice.md', canonical(['status: accepted'], 'Twice'))
    expect(await backend.decisions(checkout)).toEqual([])
    expect(await backend.check(checkout)).toEqual([
      { location: 'docs/decisions/2026-09-01-twice.md', line: 0, message: DECISION_PROBLEM.duplicate('twice', ['docs/decisions/2026-09-02-twice.md']) },
      { location: 'docs/decisions/2026-09-02-twice.md', line: 0, message: DECISION_PROBLEM.duplicate('twice', ['docs/decisions/2026-09-01-twice.md']) },
    ])
    await expect(backend.recordDecision(checkout, draft('Twice'))).rejects.toThrow(DECISION_REFUSAL.exists('twice'))
  })

  it('a file that is not named <date>-<slug>.md is reported; the folder README is not', async () => {
    const { checkout, backend } = setup()
    writeDecision(checkout, 'docs/decisions/README.md', '# Decisions\n')
    writeDecision(checkout, 'docs/decisions/notes.md', canonical(['status: accepted'], 'Notes'))
    expect(await backend.check(checkout)).toEqual([{ location: 'docs/decisions/notes.md', line: 0, message: DECISION_PROBLEM.badName('notes.md') }])
  })

  it('a dangling supersededBy and a status that disagrees with supersededBy are reported, and the files are still read', async () => {
    const { checkout, backend } = setup()
    writeDecision(checkout, 'docs/decisions/2026-09-01-orphan.md', canonical(['status: superseded', 'supersededBy: ghost'], 'Orphan'))
    writeDecision(checkout, 'docs/decisions/2026-09-01-unmarked.md', canonical(['status: superseded'], 'Unmarked'))
    expect(await backend.check(checkout)).toEqual([
      { location: 'docs/decisions/2026-09-01-orphan.md', line: 3, message: DECISION_PROBLEM.danglingSupersededBy('orphan', 'ghost') },
      { location: 'docs/decisions/2026-09-01-unmarked.md', line: 2, message: DECISION_PROBLEM.statusMismatch('unmarked') },
    ])
    expect((await backend.decisions(checkout)).map(d => d.id)).toEqual(['orphan', 'unmarked'])
  })
})

describe('git-files decisions under contention', () => {
  const fileCount = (checkout: string): number => readdirSync(path.join(checkout, 'docs/decisions')).length
  const letTheRecordReachItsLock = (): Promise<void> => Bun.sleep(0)

  it('two backend instances recording one new title with different content at once write one file, and refuse the other', async () => {
    const { checkout, locks } = setup()
    const one = createGitFilesBackend({}, { locks, structure })
    const two = createGitFilesBackend({}, { locks, structure })
    const settled = await Promise.allSettled([
      one.recordDecision(checkout, draft('Raced', { context: 'One writer.' })),
      two.recordDecision(checkout, draft('Raced', { context: 'The other writer.', date: '2026-09-30' })),
    ])
    expect(settled.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(settled.flatMap(r => (r.status === 'rejected' ? [String(r.reason)] : []))).toEqual([`Error: ${DECISION_REFUSAL.exists('raced')}`])
    expect(fileCount(checkout)).toBe(1)
  })

  it('a record waits for its slug\'s lock and re-reads under it, so a file written meanwhile under another date is not doubled', async () => {
    const { checkout, locks, backend } = setup()
    const holder = Promise.withResolvers<void>()
    const held = createBucketLocks(locks).withLocks([path.join(checkout, 'docs/decisions', 'raced')], () => holder.promise)
    const recording = Promise.allSettled([backend.recordDecision(checkout, draft('Raced', { date: '2026-09-30' }))])
    await letTheRecordReachItsLock()
    writeDecision(checkout, 'docs/decisions/2026-09-29-raced.md', canonical(['status: accepted'], 'Raced'))
    holder.resolve()
    await held
    const [outcome] = await recording
    expect(outcome.status === 'rejected' ? String(outcome.reason) : outcome.status).toBe(`Error: ${DECISION_REFUSAL.exists('raced')}`)
    expect(fileCount(checkout)).toBe(1)
  })

  it('two backend instances recording the same decision at once write one file, and the other replays', async () => {
    const { checkout, locks } = setup()
    const one = createGitFilesBackend({}, { locks, structure })
    const two = createGitFilesBackend({}, { locks, structure })
    const [first, second] = await Promise.all([one.recordDecision(checkout, draft('Same')), two.recordDecision(checkout, draft('Same', { date: '2026-09-30' }))])
    expect(second).toEqual(first)
    expect(fileCount(checkout)).toBe(1)
  })
})
