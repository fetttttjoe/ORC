import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  CHECKS_EXECUTOR_REF, EVENT_KIND, checkCommandsOf, SIGNAL_OUTCOME, UNIFIED_EVENT_TYPE,
  type AgentExecutor, type EventDraft, type ExecutorContext, type Signal, type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { commandArgv } from './command-argv'
import { COMMAND_TIMEOUT_MS, killedAtCeiling, runCommand, type CommandResult } from './run-command'

const TAIL_CHARS = 2_000
const CANCEL_POLL_MS = 2_000
const LOG_DIR = path.join('.orc', 'checks')
const CHECK_TOOL_NAME = 'check'
export const NO_CHECKS_SUMMARY = 'no checks configured'
const NOT_A_COMMAND_LIST = 'the step instructions are not a JSON list of commands'
const ITERATION = 1

interface CheckRun { command: string; startedAt: number; endedAt: number; result: CommandResult }

const passed = (c: CheckRun): boolean => !('failed' in c.result) && !('timedOut' in c.result) && c.result.exitCode === 0

const iso = (ms: number): string => new Date(ms).toISOString()

function verdictLine(c: CheckRun, timeoutMs: number): string {
  const took = `${((c.endedAt - c.startedAt) / 1000).toFixed(1)}s`
  if ('failed' in c.result) return `FAIL ${c.command} (did not run: ${c.result.error}, ${took})`
  if ('timedOut' in c.result) return `FAIL ${c.command} (hung, ${killedAtCeiling(timeoutMs)}, ${took})`
  return `${c.result.exitCode === 0 ? 'PASS' : 'FAIL'} ${c.command} (exit ${c.result.exitCode}, ${took})`
}

function tailOf(c: CheckRun): string {
  if ('failed' in c.result) return c.result.error
  const streams = [c.result.stdout, c.result.stderr].filter(s => s.length > 0).join('\n')
  return streams.length > TAIL_CHARS ? streams.slice(-TAIL_CHARS) : streams
}

function summaryOf(runs: CheckRun[], timeoutMs: number): string {
  if (runs.length === 0) return NO_CHECKS_SUMMARY
  const failed = runs.filter(c => !passed(c))
  return [
    ...runs.map(c => verdictLine(c, timeoutMs)),
    ...failed.map(c => `\n--- ${c.command}${'failed' in c.result ? '' : ` (full output: ${c.result.logPath})`} ---\n${tailOf(c)}`),
  ].join('\n')
}

const outputOf = (c: CheckRun, timeoutMs: number): Record<string, unknown> => ({
  command: c.command,
  pass: passed(c),
  verdict: verdictLine(c, timeoutMs),
  startedAt: iso(c.startedAt),
  endedAt: iso(c.endedAt),
  ...('failed' in c.result ? {} : { logPath: c.result.logPath }),
  tail: tailOf(c),
})

const logPathOf = (command: string): string =>
  path.join(LOG_DIR, `${createHash('sha256').update(command).digest('hex').slice(0, 16)}.log`)

async function runAll(commands: string[], ctx: ExecutorContext<unknown>, timeoutMs: number, cancelPollMs: number): Promise<CheckRun[]> {
  const stop = new AbortController()
  const poll = setInterval(() => {
    void ctx.isCancelled?.().then(cancelled => { if (cancelled) stop.abort() }).catch(() => {})
  }, cancelPollMs)
  try {
    return await Promise.all(commands.map(command => runCheck(command, ctx.workspaceDir, timeoutMs, stop.signal)))
  } finally {
    clearInterval(poll)
  }
}

async function runCheck(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<CheckRun> {
  const startedAt = Date.now()
  const parsed = commandArgv(command)
  const result: CommandResult = parsed.error !== undefined
    ? { failed: true, error: parsed.error }
    : await runCommand({ argv: parsed.argv, command, cwd, timeoutMs, logPath: logPathOf(command), signal })
  return { command, startedAt, endedAt: Date.now(), result }
}

function notRun(instructions: string): CheckRun {
  const now = Date.now()
  return { command: instructions, startedAt: now, endedAt: now, result: { failed: true, error: NOT_A_COMMAND_LIST } }
}

/** Runs the operator's configured commands concurrently and reports a verdict — no model call. */
export function checksExecutor(timeoutMs: number = COMMAND_TIMEOUT_MS, cancelPollMs: number = CANCEL_POLL_MS): AgentExecutor<unknown> {
  return {
    id: CHECKS_EXECUTOR_REF,

    async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | string | undefined> {
      const base = { stepId: ctx.step.id, runToken: ctx.runToken }
      const commands = checkCommandsOf(ctx.step.instructions)
      const callId = (index: number): string => `${ctx.runToken}:check:${index}`
      const runs = await ctx.checkpoint(
        'checks',
        async () => commands === null ? [notRun(ctx.step.instructions)] : runAll(commands, ctx, timeoutMs, cancelPollMs),
        (rs): EventDraft[] => rs.flatMap((c, index) => [
          { kind: EVENT_KIND.tool_call, payload: { ...base, iteration: ITERATION, toolCallId: callId(index), toolName: CHECK_TOOL_NAME, input: { command: c.command } } },
          { kind: EVENT_KIND.tool_result, payload: { ...base, iteration: ITERATION, toolCallId: callId(index), toolName: CHECK_TOOL_NAME, output: outputOf(c, timeoutMs), isError: !passed(c) } },
        ]),
      )

      for (const [index, c] of runs.entries()) {
        yield { type: UNIFIED_EVENT_TYPE.tool_call, toolCallId: callId(index), toolName: CHECK_TOOL_NAME, input: { command: c.command } }
        yield { type: UNIFIED_EVENT_TYPE.tool_result, toolCallId: callId(index), toolName: CHECK_TOOL_NAME, output: outputOf(c, timeoutMs), isError: !passed(c) }
      }

      const signal: Signal = { ...base, outcome: SIGNAL_OUTCOME.success, summary: summaryOf(runs, timeoutMs) }
      await ctx.checkpoint('signal', async () => signal, (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { ...base, signal } }])
      yield { type: UNIFIED_EVENT_TYPE.signal, signal }
      yield { type: UNIFIED_EVENT_TYPE.done }
    },
  }
}
