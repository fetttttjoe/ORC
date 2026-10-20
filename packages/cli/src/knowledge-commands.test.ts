import { afterEach, describe, expect, it } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AUTHOR_SOURCE, ClaimClass, Door, EVENT_KIND, FS_READ_TOOL_NAME, PAYLOAD_SCHEMAS, KNOWLEDGE_REFUSAL, KnowledgePatch, NO_CHAT, WORKSPACE_KIND,
  type EventInput, type EventKind, type EventRecord, type Author, type Workspace,
} from '@orc/contracts'
import { authorFixture, TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'
import { gitFilesPlugin } from '@orc/knowledge-git'
import { createTreeSitterStructure } from '@orc/structure-treesitter'
import { cliAuthor, type WorkspaceFold } from './cwd-workspace'
import { CommandFailure } from './exit'
import { knowledgeAccess, openKnowledge } from './knowledge-open'
import {
  addPatch, DRIFT_WITHOUT_LOG, NO_LOG_OPEN, NO_PROJECT_CONTEXT, VERIFY_REFUSAL, KNOWLEDGE_SUBCOMMAND, knowledgeCommand, parseAnchorArg, renderClaims, renderProblems,
  runAdd, runCard, runCheck, runDrift, runFormat, runRetire, runSearch,
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
const commitAll = (dir: string, message: string): void => {
  Bun.spawnSync(['git', '-C', dir, 'add', '.'])
  Bun.spawnSync(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message])
}
const testAuthor: Author = { source: AUTHOR_SOURCE.cli, workspaceId: 'ws-1', origin: NO_CHAT(Door.cli) }
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
  const access = knowledgeAccess(openKnowledge({ knowledge: { plugin: 'git-files', options: {} } }), { append, after: async () => [], earliestSeq: async () => 0 }, dir)
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
    const backend = { backend: gitFilesPlugin.create({}, { structure: createTreeSitterStructure() }) }
    await backend.backend.write(dir, KnowledgePatch.parse({ add: [{ text: 'ok', class: ClaimClass.fact, anchors: [{ path: 'src/a.ts' }] }] }))
    expect(await runCheck(backend, dir)).toEqual({ lines: ['knowledge: 0 problems'], failed: false })
    appendFileSync(path.join(dir, 'knowledge/src/a.ts.md'), '- by hand\n')
    expect(await runCheck(backend, dir)).toEqual({
      lines: [expect.stringContaining('knowledge/src/a.ts.md:5  missing id'), 'knowledge: 1 problems'], failed: true,
    })
  })
  it('fmt fixes a missing id and reports what it rewrote', async () => {
    const dir = checkout()
    const backend = { backend: gitFilesPlugin.create({}, { structure: createTreeSitterStructure() }) }
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
    const backend = { backend: gitFilesPlugin.create({}, { structure: createTreeSitterStructure() }) }
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
    const backend = { backend: gitFilesPlugin.create({}, { structure: createTreeSitterStructure() }) }
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
    const backend = gitFilesPlugin.create({}, { structure: createTreeSitterStructure() })
    const [ref] = (await backend.write(dir, KnowledgePatch.parse({ add: [{ text: 'ok', class: ClaimClass.fact, anchors: [{ path: 'src/a.ts' }] }] }))).added
    const { port, events } = portOn(dir)
    const lines = await runRetire(port, testAuthor, [ref.id], 'no longer true')
    expect(lines).toEqual([`retired ${ref.id} from ${ref.location}`])
    expect(events.map(e => e.kind)).toEqual([EVENT_KIND.knowledge_written])
  })
})

describe('knowledge drift', () => {
  const driftFixture = async () => {
    const dir = checkout()
    writeFileSync(path.join(dir, 'src/b.ts'), '')
    const { port } = portOn(dir)
    if ('unavailable' in port) throw new Error(port.unavailable)
    const added = []
    for (const anchor of ['src/a.ts', 'src/b.ts'])
      added.push((await port.port.write({ author: testAuthor, idempotencyKey: null }, { add: [{ text: `about ${anchor}`, class: ClaimClass.fact, anchors: [{ path: anchor }] }] })).added[0])
    commitAll(dir, 'claims')
    writeFileSync(path.join(dir, 'src/a.ts'), 'export const changed = 1\n')
    commitAll(dir, 'change a')
    return { dir, port, suspectId: added[0]?.id, cleanId: added[1]?.id }
  }
  it('lists the suspect claim with its anchors, omits the clean one, and counts every state', async () => {
    const { port, suspectId, cleanId } = await driftFixture()
    const lines = await runDrift(port, testAuthor, [], false)
    expect(lines).toEqual([`suspect  ${suspectId}  knowledge/src/a.ts.md  src/a.ts`, 'clean 1 · suspect 1 · unknown 0 · unanchored 0'])
    expect(lines.join('\n')).not.toContain(cleanId ?? 'missing')
  })
  it('narrows to the given paths', async () => {
    const { port } = await driftFixture()
    expect(await runDrift(port, testAuthor, ['src/b.ts'], false)).toEqual(['clean 1 · suspect 0 · unknown 0 · unanchored 0'])
  })
  it('--json prints one parseable document of the non-clean rows and the counts', async () => {
    const { port, suspectId } = await driftFixture()
    const [line] = await runDrift(port, testAuthor, [], true)
    expect(JSON.parse(line ?? '')).toEqual({
      claims: [{ state: 'suspect', id: suspectId, location: 'knowledge/src/a.ts.md', anchors: [{ path: 'src/a.ts', symbol: null, state: 'suspect' }] }],
      counts: { clean: 1, suspect: 1, unknown: 0, unanchored: 0 },
    })
  })
})

describe('every handler is off when the door is off', () => {
  it('rejects naming the reason knowledge is off', async () => {
    const off = { unavailable: KNOWLEDGE_REFUSAL.off() }
    await expect(runCard(off, '/nowhere', '.', { cursor: null, limit: 10 })).rejects.toThrow(KNOWLEDGE_REFUSAL.off())
    await expect(runSearch(off, '/nowhere', 'x', 10)).rejects.toThrow(KNOWLEDGE_REFUSAL.off())
    await expect(runAdd(off, testAuthor, { class: ClaimClass.fact, text: 'x' })).rejects.toThrow(KNOWLEDGE_REFUSAL.off())
    await expect(runRetire(off, testAuthor, ['aaaaaaaa'], 'why')).rejects.toThrow(KNOWLEDGE_REFUSAL.off())
    await expect(runDrift(off, testAuthor, [], false)).rejects.toThrow(KNOWLEDGE_REFUSAL.off())
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
    expect(await cliAuthor(fold, dir)).toEqual(authorFixture())
  })
})

describe('stats, verify and drift through the command line', () => {
  const FAKE_LOG_REASON = 'log is down'
  const fakeLog = (seed: EventInput[] = [], failReads = false) => {
    const records: EventRecord[] = []
    const append = async (input: EventInput): Promise<EventRecord> => {
      const record: EventRecord = {
        seq: records.length + 1, projectId: 'test-project', idempotencyKey: input.idempotencyKey ?? null,
        chatId: input.chatId, door: input.door, taskId: input.taskId, stepId: input.stepId, runToken: input.runToken,
        kind: input.kind, payload: input.payload, usage: input.usage ?? null, ts: new Date().toISOString(),
      }
      records.push(record)
      return record
    }
    const afterCalls: number[] = []
    const after = async (seq: number, kinds: EventKind[]): Promise<EventRecord[]> => {
      afterCalls.push(seq)
      if (failReads) throw new Error(FAKE_LOG_REASON)
      return records.filter(r => r.seq > seq && kinds.includes(r.kind))
    }
    const earliestSeq = async (): Promise<number> => records[0]?.seq ?? 0
    return { log: { append, after, earliestSeq }, records, afterCalls, ready: Promise.all(seed.map(append)) }
  }
  const readCall = (path: string): EventInput => ({
    kind: EVENT_KIND.tool_call, chatId: null, door: Door.supervisor, taskId: 't', stepId: 's', runToken: 'run-1', idempotencyKey: null,
    payload: { stepId: 's', runToken: 'run-1', iteration: 1, toolCallId: `c-${path}`, toolName: FS_READ_TOOL_NAME, input: { path } },
  })
  const cliWorkspace = (dir: string): WorkspaceFold => {
    const workspace: Workspace = {
      id: TEST_WORKSPACE_ID, title: 'test', cwd: dir, branch: 'main', baseBranch: null,
      kind: WORKSPACE_KIND.checkout, managed: false, onTrunk: true, createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null,
    }
    return { state: async () => ({ workspaces: new Map([[workspace.id, workspace]]) }) }
  }
  const commandOn = (dir: string, log: ReturnType<typeof fakeLog>['log']) => {
    const knowledge = knowledgeCommand({
      requireKernel: () => cliWorkspace(dir),
      project: { config: { knowledge: { plugin: 'git-files', options: {} }, dir }, log },
    })
    for (const c of [knowledge, ...knowledge.commands]) c.exitOverride().configureOutput({ writeErr: () => {} })
    return knowledge
  }
  const run = async (command: ReturnType<typeof commandOn>, argv: string[]): Promise<string[]> => {
    const lines: string[] = []
    const original = console.log
    console.log = (line: string) => { lines.push(line) }
    try { await command.parseAsync(argv, { from: 'user' }) } finally { console.log = original }
    return lines
  }
  const suspectClaim = async (dir: string) => {
    const backend = gitFilesPlugin.create({}, { structure: createTreeSitterStructure() })
    const [ref] = (await backend.write(dir, KnowledgePatch.parse({ add: [{ text: 'about a', class: ClaimClass.fact, anchors: [{ path: 'src/a.ts' }] }] }))).added
    commitAll(dir, 'claim')
    writeFileSync(path.join(dir, 'src/a.ts'), 'export const changed = 1\n')
    commitAll(dir, 'change a')
    return ref?.id ?? ''
  }

  it('stats lists a file an agent read that no claim covers', async () => {
    const dir = checkout()
    const fake = fakeLog([readCall('src/a.ts')])
    await fake.ready
    const lines = await run(commandOn(dir, fake.log), [KNOWLEDGE_SUBCOMMAND.stats])
    expect(lines).toContain('gaps: 1 files read with no claim (0 covered by a folder claim alone)')
    expect(lines).toContain('  1 runs  1 reads  src/a.ts')
  })

  it('stats fails loudly, with the reason, when the log cannot be read or is not open', async () => {
    const dir = checkout()
    const down = fakeLog([], true)
    await expect(run(commandOn(dir, down.log), [KNOWLEDGE_SUBCOMMAND.stats])).rejects.toThrow(FAKE_LOG_REASON)
    const noLog = knowledgeCommand({ requireKernel: () => cliWorkspace(dir), project: { config: { knowledge: { plugin: 'git-files', options: {} }, dir }, logUnreachable: { reason: 'postgres is down', error: new Error('connection refused') } } })
    for (const k of [noLog, ...noLog.commands]) k.exitOverride()
    await expect(run(noLog, [KNOWLEDGE_SUBCOMMAND.stats])).rejects.toThrow('connection refused')
  })

  it('stats --json prints one parseable document', async () => {
    const dir = checkout()
    const fake = fakeLog([readCall('src/a.ts'), readCall('src/b.ts')])
    await fake.ready
    const [line] = await run(commandOn(dir, fake.log), [KNOWLEDGE_SUBCOMMAND.stats, '--json', '--top', '1'])
    expect(JSON.parse(line ?? '').gaps).toEqual({ total: 2, top: [{ path: 'src/a.ts', runs: 1, reads: 1 }], byExtension: { '.ts': 2 }, folderCovered: 0 })
  })

  it('a holds check appends knowledge_checked with the anchor digests, and the suspect claim then reads clean', async () => {
    const dir = checkout()
    const id = await suspectClaim(dir)
    const fake = fakeLog()
    const command = commandOn(dir, fake.log)
    expect((await run(command, [KNOWLEDGE_SUBCOMMAND.drift]))[0]).toStartWith(`suspect  ${id}`)
    expect(await run(command, [KNOWLEDGE_SUBCOMMAND.verify, id, 'holds', '--why', 'still true'])).toEqual([`holds ${id}`])
    expect(fake.records.map(r => r.kind)).toEqual([EVENT_KIND.knowledge_checked])
    const checked = PAYLOAD_SCHEMAS.knowledge_checked.parse(fake.records[0]?.payload)
    expect([checked.id, checked.verdict, checked.why, checked.anchors.map(x => x.path)]).toEqual([id, 'holds', 'still true', ['src/a.ts']])
    expect(checked.anchors[0]?.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(await run(command, [KNOWLEDGE_SUBCOMMAND.drift])).toEqual(['clean 1 · suspect 0 · unknown 0 · unanchored 0'])
  })

  it('a false check with --retire retires the claim and records both events', async () => {
    const dir = checkout()
    const id = await suspectClaim(dir)
    const fake = fakeLog()
    const lines = await run(commandOn(dir, fake.log), [KNOWLEDGE_SUBCOMMAND.verify, id, 'false', '--why', 'gone', '--retire'])
    expect(lines).toEqual([`false ${id}`, expect.stringMatching(new RegExp(`^retired ${id} from `))])
    expect(fake.records.map(r => r.kind)).toEqual([EVENT_KIND.knowledge_written, EVENT_KIND.knowledge_checked])
    expect(await run(commandOn(dir, fake.log), [KNOWLEDGE_SUBCOMMAND.drift])).toEqual(['clean 0 · suspect 0 · unknown 0 · unanchored 0'])
  })

  it('a false check with --text corrects the claim', async () => {
    const dir = checkout()
    const id = await suspectClaim(dir)
    const fake = fakeLog()
    const lines = await run(commandOn(dir, fake.log), [KNOWLEDGE_SUBCOMMAND.verify, id, 'false', '--why', 'reworded', '--text', 'about a, corrected'])
    expect(lines[1]).toStartWith(`changed ${id} in `)
    expect(await run(commandOn(dir, fake.log), [KNOWLEDGE_SUBCOMMAND.card, 'src'])).toEqual([expect.stringContaining('about a, corrected')])
  })

  it('a false check with neither or both corrections refuses, exits 1, and appends nothing', async () => {
    const dir = checkout()
    const id = await suspectClaim(dir)
    const fake = fakeLog()
    const lines: string[] = []
    const original = console.log
    console.log = (line: string) => { lines.push(line) }
    try {
      for (const flags of [[], ['--retire', '--text', 'x']])
        await expect(commandOn(dir, fake.log).parseAsync([KNOWLEDGE_SUBCOMMAND.verify, id, 'false', '--why', 'w', ...flags], { from: 'user' })).rejects.toBeInstanceOf(CommandFailure)
    } finally { console.log = original }
    expect(lines).toEqual([KNOWLEDGE_REFUSAL.checkNeedsPatch(id), VERIFY_REFUSAL.correction(id)])
    expect(fake.records).toEqual([])
  })

  it('drift with a log that cannot be read prints the reason first, then the blame-only rows', async () => {
    const dir = checkout()
    const id = await suspectClaim(dir)
    const fake = fakeLog([], true)
    expect(await run(commandOn(dir, fake.log), [KNOWLEDGE_SUBCOMMAND.drift])).toEqual([
      DRIFT_WITHOUT_LOG(FAKE_LOG_REASON),
      `suspect  ${id}  knowledge/src/a.ts.md  src/a.ts`,
      'clean 0 · suspect 1 · unknown 0 · unanchored 0',
    ])
  })

  it('drift and stats each read the log once', async () => {
    const dir = checkout()
    await suspectClaim(dir)
    const forDrift = fakeLog()
    await run(commandOn(dir, forDrift.log), [KNOWLEDGE_SUBCOMMAND.drift])
    expect(forDrift.afterCalls).toEqual([0])
    const forStats = fakeLog()
    await run(commandOn(dir, forStats.log), [KNOWLEDGE_SUBCOMMAND.stats])
    expect(forStats.afterCalls).toEqual([0])
  })

  it('a failure that is not the log being unreachable is not reported as drift without the log', async () => {
    const dir = checkout()
    await suspectClaim(dir)
    const noWorkspaces: WorkspaceFold = { state: async () => ({ workspaces: new Map() }) }
    const knowledge = knowledgeCommand({ requireKernel: () => noWorkspaces, project: { config: { knowledge: { plugin: 'git-files', options: {} }, dir }, log: fakeLog().log } })
    for (const k of [knowledge, ...knowledge.commands]) k.exitOverride()
    await expect(run(knowledge, [KNOWLEDGE_SUBCOMMAND.drift])).rejects.toThrow('no workspace for this directory')
  })

  it('drift with no log at all reads the same way', async () => {
    const dir = checkout()
    const id = await suspectClaim(dir)
    const knowledge = knowledgeCommand({ requireKernel: () => cliWorkspace(dir), project: { config: { knowledge: { plugin: 'git-files', options: {} }, dir } } })
    for (const c of [knowledge, ...knowledge.commands]) c.exitOverride()
    const lines = await run(knowledge, [KNOWLEDGE_SUBCOMMAND.drift])
    expect(lines[0]).toBe(DRIFT_WITHOUT_LOG(NO_LOG_OPEN))
    const named = knowledgeCommand({ requireKernel: () => cliWorkspace(dir), project: { config: { knowledge: { plugin: 'git-files', options: {} }, dir }, logUnreachable: { reason: 'postgres is down', error: new Error('connection refused') } } })
    expect((await run(named, [KNOWLEDGE_SUBCOMMAND.drift]))[0]).toBe(DRIFT_WITHOUT_LOG('postgres is down'))
    expect(lines[1]).toStartWith(`suspect  ${id}`)
  })
})
