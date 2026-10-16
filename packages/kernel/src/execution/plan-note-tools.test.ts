import { afterAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { Door, EVENT_KIND, NO_CHAT, PlanNote, PlanNoteToolName, STEP_ID, STEP_ROLE } from '@orc/contracts'
import { must, planNoteFixture } from '@orc/contracts/fixtures'
import { openStorage } from '../storage'
import { Kernel } from '../kernel'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID } from '../test-helpers'
import { planNoteTools } from './plan-note-tools'
import { runOrigin } from './run-chat'
import { GROUNDED_TASK_TYPE } from './strategies/grounded-plan'

const SEED = NO_CHAT(Door.cli)
const NoteOutput = z.object({ note: PlanNote })
const NotesOutput = z.object({ notes: z.array(PlanNote) })
const ErrorOutput = z.object({ error: z.string() })

const cleanup: Array<() => Promise<void>> = []
afterAll(async () => { for (const c of cleanup.reverse()) await c() })

async function planStep() {
  const db = await createTestDb()
  const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
  cleanup.push(() => db.drop(), () => storage.close())
  await seedTestWorkspace(storage.events, SEED)
  const kernel = new Kernel(storage.events)
  const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'grounded', type: GROUNDED_TASK_TYPE }, SEED)
  const p = { taskId: t.id, stepId: STEP_ID.plan, runToken: `step:${t.id}:plan:a1`, role: STEP_ROLE.auditor, origin: runOrigin(`run:${t.id}:v1`) }
  const tool = (name: PlanNoteToolName) => must(planNoteTools({ kernel, p }).find(x => x.name === name), name)
  const written = async (): Promise<number> => (await storage.events.byTask(t.id)).filter(e => e.kind === EVENT_KIND.plan_note_written).length
  return { write: tool(PlanNoteToolName.write), read: tool(PlanNoteToolName.read), written }
}

describe('plan note tools', () => {
  it('a non-plan step gets none', () => {
    const kernel = { writePlanNote: async () => { throw new Error('should not be called') }, listPlanNotes: async () => [] }
    const p = { taskId: 't1', stepId: STEP_ID.plan, runToken: 'rt', role: STEP_ROLE.auditor, origin: runOrigin('run:t1:v1') }
    expect(planNoteTools({ kernel, p: { ...p, role: STEP_ROLE.worker } })).toEqual([])
    expect(planNoteTools({ kernel, p: { ...p, stepId: STEP_ID.verify } })).toEqual([])
    expect(planNoteTools({ kernel, p }).map(t => t.name)).toEqual([PlanNoteToolName.write, PlanNoteToolName.read])
  })

  it('a written note reads back, alone by id or among all of them', async () => {
    const { write, read } = await planStep()
    const r = await write.execute({ id: 'masterplan', title: 'Plan', subplans: ['db'] }, 'call-1')
    expect(r.isError).toBe(false)
    const note = NoteOutput.parse(r.output).note
    expect(note).toEqual(planNoteFixture({ title: 'Plan', subplans: ['db'] }))

    expect(NotesOutput.parse((await read.execute({})).output).notes).toEqual([note])
    expect(NoteOutput.parse((await read.execute({ id: 'masterplan' })).output).note).toEqual(note)
    const missing = await read.execute({ id: 'db' })
    expect(missing.isError).toBe(true)
    expect(ErrorOutput.parse(missing.output).error).toContain("'db'")
  })

  it('a replayed toolCallId returns the same note and appends nothing', async () => {
    const { write, written } = await planStep()
    const first = NoteOutput.parse((await write.execute({ id: 'db', title: 'DB', body: 'b1' }, 'call-1')).output).note
    await write.execute({ id: 'db', zone: ['src/**'] }, 'call-2')

    const replay = await write.execute({ id: 'db', title: 'DB', body: 'b1' }, 'call-1')

    expect(replay.isError).toBe(false)
    expect(NoteOutput.parse(replay.output).note).toEqual(first)
    expect(await written()).toBe(2)
  })

  it("a refusal comes back as an error carrying the kernel's message", async () => {
    const { write, written } = await planStep()
    const r = await write.execute({ id: 'db' }, 'call-1')
    expect(r.isError).toBe(true)
    expect(ErrorOutput.parse(r.output).error).toBe("plan note 'db' is new, so it needs a title")
    expect(await written()).toBe(0)
  })
})
