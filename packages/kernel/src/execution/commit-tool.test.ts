import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { COMMIT_STEP_ID, Door, NO_CHAT, ORC_CHAT_ID, STEP_ROLE, ZERO_USAGE, type Origin, type ResolvedTool, type Usage } from '@orc/contracts'
import { must, recordOf } from '@orc/contracts/fixtures'
import { emptyFold, subtreeUsage, type State } from '../projections'
import { commitTool, type CitingNotes, type StampNote } from './commit-tool'

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
  // preexisting defaults to TRUE: these fixtures are about the dirty gate, not the heal gate, and
  // a heal is what a restamp is for. The fresh-write case (preexisting: false) is stated explicitly
  // where it is the point.
  notes?: { id: string; scope: string; paths: string[]; preexisting?: boolean }[]
  // stampRevision defaults to the CURRENT HEAD: that is what an auditor's stamp names in the
  // ordinary flow (verify runs before the commit step, against the worktree, stamping HEAD), and it
  // is the case the strict gate must leave alone. Tests about the gate pass an older revision.
  verified?: { id: string; scope: string; paths: string[]; stampRevision?: string }[]
  restamp?: StampNote | null
  reverify?: StampNote | null
  citing?: CitingNotes
  knowledgeFiles?: string[]
  p?: typeof p
  state?: State
}) {
  // read EAGERLY, at build time: this is the HEAD an auditor step would have stamped, i.e. before
  // the commit under test moves it. Reading it lazily inside the callback would hand the gate the
  // POST-commit HEAD and invert every range.
  const auditedHead = head(dir)
  const stamped: { id: string; scope: string; key: string }[] = []
  const restamp: StampNote | undefined = opts.restamp === null ? undefined
    : opts.restamp ?? (async (note, key) => { stamped.push({ ...note, key }) })
  const restated: { id: string; scope: string; key: string }[] = []
  const reverify: StampNote | undefined = opts.reverify === null ? undefined
    : opts.reverify ?? (async (note, key) => { restated.push({ ...note, key }) })
  const tools = commitTool({
    kernel: {
      listTaskChangedPaths: async () => changed(...(opts.paths ?? [])),
      listTaskNoteWrites: async () => (opts.notes ?? []).map(n => ({ preexisting: true, ...n })),
      listTaskVerifiedNotes: async () => (opts.verified ?? []).map(n => ({ stampRevision: auditedHead, ...n })),
      listTaskKnowledgeWrites: async () => ({ live: [], retired: [], files: opts.knowledgeFiles ?? [] }),
      // no usage recorded by default — subtreeUsage(emptyFold().state, taskId) reads back ZERO_USAGE
      state: async () => opts.state ?? emptyFold().state,
    },
    dir, restamp, reverify, ...(opts.citing ? { citing: opts.citing } : {}), p: opts.p ?? p,
  })
  const tool = (name: string): ResolvedTool => must(tools.find(t => t.name === name), 'tool')
  // the ordinary flow: read the diff, then commit — what every test not ABOUT the gate uses
  const commit = async (message: string) => {
    await tool('commit_preview').execute({})
    return tool('git_commit').execute({ message })
  }
  return { tools, tool, commit, stamped, restated }
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

  it('nothing staged (already committed by a child, or a replay) is a success at current HEAD — restamp still runs', async () => {
    const dir = repo()
    const built = build(dir, { paths: ['a.ts'], notes: [{ id: 'area-a', scope: 'project', paths: ['a.ts'] }] })
    const r = await built.commit('feat: nothing new')
    expect(r.isError).toBe(false)
    const o = recordOf(r.output)
    expect(o.created).toBe(false)
    expect(o.commit).toBe(out(dir, 'rev-parse', 'HEAD'))
    expect(o.committedPaths).toEqual([])
    expect(built.stamped.map(s => s.id)).toEqual(['area-a'])
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

// The receipt's honesty line: citing notes nobody in this task verified must be NAMED, not
// silently left stale-stamped — the gap that produced 4/7 post-commit drift twice in one day.
describe('stillDrifted', () => {
  it('lists citing notes outside every task-written set; excludes restamped ones', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const foreign = { id: 'area-foreign', scope: 'project', title: 'F', sourceRevision: 'old' }
    const own = { id: 'area-own', scope: 'project', title: 'O', sourceRevision: 'old' }
    const built = build(dir, {
      paths: ['a.ts'],
      notes: [{ id: 'area-own', scope: 'project', paths: ['a.ts'] }], // task-written → restamped
      citing: async () => [foreign, own],
    })
    const r = await built.commit('feat: change a')
    expect(r.isError).toBe(false)
    expect(recordOf(r.output).stillDrifted).toEqual([{ id: 'area-foreign', scope: 'project' }])
    expect(built.stamped.map(s => s.id)).toEqual(['area-own'])
  })

  it('excludes ALL task-written sets: restamped, skippedDirty, and restampFailed', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    writeFileSync(path.join(dir, 'dirty.ts'), 'uncommitted\n') // keeps note-dirty dirty
    const citing = async () => [
      { id: 'note-clean', scope: 'project', title: 'C', sourceRevision: 'old' },
      { id: 'note-dirty', scope: 'project', title: 'D', sourceRevision: 'old' },
      { id: 'note-throws', scope: 'project', title: 'T', sourceRevision: 'old' },
      { id: 'note-foreign', scope: 'project', title: 'F', sourceRevision: 'old' },
    ]
    const built = build(dir, {
      paths: ['a.ts'],
      notes: [
        { id: 'note-clean', scope: 'project', paths: ['a.ts'] },       // restamped
        { id: 'note-dirty', scope: 'project', paths: ['dirty.ts'] },   // skippedDirty
        { id: 'note-throws', scope: 'project', paths: ['a.ts'] },      // restampFailed
      ],
      restamp: async note => { if (note.id === 'note-throws') throw new Error('surreal down') },
      citing,
    })
    const r = await built.commit('feat: change a')
    expect(r.isError).toBe(false)
    // only the foreign note is a leftover — every task-written note is already reported under
    // its own key (restamped / skippedDirty / restampFailed), never double-counted here
    expect(recordOf(r.output).stillDrifted).toEqual([{ id: 'note-foreign', scope: 'project' }])
  })

  it('is null when the callback is absent (memory degraded) — loud, never an empty lie', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const r = await build(dir, { paths: ['a.ts'] }).commit('feat: change a')
    expect(r.isError).toBe(false)
    const o = recordOf(r.output)
    expect(o.stillDrifted).toBeNull()
    expect(o.degraded).toEqual(['stillDrifted unmeasured — citing-notes join unavailable (memory degraded)'])
  })
})

// The `degraded` convention: an absent measurement is null in its own field PLUS a reason string
// in `degraded: string[]`, and `degraded` itself is ABSENT (not an empty array) when everything
// measured — never a one-off bespoke key per absence, never prose smuggled into another field.
// Motivating failure: a consumer grepping for "degraded" must never miss an absence because it
// was spelled a different way (or given its own key entirely).
describe('degraded convention', () => {
  it('the stamp writes absent: degraded names both, and the receipt carries no bespoke absence key', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    // citing supplied so this isolates the stamp-write gap — the citing gap is covered separately
    // above. Both writes go absent together in production: one degraded memory store injects both.
    const r = await build(dir, { paths: ['a.ts'], restamp: null, reverify: null, citing: async () => [] }).commit('feat: change a')
    expect(r.isError).toBe(false)
    const o = recordOf(r.output)
    expect(o.degraded).toEqual([
      'restamp unavailable — memory is degraded; run `orc memory restamp` once memory is back',
      'reverify unavailable — memory is degraded; notes this task verified keep their pre-commit stamp',
    ])
    // exact key set (never loosened to a length check or toContain): a one-off absence key for
    // the missing restamp — the shape this convention forbids — would show up here as an extra
    // key, not merely go unasserted
    expect(Object.keys(o).sort()).toEqual(
      ['commit', 'committedPaths', 'created', 'degraded', 'restampFailed', 'restamped', 'reverified', 'reverifyFailed', 'reverifyStale', 'skippedDirty', 'skippedIgnored', 'stillDrifted', 'usage'],
    )
  })

  it('both restamp and citing present: degraded is absent entirely, not an empty array', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const r = await build(dir, { paths: ['a.ts'], citing: async () => [] }).commit('feat: change a')
    expect(r.isError).toBe(false)
    expect(recordOf(r.output)).not.toHaveProperty('degraded')
  })
})

// The stamp reads the DECLARED state, never authorship. Writing a note is not evidence it is
// true — the piggyback that let every ambient step note ride the commit stamp: a task wrote a note
// about its own change, the commit restamped it at the new HEAD, and it read verified-fresh
// forever without one reader ever checking it against the tree.
describe('verification is declared, never inferred from the write', () => {
  it('a note the task CREATED is not restamped, and lands in stillDrifted honestly', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const built = build(dir, {
      paths: ['a.ts'],
      notes: [{ id: 'area-fresh', scope: 'project', paths: ['a.ts'], preexisting: false }],
      citing: async () => [{ id: 'area-fresh', scope: 'project', title: 'F', sourceRevision: 'old' }],
    })
    const r = await built.commit('feat: change a')
    expect(r.isError).toBe(false)
    const o = recordOf(r.output)
    expect(built.stamped).toEqual([]) // clean paths, still no stamp — the write proved nothing
    expect(o.restamped).toEqual([])
    expect(o.skippedDirty).toEqual([]) // not dirty either: it was never a stamp candidate
    expect(o.stillDrifted).toEqual([{ id: 'area-fresh', scope: 'project' }])
  })

  it('a HEALED note (it already existed) advances its stamp exactly as before', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const built = build(dir, {
      paths: ['a.ts'],
      notes: [{ id: 'area-healed', scope: 'project', paths: ['a.ts'], preexisting: true }],
      citing: async () => [{ id: 'area-healed', scope: 'project', title: 'H', sourceRevision: 'old' }],
    })
    const r = await built.commit('feat: change a')
    const o = recordOf(r.output)
    expect(built.stamped).toEqual([{ id: 'area-healed', scope: 'project', key: 'rt1:restamp:project:area-healed' }])
    expect(o.restamped).toEqual([{ id: 'area-healed', scope: 'project' }])
    expect(o.stillDrifted).toEqual([])
  })

  it('a VERIFIED note is reverified at the new HEAD and excluded from stillDrifted', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const built = build(dir, {
      paths: ['a.ts'],
      notes: [], // the auditor confirmed it with memory_verify — no write at all
      verified: [{ id: 'area-confirmed', scope: 'project', paths: ['a.ts'] }],
      citing: async () => [{ id: 'area-confirmed', scope: 'project', title: 'C', sourceRevision: 'old' }],
    })
    const r = await built.commit('feat: change a')
    expect(r.isError).toBe(false)
    const o = recordOf(r.output)
    expect(built.restated).toEqual([{ id: 'area-confirmed', scope: 'project', key: 'rt1:reverify:project:area-confirmed' }])
    expect(o.reverified).toEqual([{ id: 'area-confirmed', scope: 'project' }])
    expect(built.stamped).toEqual([]) // a verification is not a write
    expect(o.stillDrifted).toEqual([])
  })

  it('a verified note citing DIRTY paths is not reverified — the same truthfulness rule as the restamp', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    writeFileSync(path.join(dir, 'sibling.ts'), 's2\n') // stays uncommitted
    const built = build(dir, {
      paths: ['a.ts'],
      verified: [{ id: 'area-sib', scope: 'project', paths: ['sibling.ts'] }],
    })
    const r = await built.commit('feat: change a')
    const o = recordOf(r.output)
    expect(built.restated).toEqual([])
    expect(o.reverified).toEqual([])
    expect(o.skippedDirty).toEqual([{ id: 'area-sib', scope: 'project', dirtyPaths: ['sibling.ts'] }])
  })

  it('one throwing reverify is reported apart from restampFailed, and still counts as this task\'s', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const built = build(dir, {
      paths: ['a.ts'],
      verified: [{ id: 'area-v', scope: 'project', paths: ['a.ts'] }],
      reverify: async () => { throw new Error('surreal hiccup') },
      citing: async () => [{ id: 'area-v', scope: 'project', title: 'V', sourceRevision: 'old' }],
    })
    const r = await built.commit('feat: change a')
    expect(r.isError).toBe(false) // the commit EXISTS
    const o = recordOf(r.output)
    expect(o.reverifyFailed).toEqual([{ id: 'area-v', scope: 'project', error: 'surreal hiccup' }])
    expect(o.restampFailed).toEqual([]) // a failed verification stamp is NOT a failed restamp: the
    // repair differs (re-verify vs `orc memory restamp`), and one key for both would hide which
    expect(o.stillDrifted).toEqual([]) // a step of this task DID verify it — only the stamp write failed
  })

  it('a note both healed and verified by the task gets both stamps, and one dirty check', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const built = build(dir, {
      paths: ['a.ts'],
      notes: [{ id: 'area-both', scope: 'project', paths: ['a.ts'], preexisting: true }],
      verified: [{ id: 'area-both', scope: 'project', paths: ['a.ts'] }],
      citing: async () => [],
    })
    const r = await built.commit('feat: change a')
    const o = recordOf(r.output)
    expect(o.restamped).toEqual([{ id: 'area-both', scope: 'project' }])
    expect(o.reverified).toEqual([{ id: 'area-both', scope: 'project' }])
  })
})

// The strict gate on the reverify half. A verification stamp says an auditor read the CITED PATHS
// and found the note true of them; advancing it is only honest while nothing has changed those paths
// since. The observed failure it closes: child A's auditor verifies note X citing a.ts; sibling B
// then commits a change to a.ts while X's own prose stays put (so the fold's carry rule correctly
// keeps the verification); the parent's commit reverified X at the new HEAD and excluded it from
// stillDrifted — X read fresh against code nobody re-read.
describe('the strict reverify gate', () => {
  it('a verified note whose cited path a LATER COMMIT touched is stale, never reverified', async () => {
    const dir = repo()
    const audited = head(dir)                                    // the tree child A's auditor read
    writeFileSync(path.join(dir, 'a.ts'), 'a2-sibling\n')
    run(dir, 'add', '-A'); run(dir, 'commit', '-qm', 'sibling B changes a.ts') // after the audit
    writeFileSync(path.join(dir, 'other.ts'), 'o\n')             // this task's own change
    const built = build(dir, {
      paths: ['other.ts'],
      verified: [{ id: 'area-x', scope: 'project', paths: ['a.ts'], stampRevision: audited }],
      citing: async () => [{ id: 'area-x', scope: 'project', title: 'X', sourceRevision: 'old' }],
    })
    const r = await built.commit('feat: other')
    expect(r.isError).toBe(false)
    const o = recordOf(r.output)
    expect(built.restated).toEqual([])   // the callback never fired: no stamp was minted at all
    expect(o.reverified).toEqual([])
    expect(o.reverifyStale).toEqual([{ id: 'area-x', scope: 'project' }])
    expect(o.skippedDirty).toEqual([])   // a.ts IS committed and clean — this is not the dirty gate
    expect(o.stillDrifted).toEqual([])   // already reported under its own key, like skippedDirty
  })

  it('a verified note whose cited paths NO commit touched since the stamp is reverified', async () => {
    const dir = repo()
    const audited = head(dir)
    writeFileSync(path.join(dir, 'sibling.ts'), 's2\n')
    run(dir, 'add', '-A'); run(dir, 'commit', '-qm', 'a sibling commit elsewhere') // moves HEAD, not a.ts
    writeFileSync(path.join(dir, 'other.ts'), 'o\n')
    const built = build(dir, {
      paths: ['other.ts'],
      verified: [{ id: 'area-x', scope: 'project', paths: ['a.ts'], stampRevision: audited }],
    })
    const r = await built.commit('feat: other')
    expect(r.isError).toBe(false)
    const o = recordOf(r.output)
    expect(built.restated.map(s => s.id)).toEqual(['area-x'])
    expect(o.reverified).toEqual([{ id: 'area-x', scope: 'project' }])
    expect(o.reverifyStale).toEqual([])
  })

  it('an unreachable stamp revision is stale — an unanswerable question mints no stamp', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const built = build(dir, {
      paths: ['a.ts'],
      verified: [{ id: 'area-x', scope: 'project', paths: ['a.ts'], stampRevision: '0'.repeat(40) }],
    })
    const r = await built.commit('feat: change a')
    expect(r.isError).toBe(false)
    const o = recordOf(r.output)
    expect(built.restated).toEqual([])
    expect(o.reverifyStale).toEqual([{ id: 'area-x', scope: 'project' }])
  })

  it('a note both HEALED and stale-verified keeps its restamp — only the verification is refused', async () => {
    const dir = repo()
    const audited = head(dir)
    writeFileSync(path.join(dir, 'a.ts'), 'a2-sibling\n')
    run(dir, 'add', '-A'); run(dir, 'commit', '-qm', 'sibling changes a.ts')
    writeFileSync(path.join(dir, 'other.ts'), 'o\n')
    const built = build(dir, {
      paths: ['other.ts'],
      notes: [{ id: 'area-x', scope: 'project', paths: ['a.ts'], preexisting: true }],
      verified: [{ id: 'area-x', scope: 'project', paths: ['a.ts'], stampRevision: audited }],
    })
    const r = await built.commit('feat: other')
    const o = recordOf(r.output)
    // the heal rewrote the prose against the tree in front of it — that is a different claim from
    // the auditor's, and the gate that refuses the stale verification must not touch it
    expect(o.restamped).toEqual([{ id: 'area-x', scope: 'project' }])
    expect(o.reverified).toEqual([])
    expect(o.reverifyStale).toEqual([{ id: 'area-x', scope: 'project' }])
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

describe('restamp truthfulness', () => {
  it('restamps exactly the touched notes whose paths are clean after the commit', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    writeFileSync(path.join(dir, 'sibling.ts'), 's2\n') // stays dirty
    const built = build(dir, {
      paths: ['a.ts'],
      notes: [
        { id: 'area-a', scope: 'project', paths: ['a.ts'] },
        { id: 'area-sib', scope: 'project', paths: ['sibling.ts'] },
      ],
    })
    const r = await built.commit('feat: change a')
    const o = recordOf(r.output)
    expect(built.stamped).toEqual([{ id: 'area-a', scope: 'project', key: 'rt1:restamp:project:area-a' }])
    expect(o.restamped).toEqual([{ id: 'area-a', scope: 'project' }])
    expect(o.skippedDirty).toEqual([{ id: 'area-sib', scope: 'project', dirtyPaths: ['sibling.ts'] }])
  })

  it('an UNTRACKED declared path is dirty — uncommitted content must never stamp clean', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    writeFileSync(path.join(dir, 'gen.ts'), 'exec-generated\n') // exists, never committed, not in floor
    const built = build(dir, {
      paths: ['a.ts'],
      notes: [{ id: 'area-gen', scope: 'project', paths: ['gen.ts'] }],
    })
    const r = await built.commit('feat: change a')
    const o = recordOf(r.output)
    expect(built.stamped).toEqual([])
    expect(o.restamped).toEqual([])
    expect(o.skippedDirty).toEqual([{ id: 'area-gen', scope: 'project', dirtyPaths: ['gen.ts'] }])
  })

  it('a declared path with no content at HEAD (typo, never existed) is never stamped', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    const built = build(dir, {
      paths: ['a.ts'],
      notes: [{ id: 'area-typo', scope: 'project', paths: ['no/such/file.ts'] }],
    })
    const r = await built.commit('feat: change a')
    const o = recordOf(r.output)
    expect(built.stamped).toEqual([])
    expect(o.skippedDirty).toEqual([{ id: 'area-typo', scope: 'project', dirtyPaths: ['no/such/file.ts'] }])
  })

  it('a declared DIRECTORY (trailing slash included) is covered by its committed contents', async () => {
    const dir = repo()
    run(dir, '-c', 'core.quotePath=false', 'mv', 'a.ts', 'a.moved') // keep tree simple: use a subdir instead
    const sub = path.join(dir, 'src'); Bun.spawnSync(['mkdir', '-p', sub])
    writeFileSync(path.join(sub, 'x.ts'), 'x\n')
    const built = build(dir, {
      paths: ['src/x.ts'],
      notes: [{ id: 'area-src', scope: 'project', paths: ['src/'] }],
    })
    const r = await built.commit('feat: add src')
    expect(r.isError).toBe(false)
    expect(built.stamped.map(s => s.id)).toEqual(['area-src'])
  })

  it('declared paths are LITERAL: a glob string matches nothing but itself', async () => {
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

  it('one throwing restamp write never masks the created commit', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')
    writeFileSync(path.join(dir, 'sibling.ts'), 's2\n')
    run(dir, 'add', '--', 'sibling.ts'); run(dir, 'commit', '-qm', 'sibling landed') // both notes' paths clean after our commit
    const stampedOk: string[] = []
    const r = await build(dir, {
      paths: ['a.ts'],
      notes: [
        { id: 'area-throws', scope: 'project', paths: ['sibling.ts'] },
        { id: 'area-ok', scope: 'project', paths: ['a.ts'] },
      ],
      restamp: async note => {
        if (note.id === 'area-throws') throw new Error('surreal hiccup')
        stampedOk.push(note.id)
      },
    }).commit('feat: change a')
    expect(r.isError).toBe(false) // the commit EXISTS — reporting failure would be a lie
    const o = recordOf(r.output)
    expect(o.created).toBe(true)
    expect(o.restamped).toEqual([{ id: 'area-ok', scope: 'project' }])
    expect(o.restampFailed).toEqual([{ id: 'area-throws', scope: 'project', error: 'surreal hiccup' }])
    expect(stampedOk).toEqual(['area-ok'])
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
