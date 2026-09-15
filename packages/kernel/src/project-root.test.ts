import { describe, expect, it } from 'bun:test'
import { resolveProjectRoot } from './project-root'

describe('resolveProjectRoot', () => {
  it('a main checkout (--git-dir equals --git-common-dir) is its own root', () => {
    expect(resolveProjectRoot('/repo', { gitDir: '.git', commonDir: '.git' })).toBe('/repo')
  })

  it('a subdirectory of a main checkout is NOT re-rooted — both dirs still name the same .git', () => {
    expect(resolveProjectRoot('/repo/packages/cli', { gitDir: '/repo/.git', commonDir: '/repo/.git' })).toBe('/repo/packages/cli')
  })

  it('a linked worktree resolves to the parent of the shared --git-common-dir', () => {
    expect(resolveProjectRoot('/wt/feature', { gitDir: '/repo/.git/worktrees/wt', commonDir: '/repo/.git' })).toBe('/repo')
    // git may print both relative to the queried dir
    expect(resolveProjectRoot('/wt/feature', { gitDir: '../../repo/.git/worktrees/wt', commonDir: '../../repo/.git' })).toBe('/repo')
  })

  it('a subdirectory of a worktree still resolves to the repo root', () => {
    expect(resolveProjectRoot('/wt/feature/packages/cli', { gitDir: '/repo/.git/worktrees/feature', commonDir: '/repo/.git' })).toBe('/repo')
  })

  it('outside git (null) the dir is its own root', () => {
    expect(resolveProjectRoot('/plain', null)).toBe('/plain')
  })

  it('a submodule (--git-dir under .git/modules, equal to --git-common-dir) is its own root', () => {
    // equal, so the rule leaves it alone: re-rooting a submodule at its superproject would
    // silently merge two projects
    expect(resolveProjectRoot('/super/lib', { gitDir: '/super/.git/modules/lib', commonDir: '/super/.git/modules/lib' })).toBe('/super/lib')
  })

  it('a bare repo (--git-dir is "." — the repo dir itself) is its own root', () => {
    expect(resolveProjectRoot('/srv/repo.git', { gitDir: '.', commonDir: '.' })).toBe('/srv/repo.git')
  })
})
