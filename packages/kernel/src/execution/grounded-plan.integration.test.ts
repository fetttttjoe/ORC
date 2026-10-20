import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  Confidence, Door, EVENT_KIND, FINISH_STEP_ID, IsolationTier, NO_CHAT, PAYLOAD_SCHEMAS, PlanNoteToolName, SignalOutcome, TASK_STATUS,
  type AgentExecutor, type Analyzer, type CoverageReport, type EventDraft, type ExecutorContext,
  type Origin, type PlanNoteWrite, type PlanStep, type ResolvedTool,
  type SplitResult, type UnifiedEvent,
  RunOutcome,
} from '@orc/contracts'
import { must } from '@orc/contracts/fixtures'
import { openStorage } from '../storage'
import { Kernel } from '../kernel'
import { createTestDb, fakeProvider, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID, testConfig, waitFor as poll } from '../test-helpers'
import { createDbosPort, dbosSend } from './dbos-port'
import { finalizePlanTool } from './finalize-plan-tool'
import { planNoteTools } from './plan-note-tools'
import { readAnnotationsTool } from './read-annotations-tool'
import { splitTool } from './split-tool'

const CLI: Origin = NO_CHAT(Door.cli)

// Tool outputs are contract-`unknown`; this names the shape this suite reads back at the boundary.
const AnnotationsOutput = z.object({ annotations: z.array(z.object({ targetNote: z.string() })) })

// The analyzer seam: this analysisStep mirrors the real agent-analyzer's scout step verbatim.
const testAnalyzer: Analyzer = {
  id: 'agent-analyzer',
  analysisStep: ({ modelRef }): PlanStep => ({
    id: 'analyze', role: 'scout', title: 'Analyze the codebase',
    instructions: 'Ground the plan per the codebase-analysis skill.',
    executorRef: 'api-loop', modelRef, skillRefs: ['codebase-analysis'], toolRefs: [],
    isolation: IsolationTier.local, zone: [], maxIterations: 15, dependsOn: [],
  }),
}

// taskId is parsed from the runToken, the step workflow id `step:<taskId>:<stepId>:aN`.
const taskIdOf = (runToken: string): string => must(runToken.split(':')[1], 'task id in runToken')
const mutateAfterApprovalTasks = new Set<string>()

const DB_RATIONALE = 'data model first'
const DB_UNCERTAINTY = 'schema shape unverified — no analysis of existing tables'

// One scripted executor drives every step, branching on ctx.step.id; assertions read the log.
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
      const write = (tag: string, note: PlanNoteWrite) =>
        ctx.checkpoint(`write:${tag}`, () => tool(PlanNoteToolName.write).execute(note, `w-${tag}`), (r): EventDraft[] => [
          { kind: EVENT_KIND.tool_call, payload: { ...base, iteration: 1, toolCallId: `w-${tag}`, toolName: PlanNoteToolName.write, input: note } },
          { kind: EVENT_KIND.tool_result, payload: { ...base, iteration: 1, toolCallId: `w-${tag}`, toolName: PlanNoteToolName.write, output: r.output, isError: r.isError } },
        ])
      const signalDone = async function* (summary: string, ok = true): AsyncGenerator<UnifiedEvent> {
        const signal = { ...base, outcome: ok ? SignalOutcome.success : SignalOutcome.failure, summary }
        await ctx.checkpoint(`signal`, async () => signal, (): EventDraft[] => [
          { kind: EVENT_KIND.signal_received, payload: { ...base, signal } },
        ])
        yield { type: 'signal', signal }
        yield { type: 'done' }
      }

      // ---- ANALYZE scout: consent gate → analysis_completed ----
      if (ctx.step.id === 'analyze') {
        const answer = yield { type: 'feedback', question: 'May I analyze the codebase to ground the plan? (yes/no)', topic: 'consent', toolCallId: 'consent-1' }
        const analyzed = answer === 'yes'
        // this executor checkpoints analysis_completed directly instead of via report_coverage
        const report: CoverageReport = analyzed
          ? { analyzed: true, scope: ['project'], gaps: ['auth flow not exercised'], confidence: Confidence.medium, claimsWritten: 1 }
          : { analyzed: false, scope: [], gaps: [], confidence: Confidence.none, claimsWritten: 0 }
        await ctx.checkpoint('analysis-completed', async () => report, (): EventDraft[] => [
          { kind: EVENT_KIND.analysis_completed, payload: report },
        ])
        yield* signalDone(analyzed ? 'analysis complete' : 'analysis skipped by consent')
        return
      }

      // ---- PLAN auditor: author the plan notes, iterate via ask_human, finalize on approve ----
      if (ctx.step.id === 'plan') {
        const taskId = taskIdOf(ctx.runToken)
        const notes: Record<string, PlanNoteWrite> = {
          masterplan: { id: 'masterplan', title: 'Web app', body: 'build the whole web app', subplans: ['db', 'api'] },
          db: { id: 'db', title: 'DB', body: 'create the schema', rationale: DB_RATIONALE, uncertainty: [DB_UNCERTAINTY] },
          api: { id: 'api', title: 'API', body: 'build the endpoints', rationale: 'consumers need a surface', dependsOn: ['db'] },
        }
        for (const id of ['masterplan', 'db', 'api']) await write(id, must(notes[id], 'note'))
        const finalize = (checkpoint: string, toolCallId: string) =>
          ctx.checkpoint(checkpoint, () => tool(PlanNoteToolName.finalize).execute({}, toolCallId), (r): EventDraft[] => [
            { kind: EVENT_KIND.tool_call, payload: { ...base, iteration: 2, toolCallId, toolName: PlanNoteToolName.finalize, input: {} } },
            { kind: EVENT_KIND.tool_result, payload: { ...base, iteration: 2, toolCallId, toolName: PlanNoteToolName.finalize, output: r.output, isError: r.isError } },
          ])

        // A model calling finalize before ask_human cannot manufacture approval.
        const premature = await finalize('finalize:premature', 'finalize-premature')
        if (!premature.isError) { yield* signalDone('premature finalize unexpectedly succeeded', false); return }

        // ask_human loop: revise on any non-'approve' reply, re-writing ONLY annotated notes
        let cycle = 0
        for (;;) {
          cycle++
          const reply = yield { type: 'feedback', question: 'Plan ready — reply with changes, or "approve" to start.', topic: `plan:${cycle}`, toolCallId: `ask-${cycle}` }
          if (reply === 'approve') {
            if (mutateAfterApprovalTasks.delete(taskId)) {
              await write('db-post-approval', { id: 'db', body: 'create the schema [mutated after approval]' })
              const stale = await finalize('finalize:stale', 'finalize-stale')
              if (!stale.isError) { yield* signalDone('stale approval unexpectedly finalized', false); return }
              continue
            }
            break
          }
          const targets = await ctx.checkpoint(`annotations:${cycle}`, async () => {
            const r = await tool('read_annotations').execute({}, `annot-${cycle}`)
            return AnnotationsOutput.parse(r.output).annotations.map(a => a.targetNote)
          })
          for (const target of new Set(targets)) {
            const current = notes[target]
            if (!current) continue
            await write(`${target}-rev${cycle}`, { id: target, body: `${current.body ?? ''} [revised per annotation]` })
          }
        }

        const fin = await finalize('finalize', 'finalize')
        yield* signalDone(fin.isError ? `finalize failed: ${JSON.stringify(fin.output)}` : 'plan finalized', !fin.isError)
        return
      }

      // ---- the kernel's appended FINISH step, and the db/api children: nothing to do but succeed ----
      if (ctx.step.id === FINISH_STEP_ID) { yield* signalDone('nothing to reconcile'); return }
      yield* signalDone(`ran subplan ${ctx.step.id}`)
    },
  }
}

// full drive-generator runs need more than the 3s default timeout
const waitFor = (pred: () => Promise<boolean>, ms = 20_000): Promise<boolean> => poll(pred, ms)

async function bringUp() {
  const pg = await createTestDb()
  const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-grounded-e2e-'))
  const storage = await openStorage(pg.url, { projectId: TEST_PROJECT_ID })
  const log = storage.events
  const config = testConfig(pg.url, { vaultDir })
  // send=dbosSend so replyFeedback appends feedback_provided AND resumes the parked step workflow
  const kernel = new Kernel(log, undefined, new Map<string, Analyzer>([['agent-analyzer', testAnalyzer]]), dbosSend)
  await seedTestWorkspace(log, CLI)
  const port = await createDbosPort({
    storage, config,
    providers: new Map([['fake', fakeProvider]]),
    executors: new Map([['api-loop', groundedFake()]]),
    // the analyze/plan steps declare skillRefs; a minimal loader satisfies the force-load
    skills: { load: async (name: string) => ({ name, body: `body of ${name}`, hash: `hash-${name}` }) },
    // the plan step's tool surface as runtime.ts registers it
    stepTools: p => [
      ...splitTool({ kernel, config: { approvalPolicy: config.approvalPolicy, maxDepth: config.maxDepth }, p }),
      readAnnotationsTool({ kernel, p }),
      ...planNoteTools({ kernel, p }),
      ...finalizePlanTool({ kernel, config: { maxDepth: config.maxDepth, finishChecks: [] }, p }),
    ],
  })
  await port.launch()
  const cleanup = async (): Promise<void> => {
    await port.shutdown()
    await log.close()
    rmSync(vaultDir, { recursive: true, force: true })
    await pg.drop()
  }
  return { kernel, port, cleanup }
}

const writesOf = async (kernel: Kernel, taskId: string, id: string): Promise<number> =>
  (await kernel.eventsFor(taskId)).filter(e => e.kind === EVENT_KIND.plan_note_written
    && PAYLOAD_SCHEMAS.plan_note_written.parse(e.payload).note.id === id).length

describe('grounded-plan e2e: consent → analyze → plan notes → annotate → approve → split', () => {
  it('a targeted re-plan, an edit after approval refused by name, a re-approval, then dependency-ordered children', async () => {
    const { kernel, port, cleanup } = await bringUp()
    try {
      const t = await kernel.createGroundedTask({ workspaceId: TEST_WORKSPACE_ID, title: 'Web app', spec: 'build a web app', modelRef: 'fake/m', analyzerRef: 'agent-analyzer' }, CLI)
      mutateAfterApprovalTasks.add(t.id)
      const feedbackCount = async (topic: string): Promise<number> =>
        (await kernel.eventsFor(t.id)).filter(e => e.kind === EVENT_KIND.feedback_requested && PAYLOAD_SCHEMAS.feedback_requested.parse(e.payload).topic === topic).length
      const toolResult = async (toolCallId: string) => (await kernel.eventsFor(t.id)).find(e =>
        e.kind === EVENT_KIND.tool_result && PAYLOAD_SCHEMAS.tool_result.parse(e.payload).toolCallId === toolCallId)

      const handle = await port.startRun(t.id)

      expect(await waitFor(() => feedbackCount('consent').then(n => n >= 1))).toBe(true)
      expect(await kernel.replyFeedback(t.id, 'yes', CLI)).toBe('consent')

      // authored → an untrusted direct finalize is rejected before the first human gate
      expect(await waitFor(() => feedbackCount('plan:1').then(n => n >= 1))).toBe(true)
      const premature = await toolResult('finalize-premature')
      expect(premature?.payload).toMatchObject({ isError: true })
      expect(JSON.stringify(premature?.payload)).toContain('approval')
      expect((await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.split_proposed)).toBe(false)

      // annotate 'db', reply 'go': only db is re-written, and the merge keeps what the revise left out
      await kernel.annotatePlan(t.id, { targetNote: 'db', text: 'tighten the schema step' }, CLI)
      expect(await kernel.replyFeedback(t.id, 'go', CLI)).toBe('plan:1')
      expect(await waitFor(() => feedbackCount('plan:2').then(n => n >= 1))).toBe(true)
      expect(await writesOf(kernel, t.id, 'db')).toBe(2)
      expect(await writesOf(kernel, t.id, 'api')).toBe(1)
      const revisedDb = must((await kernel.listPlanNotes(t.id)).find(n => n.id === 'db'), 'db note')
      expect(revisedDb.body).toContain('[revised per annotation]')
      expect(revisedDb.rationale).toBe(DB_RATIONALE)
      expect(revisedDb.uncertainty).toEqual([DB_UNCERTAINTY])

      // the first approval, then the agent edits db: finalize refuses and names the edited note
      expect(await kernel.replyFeedback(t.id, 'approve', CLI)).toBe('plan:2')
      expect(await waitFor(() => feedbackCount('plan:3').then(n => n >= 1))).toBe(true)
      const stale = await toolResult('finalize-stale')
      expect(stale?.payload).toMatchObject({ isError: true })
      expect(JSON.stringify(stale?.payload)).toContain('changed after approval')
      expect(JSON.stringify(stale?.payload)).toContain("'db'")
      expect((await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.split_proposed)).toBe(false)

      // re-approval binds the edited notes, and the freeze passes
      expect(await kernel.replyFeedback(t.id, 'approve', CLI)).toBe('plan:3')
      expect(await handle.wait()).toBe(RunOutcome.done)

      const split = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.split_proposed)
      const childId = PAYLOAD_SCHEMAS.split_proposed.parse(must(split, 'split event').payload).childTaskId
      expect(await waitFor(async () => (await kernel.getTask(childId))?.status === TASK_STATUS.done, 30_000)).toBe(true)

      // 'api' started only AFTER 'db' completed: the scheduler honoured api dependsOn db
      const childEvents = await kernel.eventsFor(childId)
      const dbDone = childEvents.find(e => e.kind === EVENT_KIND.step_completed && PAYLOAD_SCHEMAS.step_completed.parse(e.payload).stepId === 'db')
      const apiStart = childEvents.find(e => e.kind === EVENT_KIND.step_started && PAYLOAD_SCHEMAS.step_started.parse(e.payload).stepId === 'api')
      expect(must(dbDone, 'db done event').seq).toBeLessThan(must(apiStart, 'api start event').seq)

      // the frozen db step leads with its rationale on a Why: line, then the body, then its uncertainty
      const dbStep = must(must(await kernel.getPlan(childId), 'child plan').steps.find(s => s.id === 'db'), 'db step')
      expect(dbStep.instructions).toStartWith(`Why: ${DB_RATIONALE}\n\ncreate the schema [mutated after approval]`)
      expect(dbStep.instructions).toContain(DB_UNCERTAINTY)
    } finally {
      await cleanup()
    }
  }, 60_000)

  it('consent no → empty CoverageReport (analyzed:false) → assumption-mode plan with marked uncertainties', async () => {
    const { kernel, port, cleanup } = await bringUp()
    try {
      const t = await kernel.createGroundedTask({ workspaceId: TEST_WORKSPACE_ID, title: 'CLI tool', spec: 'ship a cli', modelRef: 'fake/m', analyzerRef: 'agent-analyzer' }, CLI)
      const feedbackCount = async (topic: string): Promise<number> =>
        (await kernel.eventsFor(t.id)).filter(e => e.kind === EVENT_KIND.feedback_requested && PAYLOAD_SCHEMAS.feedback_requested.parse(e.payload).topic === topic).length

      const handle = await port.startRun(t.id)

      expect(await waitFor(() => feedbackCount('consent').then(n => n >= 1))).toBe(true)
      expect(await kernel.replyFeedback(t.id, 'no', CLI)).toBe('consent')

      expect(await waitFor(() => kernel.eventsFor(t.id).then(es => es.some(e => e.kind === EVENT_KIND.analysis_completed)))).toBe(true)
      const ac = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.analysis_completed)
      const report = PAYLOAD_SCHEMAS.analysis_completed.parse(must(ac, 'analysis completed event').payload)
      expect(report.analyzed).toBe(false)
      expect(report.gaps).toEqual([])
      expect(report.claimsWritten).toBe(0)

      expect(await waitFor(() => feedbackCount('plan:1').then(n => n >= 1))).toBe(true)
      expect(await kernel.replyFeedback(t.id, 'approve', CLI)).toBe('plan:1')
      expect(await handle.wait()).toBe(RunOutcome.done)

      const childId = PAYLOAD_SCHEMAS.split_proposed.parse(must((await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.split_proposed), 'split proposed event').payload).childTaskId
      expect(await waitFor(async () => (await kernel.getTask(childId))?.status === TASK_STATUS.done, 30_000)).toBe(true)

      // the assumption-mode plan notes carry their marked uncertainty and rationale in the kernel
      const db = must((await kernel.listPlanNotes(t.id)).find(n => n.id === 'db'), 'db note')
      expect(db.uncertainty).toEqual([DB_UNCERTAINTY])
      expect(db.rationale).toBe(DB_RATIONALE)
    } finally {
      await cleanup()
    }
  }, 60_000)
})
