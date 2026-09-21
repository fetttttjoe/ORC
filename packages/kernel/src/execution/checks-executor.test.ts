import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { CHECKS_EXECUTOR_REF, Door, EVENT_KIND, SignalOutcome, UnifiedEventType, type Checkpoint, type EventDraft, type ExecutorContext, type OperationCheckpoint, type UnifiedEvent } from '@orc/contracts'
import { stepFixture } from '@orc/contracts/fixtures'
import { NO_CHECKS_SUMMARY, checksExecutor } from './checks-executor'
import { COMMAND_CANCELLED } from './run-command'

const dirs: string[] = []
function workspace(scripts: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-checks-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(scripts)) writeFileSync(path.join(dir, name), body)
  return dir
}
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

const makeCheckpoint = (captured: EventDraft[]): Checkpoint => async (_name, fn, toEvents) => {
  const r = await fn()
  if (toEvents) captured.push(...toEvents(r))
  return r
}
const unusedOperation: OperationCheckpoint = async (_spec, fn) => fn(1)

function ctx(commands: string[], workspaceDir: string, captured: EventDraft[], instructions: string = JSON.stringify(commands)): ExecutorContext<unknown> {
  return {
    step: stepFixture({ id: 'checks', executorRef: CHECKS_EXECUTOR_REF, instructions }),
    taskSpec: 'the task',
    depOutputs: {},
    skills: [],
    extraTools: [],
    model: null,
    runToken: 'step:t1:checks:a1',
    origin: { chatId: 'run:t1:v1', door: Door.supervisor },
    workspaceDir,
    checkpoint: makeCheckpoint(captured),
    operation: unusedOperation,
    budgetRemainingUSD: async () => null,
  }
}

async function drain(gen: AsyncIterable<UnifiedEvent>): Promise<UnifiedEvent[]> {
  const out: UnifiedEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

const CheckOutput = z.object({ command: z.string(), pass: z.boolean(), verdict: z.string(), startedAt: z.string(), endedAt: z.string(), tail: z.string() })
type CheckOutput = z.infer<typeof CheckOutput>

const results = (events: UnifiedEvent[]): CheckOutput[] =>
  events.flatMap(e => e.type === UnifiedEventType.tool_result ? [CheckOutput.parse(e.output)] : [])

const signalOf = (events: UnifiedEvent[]) => {
  const ev = events.find(e => e.type === UnifiedEventType.signal)
  if (ev?.type !== UnifiedEventType.signal) throw new Error(`no signal in ${JSON.stringify(events.map(e => e.type))}`)
  return ev.signal
}

const SLOW_PASS = 'sleep 0.5\necho all-good\n'
const SLOW_FAIL = 'sleep 0.5\necho BOOM_IN_THE_TAIL 1>&2\nexit 3\n'

describe('checksExecutor', () => {
  it('runs every command concurrently and reports one PASS/FAIL line each', async () => {
    const dir = workspace({ 'ok.sh': SLOW_PASS, 'bad.sh': SLOW_FAIL })
    const captured: EventDraft[] = []
    const at = Date.now()
    const events = await drain(checksExecutor().startTurn(ctx(['sh ok.sh', 'sh bad.sh'], dir, captured)))
    const elapsed = Date.now() - at

    const [ok, bad] = results(events)
    if (!ok || !bad) throw new Error('expected two check results')
    expect(Date.parse(ok.startedAt)).toBeLessThan(Date.parse(bad.endedAt))
    expect(Date.parse(bad.startedAt)).toBeLessThan(Date.parse(ok.endedAt))
    expect(elapsed).toBeLessThan(900)

    const summary = signalOf(events).summary
    expect(summary).toContain('PASS sh ok.sh (exit 0,')
    expect(summary).toContain('FAIL sh bad.sh (exit 3,')
    expect(summary).toContain('BOOM_IN_THE_TAIL')
    expect(summary).not.toContain('all-good')
    expect(signalOf(events).outcome).toBe(SignalOutcome.success)
  }, 20_000)

  it('emits one tool_call/tool_result pair per command, in the log too', async () => {
    const dir = workspace()
    const captured: EventDraft[] = []
    const events = await drain(checksExecutor().startTurn(ctx(['true', 'true', 'true'], dir, captured)))
    expect(events.filter(e => e.type === UnifiedEventType.tool_call)).toHaveLength(3)
    expect(events.filter(e => e.type === UnifiedEventType.tool_result)).toHaveLength(3)
    expect(captured.filter(d => d.kind === EVENT_KIND.tool_call)).toHaveLength(3)
    expect(captured.filter(d => d.kind === EVENT_KIND.tool_result)).toHaveLength(3)
    expect(captured.filter(d => d.kind === EVENT_KIND.signal_received)).toHaveLength(1)
    expect(new Set(results(events).map(r => r.pass))).toEqual(new Set([true]))
  }, 20_000)

  it('reports a timed-out command as a FAIL that says it hung', async () => {
    const dir = workspace({ 'hang.sh': "trap '' TERM\nsleep 30\n" })
    const captured: EventDraft[] = []
    const events = await drain(checksExecutor(300).startTurn(ctx(['sh hang.sh'], dir, captured)))
    const summary = signalOf(events).summary
    expect(summary).toContain('FAIL sh hang.sh (hung,')
    expect(summary).toContain('0.3s ceiling')
    expect(signalOf(events).outcome).toBe(SignalOutcome.success)
  }, 20_000)

  it('stops its commands when the run is cancelled, and still reports them', async () => {
    const dir = workspace({ 'slow.sh': 'sleep 30\n' })
    const started = Date.now()
    const cancelled = { ...ctx(['sh slow.sh'], dir, []), isCancelled: async () => Date.now() - started > 200 }
    const events = await drain(checksExecutor(30_000, 50).startTurn(cancelled))
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(signalOf(events).summary).toContain(`FAIL sh slow.sh (did not run: ${COMMAND_CANCELLED}`)
  }, 20_000)

  it.each(['bun run typecheck', '{"a":1}', '["ok", 3]'])('reports instructions that are not a command list as a FAIL and still signals success: %s', async (instructions) => {
    const events = await drain(checksExecutor().startTurn(ctx([], workspace(), [], instructions)))
    const signal = signalOf(events)
    expect(signal.outcome).toBe(SignalOutcome.success)
    expect(signal.summary).toStartWith(`FAIL ${instructions} (did not run: `)
    expect(results(events).map(r => r.pass)).toEqual([false])
  })

  it('signals success with an empty verdict when no commands are configured', async () => {
    const captured: EventDraft[] = []
    const events = await drain(checksExecutor().startTurn(ctx([], workspace(), captured)))
    expect(results(events)).toEqual([])
    expect(signalOf(events).summary).toBe(NO_CHECKS_SUMMARY)
    expect(signalOf(events).outcome).toBe(SignalOutcome.success)
  })
})
