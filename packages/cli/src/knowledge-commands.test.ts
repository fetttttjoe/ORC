import { afterEach, describe, expect, it } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AUTHOR_SOURCE, ClaimClass, Door, EVENT_KIND, KNOWLEDGE_REFUSAL, KnowledgePatch, NO_CHAT, WORKSPACE_KIND,
  type EventInput, type EventRecord, type MemoryAuthor, type Workspace,
} from '@orc/contracts'
import { authorFixture, TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'
import { gitFilesPlugin } from '@orc/knowledge-git'
import type { WorkspaceFold } from './cwd-workspace'
import { knowledgeAccess, openKnowledge } from './knowledge-open'
import {
  addPatch, NO_PROJECT_CONTEXT, KNOWLEDGE_SUBCOMMAND, knowledgeAuthor, knowledgeCommand, parseAnchorArg, renderClaims, renderProblems,
  runAdd, runCard, runCheck, runFormat, runRetire, runSearch,
} from './knowledge-commands'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const checkout = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-kcli-')))
  dirs.push(dir)
  Bun.spawnSync(['git', 'init', '-q', dir])
  mkdirSync(path.join(dir, 'src'))
  writeFileSync(path.join(dir, 'src/a.ts'), '')
  return dir
}
const testAuthor: MemoryAuthor = { source: AUTHOR_SOURCE.cli, workspaceId: 'ws-1', origin: NO_CHAT(Door.cli) }
const portOn = (dir: string) => {
  const events: EventInput[] = []
  let seq = 0
  const append = async (input: EventInput): Promise<EventRecord> => {
    events.push(input)
    return {
      seq: ++seq, projectId: 'test-project', idempotencyKey: input.idempotencyKey ?? null,
      chatId: input.chatId, door: input.door, taskId: input.taskId, stepId: input.stepId, runToken: input.runToken,
      kind: input.kind, payload: input.payload, usage: input.usage ?? null, ts: new Date().toISOString(),
    }
  }
  const access = knowledgeAccess(openKnowledge({ knowledge: { plugin: 'git-files', options: {} } }), { append }, dir)
  return { port: access, events }
}

describe('knowledge command helpers', () => {
  it('parses an anchor argument with and without a symbol', () => {
    expect(parseAnchorArg('src/a.ts#createStore.write')).toEqual({ path: 'src/a.ts', symbol: 'createStore.write' })
    expect(parseAnchorArg('src/a.ts')).toEqual({ path: 'src/a.ts', symbol: null })
  })
  it('renders claims one per line and says so when there are none', () => {
    expect(renderClaims([])).toEqual(['_no claims_'])
    expect(renderClaims([{ id: 'aaaaaaaa', text: 'T.', class: ClaimClass.why, anchors: [{ path: 'src/a.ts', symbol: 'f' }], tags: ['x'], sources: ['https://e.com/x'], decision: 'd', location: 'knowledge/src/a.ts.md' }]))
      .toEqual(['[aaaaaaaa] why: T.  ← src/a.ts f  tags: x  sources: https://e.com/x  decision: d  (knowledge/src/a.ts.md)'])
  })
  it('renders problems as location:line message', () => {
    expect(renderProblems([{ location: 'k/a.md', line: 3, message: 'bad' }])).toEqual(['k/a.md:3  bad'])
  })
})

describe('knowledge check and fmt', () => {
  it('check passes on a clean checkout and fails with the problems listed', async () => {
    const dir = checkout()
    const backend = { backend: gitFilesPlugin.create({}) }
    await backend.backend.write(dir, KnowledgePatch.parse({ add: [{ text: 'ok', class: ClaimClass.fact, anchors: [{ path: 'src/a.ts' }] }] }))
    expect(await runCheck(backend, dir)).toEqual({ lines: ['knowledge: 0 problems'], failed: false })
    appendFileSync(path.join(dir, 'knowledge/src/a.ts.md'), '- by hand\n')
    expect(await runCheck(backend, dir)).toEqual({
      lines: [expect.stringContaining('knowledge/src/a.ts.md:5  missing id'), 'knowledge: 1 problems'], failed: true,
    })
  })
  it('fmt fixes a missing id and reports what it rewrote', async () => {
    const dir = checkout()
    const backend = { backend: gitFilesPlugin.create({}) }
    await backend.backend.write(dir, KnowledgePatch.parse({ add: [{ text: 'ok', class: ClaimClass.fact, anchors: [{ path: 'src/a.ts' }] }] }))
    appendFileSync(path.join(dir, 'knowledge/src/a.ts.md'), '- by hand {@src/a.ts}\n')
    expect(await runFormat(backend, dir)).toEqual(['formatted knowledge/src/a.ts.md', 'knowledge: 0 problems'])
  })
  it('both say knowledge is off when the config turns it off', async () => {
    await expect(runCheck({ unavailable: KNOWLEDGE_REFUSAL.off() }, '/nowhere')).rejects.toThrow(KNOWLEDGE_REFUSAL.off())
    await expect(runFormat({ unavailable: KNOWLEDGE_REFUSAL.off() }, '/nowhere')).rejects.toThrow(KNOWLEDGE_REFUSAL.off())
  })
})

describe('addPatch', () => {
  it('maps every add option into a claim addition', () => {
    const patch = addPatch({
      class: ClaimClass.fact, text: 'ok', anchor: ['src/a.ts#Foo.bar', 'src/b.ts'],
      tag: ['x', 'y'], source: ['https://e.com/x'], decision: 'some-decision', why: 'why text',
    })
    expect(patch).toEqual({
      add: [{
        text: 'ok', class: ClaimClass.fact,
        anchors: [{ path: 'src/a.ts', symbol: 'Foo.bar' }, { path: 'src/b.ts', symbol: null }],
        tags: ['x', 'y'], sources: ['https://e.com/x'], decision: 'some-decision',
      }],
      change: [], retire: [], why: 'why text', decision: null,
    })
  })
})

describe('knowledge card and search', () => {
  it('runCard lists claims anchored under a path and pages with a cursor', async () => {
    const dir = checkout()
    writeFileSync(path.join(dir, 'src/b.ts'), '')
    const backend = { backend: gitFilesPlugin.create({}) }
    await backend.backend.write(dir, KnowledgePatch.parse({
      add: [
        { text: 'first', class: ClaimClass.fact, anchors: [{ path: 'src/a.ts' }] },
        { text: 'second', class: ClaimClass.fact, anchors: [{ path: 'src/b.ts' }] },
      ],
    }))
    const page1 = await runCard(backend, dir, 'src', { cursor: null, limit: 1 })
    expect(page1).toEqual([expect.stringContaining('first'), 'more: --cursor 1'])
    const page2 = await runCard(backend, dir, 'src', { cursor: '1', limit: 1 })
    expect(page2).toEqual([expect.stringContaining('second')])
  })
  it('runSearch finds a written claim', async () => {
    const dir = checkout()
    const backend = { backend: gitFilesPlugin.create({}) }
    await backend.backend.write(dir, KnowledgePatch.parse({ add: [{ text: 'findme', class: ClaimClass.fact, anchors: [{ path: 'src/a.ts' }] }] }))
    expect(await runSearch(backend, dir, 'findme', 20)).toEqual([expect.stringContaining('findme')])
  })
})

describe('knowledge add and retire through a real port', () => {
  it('runAdd writes through the port, reports the location, and records a knowledge_written event', async () => {
    const dir = checkout()
    const { port, events } = portOn(dir)
    const lines = await runAdd(port, testAuthor, { class: ClaimClass.fact, text: 'ok', anchor: ['src/a.ts'] })
    expect(lines).toEqual([expect.stringMatching(/^added [a-z0-9]{8} → knowledge\/src\/a\.ts\.md$/)])
    expect(events.map(e => e.kind)).toEqual([EVENT_KIND.knowledge_written])
  })
  it('runRetire retires a written claim and records a knowledge_written event', async () => {
    const dir = checkout()
    const backend = gitFilesPlugin.create({})
    const [ref] = (await backend.write(dir, KnowledgePatch.parse({ add: [{ text: 'ok', class: ClaimClass.fact, anchors: [{ path: 'src/a.ts' }] }] }))).added
    const { port, events } = portOn(dir)
    const lines = await runRetire(port, testAuthor, [ref.id], 'no longer true')
    expect(lines).toEqual([`retired ${ref.id} from ${ref.location}`])
    expect(events.map(e => e.kind)).toEqual([EVENT_KIND.knowledge_written])
  })
})

describe('every handler is off when the door is off', () => {
  it('rejects naming the reason knowledge is off', async () => {
    const off = { unavailable: KNOWLEDGE_REFUSAL.off() }
    await expect(runCard(off, '/nowhere', '.', { cursor: null, limit: 10 })).rejects.toThrow(KNOWLEDGE_REFUSAL.off())
    await expect(runSearch(off, '/nowhere', 'x', 10)).rejects.toThrow(KNOWLEDGE_REFUSAL.off())
    await expect(runAdd(off, testAuthor, { class: ClaimClass.fact, text: 'x' })).rejects.toThrow(KNOWLEDGE_REFUSAL.off())
    await expect(runRetire(off, testAuthor, ['aaaaaaaa'], 'why')).rejects.toThrow(KNOWLEDGE_REFUSAL.off())
  })
})

describe('the knowledge command line', () => {
  const quietCommand = () => {
    const knowledge = knowledgeCommand({ requireKernel: () => { throw new Error('no kernel in this test') } })
    for (const c of [knowledge, ...knowledge.commands]) c.exitOverride().configureOutput({ writeErr: () => {} })
    return knowledge
  }
  it.each([[KNOWLEDGE_SUBCOMMAND.card, 'src'], [KNOWLEDGE_SUBCOMMAND.search, 'query']])('%s refuses a --limit that is not a positive integer', async (sub, arg) => {
    for (const bad of ['abc', '0', '-1', '1.5'])
      await expect(quietCommand().parseAsync([sub, arg, '--limit', bad], { from: 'user' })).rejects.toThrow(`must be a positive integer (>= 1), got '${bad}'`)
    await expect(quietCommand().parseAsync([sub, arg, '--limit', '5'], { from: 'user' })).rejects.toThrow(NO_PROJECT_CONTEXT)
  })
  it('stamps a terminal write as cli, from the cwd workspace, through the cli door', async () => {
    const dir = checkout()
    const workspace: Workspace = {
      id: TEST_WORKSPACE_ID, title: 'test', cwd: dir, branch: 'main', baseBranch: null,
      kind: WORKSPACE_KIND.checkout, managed: false, onTrunk: true, createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null,
    }
    const fold: WorkspaceFold = { state: async () => ({ workspaces: new Map([[workspace.id, workspace]]) }) }
    expect(await knowledgeAuthor(fold, dir)).toEqual(authorFixture())
  })
})
