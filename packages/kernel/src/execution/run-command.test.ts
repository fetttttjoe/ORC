import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCommand, type CommandExited, type CommandResult, type CommandTimedOut } from './run-command'

const dirs: string[] = []
const ws = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-run-command-'))
  dirs.push(dir)
  return dir
}
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

const LOG_PATH = path.join('.orc', 'exec', 'run.log')

const exited = (r: CommandResult): CommandExited => {
  if ('failed' in r || 'timedOut' in r) throw new Error(`expected a normal exit, got ${JSON.stringify(r)}`)
  return r
}
const timedOut = (r: CommandResult): CommandTimedOut => {
  if (!('timedOut' in r)) throw new Error(`expected a timed-out run, got ${JSON.stringify(r)}`)
  return r
}

const run = (argv: string[], cwd: string, timeoutMs = 30_000): Promise<CommandResult> =>
  runCommand({ argv, command: argv.join(' '), cwd, timeoutMs, logPath: LOG_PATH })

describe('runCommand', () => {
  it('kills a child that ignores SIGTERM at the ceiling and reports what it printed', async () => {
    const dir = ws()
    writeFileSync(path.join(dir, 'stubborn.sh'), "trap '' TERM\necho PRINTED_BEFORE_HANG\nsleep 30\n")
    const out = timedOut(await run(['sh', 'stubborn.sh'], dir, 300))
    expect(out.stdout).toContain('PRINTED_BEFORE_HANG')
    expect(out.error.toLowerCase()).toContain('hang')
    expect(out.error).toContain('0.3s ceiling')
    const log = readFileSync(path.join(dir, out.logPath), 'utf8')
    expect(log).toContain('killed at the 0.3s ceiling')
    expect(log).toContain('PRINTED_BEFORE_HANG')
  }, 20_000)

  it('clips a long stream keeping the head AND the tail, with the full output in the log', async () => {
    const dir = ws()
    const out = exited(await run(['seq', '1', '100000'], dir))
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('chars omitted')
    expect(out.stdout.startsWith('1\n')).toBe(true)
    expect(out.stdout.trimEnd().endsWith('100000')).toBe(true)
    expect(readFileSync(path.join(dir, out.logPath), 'utf8')).toContain('\n50000\n')
  }, 15_000)

  it('reports a non-zero exit with its code and output instead of throwing', async () => {
    const dir = ws()
    const out = exited(await run(['ls', 'no-such-file-here'], dir))
    expect(out.exitCode).not.toBe(0)
    expect(out.stderr).toContain('no-such-file-here')
    expect(readFileSync(path.join(dir, out.logPath), 'utf8')).toContain(`exit ${out.exitCode}`)
  }, 15_000)
})
