import { describe, expect, it } from 'bun:test'
import { EVENT_KIND, FAILURE_CLASS, NOTE_TIER, TASK_STATUS, type EventRecord, type FailureClass, type TaskStatus } from '@orc/contracts'
import { authorFixture, eventFixture, must, planFixture, stepFixture, taskFixture } from '@orc/contracts/fixtures'
import { planScope } from '@orc/kernel'
import { artifactNodeId, modelNodeId, noteNodeId, stepNodeId } from '../graph'
import { modelOf } from '../test-helpers'
import { models } from './models'
import { node } from './node'
import { operatorStateView } from './operator-state'
import { planNotes } from './plan-notes'
import { plans } from './plans'
import { transcript } from './transcript'
import { NODE_KIND } from '../wire'

const ev = (seq: number, kind: EventRecord['kind'], taskId: string | null, payload: Record<string, unknown> = {}): EventRecord =>
  eventFixture({ seq, kind, taskId, payload })

const author = authorFixture()
const wrote = (seq: number, scope: string, id: string, note: Record<string, unknown> = {}) =>
  ev(seq, EVENT_KIND.memory_written, null, { note: { id, title: id, scope, ...note }, author })
// a run's envelope: the fold keys a step's run state off runToken/stepId, not off the payload
const ran = (seq: number, kind: EventRecord['kind'], stepId: string, payload: Record<string, unknown>): EventRecord =>
  eventFixture({ seq, kind, taskId: 'C', stepId, runToken: 'r1', payload })

// parent P, child C — the parentage every `touches` rule below reads out of the fold rather than
// out of the id string
const m = modelOf([
  ev(1, EVENT_KIND.task_created, 'P', { task: taskFixture({ id: 'P', title: 'parent' }) }),
  ev(2, EVENT_KIND.task_created, 'C', { task: taskFixture({ id: 'C', parentId: 'P', depth: 1, title: 'child' }) }),
])

describe('what one event makes stale', () => {
  it('a task event touches that task and its parent, in node, plans, plan notes and transcript', () => {
    const e = ev(10, EVENT_KIND.step_completed, 'C', { stepId: 's1', summary: 'done' })
    expect(node.touches(e, m)).toEqual([{ id: 'C' }, { id: 'P' }])
    expect(plans.touches(e, m)).toEqual([{ taskId: 'C' }, { taskId: 'P' }])
    expect(planNotes.touches(e, m)).toEqual([{ taskId: 'C' }, { taskId: 'P' }])
    expect(transcript.touches(e, m)).toEqual([{ taskId: 'C' }])
  })

  it('a root task touches only itself — there is no parent to refetch', () => {
    expect(node.touches(ev(10, EVENT_KIND.step_started, 'P', { stepId: 's1', attempt: 1 }), m)).toEqual([{ id: 'P' }])
  })

  it('agent-loop noise touches the transcript and nothing else', () => {
    const e = ev(11, EVENT_KIND.tool_call, 'C', { toolName: 'x', input: {} })
    expect(node.touches(e, m)).toEqual([])
    expect(plans.touches(e, m)).toEqual([])
    expect(planNotes.touches(e, m)).toEqual([])
    expect(transcript.touches(e, m)).toEqual([{ taskId: 'C' }])
  })

  it('an event with no task touches no task-keyed view', () => {
    const e = ev(12, EVENT_KIND.models_discovered, null, { providerId: 'a', models: ['m'] })
    expect(node.touches(e, m)).toEqual([])
    expect(transcript.touches(e, m)).toEqual([])
  })

  it('a memory write touches the note node', () => {
    expect(node.touches(wrote(13, 'project', 'n'), m)).toEqual([{ id: noteNodeId('project', 'n') }])
  })

  // A write's OWN node is not the only one it stales: a note that links to another note changes
  // what the TARGET's own `backlinks` field renders (node.ts's note branch), and nothing about the
  // target's envelope or payload says so — the write names the target only inside `note.links`.
  it('a write that links to another note touches the target too, for its backlinks', () => {
    const linked = ev(13, EVENT_KIND.memory_written, null, { note: { id: 'b', title: 'b', scope: 'project', links: [{ id: 'a' }] }, author })
    expect(node.touches(linked, m)).toEqual([{ id: noteNodeId('project', 'b') }, { id: noteNodeId('project', 'a') }])
  })

  // agent_call is deliberately off STATE_CHANGE (task-touch.ts), so taskAndParent never fires for
  // it — but it is the only event that moves usage/stepUsage/iterations, which the task node, its
  // running step and the model it ran under all return. Leaving it untouched freezes a live run's
  // spend and iteration count on every one of those three panes.
  it('agent_call touches the task, its running step, and the model it ran under', () => {
    const ref = stepFixture().modelRef
    const withPlan = modelOf([
      ev(1, EVENT_KIND.task_created, 'C', { task: taskFixture({ id: 'C' }) }),
      ev(2, EVENT_KIND.plan_proposed, 'C', { plan: planFixture({ taskId: 'C' }) }),
      ev(3, EVENT_KIND.plan_approved, 'C', { taskId: 'C', version: 1 }),
    ])
    const call = eventFixture({ seq: 4, kind: EVENT_KIND.agent_call, taskId: 'C', stepId: 's1', payload: { stepId: 's1', iteration: 1 } })
    expect(node.touches(call, withPlan)).toEqual([{ id: 'C' }, { id: stepNodeId('C', 's1') }, { id: modelNodeId(ref) }])
  })

  // Every memory kind that names a note changes what the node view ANSWERS for it: a write or a
  // delete changes the note and its backlinks, a verification changes its stamp, and a read moves
  // the `hits` count the view returns. A kind left out here is a pane that never refreshes.
  it('a delete, a verification and a read touch it too', () => {
    const stamp = { revision: 'abc', at: '2026-09-18T00:00:00.000Z', by: 'cli' }
    expect(node.touches(ev(14, EVENT_KIND.memory_deleted, null, { id: 'n', scope: 'project', author }), m))
      .toEqual([{ id: noteNodeId('project', 'n') }])
    expect(node.touches(ev(15, EVENT_KIND.memory_verified, null, { id: 'n', scope: 'project', stamp, author }), m))
      .toEqual([{ id: noteNodeId('project', 'n') }])
    expect(node.touches(ev(16, EVENT_KIND.memory_accessed, null, { id: 'n', scope: 'project', mode: 'read', author }), m))
      .toEqual([{ id: noteNodeId('project', 'n') }])
  })

  it('a memory payload that does not parse touches nothing, rather than a node id built from undefined', () => {
    expect(node.touches(ev(17, EVENT_KIND.memory_written, null, { note: { title: 'no id' } }), m)).toEqual([])
  })

  it('models are touched only by a discovery', () => {
    expect(models.touches(ev(18, EVENT_KIND.models_discovered, null, { providerId: 'a', models: ['m'] }), m)).toEqual([{}])
    expect(models.touches(ev(19, EVENT_KIND.tool_call, 'C', { toolName: 'x', input: {} }), m)).toEqual([])
  })
})

describe('node view', () => {
  it('answers null for an id nothing has', () => {
    expect(node.read(m, { id: 'nope' })).toBeNull()
  })

  // One project holding a node of every kind: the discriminant is asserted against the same
  // vocabulary the graph emits those nodes under, so a kind that stopped naming itself — or named
  // itself something the graph never says — fails here.
  it('every answer names the node kind it is about', () => {
    const ref = stepFixture().modelRef
    const whole = modelOf([
      ev(1, EVENT_KIND.task_created, 'C', { task: taskFixture({ id: 'C' }) }),
      ev(2, EVENT_KIND.plan_proposed, 'C', { plan: planFixture({ taskId: 'C' }) }),
      ev(3, EVENT_KIND.plan_approved, 'C', { taskId: 'C', version: 1 }),
      ran(4, EVENT_KIND.artifact_produced, 's1', { path: 'out.txt', sha256: 'a'.repeat(64), size: 3 }),
      eventFixture({
        seq: 5, kind: EVENT_KIND.agent_call, taskId: 'C', stepId: 's1',
        payload: { stepId: 's1', iteration: 1 },
        usage: { inputTokens: 1, outputTokens: 1, costUSD: null, estimated: false },
      }),
      wrote(6, 'project', 'n'),
    ])
    const kindOf = (id: string) => node.read(whole, { id })?.type ?? null
    expect(kindOf('C')).toBe(NODE_KIND.task)
    expect(kindOf(stepNodeId('C', 's1'))).toBe(NODE_KIND.step)
    expect(kindOf(artifactNodeId('C', 'out.txt'))).toBe(NODE_KIND.artifact)
    expect(kindOf(noteNodeId('project', 'n'))).toBe(NODE_KIND.note)
    expect(kindOf(modelNodeId(ref))).toBe(NODE_KIND.model)
  })

  it('reads a task with its steps, artifacts and memory pulls', () => {
    const withRun = modelOf([
      ev(1, EVENT_KIND.task_created, 'C', { task: taskFixture({ id: 'C', title: 'child' }) }),
      ev(2, EVENT_KIND.plan_proposed, 'C', { plan: planFixture({ taskId: 'C' }) }),
      ev(3, EVENT_KIND.plan_approved, 'C', { taskId: 'C', version: 1 }),
      ran(4, EVENT_KIND.step_started, 's1', { stepId: 's1', attempt: 1 }),
      ran(5, EVENT_KIND.artifact_produced, 's1', { path: 'out.txt', sha256: 'a'.repeat(64), size: 3 }),
      ev(6, EVENT_KIND.memory_accessed, 'C', { id: 'n', scope: 'project', mode: 'read', author }),
    ])
    expect(node.read(withRun, { id: 'C' })).toMatchObject({
      type: NODE_KIND.task,
      task: { id: 'C', title: 'child' },
      steps: [{ stepId: 's1', status: 'running' }],
      artifacts: [{ path: 'out.txt' }],
      memoryPulls: 1,
    })
  })

  it('reads a note with its access count and the notes that link to it', () => {
    const withNotes = modelOf([
      wrote(1, 'project', 'target'),
      ev(2, EVENT_KIND.memory_written, null, { note: { id: 'pointer', title: 'pointer', links: [{ id: 'target' }] }, author }),
      ev(3, EVENT_KIND.memory_accessed, null, { id: 'target', scope: 'project', mode: 'read', author }),
    ])
    expect(node.read(withNotes, { id: noteNodeId('project', 'target') })).toMatchObject({
      type: NODE_KIND.note,
      note: { id: 'target' },
      hits: 1,
      backlinks: [{ id: 'pointer' }],
    })
  })

  it('reads a step of the approved plan, and a model node with the spend of the steps that ran on it', () => {
    const ref = stepFixture().modelRef
    const withPlan = modelOf([
      ev(1, EVENT_KIND.task_created, 'C', { task: taskFixture({ id: 'C' }) }),
      ev(2, EVENT_KIND.plan_proposed, 'C', { plan: planFixture({ taskId: 'C' }) }),
      ev(3, EVENT_KIND.plan_approved, 'C', { taskId: 'C', version: 1 }),
      eventFixture({
        seq: 4, kind: EVENT_KIND.agent_call, taskId: 'C', stepId: 's1',
        payload: { stepId: 's1', iteration: 1 },
        usage: { inputTokens: 7, outputTokens: 3, costUSD: null, estimated: false },
      }),
    ])
    expect(node.read(withPlan, { id: stepNodeId('C', 's1') })).toMatchObject({ type: NODE_KIND.step, step: { id: 's1' } })
    expect(node.read(withPlan, { id: modelNodeId(ref) })).toMatchObject({
      type: NODE_KIND.model, ref, tasks: [{ taskId: 'C', calls: 1, usage: { inputTokens: 7, outputTokens: 3 } }],
    })
    // a model no step names has no lens to show, which is a 404 rather than an empty one
    expect(node.read(withPlan, { id: modelNodeId('nobody/uses-this') })).toBeNull()
    expect(node.read(withPlan, { id: artifactNodeId('C', 'out.txt') })).toBeNull()
  })
})

describe('transcript view', () => {
  it('reads the task conversation, and narrows to one step', () => {
    const talked = modelOf([
      eventFixture({ seq: 1, kind: EVENT_KIND.agent_call, taskId: 'C', stepId: 's1', payload: { stepId: 's1', iteration: 1, response: { text: 'hello there' } } }),
      eventFixture({ seq: 2, kind: EVENT_KIND.agent_call, taskId: 'C', stepId: 's2', payload: { stepId: 's2', iteration: 1, response: { text: 'elsewhere' } } }),
    ])
    expect(transcript.read(talked, { taskId: 'C' })).toEqual([
      { kind: 'message', iteration: 1, stepId: 's1', text: 'hello there' },
      { kind: 'message', iteration: 1, stepId: 's2', text: 'elsewhere' },
    ])
    expect(transcript.read(talked, { taskId: 'C', stepId: 's2' })).toEqual([{ kind: 'message', iteration: 1, stepId: 's2', text: 'elsewhere' }])
  })
})

describe('plans view', () => {
  it('answers null for a task with no plan — the caller renders "not proposed yet", not an empty plan', () => {
    expect(plans.read(m, { taskId: 'C' })).toBeNull()
  })

  it('lays the shown version out in waves, carrying each step run status', () => {
    const planned = modelOf([
      ev(1, EVENT_KIND.task_created, 'C', { task: taskFixture({ id: 'C' }) }),
      ev(2, EVENT_KIND.plan_proposed, 'C', { plan: planFixture({ taskId: 'C', steps: [stepFixture({ id: 'a' }), stepFixture({ id: 'b', dependsOn: ['a'] })] }) }),
      ev(3, EVENT_KIND.plan_approved, 'C', { taskId: 'C', version: 1 }),
      ran(4, EVENT_KIND.step_started, 'a', { stepId: 'a', attempt: 1 }),
    ])
    const view = must(plans.read(planned, { taskId: 'C' }), 'plans.read')
    expect(view.approvedVersion).toBe(1)
    expect(view.versions.map(v => v.version)).toEqual([1])
    expect(view.visual?.waves.map(w => w.steps.map(s => [s.id, s.status]))).toEqual([[['a', 'running']], [['b', 'pending']]])
  })
})

describe('plan notes view', () => {
  it('reads the decomposition notes living in the task plan scope, and nothing from another scope', () => {
    const decomposed = modelOf([
      wrote(1, planScope('C'), 'sub-a', { tier: NOTE_TIER.plan }),
      wrote(2, planScope('other'), 'sub-b', { tier: NOTE_TIER.plan }),
    ])
    expect(planNotes.read(decomposed, { taskId: 'C' })?.notes.map(n => n.id)).toEqual(['sub-a'])
  })

  // memory_written/memory_deleted carry taskId null (store.ts appends them project-scoped), so
  // taskAndParent alone (envelope-keyed) never fires for the two kinds this view's read actually
  // folds — the decomposition it exists to show went stale silently. touches has to match the
  // note's own scope against the task it belongs to instead.
  it('a memory write in the task plan scope touches that task, and a write in another scope touches nothing', () => {
    expect(planNotes.touches(wrote(3, planScope('C'), 'sub-a'), m)).toEqual([{ taskId: 'C' }])
    expect(planNotes.touches(wrote(4, 'project', 'unrelated'), m)).toEqual([])
  })

  it('a memory delete in the task plan scope touches that task too', () => {
    expect(planNotes.touches(ev(5, EVENT_KIND.memory_deleted, null, { id: 'sub-a', scope: planScope('C'), author }), m))
      .toEqual([{ taskId: 'C' }])
  })
})

describe('models view', () => {
  it('lists provider/model refs, latest discovery per provider, sorted', () => {
    const discovered = modelOf([
      ev(1, EVENT_KIND.models_discovered, null, { providerId: 'zeta', models: ['big'] }),
      ev(2, EVENT_KIND.models_discovered, null, { providerId: 'alpha', models: ['one'] }),
      ev(3, EVENT_KIND.models_discovered, null, { providerId: 'alpha', models: ['two', 'three'] }),
    ])
    expect(models.read(discovered, {})).toEqual(['alpha/three', 'alpha/two', 'zeta/big'])
    // no discovery yet is an empty catalog, never a 404: the project exists, its catalog is empty
    expect(models.read(m, {})).toEqual([])
  })
})

describe('operator state view', () => {
  const asked = [
    ev(1, EVENT_KIND.task_created, 'C', { task: taskFixture({ id: 'C' }) }),
    ev(2, EVENT_KIND.feedback_requested, 'C', { question: 'which cwd?', topic: 'cwd' }),
  ]

  it('reads the question out of the payload, not out of a summarized row', () => {
    expect(operatorStateView.read(modelOf(asked), {})?.openQuestions)
      .toEqual([{ taskId: 'C', topic: 'cwd', stepId: null, question: 'which cwd?', seq: 2 }])
  })

  // Terminality comes from the FOLD's task status, which is what makes this the view's own logic
  // rather than the fold's: a cancelled task's step is gone, so nothing can receive the reply.
  it('withdraws a question whose task reached a terminal status', () => {
    const cancelled = modelOf([...asked, ev(3, EVENT_KIND.task_status_changed, 'C', { taskId: 'C', to: TASK_STATUS.cancelled })])
    expect(operatorStateView.read(cancelled, {})?.openQuestions).toEqual([])
  })

  // A real run, folded: step_failed only moves a StepState the matching runToken already created,
  // so the started event is what makes the failure visible to the retry predicate at all.
  const ranAndFailed = (cls: FailureClass, to: TaskStatus): EventRecord[] => [
    ev(1, EVENT_KIND.task_created, 'C', { task: taskFixture({ id: 'C' }) }),
    ev(2, EVENT_KIND.plan_proposed, 'C', { plan: planFixture({ taskId: 'C' }) }),
    eventFixture({ seq: 3, kind: EVENT_KIND.step_started, taskId: 'C', stepId: 's1', runToken: 'r1', payload: { stepId: 's1', attempt: 1 } }),
    eventFixture({ seq: 4, kind: EVENT_KIND.step_failed, taskId: 'C', stepId: 's1', runToken: 'r1', payload: { stepId: 's1', class: cls, message: 'boom' } }),
    ev(5, EVENT_KIND.task_status_changed, 'C', { taskId: 'C', to }),
  ]

  // `retryable` is the kernel's own admission rule, not a parallel reading of the events. The four
  // cases below are exactly where an event-order rule ("failed until something starts again")
  // disagrees with the door that would have to serve the retry.
  describe('retryable', () => {
    it('offers a retry on a blocked task whose step malfunctioned', () => {
      expect(operatorStateView.read(modelOf(ranAndFailed(FAILURE_CLASS.agent_error, TASK_STATUS.blocked)), {})?.retryable).toEqual(['C'])
    })

    it('withdraws it once the task is cancelled — nothing will serve it again', () => {
      const gone = modelOf([
        ...ranAndFailed(FAILURE_CLASS.agent_error, TASK_STATUS.blocked),
        ev(6, EVENT_KIND.task_status_changed, 'C', { taskId: 'C', to: TASK_STATUS.cancelled }),
      ])
      expect(operatorStateView.read(gone, {})?.retryable).toEqual([])
    })

    // The door refuses this one with a paragraph explaining why; offering the button anyway is how
    // an operator ends up pressing something that provably cannot succeed.
    it('withdraws it when every failure is a verdict — a retry would reach the same verdict', () => {
      expect(operatorStateView.read(modelOf(ranAndFailed(FAILURE_CLASS.rejected, TASK_STATUS.blocked)), {})?.retryable).toEqual([])
    })

    it('offers nothing on a running task, whatever an older step did', () => {
      expect(operatorStateView.read(modelOf(ranAndFailed(FAILURE_CLASS.agent_error, TASK_STATUS.running)), {})?.retryable).toEqual([])
    })
  })

  describe('planned', () => {
    it('names the tasks the fold holds a plan for', () => {
      expect(operatorStateView.read(modelOf(ranAndFailed(FAILURE_CLASS.agent_error, TASK_STATUS.blocked)), {})?.planned).toEqual(['C'])
      expect(operatorStateView.read(modelOf(asked), {})?.planned).toEqual([])
    })

    // The difference from classifying by event KIND: a proposal nobody can read is not a plan an
    // operator can be shown, and the fold is the side that already knows that.
    it('leaves out a task whose plan proposal did not parse', () => {
      expect(operatorStateView.read(modelOf([...asked, ev(3, EVENT_KIND.plan_proposed, 'C', { plan: { nonsense: true } })]), {})?.planned).toEqual([])
    })
  })

  // Pushed: its value rides the stream frame, so it names no query to refetch.
  it('stales nothing', () => {
    expect(operatorStateView.touches(ev(4, EVENT_KIND.feedback_requested, 'C', { question: 'q', topic: 't' }), m)).toEqual([])
  })
})
