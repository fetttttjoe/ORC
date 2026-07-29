import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { COMMIT_STEP_ID, STEP_ROLE, type ResolvedTool } from '@orc/contracts'
import { commitTool, type RestampNote } from './commit-tool'

const run = (dir: string, ...args: string[]) => Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'ignore', stderr: 'ignore' })
const out = (dir: string, ...args: string[]) => Bun.spawnSync(['git', '-C', dir, '-c', 'core.quotePath=false', ...args], { stdout: 'pipe' }).stdout.toString().trim()
function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-commit-'))
  run(dir, 'init', '-q'); run(dir, 'config', 'user.email', 't@t.t'); run(dir, 'config', 'user.name', 't')
  writeFileSync(path.join(dir, 'a.ts'), 'a1\n')
  writeFileSync(path.join(dir, 'sibling.ts'), 's1\n')
  run(dir, 'add', '-A'); run(dir, 'commit', '-qm', 'base')
  return dir
}

const p: { taskId: string; stepId: string; role: string; runToken: string } =
  { taskId: 't1', stepId: COMMIT_STEP_ID, role: STEP_ROLE.committer, runToken: 'rt1' }
const changed = (...paths: string[]) => paths.map(path => ({ path, taskId: 't1', steps: [{ stepId: 's1', tool: 'fs_write', seq: 1 }] }))

function build(dir: string, opts: {
  paths?: string[]
  notes?: { id: string; scope: string; paths: string[] }[]
  restamp?: RestampNote | null
  p?: typeof p
}) {
  const stamped: { id: string; scope: string; key: string }[] = []
  const restamp: RestampNote | undefined = opts.restamp === null ? undefined
    : opts.restamp ?? (async (note, key) => { stamped.push({ ...note, key }) })
  const tools = commitTool({
    kernel: {
      listTaskChangedPaths: async () => changed(...(opts.paths ?? [])),
      listTaskNoteWrites: async () => opts.notes ?? [],
    },
    dir, restamp, p: opts.p ?? p,
  })
  const tool = (name: string): ResolvedTool => tools.find(t => t.name === name)!
  // the ordinary flow: read the diff, then commit — what every test not ABOUT the gate uses
  const commit = async (message: string) => {
    await tool('commit_preview').execute({})
    return tool('git_commit').execute({ message })
  }
  return { tools, tool, commit, stamped }
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
    const o = r.output as Record<string, unknown>
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
    expect(String((r.output as Record<string, unknown>).diff)).toContain('+n') // untracked file still previews
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
    expect((r.output as Record<string, unknown>).committedPaths).toEqual(['a.ts'])
    expect(out(dir, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.ts')
    expect(out(dir, 'status', '--porcelain')).toBe('M  sibling.ts') // still staged (M_ = staged modify), still theirs
  })
})

describe('git_commit', () => {
  it('commits ONLY the task-recorded paths; sibling work stays uncommitted', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'a.ts'), 'a2\n')          // this task's edit
    writeFileSync(path.join(dir, 'sibling.ts'), 's2\n')    // another task's edit, not in the floor
    const r = await build(dir, { paths: ['a.ts'] }).commit('feat: change a')
    expect(r.isError).toBe(false)
    const o = r.output as Record<string, unknown>
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
    expect((r.output as Record<string, unknown>).committedPaths).toEqual(['a.ts', 'new.ts'])
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
    const o = r.output as Record<string, unknown>
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
    expect((r.output as Record<string, unknown>).committedPaths).toEqual(['ümlaut.ts'])
    expect(out(dir, 'show', '--name-only', '--format=', 'HEAD')).toBe('ümlaut.ts')
  })

  it('nothing staged (already committed by a child, or a replay) is a success at current HEAD — restamp still runs', async () => {
    const dir = repo()
    const built = build(dir, { paths: ['a.ts'], notes: [{ id: 'area-a', scope: 'project', paths: ['a.ts'] }] })
    const r = await built.commit('feat: nothing new')
    expect(r.isError).toBe(false)
    const o = r.output as Record<string, unknown>
    expect(o.created).toBe(false)
    expect(o.commit).toBe(out(dir, 'rev-parse', 'HEAD'))
    expect(o.committedPaths).toEqual([])
    expect(built.stamped.map(s => s.id)).toEqual(['area-a'])
  })

  it('outside a git repository both tools error honestly', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-norepo-'))
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
    const o = r.output as Record<string, unknown>
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
    const o = r.output as Record<string, unknown>
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
    const o = r.output as Record<string, unknown>
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
    expect((r.output as Record<string, unknown>).committedPaths).toEqual(['a*.ts'])
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
    const o = r.output as Record<string, unknown>
    expect(o.created).toBe(true)
    expect(o.restamped).toEqual([{ id: 'area-ok', scope: 'project' }])
    expect(o.restampFailed).toEqual([{ id: 'area-throws', scope: 'project', error: 'surreal hiccup' }])
    expect(stampedOk).toEqual(['area-ok'])
  })
})
