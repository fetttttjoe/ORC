import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import { initializeProject, loadConfig, requireProject } from '@orc/kernel'
import { tmpGitRepo } from '@orc/kernel/test-helpers'
import { servePidFile, serveLogFile } from './serve-paths'

describe('project-scoped files live in the main checkout', () => {
  it('pid file and serve log resolve under projectRoot from a worktree', () => {
    const { main, worktree } = tmpGitRepo()
    initializeProject(main, 'p')
    const c = requireProject(loadConfig(worktree))
    expect(servePidFile(c.projectRoot)).toBe(path.join(main, '.orc', 'serve.pid'))
    expect(serveLogFile(c)).toBe(path.join(main, '.orc', 'serve.log'))
  })
})
