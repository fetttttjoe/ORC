import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  EVENT_KIND, MemoryWrittenPayload, SIGNAL_OUTCOME,
  type AgentExecutor, type EventDraft, type ExecutorContext, type ResolvedTool,
  type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { createMemory } from '@orc/memory'
import { createTestSurreal } from '@orc/memory/test-helpers'
import { openStorage } from '../storage'
import { Kernel } from '../kernel'
import { createTestDb, fakeProvider, testConfig, TEST_PROJECT_ID } from '../test-helpers'
import { createDbosPort, type DbosPort } from './dbos-port'

// memory_read's tool output is `{ note: <full note | null> }` (tool output is contract-`unknown`).
// The note stays opaque — it round-trips into a recorded event untouched; only its title is read
// for the reuse summary, parsed on its own.
const ReadOutput = z.object({ note: z.unknown() })
const NoteTitle = z.object({ title: z.string() })

const NOTE_ID = 'finding-x'
const NOTE = { id: NOTE_ID, title: 'Finding X', summary: 'a durable finding', body: 'the full write-up' }

// Step A writes a note via the injected memory_write tool; step B (dependsOn A) polls
// memory_read for it — proving reuse across the eventually-consistent SurrealDB projection.
function memoryExecutor(): AgentExecutor<unknown> {
  return {
    id: 'memory-fake',
    async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
      const base = { stepId: ctx.step.id, runToken: ctx.runToken }
      const tool = (name: string): ResolvedTool => {
        const t = ctx.extraTools.find(x => x.name === name)
        if (!t) throw new Error(`no '${name}' tool injected`)
        return t
      }

      if (ctx.step.id === 's1') {
        const write = tool('memory_write')
        const r = await ctx.checkpoint('tools:write', () => write.execute(NOTE), (r): EventDraft[] => [
          { kind: EVENT_KIND.tool_call, payload: { ...base, iteration: 1, toolCallId: 'c1', toolName: 'memory_write', input: NOTE } },
          { kind: EVENT_KIND.tool_result, payload: { ...base, iteration: 1, toolCallId: 'c1', toolName: 'memory_write', output: r.output, isError: r.isError } },
        ])
        const signal = { ...base, outcome: r.isError ? SIGNAL_OUTCOME.failure : SIGNAL_OUTCOME.success, summary: r.isError ? 'write failed' : 'wrote finding-x' }
        await ctx.checkpoint('signal:1', async () => signal, (): EventDraft[] => [
          { kind: EVENT_KIND.signal_received, payload: { ...base, signal } },
        ])
        yield { type: 'signal', signal }
        yield { type: 'done' }
        return
      }

      // step B: the memory projector applies memory_written asynchronously — poll a few
      // times with a short delay until the note materializes (or give up and fail, which
      // would prove the reuse path broken).
      const read = tool('memory_read')
      const found = await ctx.checkpoint('tools:read', async () => {
        for (let i = 0; i < 20; i++) {
          const r = await read.execute({ id: NOTE_ID })
          const parsed = ReadOutput.safeParse(r.output)
          const note = parsed.success ? (parsed.data.note ?? null) : null
          if (note) return { note, isError: r.isError }
          await Bun.sleep(100)
        }
        return { note: null, isError: false }
      }, (r): EventDraft[] => [
        { kind: EVENT_KIND.tool_call, payload: { ...base, iteration: 1, toolCallId: 'c2', toolName: 'memory_read', input: { id: NOTE_ID } } },
        { kind: EVENT_KIND.tool_result, payload: { ...base, iteration: 1, toolCallId: 'c2', toolName: 'memory_read', output: { note: r.note }, isError: r.isError } },
      ])
      const signal = found.note
        ? { ...base, outcome: SIGNAL_OUTCOME.success, summary: `read back: ${NoteTitle.parse(found.note).title}` }
        : { ...base, outcome: SIGNAL_OUTCOME.failure, summary: 'finding-x never appeared' }
      await ctx.checkpoint('signal:1', async () => signal, (): EventDraft[] => [
        { kind: EVENT_KIND.signal_received, payload: { ...base, signal } },
      ])
      yield { type: 'signal', signal }
      yield { type: 'done' }
    },
  }
}

describe('memory reuse over a real run (e2e): step B reads step A\'s note', () => {
  it('step B reuses the note step A wrote', async () => {
    // generous: DB/DBOS bring-up + step B's up-to-2s eventual-consistency poll exceed the 5s default
    const pg = await createTestDb()
    const ts = await createTestSurreal()
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-memory-e2e-'))
    const storage = await openStorage(pg.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    const kernel = new Kernel(log)
    const config = testConfig(pg.url, {
      vaultDir,
      projectDbUrl: ts.url, projectDbNamespace: ts.ns, projectDbName: ts.db,
      projectDbUser: ts.username, projectDbPassword: ts.password,
    })
    const memory = await createMemory({ log, config })
    await memory.projector.start()
    const port: DbosPort = await createDbosPort({
      storage, config,
      providers: new Map([['fake', fakeProvider]]),
      executors: new Map([['memory-fake', memoryExecutor()]]),
      stepTools: p => memory.buildTools({
        source: 'agent', taskId: p.taskId, stepId: p.stepId, runToken: p.runToken,
        executor: p.executor, model: p.model, role: p.role,
      }),
    })
    await port.launch()

    try {
      const t = await kernel.createTask({ title: 'memory reuse e2e', spec: 'write then reuse a finding' })
      await kernel.proposePlan(t.id, draftFixture([
        stepFixture({ id: 's1', role: 'worker', executorRef: 'memory-fake', modelRef: 'fake/m' }),
        stepFixture({ id: 's2', role: 'worker', executorRef: 'memory-fake', modelRef: 'fake/m', dependsOn: ['s1'] }),
      ]))
      await kernel.approvePlan(t.id)

      const handle = await port.startRun(t.id)
      expect(await handle.wait()).toBe('done') // proves step B signaled success (i.e. it read the note)

      await Bun.sleep(200) // final projector flush window

      const events = await log.all()
      const written = events.find(e => e.kind === 'memory_written')
      expect(written).toBeDefined()
      expect(written!.taskId).toBeNull()
      const author = MemoryWrittenPayload.parse(written!.payload).author
      expect(author.executor).toBe('memory-fake')
      expect(author.role).toBe('worker')

      const stored = await memory.store.get(NOTE_ID)
      expect(stored?.title).toBe('Finding X')

      const notePath = path.join(vaultDir, 'memory', `${NOTE_ID}.md`)
      expect(existsSync(notePath)).toBe(true)
      expect(readFileSync(notePath, 'utf8')).toContain('type: memory')
    } finally {
      await memory.close()
      await port.shutdown()
      await log.close()
      rmSync(vaultDir, { recursive: true, force: true })
      await ts.drop()
      await pg.drop()
    }
  }, 20000)
})
