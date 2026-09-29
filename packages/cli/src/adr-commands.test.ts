import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Command } from 'commander'
import { z } from 'zod'
import { AdrSection, AUTHOR_SOURCE, DecisionStatus, Door, EVENT_KIND, KNOWLEDGE_REFUSAL, KnowledgeWrittenPayload, NO_CHAT } from '@orc/contracts'
import { createMemoryBackend } from '@orc/knowledge-core'
import { loadConfig, requireProject } from '@orc/kernel'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { adrCommand, renderDecisionList } from './adr-commands'
import type { KnowledgeOpening } from './knowledge-open'
import { openKernel } from './main'

const cleanup: Array<() => Promise<void> | void> = []
afterAll(async () => { for (const c of cleanup.reverse()) await c() }, 30_000)
afterEach(() => mock.restore())

const memoryOpening = (): KnowledgeOpening => ({ backend: createMemoryBackend({ exists: () => true }) })

async function makeAdr(opening: KnowledgeOpening = memoryOpening()) {
  const db = await createTestDb()
  cleanup.push(() => db.drop())
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-adr-cli-'))
  const config = requireProject({ ...loadConfig(dir), projectId: TEST_PROJECT_ID, projectName: 'test' })
  const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config })
  cleanup.push(() => log.close())
  await seedTestWorkspace(log, NO_CHAT(Door.cli), realpathSync(config.dir))
  const lines: string[] = []
  spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
  const run = async (...args: string[]): Promise<string[]> => {
    const from = lines.length
    await new Command().addCommand(adrCommand({ requireKernel: () => kernel, project: { config, log }, opening })).parseAsync(['adr', ...args], { from: 'user' })
    return lines.slice(from)
  }
  return { run, log }
}

const NEW = ['--context', 'two stores drifted', '--decision', 'the log is the only writer of facts', '--consequences', 'projections are disposable']

describe('orc adr', () => {
  it('new records a human-authored decision, ls lists it, show prints its sections', async () => {
    const { run, log } = await makeAdr()
    const out = await run('new', 'Event log is truth', ...NEW, '--considered', 'path-level drift', 'restamp to HEAD', '--tags', 'architecture')
    expect(out[0]).toMatch(/^recorded decision 'event-log-is-truth' \(accepted\) — \S+/)

    const written = (await log.all()).filter(e => e.kind === EVENT_KIND.knowledge_written).map(e => KnowledgeWrittenPayload.parse(e.payload))
    expect(written.at(-1)?.author).toMatchObject({ source: AUTHOR_SOURCE.human, workspaceId: TEST_WORKSPACE_ID })

    const ls = await run('ls')
    expect(ls).toHaveLength(1)
    expect(ls[0]).toMatch(/^event-log-is-truth\s+accepted\s+\d{4}-\d{2}-\d{2}  Event log is truth$/)

    const shown = (await run('show', 'event-log-is-truth')).join('\n')
    expect(shown).toStartWith('# Event log is truth\nid: event-log-is-truth\nstatus: accepted\ndate: ')
    expect(shown).toContain('tags: architecture')
    expect(shown).toContain(`file: ${out[0]?.split(' — ')[1]}`)
    expect(shown).toContain(`## ${AdrSection.context}\n\ntwo stores drifted`)
    expect(shown).toContain(`## ${AdrSection.decision}\n\nthe log is the only writer of facts`)
    expect(shown).toContain(`## ${AdrSection.consequences}\n\nprojections are disposable`)
    expect(shown).toContain(`## ${AdrSection.considered}\n\n- path-level drift\n- restamp to HEAD`)
    expect(shown).not.toContain('supersedes:')
    expect((await run('new', 'Bare', ...NEW).then(() => run('show', 'bare'))).join('\n')).not.toContain('tags:')
  }, 30_000)

  it('supersede marks the old decision and ls points at its replacement', async () => {
    const { run } = await makeAdr()
    await run('new', 'Identity per checkout', ...NEW)
    const out = await run('supersede', 'identity-per-checkout', 'Identity per repository', ...NEW)
    expect(out[1]).toBe("superseded 'identity-per-checkout'")
    const ls = await run('ls')
    expect(ls.find(l => l.startsWith('identity-per-repository'))).toContain('accepted')
    expect(ls.find(l => l.startsWith('identity-per-checkout'))).toMatch(/superseded\s+\d{4}-\d{2}-\d{2}  Identity per checkout {2}→ identity-per-repository$/)
    const old = (await run('show', 'identity-per-checkout')).join('\n')
    expect(old).toContain('superseded by: identity-per-repository')
    expect((await run('show', 'identity-per-repository')).join('\n')).toContain('supersedes: identity-per-checkout')
  }, 30_000)

  it('ls --status keeps only that status', async () => {
    const { run } = await makeAdr()
    await run('new', 'Settled', ...NEW)
    await run('new', 'Open question', ...NEW, '--status', DecisionStatus.proposed)
    const proposed = await run('ls', '--status', DecisionStatus.proposed)
    expect(proposed).toHaveLength(1)
    expect(proposed[0]).toStartWith('open-question')
  }, 30_000)

  it('new refuses --status superseded at the option parser, naming the allowed values', async () => {
    const { run } = await makeAdr()
    const stderr: string[] = []
    spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true })
    spyOn(process, 'exit').mockImplementation((code?: number | string | null) => { throw new Error(`exit ${code}`) })
    await expect(run('new', 'Nope', ...NEW, '--status', DecisionStatus.superseded)).rejects.toThrow('exit 1')
    expect(stderr.join('')).toContain(`valid: ${DecisionStatus.proposed}, ${DecisionStatus.accepted}, ${DecisionStatus.deprecated}`)
  }, 30_000)

  it('ls --json prints decision summaries, not whole decisions', async () => {
    const { run } = await makeAdr()
    await run('new', 'Summarised', ...NEW)
    const rows = z.array(z.record(z.string(), z.unknown())).parse(JSON.parse((await run('ls', '--json')).join('\n')))
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0] ?? {}).toSorted()).toEqual(['date', 'id', 'status', 'summary', 'supersededBy', 'supersedes', 'title'])
    expect(rows[0]?.summary).toBe('the log is the only writer of facts')
  }, 30_000)

  it('fails with the off refusal when knowledge is off for the project', async () => {
    const { run } = await makeAdr({ unavailable: KNOWLEDGE_REFUSAL.off() })
    await expect(run('ls')).rejects.toThrow(KNOWLEDGE_REFUSAL.off())
    await expect(run('new', 'Nothing', ...NEW)).rejects.toThrow(KNOWLEDGE_REFUSAL.off())
  }, 30_000)
})

describe('renderDecisionList', () => {
  it('renders one row per decision with status, date and the superseding id', () => {
    const rows = renderDecisionList([{ id: 'a', title: 'A', status: DecisionStatus.superseded, date: '2026-01-01', tags: [], supersedes: null, context: 'c', decision: 'd', consequences: 'q', considered: [], supersededBy: 'b', location: 'docs/decisions/a.md' }])
    expect(rows).toEqual([`${'a'.padEnd(1)} ${'superseded'.padEnd(10)} 2026-01-01  A  → b`])
    expect(renderDecisionList([])).toEqual(['_no decisions_'])
  })
})
