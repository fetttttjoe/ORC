import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { errorMessage } from '@orc/contracts'
import { childEnv } from './child-env'
import { clipMiddle } from './clip'

const KILL_GRACE_MS = 5_000 // SIGTERM → wait → SIGKILL, so a child that ignores SIGTERM still dies
const EXIT_FLUSH_MS = 250 // after 'exit', how long the streams get to flush before we settle
export const COMMAND_TIMEOUT_MS = 10 * 60_000
export const COMMAND_CANCELLED = 'the run was cancelled'
const CLIP_CHARS = 8_000 // per stream, head + tail: typecheck errors lead, test summaries trail
const MAX_BYTES = 64 * 1024 * 1024 // per stream, matches the old spawnSync maxBuffer

const clip = (s: string): string => clipMiddle(s, CLIP_CHARS)

export const killedAtCeiling = (ms: number): string => `killed at the ${ms / 1000}s ceiling`

const hangError = (ms: number): string =>
  `command HUNG and was ${killedAtCeiling(ms)} — it is not merely slow: the last lines of stdout/stderr name what never finished, and the full streams are in logPath. Re-running the same files with other flags hangs again; narrow to that one test or signal what you have.`

export interface CommandStreams { stdout: string; stderr: string; logPath: string }
export interface CommandExited extends CommandStreams { exitCode: number }
export interface CommandTimedOut extends CommandStreams { timedOut: true; error: string }
export interface CommandFailed { failed: true; error: string }
export type CommandResult = CommandExited | CommandTimedOut | CommandFailed

export function runCommand(opts: {
  argv: string[]
  command: string
  cwd: string
  timeoutMs: number
  logPath: string
  signal?: AbortSignal
}): Promise<CommandResult> {
  const { argv, command, cwd, timeoutMs, logPath, signal } = opts
  // async spawn: a synchronous wait would freeze every other step in this process
  return new Promise<CommandResult>(resolve => {
    let settled = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (r: CommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      if (graceTimer) clearTimeout(graceTimer)
      if (exitTimer) clearTimeout(exitTimer)
      signal?.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const [bin, ...rest] = argv
    if (bin === undefined) return finish({ failed: true, error: 'empty command' })
    const child = spawn(bin, rest, { cwd, env: childEnv(), detached: true })
    const killTree = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid === undefined) child.kill(sig)
        else process.kill(-child.pid, sig)
      } catch { /* the group is already gone */ }
    }
    function onAbort(): void {
      killTree('SIGKILL')
      finish({ failed: true, error: COMMAND_CANCELLED })
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    let stdout = '', stderr = '', timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', d => { if (stdout.length < MAX_BYTES) stdout += d })
    child.stderr.on('data', d => { if (stderr.length < MAX_BYTES) stderr += d })
    // an unhandled stream 'error' (EPIPE on SIGKILL) would crash the process
    const onStreamError = (e: Error): void => finish({ failed: true, error: errorMessage(e) })
    child.stdout.on('error', onStreamError)
    child.stderr.on('error', onStreamError)
    const killTimer = setTimeout(() => {
      timedOut = true
      killTree('SIGTERM')
      graceTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS)
    }, timeoutMs)
    child.on('error', e => finish({ failed: true, error: errorMessage(e) }))
    const report = (ending: { exitCode: number } | { killedAtCeiling: true }): CommandResult => {
      const killed = 'killedAtCeiling' in ending
      const status = killed ? killedAtCeiling(timeoutMs) : `exit ${ending.exitCode}`
      try {
        mkdirSync(path.dirname(path.join(cwd, logPath)), { recursive: true })
        writeFileSync(path.join(cwd, logPath), `$ ${command}\n${status}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`)
      } catch { /* advisory: losing the log must never fail the command it describes */ }
      const streams = { stdout: clip(stdout), stderr: clip(stderr), logPath }
      if (killed) return { timedOut: true, ...streams, error: hangError(timeoutMs) }
      return { exitCode: ending.exitCode, ...streams }
    }
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (timedOut) return finish(report({ killedAtCeiling: true }))
      // an external signal is a failure, not a timeout
      if (signal) return finish({ failed: true, error: `command killed by ${signal}` })
      finish(report({ exitCode: code ?? -1 }))
    }
    child.on('close', settle)
    // 'close' never fires while a grandchild holds the pipes; 'exit' is the process-level truth
    child.on('exit', (code, signal) => {
      exitTimer = setTimeout(() => settle(code, signal), EXIT_FLUSH_MS)
    })
  })
}
