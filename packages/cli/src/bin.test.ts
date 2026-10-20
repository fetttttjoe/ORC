import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORKSPACE_KIND } from '@orc/contracts'
import { grantExtensionTrust, IDENTITY_FILE } from '@orc/kernel'
import { createTestDb, testOrcConfig, tmpGitRepo } from '@orc/kernel/test-helpers'
import { DATABASE_UNREACHABLE, EXIT_CODE } from './exit'
import { openKernel } from './main'

const databases: Array<{ drop(): Promise<void> }> = []
afterAll(async () => { await Promise.all(databases.map(database => database.drop())) }, 30_000)

const BIN = fileURLToPath(new URL('./bin.ts', import.meta.url))

async function runBin(cwd: string, args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(['bun', BIN, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe('orc bin bootstrap', () => {
  it('shows root and subcommand help without a project or reachable database', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'orc-bin-help-'))
    const env = { ORC_DATABASE_URL: 'postgresql://postgres:orc@127.0.0.1:59999/orc' }

    for (const args of [['--help'], ['new', '--help'], ['help', 'new']]) {
      const result = await runBin(cwd, args, env)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Usage:')
      expect(result.stderr).toBe('')
    }
  }, 15_000)

  // silence means not an orc project; a line means orc is broken here
  it('a directory that is no orc project exits with its own code, not the generic failure', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'orc-bin-noproject-'))
    // an unreachable port: the refusal must come BEFORE any connection is attempted
    const result = await runBin(cwd, ['tasks'], { ORC_DATABASE_URL: 'postgresql://postgres:orc@127.0.0.1:59999/orc' })
    expect(result.exitCode).toBe(EXIT_CODE.noProject)
    expect(result.stderr).toContain('orc init')
    expect(result.stdout).toBe('')
  }, 15_000)

  it('formats validation errors as concise paths', async () => {
    const database = await createTestDb()
    databases.push(database)
    const cwd = mkdtempSync(path.join(tmpdir(), 'orc-bin-validation-'))
    const env = { ORC_DATABASE_URL: database.url }
    expect((await runBin(cwd, ['init', '--name', 'demo'], env)).exitCode).toBe(0)

    const result = await runBin(cwd, ['new', ''], env)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Too small')
    expect(result.stderr).toContain('at task.title')
    expect(result.stderr.trimStart().startsWith('[')).toBe(false)
  }, 30_000)

  it('drains delayed event hooks before a successful command exits', async () => {
    const database = await createTestDb()
    databases.push(database)
    const cwd = mkdtempSync(path.join(tmpdir(), 'orc-bin-hook-'))
    const env = { ORC_DATABASE_URL: database.url }
    expect((await runBin(cwd, ['init', '--name', 'demo'], env)).exitCode).toBe(0)

    const marker = path.join(cwd, 'hook-finished.txt')
    writeFileSync(path.join(cwd, 'slow-extension.ts'), `
export default {
  id: 'slow-hook',
  activate(api) {
    api.on('event_appended', async () => {
      await Bun.sleep(500)
      await Bun.write(${JSON.stringify(marker)}, 'finished')
    })
  },
}
`)
    // settings only — `orc init` writes identity to .orc/identity.json and never touches this file
    writeFileSync(path.join(cwd, '.orc', 'config.json'), JSON.stringify({ extensions: ['slow-extension.ts'] }))
    grantExtensionTrust('slow-extension.ts', cwd)

    const result = await runBin(cwd, ['new', 'hook task'], env)
    expect(result.exitCode).toBe(0)
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe('finished')
  }, 30_000)

  it('adopts the checkout it boots in as a workspace, once however many commands run there', async () => {
    const database = await createTestDb()
    databases.push(database)
    const { main } = tmpGitRepo()
    const env = { ORC_DATABASE_URL: database.url }
    expect((await runBin(main, ['init', '--name', 'demo'], env)).exitCode).toBe(0)
    // adoption is a boot-time fact: the second boot must find the first one's record
    expect((await runBin(main, ['tasks'], env)).exitCode).toBe(0)
    expect((await runBin(main, ['tasks'], env)).exitCode).toBe(0)

    const { projectId } = JSON.parse(readFileSync(path.join(main, '.orc', IDENTITY_FILE), 'utf8'))
    const { kernel, storage } = await openKernel(database.url, { projectId, config: testOrcConfig() })
    database.onClose(() => storage.close())
    const workspaces = await kernel.listWorkspaces()
    expect(workspaces.length).toBe(1)
    // no origin in a throwaway repo: the trunk falls back to DEFAULT_TRUNK, which `main` is on
    expect(workspaces[0]).toMatchObject({ cwd: realpathSync(main), kind: WORKSPACE_KIND.checkout, branch: 'main', onTrunk: true })
  }, 30_000)

  it('with the database unreachable, a kernel command fails as before and knowledge drift still answers from git blame', async () => {
    const database = await createTestDb()
    databases.push(database)
    const { main } = tmpGitRepo()
    expect((await runBin(main, ['init', '--name', 'demo'], { ORC_DATABASE_URL: database.url })).exitCode).toBe(0)
    const downUrl = 'postgresql://postgres:orc@127.0.0.1:59999/orc'
    const down = { ORC_DATABASE_URL: downUrl }

    const tasks = await runBin(main, ['tasks'], down)
    expect(tasks.exitCode).toBe(EXIT_CODE.failure)
    expect(tasks.stderr).toContain(DATABASE_UNREACHABLE(downUrl))
    expect(tasks.stdout).toBe('')

    const drift = await runBin(main, ['knowledge', 'drift'], down)
    expect(drift.exitCode).toBe(0)
    expect(drift.stdout.split('\n')[0]).toContain('drift read without the event log (')
    expect(drift.stdout).toContain('clean 0 · suspect 0 · unknown 0 · unanchored 0')

    const stats = await runBin(main, ['knowledge', 'stats'], down)
    expect(stats.exitCode).toBe(EXIT_CODE.failure)
    expect(stats.stderr).toContain(DATABASE_UNREACHABLE(downUrl))

    for (const args of [['purge', 'demo', '--yes'], ['projects'], ['delete', 'demo', '--yes'], ['brief'], ['adr', 'ls'], ['ws', 'ls']]) {
      const result = await runBin(main, args, down)
      expect([args.join(' '), result.exitCode, result.stderr]).toEqual([args.join(' '), EXIT_CODE.failure, expect.stringContaining(DATABASE_UNREACHABLE(downUrl))])
    }
  }, 30_000)

  it('migrates a fresh database before project initialization', async () => {
    const database = await createTestDb({ migrate: false })
    databases.push(database)
    const cwd = mkdtempSync(path.join(tmpdir(), 'orc-bin-migrate-'))
    const env = { ORC_DATABASE_URL: database.url }

    const migrated = await runBin(cwd, ['db', 'migrate'], env)
    expect(migrated).toMatchObject({ exitCode: 0, stderr: '' })
    expect(migrated.stdout).toContain('database migrated')

    expect((await runBin(cwd, ['init', '--name', 'demo'], env)).exitCode).toBe(0)
    const tasks = await runBin(cwd, ['tasks'], env)
    expect(tasks.exitCode).toBe(0)
    expect(tasks.stdout).toContain('_no tasks_')
    expect(tasks.stderr).not.toContain('database schema is behind')
  }, 30_000)
})
