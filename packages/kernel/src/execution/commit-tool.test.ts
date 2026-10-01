import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { COMMIT_STEP_ID, Door, NO_CHAT, ORC_CHAT_ID, STEP_ROLE, ZERO_USAGE, type Origin, type ResolvedTool, type Usage } from '@orc/contracts'
import { must, recordOf } from '@orc/contracts/fixtures'
import { emptyFold, subtreeUsage, type State } from '../projections'
import { commitTool, type SuspectAt } from './commit-tool'

const tempDirs: string[] = []
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const run = (dir: string, ...args: string[]) => Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'ignore', stderr: 'ignore' })
const out = (dir: string, ...args: string[]) => Bun.spawnSync(['git', '-C', dir, '-c', 'core.quotePath=false', ...args], { stdout: 'pipe' }).stdout.toString().trim()
const head = (dir: string) => out(dir, 'rev-parse', 'HEAD')
function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-commit-'))
  tempDirs.push(dir)
  run(dir, 'init', '-q'); run(dir, 'config', 'user.email', 't@t.t'); run(dir, 'config', 'user.name', 't')
  writeFileSync(path.join(dir, 'a.ts'), 'a1\n')
  writeFileSync(path.join(dir, 'sibling.ts'), 's1\n')
  run(dir, 'add', '-A'); run(dir, 'commit', '-qm', 'base')
  return dir
}

// a committer step runs inside its run's chat, so that is what the fixture spells
const p: { taskId: string; stepId: string; role: string; runToken: string; origin: Origin } =
  { taskId: 't1', stepId: COMMIT_STEP_ID, role: STEP_ROLE.committer, runToken: 'rt1', origin: { chatId: 'run:t1:v1', door: Door.supervisor } }
const UNSET = '<unset>'
// A hook runs inside git's OWN process, so it is the only witness that the chat id reached git
// rather than merely the tool's argv; the sentinel keeps an absent key distinct from an empty one.
function chatIdHook(dir: string): () => string {
  writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'),
    `#!/bin/sh\nprintf %s "\${${ORC_CHAT_ID}-${UNSET}}" > chat-env.txt\n`, { mode: 0o755 })
  return () => readFileSync(path.join(dir, 'chat-env.txt'), 'utf8')
}
const changed = (...paths: string[]) => paths.map(path => ({ path, taskId: 't1', steps: [{ stepId: 's1', tool: 'fs_write', seq: 1 }] }))

function build(dir: string, opts: {
  paths?: string[]
  suspectAt?: SuspectAt
  knowledgeFiles?: string[]
  p?: typeof p
  state?: State
}) {
  const tools = commitTool({
    kernel: {
      listTaskChangedPaths: async () => changed(...(opts.paths ?? [])),
      listTaskKnowledgeWrites: async () => ({ live: [], retired: [], files: opts.knowledgeFiles ?? [] }),
      // no usage recorded by default — subtreeUsage(emptyFold().state, taskId) reads back ZERO_USAGE
      state: async () => opts.state ?? emptyFold().state,
    },
    dir, ...(opts.suspectAt ? { suspectAt: opts.suspectAt } : {}), p: opts.p ?? p,
  })
  const tool = (name: string): ResolvedTool => must(tools.find(t => t.name === name), 'tool')
  // the ordinary flow: read the diff, then commit — what every test not ABOUT the gate uses
  const commit = async (message: string) => {
    await tool('commit_preview').execute({})
    return tool('git_commit').execute({ message })
  }
  return { tools, tool, commit }
}

describe('commitTool registration gate', () => {
  it('registers the pair only for the commit step run as committer', () => {
    const dir = repo()
    expect(build(dir, { p: { ...p, stepId: 'verify' } }).tools).toEqual([])
    expect(build(dir, { p: { ...p, role: STEP_ROLE.implementer } }).tools).toEqual([])
    expect(build(dir, {}).tools.map(t => t.name).sort()).toEqual(['commit_preview', 'git_commit'])
  })
})

describe('diff-first flow', () => {
  it('commit_preview returns the floor and the real diff of exactly those paths', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    writeFileSync(path.join(dir, 'sibling.ts'), 's2\n') // not in the floor — must not appear
    const r = await build(dir, { paths: ['a.ts'] }).tool('commit_preview').execute({})
    expect(r.isError).toBe(false)
    const o = recordOf(r.output)
    expect(o.paths).toEqual(['a.ts'])
    expect(String(o.diff)).toContain('+a2')
    expect(String(o.diff)).not.toContain('sibling')
  })

  it('commit_preview never touches the real index — a preview is a look, not a stage', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    writeFileSync(path.join(dir, 'new.ts'), 'n\n')
    const r = await build(dir, { paths: ['a.ts', 'new.ts'] }).tool('commit_preview').execute({})
    expect(r.isError).toBe(false)
    expect(String(recordOf(r.output).diff)).toContain('+n') // untracked file still previews
    expect(out(dir, 'diff', '--cached', '--name-only')).toBe('') // real index untouched
  })

  it('git_commit before any preview refuses with the diff, and the refusal ARMS the gate', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const { tool } = build(dir, { paths: ['a.ts'] })
    const refused = await tool('git_commit').execute({ message: 'feat: blind' })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.output)).toContain('+a2') // the refusal carries the diff
    expect(out(dir, 'log', '-1', '--format=%s')).toBe('base') // nothing committed
    // the refusal delivered the identical diff a preview would — the next call may commit
    const r = await tool('git_commit').execute({ message: 'feat: informed' })
    expect(r.isError).toBe(false)
    expect(out(dir, 'log', '-1', '--format=%s')).toBe('feat: informed')
  })

  it('a tree that moved after the preview re-refuses with the FRESH diff, then commits', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const { tool } = build(dir, { paths: ['a.ts'] })
    await tool('commit_preview').execute({})
    writeFileSync(path.join(dir, 'a.ts'), 'a3-moved\n') // the previewed diff is no longer the truth
    const refused = await tool('git_commit').execute({ message: 'feat: stale view' })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.output)).toContain('a3-moved')
    const r = await tool('git_commit').execute({ message: 'feat: fresh view' })
    expect(r.isError).toBe(false)
    expect(out(dir, 'show', 'HEAD:a.ts')).toBe('a3-moved')
  })

  it('a pre-staged UNRELATED file never rides along in the commit', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    writeFileSync(path.join(dir, 'sibling.ts'), 's2\n')
    run(dir, 'add', '--', 'sibling.ts') // someone else staged it
    const r = await build(dir, { paths: ['a.ts'] }).commit('feat: only mine')
    expect(r.isError).toBe(false)
    expect(recordOf(r.output).committedPaths).toEqual(['a.ts'])
    expect(out(dir, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.ts')
    expect(out(dir, 'status', '--porcelain')).toBe('M  sibling.ts') // still staged (M_ = staged modify), still theirs
  })
})

describe('git_commit', () => {
  it('refuses a message over two non-empty lines with the rule in the error', async () => {
    // the operator's history rule: subject + at most one body line. A live committer wrote a
    // three-line message whose body broke off mid-sentence (79303eb) — the cap makes the next
    // one impossible instead of hoping the next agent writes better.
    const dir = repo()
    const b = build(dir, { paths: ['a.ts'] })
    await b.tool('commit_preview').execute({})
    const r = await b.tool('git_commit').execute({ message: 'fix(kernel): subject\n\nbody line one\nbody line two' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('two lines')
    // subject + one body line commits fine
    const ok = await b.tool('git_commit').execute({ message: 'fix(kernel): subject\n\none body line' })
    expect(ok.isError).toBe(false)
  })

  it('commits ONLY the task-recorded paths; sibling work stays uncommitted', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')          // this task's edit
    writeFileSync(path.join(dir, 'sibling.ts'), 's2\n')    // another task's edit, not in the floor
    const r = await build(dir, { paths: ['a.ts'] }).commit('feat: change a')
    expect(r.isError).toBe(false)
    const o = recordOf(r.output)
    expect(o.created).toBe(true)
    expect(o.commit).toBe(out(dir, 'rev-parse', 'HEAD'))
    expect(o.committedPaths).toEqual(['a.ts'])
    expect(out(dir, 'log', '-1', '--format=%s')).toBe('feat: change a')
    expect(out(dir, 'status', '--porcelain')).toBe('M sibling.ts') // out() trims; the ' M' status means modified, unstaged
  })

  it('stages a new file and a deletion (floor paths that exist or are tracked)', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'new.ts'), 'n\n')
    rmSync(path.join(dir, 'a.ts'))
    const r = await build(dir, { paths: ['new.ts', 'a.ts', 'never-existed.ts'] }).commit('chore: churn')
    expect(r.isError).toBe(false)
    expect(recordOf(r.output).committedPaths).toEqual(['a.ts', 'new.ts'])
    expect(existsSync(path.join(dir, 'a.ts'))).toBe(false)
  })

  it('a gitignored floor path is skipped and reported — it never bricks the commit', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, '.gitignore'), 'ig.ts\n')
    run(dir, 'add', '-A'); run(dir, 'commit', '-qm', 'ignore ig')
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    writeFileSync(path.join(dir, 'ig.ts'), 'generated\n') // task wrote it; .gitignore excludes it
    const r = await build(dir, { paths: ['a.ts', 'ig.ts'] }).commit('feat: change a')
    expect(r.isError).toBe(false)
    const o = recordOf(r.output)
    expect(o.created).toBe(true)
    expect(o.committedPaths).toEqual(['a.ts'])
    expect(o.skippedIgnored).toEqual(['ig.ts'])
  })

  it('commits a deletion of a non-ASCII filename (quotePath must not mangle the sets)', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'ümlaut.ts'), 'u\n')
    run(dir, 'add', '-A'); run(dir, 'commit', '-qm', 'add umlaut')
    rmSync(path.join(dir, 'ümlaut.ts'))
    const r = await build(dir, { paths: ['ümlaut.ts'] }).commit('chore: drop umlaut')
    expect(r.isError).toBe(false)
    expect(recordOf(r.output).committedPaths).toEqual(['ümlaut.ts'])
    expect(out(dir, 'show', '--name-only', '--format=', 'HEAD')).toBe('ümlaut.ts')
  })

  it('nothing staged (already committed by a child, or a replay) is a success at current HEAD — stillDrifted is still read', async () => {
    const dir = repo()
    const asked: string[][] = []
    const built = build(dir, { paths: ['a.ts'], suspectAt: async paths => { asked.push(paths); return [] } })
    const r = await built.commit('feat: nothing new')
    expect(r.isError).toBe(false)
    const o = recordOf(r.output)
    expect(o.created).toBe(false)
    expect(o.commit).toBe(out(dir, 'rev-parse', 'HEAD'))
    expect(o.committedPaths).toEqual([])
    expect(asked).toEqual([[]])
    expect(o.stillDrifted).toEqual([])
  })

  it('outside a git repository both tools error honestly', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-norepo-'))
    tempDirs.push(dir)
    writeFileSync(path.join(dir, 'a.ts'), 'a\n')
    const { tool } = build(dir, { paths: ['a.ts'] })
    expect((await tool('commit_preview').execute({})).isError).toBe(true)
    expect((await tool('git_commit').execute({ message: 'x' })).isError).toBe(true)
  })

  it('rejects a missing or empty message', async () => {
    const { tool } = build(repo(), { paths: ['a.ts'] })
    expect((await tool('git_commit').execute({})).isError).toBe(true)
    expect((await tool('git_commit').execute({ message: '' })).isError).toBe(true)
  })

  it("carries the step's chat into git's own environment, so the commit hook can name the interaction", async () => {
    const dir = repo()
    const seen = chatIdHook(dir)
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const r = await build(dir, { paths: ['a.ts'], p: { ...p, origin: { chatId: 'chat-commit', door: Door.web } } }).commit('feat: change a')
    expect(r.isError).toBe(false)
    expect(seen()).toBe('chat-commit')
  })

  it('a chatless commit passes NO chat key at all, rather than an empty one', async () => {
    const dir = repo()
    const seen = chatIdHook(dir)
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const r = await build(dir, { paths: ['a.ts'], p: { ...p, origin: NO_CHAT(Door.supervisor) } }).commit('feat: change a')
    expect(r.isError).toBe(false)
    expect(seen()).toBe(UNSET) // an empty ORC_CHAT_ID would read to a hook as a chat named ''
  })
})

describe('stillDrifted', () => {
  it('lists what suspectAt returns for exactly the committed paths', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    writeFileSync(path.join(dir, 'sibling.ts'), 's2\n')
    const asked: string[][] = []
    const suspect = [{ id: 'a-claim', location: 'knowledge/a.ts.md' }]
    const r = await build(dir, { paths: ['a.ts'], suspectAt: async paths => { asked.push(paths); return suspect } }).commit('feat: change a')
    expect(r.isError).toBe(false)
    expect(asked).toEqual([['a.ts']])
    expect(recordOf(r.output).stillDrifted).toEqual(suspect)
  })

  it('a throwing suspectAt never masks the created commit', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const r = await build(dir, { paths: ['a.ts'], suspectAt: async () => { throw new Error('outline provider down') } }).commit('feat: change a')
    expect(r.isError).toBe(false)
    const o = recordOf(r.output)
    expect(o.created).toBe(true)
    expect(o.commit).toBe(head(dir))
    expect(o.stillDrifted).toBeNull()
    expect(o.degraded).toEqual([expect.stringContaining('outline provider down')])
  })

  it('is null with one degraded line when suspectAt is absent — never an empty lie', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const r = await build(dir, { paths: ['a.ts'] }).commit('feat: change a')
    expect(r.isError).toBe(false)
    const o = recordOf(r.output)
    expect(o.stillDrifted).toBeNull()
    expect(o.degraded).toEqual(['stillDrifted unmeasured — knowledge is unavailable'])
  })

  it('suspectAt present: degraded is absent entirely, and the receipt carries exactly the documented keys', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const r = await build(dir, { paths: ['a.ts'], suspectAt: async () => [] }).commit('feat: change a')
    expect(r.isError).toBe(false)
    const o = recordOf(r.output)
    expect(o).not.toHaveProperty('degraded')
    expect(Object.keys(o).sort()).toEqual(['commit', 'committedPaths', 'created', 'skippedIgnored', 'stillDrifted', 'usage'])
  })
})


// Cost carriage (fail-first before commit-tool.ts computed a usage field at all): the receipt
// names a total for the task subtree via projections' subtreeUsage, the same read model the
// per-step status line and the approval-door estimate draw from — never a hand-rolled shape.
describe('usage in the receipt', () => {
  it('carries the task subtree\'s usage total, from the injected kernel.state()', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const st = emptyFold().state
    const measured: Usage = {
      inputTokens: 1200, outputTokens: 340, cacheReadTokens: 50, cacheWriteTokens: 20,
      costUSD: 0.087, estimated: false,
    }
    st.usage.set('t1', measured)
    const expected = subtreeUsage(st, 't1')
    const r = await build(dir, { paths: ['a.ts'], state: st }).commit('feat: change a')
    expect(r.isError).toBe(false)
    const o = recordOf(r.output)
    expect(o.usage).toEqual(expected)
    expect(o.usage).toEqual(measured)
  })

  it('is ZERO_USAGE when the task subtree recorded no agent_call usage', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const r = await build(dir, { paths: ['a.ts'] }).commit('feat: change a')
    expect(r.isError).toBe(false)
    expect(recordOf(r.output).usage).toEqual(ZERO_USAGE)
  })
})

describe('literal pathspecs', () => {
  it('floor paths are LITERAL: a glob string matches nothing but itself', async () => {
    const dir = repo()
    // a file literally named 'a*.ts' is this task's change; ab.ts is dirty sibling work
    writeFileSync(path.join(dir, 'a*.ts'), 'star\n')
    writeFileSync(path.join(dir, 'ab.ts'), 'sibling-dirty\n')
    const r = await build(dir, { paths: ['a*.ts'] }).commit('feat: literal star')
    expect(r.isError).toBe(false)
    // without --literal-pathspecs the pathspec 'a*.ts' would glob onto ab.ts and commit sibling work
    expect(recordOf(r.output).committedPaths).toEqual(['a*.ts'])
    expect(out(dir, 'status', '--porcelain')).toContain('ab.ts')
  })
})

describe('knowledge files ride the commit', () => {
  const committed = (dir: string): string[] =>
    Bun.spawnSync(['git', '-C', dir, 'show', '--name-only', '--format=', 'HEAD']).stdout.toString().trim().split('\n').sort()
  it('a knowledge file the task wrote is committed with the code', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    mkdirSync(path.join(dir, 'knowledge'), { recursive: true })
    writeFileSync(path.join(dir, 'knowledge', 'a.ts.md'), '# a.ts\n')
    const r = await build(dir, { paths: ['a.ts'], knowledgeFiles: ['knowledge/a.ts.md'] }).commit('feat: a')
    expect(r.isError).toBe(false)
    expect(committed(dir)).toEqual(['a.ts', 'knowledge/a.ts.md'])
  })
  it('a bucket the task emptied is committed as a deletion', async () => {
    const dir = repo()
    mkdirSync(path.join(dir, 'knowledge'), { recursive: true })
    writeFileSync(path.join(dir, 'knowledge', 'b.ts.md'), '# b.ts\n')
    Bun.spawnSync(['git', '-C', dir, 'add', '-A'])
    Bun.spawnSync(['git', '-C', dir, 'commit', '-qm', 'seed bucket'])
    rmSync(path.join(dir, 'knowledge', 'b.ts.md'))
    const r = await build(dir, { knowledgeFiles: ['knowledge/b.ts.md'] }).commit('chore: retire')
    expect(r.isError).toBe(false)
    expect(Bun.spawnSync(['git', '-C', dir, 'log', '-1', '--format=%s']).stdout.toString().trim()).toBe('chore: retire')
    expect(committed(dir)).toEqual(['knowledge/b.ts.md'])
    expect(Bun.spawnSync(['git', '-C', dir, 'ls-files', 'knowledge/b.ts.md']).stdout.toString()).toBe('')
  })
})
