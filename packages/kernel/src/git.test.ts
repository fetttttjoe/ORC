import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { branchDelete, currentBranch, defaultBranch, dirtyPaths, gitDirs, gitToplevel, isAncestor, isClean, MERGE_REFUSAL, mergeBranch, revParse, worktreeAdd, worktreeRemove } from './git'
import { sh, tmpGitRepo } from './test-helpers'

// real git, like every case in this file: the assertions are about what git actually does
const branches = (repo: string): string[] => {
  const r = Bun.spawnSync(['git', '-C', repo, 'branch', '--format=%(refname:short)'], { stdout: 'pipe', stderr: 'pipe' })
  return new TextDecoder().decode(r.stdout).split('\n').filter(l => l !== '')
}

describe('gitDirs', () => {
  it('names the shared .git for a main checkout, a linked worktree, and a subdirectory of that worktree', () => {
    const { main, worktree } = tmpGitRepo()
    const sharedGit = path.join(main, '.git')

    const mainDirs = gitDirs(main)
    expect(path.resolve(main, mainDirs?.gitDir ?? '')).toBe(sharedGit)
    expect(path.resolve(main, mainDirs?.commonDir ?? '')).toBe(sharedGit)

    const wtDirs = gitDirs(worktree)
    expect(path.resolve(worktree, wtDirs?.commonDir ?? '')).toBe(sharedGit)
    expect(path.resolve(worktree, wtDirs?.gitDir ?? '')).toContain(path.join(sharedGit, 'worktrees'))

    // git prints these relative to the QUERIED directory, not the worktree root
    const sub = path.join(worktree, 'sub')
    mkdirSync(sub)
    const subDirs = gitDirs(sub)
    expect(path.resolve(sub, subDirs?.gitDir ?? '')).toBe(path.resolve(worktree, wtDirs?.gitDir ?? ''))
    expect(path.resolve(sub, subDirs?.commonDir ?? '')).toBe(sharedGit)
  })

  it('returns null outside a repository', () => {
    expect(gitDirs(mkdtempSync(path.join(tmpdir(), 'orc-nogit-')))).toBeNull()
  })
})

describe('checkout facts and worktree lifecycle', () => {
  it('currentBranch names the branch; isClean flips on an untracked file', () => {
    const { main, worktree } = tmpGitRepo()
    expect(currentBranch(main)).toBe('main')
    expect(currentBranch(worktree)).toBe('feature')
    expect(isClean(worktree)).toBe(true)
    writeFileSync(path.join(worktree, 'dirty.txt'), 'x')
    expect(isClean(worktree)).toBe(false)
    expect(isClean(mkdtempSync(path.join(tmpdir(), 'orc-nogit-')))).toBeNull()
  })

  it('worktreeAdd creates a branch off base at dest; remove refuses a dirty tree and succeeds on a clean one', () => {
    const { main } = tmpGitRepo()
    const dest = path.join(main, '.orc', 'worktrees', 'req-1')
    expect(worktreeAdd(main, dest, 'orc/req-1', 'main')).toEqual({ ok: true })
    expect(currentBranch(dest)).toBe('orc/req-1')
    writeFileSync(path.join(dest, 'wip'), 'x')
    const refused = worktreeRemove(main, dest)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toContain('wip')
    rmSync(path.join(dest, 'wip'))
    expect(worktreeRemove(main, dest)).toEqual({ ok: true })
    expect(existsSync(dest)).toBe(false)
  })

  it('branchDelete removes the branch a rolled-back worktree left behind, and reports git\'s refusal', () => {
    const { main } = tmpGitRepo()
    const dest = path.join(main, '.orc', 'worktrees', 'req-2')
    expect(worktreeAdd(main, dest, 'orc/req-2', 'main')).toEqual({ ok: true })
    // remove the worktree BEFORE the branch, or the branch survives with nothing pointing at it
    expect(branchDelete(main, 'orc/req-2').ok).toBe(false)
    expect(worktreeRemove(main, dest)).toEqual({ ok: true })
    expect(branchDelete(main, 'orc/req-2')).toEqual({ ok: true })
    expect(branches(main)).not.toContain('orc/req-2')
    // deleting what is gone fails with git's own message, never a silent ok
    expect(branchDelete(main, 'orc/req-2').ok).toBe(false)
  })

  it('worktreeAdd reports git\'s own error when the branch already exists', () => {
    const { main } = tmpGitRepo()
    const r = worktreeAdd(main, path.join(main, '.orc', 'worktrees', 'dup'), 'feature', 'main')
    expect(r.ok).toBe(false)
  })
})

describe('gitToplevel', () => {
  it('answers the checkout root from a subdirectory, the WORKTREE root inside a worktree, and null outside git', () => {
    const { main, worktree } = tmpGitRepo()
    const sub = path.join(main, 'apps', 'x')
    mkdirSync(sub, { recursive: true })
    // realpath both sides: git prints the resolved path, and a tmpdir may be a symlink
    expect(gitToplevel(sub)).toBe(realpathSync(main))
    // a linked worktree is its own toplevel — the directory being worked in, not the main checkout
    expect(gitToplevel(worktree)).toBe(realpathSync(worktree))
    expect(gitToplevel(mkdtempSync(path.join(tmpdir(), 'orc-nogit-')))).toBeNull()
  })
})

describe('merging a workspace branch into trunk', () => {
  it('mergeBranch lands the branch as one merge commit, isAncestor then reports the tip merged, and a second merge has nothing to record', () => {
    const { main, worktree } = tmpGitRepo()
    writeFileSync(path.join(worktree, 'f.txt'), 'x')
    sh(worktree, 'add', 'f.txt')
    sh(worktree, 'commit', '-q', '-m', 'f')
    const tip = sh(worktree, 'rev-parse', 'HEAD')
    expect(isAncestor(main, tip, 'main')).toBe(false)

    const r = mergeBranch(main, 'feature', 'main')
    if (!r.ok) throw new Error(r.error)
    expect(isAncestor(main, tip, 'main')).toBe(true)
    expect(existsSync(path.join(main, 'f.txt'))).toBe(true)
    expect(revParse(main, 'HEAD')).toBe(r.mergeCommit)
    // --no-ff: the landing is its OWN commit, one addressable point on trunk
    expect(r.mergeCommit).not.toBe(tip)

    // a second merge of a merged branch exits 0 and commits NOTHING: HEAD would name the first
    const again = mergeBranch(main, 'feature', 'main')
    expect(again.ok).toBe(false)
    if (!again.ok) {
      expect(again.error).toContain('already contained')
      // the REASON, not the sentence: callers branch on it and the wording will improve
      expect(again.reason).toBe(MERGE_REFUSAL.alreadyContained)
    }
  })

  it('mergeBranch refuses a dirty trunk naming the file, a checkout that is not on trunk, a detached HEAD, and a non-repository', () => {
    const { main, worktree } = tmpGitRepo()
    writeFileSync(path.join(main, 'dirty'), 'x')
    const dirty = mergeBranch(main, 'feature', 'main')
    expect(dirty.ok).toBe(false)
    if (!dirty.ok) {
      expect(dirty.error).toContain('dirty')
      expect(dirty.reason).toBe(MERGE_REFUSAL.dirty)
    }
    rmSync(path.join(main, 'dirty'))
    // the linked worktree is on `feature`, so it is not the checkout `main` can be merged in
    const wrong = mergeBranch(worktree, 'feature', 'main')
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) {
      expect(wrong.error).toContain('feature')
      expect(wrong.reason).toBe(MERGE_REFUSAL.wrongBranch)
    }
    // detached HEAD: currentBranch answers null, and a refusal must not read 'is on null'
    sh(main, 'checkout', '--detach', '--quiet')
    const detached = mergeBranch(main, 'feature', 'main')
    expect(detached.ok).toBe(false)
    if (!detached.ok) {
      expect(detached.error).toContain('a detached HEAD')
      expect(detached.reason).toBe(MERGE_REFUSAL.wrongBranch)
    }
    const outside = mergeBranch(mkdtempSync(path.join(tmpdir(), 'orc-nogit-')), 'feature', 'main')
    expect(outside.ok).toBe(false)
    if (!outside.ok) expect(outside.reason).toBe(MERGE_REFUSAL.notRepo)
  })

  it('dirtyPaths names what isClean only counts, and tells "gone" apart from "clean"', () => {
    const { main } = tmpGitRepo()
    expect(dirtyPaths(main)).toBe('')
    writeFileSync(path.join(main, 'wip.txt'), 'x')
    expect(dirtyPaths(main)).toContain('wip.txt')
    expect(isClean(main)).toBe(false)
    // null, not '': a removed checkout must be told apart from a clean one
    expect(dirtyPaths(mkdtempSync(path.join(tmpdir(), 'orc-nogit-')))).toBeNull()
  })

  it('mergeBranch hands back git\'s conflict report and leaves the half-merged tree alone', () => {
    const { main, worktree } = tmpGitRepo()
    writeFileSync(path.join(worktree, 'README'), 'theirs\n')
    sh(worktree, 'commit', '-q', '-am', 'theirs')
    writeFileSync(path.join(main, 'README'), 'ours\n')
    sh(main, 'commit', '-q', '-am', 'ours')
    const r = mergeBranch(main, 'feature', 'main')
    expect(r.ok).toBe(false)
    // a conflict prints to STDOUT with stderr EMPTY: a stderr-only refusal would be blank
    if (!r.ok) {
      expect(r.error).toContain('CONFLICT')
      expect(r.error).toContain('merge --abort')
      expect(r.reason).toBe(MERGE_REFUSAL.conflict)
    }
    // never aborted behind the operator's back: the resolution (or the abort) is theirs to make
    expect(isClean(main)).toBe(false)
    expect(existsSync(path.join(main, '.git', 'MERGE_HEAD'))).toBe(true)

    // a mid-merge tree's way out is to finish or abandon the merge, not to commit it blind
    const during = mergeBranch(main, 'feature', 'main')
    expect(during.ok).toBe(false)
    if (!during.ok) {
      expect(during.reason).toBe(MERGE_REFUSAL.mergeInProgress)
      expect(during.error).toContain('merge is already in progress')
      expect(during.error).toContain('merge --abort')
    }
  })

  it('isAncestor and revParse answer null for an unknown ref and outside a repository', () => {
    const { main } = tmpGitRepo()
    const nogit = mkdtempSync(path.join(tmpdir(), 'orc-nogit-'))
    const head = revParse(main, 'main')
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(revParse(main, 'no-such-branch')).toBeNull()
    expect(revParse(nogit, 'HEAD')).toBeNull()
    expect(isAncestor(main, head ?? '', 'main')).toBe(true) // a commit is its own ancestor
    // exit 1 is 'no', anything else 'cannot tell': an unknown branch is not merely unmerged
    expect(isAncestor(main, 'no-such-branch', 'main')).toBeNull()
    expect(isAncestor(main, head ?? '', 'no-such-branch')).toBeNull()
    expect(isAncestor(nogit, 'HEAD', 'main')).toBeNull()
  })
})

describe('defaultBranch', () => {
  it('is null with no origin/HEAD set, and reads the captured trunk name once it is', () => {
    const { main } = tmpGitRepo()
    expect(defaultBranch(main)).toBeNull()
    // the ref target need not exist for symbolic-ref --short; this repo has no origin remote
    const r = Bun.spawnSync(['git', '-C', main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    expect(r.exitCode).toBe(0)
    expect(defaultBranch(main)).toBe('main')
  })

  it('is null outside a repository', () => {
    expect(defaultBranch(mkdtempSync(path.join(tmpdir(), 'orc-nogit-')))).toBeNull()
  })
})
