import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  EVENT_KIND, ISOLATION_TIER, LINK_KIND, NOTE_KIND, SIGNAL_OUTCOME, TASK_STATUS,
  type AgentExecutor, type Analyzer, type CoverageReport, type EventDraft, type ExecutorContext,
  type MemoryNoteDraft, type PlanStep, type ResolvedTool,
  type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { createMemory, tierForRole } from '@orc/memory'
import { createTestSurreal } from '@orc/memory/test-helpers'
import { openStorage } from '../storage'
import { Kernel } from '../kernel'
import { createTestDb, fakeProvider, testConfig, TEST_PROJECT_ID } from '../test-helpers'
import { createDbosPort, dbosSend } from './dbos-port'
import { finalizePlanTool } from './finalize-plan-tool'
import { readAnnotationsTool } from './read-annotations-tool'
import { splitTool } from './split-tool'
import { planScope } from './strategies/grounded-plan'

// The analyzer seam (Task 3): the kernel consumes ANY Analyzer; this test provides one whose
// analysisStep mirrors the real agent-analyzer's scout step verbatim (id 'analyze', role 'scout',
// executorRef 'api-loop', codebase-analysis skill) — the seam IS the interface, not a stub of it.
const testAnalyzer: Analyzer = {
  id: 'agent-analyzer',
  analysisStep: ({ modelRef }): PlanStep => ({
    id: 'analyze', role: 'scout', title: 'Analyze the codebase',
    instructions: 'Ground the plan per the codebase-analysis skill.',
    executorRef: 'api-loop', modelRef, skillRefs: ['codebase-analysis'], toolRefs: [],
    isolation: ISOLATION_TIER.local, zone: [], maxIterations: 15, dependsOn: [],
  }),
}

// The taskId (grounded task) / childTaskId is not on ExecutorContext, but the runToken is the
// step workflow id `step:<taskId>:<stepId>:aN` — the deterministic id the port builds. Parse it.
const taskIdOf = (runToken: string): string => runToken.split(':')[1]!

// ONE scripted executor registered as 'api-loop' drives every step of the grounded loop — the
// analyze scout, the plan auditor, and the db/api children the split expands (all inherit
// executorRef 'api-loop'). It branches on ctx.step.id. Behaviour is a pure function of the human
// replies the test delivers via replyFeedback + the plan-note graph it authors: it emits REAL
// feedback gates, authors REAL plan-notes via the injected memory_write, reads the human's
// annotations via the REAL read_annotations tool, and calls the REAL finalize_plan — so the
// assertions read committed events / the projected store, never the fake.
function groundedFake(): AgentExecutor<unknown> {
  return {
    id: 'api-loop',
    async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | string | undefined> {
      const base = { stepId: ctx.step.id, runToken: ctx.runToken }
      const tool = (name: string): ResolvedTool => {
        const t = ctx.extraTools.find(x => x.name === name)
        if (!t) throw new Error(`no '${name}' tool injected`)
        return t
      }
      const write = (tag: string, note: MemoryNoteDraft) =>
        ctx.checkpoint(`write:${tag}`, () => tool('memory_write').execute(note, `w-${tag}`), (r): EventDraft[] => [
          { kind: EVENT_KIND.tool_call, payload: { ...base, iteration: 1, toolCallId: `w-${tag}`, toolName: 'memory_write', input: note } },
          { kind: EVENT_KIND.tool_result, payload: { ...base, iteration: 1, toolCallId: `w-${tag}`, toolName: 'memory_write', output: r.output, isError: r.isError } },
        ])
      const signalDone = async function* (summary: string, ok = true): AsyncGenerator<UnifiedEvent> {
        const signal = { ...base, outcome: ok ? SIGNAL_OUTCOME.success : SIGNAL_OUTCOME.failure, summary }
        await ctx.checkpoint(`signal`, async () => signal, (): EventDraft[] => [
          { kind: EVENT_KIND.signal_received, payload: { ...base, signal } },
        ])
        yield { type: 'signal', signal }
        yield { type: 'done' }
      }

      // ---- ANALYZE scout: consent gate → (maybe) write an analysis note → analysis_completed ----
      if (ctx.step.id === 'analyze') {
        const answer = yield { type: 'feedback', question: 'May I analyze the codebase to ground the plan? (yes/no)', topic: 'consent', toolCallId: 'consent-1' }
        const analyzed = answer === 'yes'
        if (analyzed)
          await write('analysis', { id: 'analysis', title: 'Architecture', kind: NOTE_KIND.architecture_current, body: 'observed layering', summary: 'the shape of the code', paths: ['src/'] })
        // TEST-ONLY SCAFFOLD: production has NO emitter for analysis_completed/CoverageReport —
        // it's a reserved contract seam (spec §9), fabricated here only by this fake, and the fold
        // is a no-op (projections.ts). Do not read this as proof of RG7 degradation; the
        // production-truthful proof is the persisted uncertainty[] on the plan-notes, asserted in
        // test 2 below via the store/projection, not this event.
        const report: CoverageReport = analyzed
          ? { analyzed: true, scope: ['project'], gaps: ['auth flow not exercised'], confidence: 'medium', notesWritten: 1 }
          : { analyzed: false, scope: [], gaps: [], confidence: 'none', notesWritten: 0 }
        await ctx.checkpoint('analysis-completed', async () => report, (): EventDraft[] => [
          { kind: EVENT_KIND.analysis_completed, payload: report },
        ])
        yield* signalDone(analyzed ? 'analysis complete' : 'analysis skipped by consent')
        return
      }

      // ---- PLAN auditor: author a masterplan graph, iterate via ask_human, finalize on approve ----
      if (ctx.step.id === 'plan') {
        const taskId = taskIdOf(ctx.runToken)
        const scope = planScope(taskId)
        // masterplan decomposes_into {db, api}; api depends_on db; db carries an uncertainty (RG7 —
        // in assumption mode this is the only ground truth about the gap).
        const notes: Record<string, MemoryNoteDraft> = {
          masterplan: { id: 'masterplan', title: 'Web app', kind: NOTE_KIND.plan, scope, body: 'build the whole web app', links: [{ id: 'db', kind: LINK_KIND.decomposes_into }, { id: 'api', kind: LINK_KIND.decomposes_into }] },
          db: { id: 'db', title: 'DB', kind: NOTE_KIND.plan, scope, body: 'create the schema', rationale: 'data model first', uncertainty: ['schema shape unverified — no analysis of existing tables'] },
          api: { id: 'api', title: 'API', kind: NOTE_KIND.plan, scope, body: 'build the endpoints', rationale: 'consumers need a surface', links: [{ id: 'db', kind: LINK_KIND.depends_on }] },
        }
        for (const id of ['masterplan', 'db', 'api']) await write(id, notes[id]!)

        // ask_human loop: revise on any non-'approve' reply, applying ONLY the annotated notes.
        let cycle = 0
        for (;;) {
          cycle++
          const reply = yield { type: 'feedback', question: 'Plan ready — reply with changes, or "approve" to start.', topic: `plan:${cycle}`, toolCallId: `ask-${cycle}` }
          if (reply === 'approve') break
          // targeted re-plan (D6): learn which notes the human flagged by calling the REAL
          // read_annotations tool (FixB's channel — kernel.listAnnotations off the log, taskId bound
          // from the injected step context), then re-write ONLY those notes and leave every sibling
          // byte-stable. No log peeking: a real agent has no such access — this injected tool is its
          // only channel, so if read_annotations were dropped the fake throws and this test fails.
          const targets = await ctx.checkpoint(`annotations:${cycle}`, async () => {
            const r = await tool('read_annotations').execute({}, `annot-${cycle}`)
            return (r.output as { annotations: { targetNote: string }[] }).annotations.map(a => a.targetNote)
          })
          for (const target of new Set(targets)) {
            if (!notes[target]) continue
            notes[target] = { ...notes[target]!, body: `${notes[target]!.body} [revised per annotation]` }
            await write(`${target}-rev${cycle}`, notes[target]!)
          }
        }

        // approve → finalize_plan freezes the graph and task_splits it (REAL kernel.proposeSplit).
        const fin = await ctx.checkpoint('finalize', () => tool('finalize_plan').execute({}, 'finalize'), (r): EventDraft[] => [
          { kind: EVENT_KIND.tool_call, payload: { ...base, iteration: 2, toolCallId: 'finalize', toolName: 'finalize_plan', input: {} } },
          { kind: EVENT_KIND.tool_result, payload: { ...base, iteration: 2, toolCallId: 'finalize', toolName: 'finalize_plan', output: r.output, isError: r.isError } },
        ])
        yield* signalDone(fin.isError ? `finalize failed: ${JSON.stringify(fin.output)}` : 'plan finalized', !fin.isError)
        return
      }

      // ---- CHILD subplan step (db / api): read its OWN plan-note back from the plan-note graph ----
      const childTaskId = taskIdOf(ctx.runToken)
      const scope = planScope(childTaskId.split('.')[0]!) // childTaskId = <groundedId>.plan.<callId>
      const found = await ctx.checkpoint('read-subplan', async () => {
        for (let i = 0; i < 20; i++) {
          const r = await tool('memory_read').execute({ id: ctx.step.id, scope })
          const note = (r.output as { note: { title: string } | null }).note
          if (note) return note
          await Bun.sleep(100)
        }
        return null
      }, (note): EventDraft[] => [
        { kind: EVENT_KIND.tool_call, payload: { ...base, iteration: 1, toolCallId: `read-${ctx.step.id}`, toolName: 'memory_read', input: { id: ctx.step.id, scope } } },
        { kind: EVENT_KIND.tool_result, payload: { ...base, iteration: 1, toolCallId: `read-${ctx.step.id}`, toolName: 'memory_read', output: { note }, isError: false } },
      ])
      yield* signalDone(found ? `read subplan ${ctx.step.id}` : `subplan ${ctx.step.id} not found`, found !== null)
    },
  }
}

const waitFor = async (pred: () => Promise<boolean>, ms = 20_000): Promise<boolean> => {
  const start = Date.now()
  while (Date.now() - start < ms) { if (await pred()) return true; await Bun.sleep(50) }
  return false
}

async function bringUp() {
  const pg = await createTestDb()
  const ts = await createTestSurreal()
  const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-grounded-e2e-'))
  const storage = await openStorage(pg.url, { projectId: TEST_PROJECT_ID })
  const log = storage.events
  const config = testConfig(pg.url, {
    vaultDir,
    projectDbUrl: ts.url, projectDbNamespace: ts.ns, projectDbName: ts.db,
    projectDbUser: ts.username, projectDbPassword: ts.password,
  })
  // send=dbosSend so replyFeedback both appends feedback_provided AND resumes the parked step
  // workflow (the real CLI wiring: new Kernel(log, refValidator, analyzers, dbosSend)).
  const kernel = new Kernel(log, undefined, new Map<string, Analyzer>([['agent-analyzer', testAnalyzer]]), dbosSend)
  const memory = await createMemory({ log, config })
  await memory.projector.start()
  const port = await createDbosPort({
    storage, config,
    providers: new Map([['fake', fakeProvider]]),
    executors: new Map([['api-loop', groundedFake()]]),
    // the analyze/plan steps declare skillRefs; a minimal loader satisfies the force-load (the
    // fake ignores skill bodies — the loop behaviour comes from the scripted branches).
    skills: { load: async (name: string) => ({ name, body: `body of ${name}`, hash: `hash-${name}` }) },
    // FAITHFUL MIRROR of runtime.ts buildRuntime.stepTools — the SAME tier-derived memory surface +
    // task_split + read_annotations + finalize_plan the CLI wires in production. The factory shape
    // is replicated (not imported) on purpose: that inline factory is a composition-root concern
    // closing over cli-only handles, and sharing it would force kernel→memory as a PROD dep — the
    // stepTools seam exists precisely so the kernel stays memory-agnostic. But the tier DERIVATION
    // itself now comes from tierForRole (@orc/memory is a devDependency here — test-only, no prod
    // edge), so this test can no longer drift from production's role→tier mapping (FixD).
    stepTools: p => [
      // step role keys the memory tier: scout (analyze) / auditor (plan) narrow-or-widen the surface;
      // every other role (the implementer children) gets verify. Scout MUST keep memory_write (FixA).
      ...memory.buildTools(
        { source: 'agent', taskId: p.taskId, stepId: p.stepId, runToken: p.runToken, executor: p.executor, model: p.model, role: p.role },
        tierForRole(p.role),
      ),
      splitTool({ kernel, config: { approvalPolicy: config.approvalPolicy, maxDepth: config.maxDepth }, p }),
      readAnnotationsTool({ kernel, p }),
      finalizePlanTool({ kernel, config: { maxDepth: config.maxDepth }, p }),
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
  return { kernel, log, memory, port, cleanup }
}

describe('grounded-plan e2e: the full consent → analyze → plan-graph → annotate → approve → parallel loop', () => {
  it('consent yes → grounded plan → targeted re-plan → approve → dependency-ordered child execution', async () => {
    const { kernel, memory, port, cleanup } = await bringUp()
    try {
      const t = await kernel.createGroundedTask({ title: 'Web app', spec: 'build a web app', modelRef: 'fake/m', analyzerRef: 'agent-analyzer' })
      const scope = planScope(t.id)
      const feedbackCount = async (topic: string): Promise<number> =>
        (await kernel.eventsFor(t.id)).filter(e => e.kind === EVENT_KIND.feedback_requested && (e.payload as { topic: string }).topic === topic).length

      const handle = await port.startRun(t.id)

      // consent gate → yes (the real durable feedback gate: recv parks, replyFeedback→DBOS.send resumes)
      expect(await waitFor(() => feedbackCount('consent').then(n => n >= 1))).toBe(true)
      expect(await kernel.replyFeedback(t.id, 'yes')).toBe('consent')

      // ASSERT (FixA Gap C): the analyze SCOUT authored its note via the REAL memory_write tool —
      // proof it runs under scout tier that STILL carries memory_write. Pre-FixA scout dropped
      // memory_write, so the fake's write would throw "no 'memory_write' tool injected", the step
      // would never finish, and 'analysis' would never exist. Read it back from the store (default
      // 'project' scope) to prove authored-under-scout-tier + projected.
      expect(await waitFor(async () => (await memory.store.get('analysis', 'project')) !== null)).toBe(true)
      expect((await memory.store.get('analysis', 'project'))?.title).toBe('Architecture')

      // plan authored → first ask_human → annotate 'db' then reply 'go' (a targeted revise, not approve)
      expect(await waitFor(() => feedbackCount('plan:1').then(n => n >= 1))).toBe(true)
      await kernel.annotatePlan(t.id, { targetNote: 'db', text: 'tighten the schema step' })
      expect(await kernel.replyFeedback(t.id, 'go')).toBe('plan:1')

      // wait for the revise to project, then ASSERT (a): annotating 'db' bumped ONLY db's revision;
      // sibling 'api' is byte-stable at revision 1 (targeted re-plan, D6).
      expect(await waitFor(async () => {
        const db = await memory.store.get('db', scope)
        const api = await memory.store.get('api', scope)
        return db?.revision === 2 && api?.revision === 1
      })).toBe(true)
      const dbNote = await memory.store.get('db', scope)
      const apiNote = await memory.store.get('api', scope)
      expect(dbNote?.revision).toBe(2)
      expect(apiNote?.revision).toBe(1)
      expect(dbNote?.body).toContain('[revised per annotation]')
      expect(apiNote?.body).not.toContain('[revised')

      // second ask_human → approve → finalize_plan → task_split
      expect(await waitFor(() => feedbackCount('plan:2').then(n => n >= 1))).toBe(true)
      expect(await kernel.replyFeedback(t.id, 'approve')).toBe('plan:2')

      // ASSERT (d.1): the grounded run resolves 'done' (plan step signalled after finalize_plan)
      expect(await handle.wait()).toBe('done')

      // finalize_plan split off a child task carrying the frozen db/api plan
      const split = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.split_proposed)
      expect(split).toBeDefined()
      const childId = (split!.payload as { childTaskId: string }).childTaskId

      // ASSERT (d.2): the child (db → api) runs to completion via the router-started child run
      expect(await waitFor(async () => (await kernel.getTask(childId))?.status === TASK_STATUS.done, 30_000)).toBe(true)

      const childEvents = await kernel.eventsFor(childId)
      // ASSERT (b): 'api' started only AFTER 'db' completed — the real ready-set scheduler honoured
      // api depends_on db (instantiateFrozenPlan → dependsOn). Proven by log seq ordering.
      const dbDone = childEvents.find(e => e.kind === EVENT_KIND.step_completed && (e.payload as { stepId: string }).stepId === 'db')
      const apiStart = childEvents.find(e => e.kind === EVENT_KIND.step_started && (e.payload as { stepId: string }).stepId === 'api')
      expect(dbDone).toBeDefined()
      expect(apiStart).toBeDefined()
      expect(dbDone!.seq).toBeLessThan(apiStart!.seq)

      // ASSERT (c): a child read its OWN subplan-note back from the plan-note graph (memory traversal).
      const apiRead = childEvents.find(e => e.kind === EVENT_KIND.tool_result
        && (e.payload as { toolName: string }).toolName === 'memory_read'
        && (e.payload as { stepId: string }).stepId === 'api')
      expect(apiRead).toBeDefined()
      expect((apiRead!.payload as { output: { note: { title: string } | null } }).output.note?.title).toBe('API')
    } finally {
      await cleanup()
    }
  }, 60_000)

  it('consent no → empty CoverageReport (analyzed:false) → assumption-mode plan with marked uncertainties', async () => {
    const { kernel, memory, port, cleanup } = await bringUp()
    try {
      const t = await kernel.createGroundedTask({ title: 'CLI tool', spec: 'ship a cli', modelRef: 'fake/m', analyzerRef: 'agent-analyzer' })
      const scope = planScope(t.id)
      const feedbackCount = async (topic: string): Promise<number> =>
        (await kernel.eventsFor(t.id)).filter(e => e.kind === EVENT_KIND.feedback_requested && (e.payload as { topic: string }).topic === topic).length

      const handle = await port.startRun(t.id)

      // consent gate → NO (degradation path, RG7)
      expect(await waitFor(() => feedbackCount('consent').then(n => n >= 1))).toBe(true)
      expect(await kernel.replyFeedback(t.id, 'no')).toBe('consent')

      // NOTE (test-only scaffold, not load-bearing): this only pins the FAKE's own emitted event —
      // production has no analysis_completed emitter (reserved CoverageReport seam, spec §9), so this
      // is not evidence of any real degradation behavior. The production-truthful proof of RG7
      // degradation is below: persisted uncertainty[] on the plan-notes, read back from the store.
      expect(await waitFor(() => kernel.eventsFor(t.id).then(es => es.some(e => e.kind === EVENT_KIND.analysis_completed)))).toBe(true)
      const ac = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.analysis_completed)
      const report = ac!.payload as CoverageReport
      expect(report.analyzed).toBe(false)
      expect(report.gaps).toEqual([])
      expect(report.notesWritten).toBe(0)

      // drive the plan to done (no annotations → approve on the first ask_human)
      expect(await waitFor(() => feedbackCount('plan:1').then(n => n >= 1))).toBe(true)
      expect(await kernel.replyFeedback(t.id, 'approve')).toBe('plan:1')
      expect(await handle.wait()).toBe('done')

      // let the router-started child run settle before teardown (avoids racing memory.close())
      const childId2 = ((await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.split_proposed)!.payload as { childTaskId: string }).childTaskId
      await waitFor(async () => (await kernel.getTask(childId2))?.status === TASK_STATUS.done, 30_000)

      // ASSERT (FixA Gap A) — THE PRODUCTION-TRUTHFUL PROOF OF RG7 DEGRADATION (not the fabricated
      // analysis_completed above, which production never emits): the assumption-mode plan-notes
      // carry marked uncertainties (every gap surfaced on the note it affects), and
      // uncertainty[]/rationale round-trip THROUGH THE READ MODEL — read db's note back from the
      // store (the SurrealDB projection), NOT the event log. Pre-FixA the projection dropped these
      // fields, so this returned [] / '' even though the log carried them; FixA persists them
      // through table/upsert/toNote.
      expect(await waitFor(async () => ((await memory.store.get('db', scope))?.uncertainty.length ?? 0) > 0)).toBe(true)
      const dbNote = await memory.store.get('db', scope)
      expect(dbNote?.uncertainty.length).toBeGreaterThan(0)
      expect(dbNote?.uncertainty[0]).toContain('unverified')
      expect(dbNote?.rationale).toBe('data model first')
    } finally {
      await cleanup()
    }
  }, 60_000)

  it('memory_neighbors from the masterplan returns its subplan-notes (the plan-graph is consumable)', async () => {
    const { kernel, memory, port, cleanup } = await bringUp()
    try {
      const t = await kernel.createGroundedTask({ title: 'Service', spec: 'build a service', modelRef: 'fake/m', analyzerRef: 'agent-analyzer' })
      const scope = planScope(t.id)
      const feedbackCount = async (topic: string): Promise<number> =>
        (await kernel.eventsFor(t.id)).filter(e => e.kind === EVENT_KIND.feedback_requested && (e.payload as { topic: string }).topic === topic).length

      const handle = await port.startRun(t.id)
      expect(await waitFor(() => feedbackCount('consent').then(n => n >= 1))).toBe(true)
      expect(await kernel.replyFeedback(t.id, 'yes')).toBe('consent')
      expect(await waitFor(() => feedbackCount('plan:1').then(n => n >= 1))).toBe(true)
      expect(await kernel.replyFeedback(t.id, 'approve')).toBe('plan:1')
      expect(await handle.wait()).toBe('done')

      // let the router-started child run settle before teardown (avoids racing memory.close())
      const childId3 = ((await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.split_proposed)!.payload as { childTaskId: string }).childTaskId
      await waitFor(async () => (await kernel.getTask(childId3))?.status === TASK_STATUS.done, 30_000)

      // wait for the whole plan-note graph to project, then traverse decomposes_into from masterplan
      expect(await waitFor(async () =>
        (await memory.store.get('masterplan', scope)) !== null
        && (await memory.store.get('db', scope)) !== null
        && (await memory.store.get('api', scope)) !== null)).toBe(true)

      const neighbors = await memory.store.neighbors('masterplan', { kinds: [LINK_KIND.decomposes_into], scope })
      expect(neighbors.map(n => n.id).sort()).toEqual(['api', 'db'])
      expect(neighbors.every(n => n.via === LINK_KIND.decomposes_into)).toBe(true)
    } finally {
      await cleanup()
    }
  }, 60_000)
})
