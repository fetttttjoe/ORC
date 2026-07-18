import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ApprovalPolicy, EVENT_KIND, RUN_OUTCOME, SIGNAL_OUTCOME, TASK_STATUS,
  type AgentExecutor, type EventDraft, type ExecutorContext, type ResolvedTool,
  type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { createMemory } from '@orc/memory'
import { createTestSurreal } from '@orc/memory/test-helpers'
import { EventLog } from '../eventlog'
import { Kernel } from '../kernel'
import { createTestDb, fakeProvider, testConfig, TEST_PROJECT_ID } from '../test-helpers'
import { createDbosPort } from './dbos-port'
import { splitTool } from './split-tool'

// The 1-step child plan the parent proposes via task_split (dependsOn/skillRefs are required
// on ChildPlanStep — no zod default — so they are spelled out here).
const CHILD_PLAN = { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [] }] }
const CHILD_NOTE = { id: 'child-finding', title: 'CF', body: 'from the child' }

const waitFor = async (pred: () => Promise<boolean>, ms = 15_000): Promise<boolean> => {
  const start = Date.now()
  while (Date.now() - start < ms) { if (await pred()) return true; await Bun.sleep(50) }
  return false
}

// ONE scripted executor drives BOTH the parent step (s1) and the split child step (w1),
// branching on ctx.step.id — the child inherits executorRef='split-fake' at expansion.
// cfg.expectGated is what the parent asserts task_split returned; cfg.child selects the
// child's behavior. Assertions are encoded into the parent's success/failure signal
// (mirrors memory-reuse.test.ts: 'done' at the run level PROVES the encoded checks held).
function splitFake(cfg: { expectGated: boolean; child: 'write' | 'signal' | 'sleep'; foreignSplit?: boolean }): AgentExecutor<unknown> {
  return {
    id: 'split-fake',
    async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
      const base = { stepId: ctx.step.id, runToken: ctx.runToken }
      const tool = (name: string): ResolvedTool => {
        const t = ctx.extraTools.find(x => x.name === name)
        if (!t) throw new Error(`no '${name}' tool injected`)
        return t
      }
      // ---- CHILD step (w1) ----
      if (ctx.step.id === 'w1') {
        if (cfg.child === 'sleep') {
          // genuinely running until DBOS cancels the workflow (the next checkpoint throws).
          // ponytail: bounded at ~20s so a missed cancel can't wedge the suite; cancel lands <1s.
          for (let i = 0; i < 200; i++) await ctx.checkpoint(`wait:${i}`, async () => { await Bun.sleep(100); return null })
          const signal = { ...base, outcome: SIGNAL_OUTCOME.success, summary: 'child was never cancelled' }
          yield { type: 'signal', signal }
          yield { type: 'done' }
          return
        }
        if (cfg.child === 'write') {
          const write = tool('memory_write')
          const r = await ctx.checkpoint('tools:write', () => write.execute(CHILD_NOTE), (r): EventDraft[] => [
            { kind: EVENT_KIND.tool_call, payload: { ...base, iteration: 1, toolCallId: 'c1', toolName: 'memory_write', input: CHILD_NOTE } },
            { kind: EVENT_KIND.tool_result, payload: { ...base, iteration: 1, toolCallId: 'c1', toolName: 'memory_write', output: r.output, isError: r.isError } },
          ])
          const signal = { ...base, outcome: r.isError ? SIGNAL_OUTCOME.failure : SIGNAL_OUTCOME.success, summary: r.isError ? 'write failed' : 'wrote child-finding' }
          await ctx.checkpoint('signal:1', async () => signal, (): EventDraft[] => [
            { kind: EVENT_KIND.signal_received, payload: { ...base, signal } },
          ])
          yield { type: 'signal', signal }
          yield { type: 'done' }
          return
        }
        const signal = { ...base, outcome: SIGNAL_OUTCOME.success, summary: 'child ok' }
        await ctx.checkpoint('signal:1', async () => signal, (): EventDraft[] => [
          { kind: EVENT_KIND.signal_received, payload: { ...base, signal } },
        ])
        yield { type: 'signal', signal }
        yield { type: 'done' }
        return
      }

      // ---- PARENT step (s1): propose a split, gate on it, join the child ----
      const split = tool('task_split')
      const input = { title: 'child', spec: 'do child work', plan: CHILD_PLAN }
      const res = await ctx.checkpoint('tools:split', () => split.execute(input, 'call-1'), (r): EventDraft[] => [
        { kind: EVENT_KIND.tool_call, payload: { ...base, iteration: 1, toolCallId: 'call-1', toolName: 'task_split', input } },
        { kind: EVENT_KIND.tool_result, payload: { ...base, iteration: 1, toolCallId: 'call-1', toolName: 'task_split', output: r.output, isError: r.isError } },
      ])
      const out = res.output as { splitId: string; childTaskId: string; gated: boolean }
      const gatedOk = res.isError === false && out.gated === cfg.expectGated

      // yield the gate; the port resumes the generator with SplitResult[] once the child resolves.
      // a foreign id (not one of THIS attempt's splits) must be dropped, not recv-waited forever.
      const splitIds = cfg.foreignSplit ? [out.splitId, 'split:foreign:nope'] : [out.splitId]
      const results = yield { type: 'gate', splitIds, toolCallId: 'g1' }
      const r0 = results?.[0]

      // if the child wrote notes, read one back through the (eventually-consistent) memory store
      let readOk = true
      if (r0 && r0.outcome === RUN_OUTCOME.done && r0.notes.length > 0) {
        const read = tool('memory_read')
        const n = r0.notes[0]!
        const body = await ctx.checkpoint('tools:read', async () => {
          for (let i = 0; i < 20; i++) {
            const rr = await read.execute({ id: n.id, scope: n.scope })
            const note = (rr.output as { note: { body: string } | null }).note
            if (note) return note.body
            await Bun.sleep(100)
          }
          return null
        }, (b): EventDraft[] => [
          { kind: EVENT_KIND.tool_call, payload: { ...base, iteration: 2, toolCallId: 'c2', toolName: 'memory_read', input: { id: n.id, scope: n.scope } } },
          { kind: EVENT_KIND.tool_result, payload: { ...base, iteration: 2, toolCallId: 'c2', toolName: 'memory_read', output: { body: b }, isError: false } },
        ])
        readOk = body === CHILD_NOTE.body
      }

      const good = gatedOk && !!r0 && r0.outcome === RUN_OUTCOME.done && readOk
      const signal = { ...base, outcome: good ? SIGNAL_OUTCOME.success : SIGNAL_OUTCOME.failure, summary: good ? 'joined child' : 'join/read/gate mismatch' }
      await ctx.checkpoint('signal:1', async () => signal, (): EventDraft[] => [
        { kind: EVENT_KIND.signal_received, payload: { ...base, signal } },
      ])
      yield { type: 'signal', signal }
      yield { type: 'done' }
    },
  }
}

async function bringUp(policy: 'auto' | 'manual', executor: AgentExecutor<unknown>, over: { concurrency?: number } = {}) {
  const pg = await createTestDb()
  const ts = await createTestSurreal()
  const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-split-e2e-'))
  const log = await EventLog.open(pg.url, { projectId: TEST_PROJECT_ID })
  const kernel = new Kernel(log)
  const config = testConfig(pg.url, {
    vaultDir,
    projectDbUrl: ts.url, projectDbNamespace: ts.ns, projectDbName: ts.db,
    projectDbUser: ts.username, projectDbPassword: ts.password,
    approvalPolicy: ApprovalPolicy.parse({ default: policy }), maxDepth: 3, concurrency: over.concurrency ?? 3,
  })
  const memory = await createMemory({ log, config })
  await memory.projector.start()
  const port = await createDbosPort({
    log, config,
    providers: new Map([['fake', fakeProvider]]),
    executors: new Map([['split-fake', executor]]),
    stepTools: p => [
      ...memory.buildTools({ source: 'agent', taskId: p.taskId, stepId: p.stepId, runToken: p.runToken, executor: p.executor, model: p.model, role: p.role }),
      splitTool({ kernel, config: { approvalPolicy: config.approvalPolicy, maxDepth: config.maxDepth }, p }),
    ],
  })
  await port.launch()
  const cleanup = async (): Promise<void> => {
    await memory.close()
    await port.shutdown()
    await log.close()
    rmSync(vaultDir, { recursive: true, force: true })
    await ts.drop()
    await pg.drop()
  }
  return { kernel, log, port, cleanup }
}

const parentTask = async (kernel: Kernel): Promise<string> => {
  const t = await kernel.createTask({ title: 'split e2e', spec: 'spawn a child, gate, join' })
  await kernel.proposePlan(t.id, draftFixture([stepFixture({ id: 's1', role: 'worker', executorRef: 'split-fake', modelRef: 'fake/m' })]))
  await kernel.approvePlan(t.id)
  return t.id
}

describe('recursion e2e: split, gate, join, manual approve, queue partition', () => {
  it('(a) auto-approved split runs the full loop: propose → child runs → join → read back', async () => {
    const { kernel, log, port, cleanup } = await bringUp('auto', splitFake({ expectGated: false, child: 'write' }))
    try {
      const parentId = await parentTask(kernel)
      const childId = `${parentId}.s1.call-1`
      const handle = await port.startRun(parentId)
      expect(await handle.wait()).toBe('done') // proves gate!==true, join outcome=done, note round-tripped

      const events = await log.all()
      expect(events.some(e => e.kind === EVENT_KIND.split_proposed)).toBe(true)
      const resolved = events.find(e => e.kind === EVENT_KIND.split_resolved)
      expect(resolved).toBeDefined()
      expect(resolved!.payload).toMatchObject({ outcome: RUN_OUTCOME.done, notes: [{ id: 'child-finding', scope: 'project' }] })

      expect((await kernel.getTask(childId))?.status).toBe(TASK_STATUS.done)
      const approved = events.find(e => e.kind === EVENT_KIND.plan_approved && e.taskId === childId)
      expect((approved!.payload as { approvedBy: string }).approvedBy).toBe('policy')
    } finally {
      await cleanup()
    }
  }, 20_000)

  it('(b) manual gate: parent parks the child; a human approvePlan resumes the run to done', async () => {
    const { kernel, port, cleanup } = await bringUp('manual', splitFake({ expectGated: true, child: 'write' }))
    try {
      const parentId = await parentTask(kernel)
      const childId = `${parentId}.s1.call-1`
      const handle = await port.startRun(parentId)

      // the child is parked at awaiting_approval; nothing runs it until a human approves
      expect(await waitFor(async () => (await kernel.getTask(childId))?.status === TASK_STATUS.awaiting_approval, 10_000)).toBe(true)
      await kernel.approvePlan(childId) // router route 2 starts the child run — no other test-side action

      expect(await handle.wait()).toBe('done')
      expect((await kernel.getTask(childId))?.status).toBe(TASK_STATUS.done)
    } finally {
      await cleanup()
    }
  }, 20_000)

  it('(c) queue partition: a depth-0 parent gating on a depth-1 child completes at concurrency 1', async () => {
    // on a flat queue the gate-waiting parent holds the only slot and deadlocks its child;
    // depth-partitioned agents:0/agents:1 let both hold a slot, so it finishes.
    const { kernel, port, cleanup } = await bringUp('auto', splitFake({ expectGated: false, child: 'signal' }), { concurrency: 1 })
    try {
      const parentId = await parentTask(kernel)
      const handle = await port.startRun(parentId)
      expect(await handle.wait()).toBe('done')
    } finally {
      await cleanup()
    }
  }, 40_000)

  it('(d) cancel cascades to a RUNNING child: whole subtree cancelled, split resolves cancelled', async () => {
    const { kernel, log, port, cleanup } = await bringUp('auto', splitFake({ expectGated: false, child: 'sleep' }))
    try {
      const parentId = await parentTask(kernel)
      const childId = `${parentId}.s1.call-1`
      const handle = await port.startRun(parentId)

      // wait until the auto-approved child is genuinely running before cancelling the parent
      expect(await waitFor(async () => (await kernel.getTask(childId))?.status === TASK_STATUS.running, 15_000)).toBe(true)
      await port.cancelRun(parentId)
      await handle.wait().then(() => {}, () => {}) // a DBOS-cancelled workflow may resolve OR reject — both fine

      expect((await kernel.getTask(parentId))?.status).toBe(TASK_STATUS.cancelled)
      expect((await kernel.getTask(childId))?.status).toBe(TASK_STATUS.cancelled)
      // the live router resolves the still-pending split off the child's cancelled terminal status
      expect(await waitFor(async () =>
        (await log.all()).some(e => e.kind === EVENT_KIND.split_resolved && (e.payload as { outcome: string }).outcome === RUN_OUTCOME.cancelled),
      )).toBe(true)
    } finally {
      await cleanup()
    }
  }, 40_000)

  it('(e) gate drops a foreign splitId: run joins the real child, never wedges recv on the bogus id', async () => {
    // without the intersection guard the port recv-waits on split:split:foreign:nope forever and
    // this run never settles (timeout); with it, the foreign id is dropped and only the real split awaited.
    const { kernel, port, cleanup } = await bringUp('auto', splitFake({ expectGated: false, child: 'signal', foreignSplit: true }))
    try {
      const parentId = await parentTask(kernel)
      const handle = await port.startRun(parentId)
      expect(await handle.wait()).toBe('done')
    } finally {
      await cleanup()
    }
  }, 40_000)
})
