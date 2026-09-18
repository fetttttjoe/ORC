import { EVENT_KIND, PAYLOAD_SCHEMAS, ZERO_USAGE, addUsage, noteLabel, type EventRecord, type MemoryLink, type Usage } from '@orc/contracts'
import { stepUsage, taskUsage } from '@orc/kernel'
import { NODE_PREFIX, modelNodeId, noteNodeId, stepNodeId } from '../graph'
import { NODE_KIND, VIEW, type ModelDetail } from '../wire'
import { taskAndParent } from './task-touch'
import { defineView, type ReadModel } from './view'

// Which note a memory event is ABOUT, and — for a write — which OTHER notes its links point at.
// Neither comes from the envelope: memory events carry taskId null (a note is a project-level
// fact), so both live in the payload and nowhere else. Each kind spells the subject differently,
// hence one entry per kind rather than one shared parse; `links` is only ever populated for a
// write, since only a write's payload carries the note's current link list.
const NOTE_SUBJECT: Partial<Record<EventRecord['kind'], (payload: unknown) => { scope: string; id: string; links?: readonly MemoryLink[] } | null>> = {
  [EVENT_KIND.memory_written]: p => {
    const d = PAYLOAD_SCHEMAS.memory_written.safeParse(p)
    return d.success ? { scope: d.data.note.scope, id: d.data.note.id, links: d.data.note.links } : null
  },
  [EVENT_KIND.memory_deleted]: p => {
    const d = PAYLOAD_SCHEMAS.memory_deleted.safeParse(p)
    return d.success ? { scope: d.data.scope, id: d.data.id } : null
  },
  [EVENT_KIND.memory_verified]: p => {
    const d = PAYLOAD_SCHEMAS.memory_verified.safeParse(p)
    return d.success ? { scope: d.data.scope, id: d.data.id } : null
  },
  // a read moves the `hits` this view returns; leaving it out freezes that counter on the pane
  [EVENT_KIND.memory_accessed]: p => {
    const d = PAYLOAD_SCHEMAS.memory_accessed.safeParse(p)
    return d.success ? { scope: d.data.scope, id: d.data.id } : null
  },
}

// The model ref a task/step pair ran under, read off the SAME approved-version lookup the model
// node's own `read` branch above sums usage over — so an `agent_call` touches exactly the model
// node its answer walks back to, never a second guess at which step named which ref.
function modelRefOf(model: ReadModel, taskId: string, stepId: string): string | null {
  const tp = model.state.plans.get(taskId)
  const version = tp?.approvedVersion != null ? tp.versions.find(v => v.version === tp.approvedVersion) : undefined
  return version?.steps.find(st => st.id === stepId)?.modelRef ?? null
}

// `agent_call` is off STATE_CHANGE (task-touch.ts), so `taskAndParent` never fires for it — but it
// moves usage/stepUsage/iterations, which the task node, its running step, and the model it ran
// under all return (see the task/step/model branches of `read` above). None of those three ids
// comes from a shared task-keyed rule; `plans`/`planNotes`/`transcript` do not need this event.
function agentCallTargets(event: EventRecord, model: ReadModel): string[] {
  if (event.kind !== EVENT_KIND.agent_call || event.taskId === null || event.stepId === null) return []
  const ref = modelRefOf(model, event.taskId, event.stepId)
  return [event.taskId, stepNodeId(event.taskId, event.stepId), ...(ref ? [modelNodeId(ref)] : [])]
}

// One graph node, in the shape its pane renders. The id says which kind: the prefixes are the
// graph's own (graph-wire's NODE_PREFIX), so a node the graph emitted can always be asked about.
export const node = defineView({
  name: VIEW.node,
  push: false,

  // Every answer says which KIND it is, in the node vocabulary the graph already speaks: that is
  // the union's discriminant, so each branch below is checked against its own wire shape and a
  // renamed field fails the build instead of reaching a pane that cannot parse it.
  read(model, { id: nodeId }) {
    if (nodeId.startsWith(NODE_PREFIX.step)) {
      const [, taskId, stepId] = nodeId.split(':')
      if (!taskId || !stepId) return null
      const plans = model.state.plans.get(taskId)
      const plan = plans?.approvedVersion != null ? plans.versions.find(v => v.version === plans.approvedVersion) : undefined
      const step = plan?.steps.find(st => st.id === stepId)
      if (!step) return null
      return { type: NODE_KIND.step, step, run: model.state.steps.get(taskId)?.get(stepId) ?? null }
    }
    if (nodeId.startsWith(NODE_PREFIX.artifact)) {
      const [, taskId, ...pathParts] = nodeId.split(':')
      const path = pathParts.join(':') // artifact paths may contain ':'
      const record = (model.state.artifacts.get(taskId ?? '') ?? []).find(a => a.path === path)
      return record ? { type: NODE_KIND.artifact, ...record } : null
    }
    if (nodeId.startsWith(NODE_PREFIX.model)) {
      // performance lens: every task this model took over, with per-model usage summed from
      // the agent_call events of exactly the steps that ran on it
      const ref = nodeId.slice(NODE_PREFIX.model.length)

      const tasks: ModelDetail['tasks'] = []
      // summed here rather than re-reduced over `tasks`: the wire calls a task's usage optional
      // (a pane may render a row before spend is known), and re-reading it back out of the list
      // would make the total depend on that optionality instead of on the events just counted
      let totals: Usage = ZERO_USAGE
      for (const t of model.state.tasks.values()) {
        const tp = model.state.plans.get(t.id)
        const plan = tp?.approvedVersion != null ? tp.versions.find(v => v.version === tp.approvedVersion) : undefined
        const stepIds = new Set((plan?.steps ?? []).filter(st => st.modelRef === ref).map(st => st.id))
        if (stepIds.size === 0) continue
        let usage: Usage = ZERO_USAGE
        let calls = 0
        for (const e of model.events) {
          if (e.kind !== EVENT_KIND.agent_call || e.taskId !== t.id || !e.stepId || !stepIds.has(e.stepId) || !e.usage) continue
          usage = addUsage(usage, e.usage)
          calls++
        }
        tasks.push({ taskId: t.id, title: t.title, status: t.status, calls, usage })
        totals = addUsage(totals, usage)
      }
      if (tasks.length === 0) return null
      return { type: NODE_KIND.model, ref, tasks, totals }
    }
    if (nodeId.startsWith(NODE_PREFIX.note)) {
      const key = nodeId.slice(NODE_PREFIX.note.length) // `${scope}\u0000${id}`
      const live = model.memory.notes
      const payload = live.get(key)
      if (!payload) return null
      const [scope, id] = key.split('\u0000')
      const hits = model.memory.access.get(key)?.hits ?? 0
      // backlinks: notes whose links target this note (links resolve same-scope)
      const backlinks = [...live.values()]
        .filter(({ note }) => note.scope === scope && note.links.some(l => l.id === id))
        .map(({ note }) => ({ id: note.id, scope: note.scope, title: note.title, kind: noteLabel(note) }))
      // paths / categories / claims / sources belong to the SEMANTIC tier alone — a plan or
      // episodic note has no such fields — but every reader of a note renders them the same way,
      // so they are seeded empty and overwritten by whatever the note itself carries. Without the
      // seed the two sides disagree on what "absent" means: the schema fills it in for the browser
      // while a tool reading this value in-process gets undefined and has to guard per field.
      return {
        type: NODE_KIND.note,
        ...payload,
        note: { paths: [], categories: [], claims: [], sources: [], ...payload.note },
        hits,
        backlinks,
      }
    }
    const task = model.state.tasks.get(nodeId)
    if (!task) return null
    // artifacts dedup by (path, sha): a verify step re-declaring the same output is one
    // artifact, not two — the raw per-event list stays available on the artifact node itself
    const arts = new Map((model.state.artifacts.get(nodeId) ?? []).map(a => [`${a.path}\u0000${a.sha256}`, a] as const))
    return {
      type: NODE_KIND.task,
      task,
      usage: taskUsage(model.state, nodeId),
      steps: [...(model.state.steps.get(nodeId)?.values() ?? [])].map(st => ({ ...st, usage: stepUsage(model.state, nodeId, st.stepId) })),
      artifacts: [...arts.values()],
      // token-economy made visible: how often this task pulled knowledge instead of re-reading
      // (memory_accessed envelopes are task-bound since the store threads author identity)
      memoryPulls: model.events.filter(e => e.kind === EVENT_KIND.memory_accessed && e.taskId === nodeId).length,
    }
  },

  // A task node and its parent, the note node a memory event is about, the notes ITS links point
  // at (a write changes what those notes' own `backlinks` render, not just its own node), and —
  // for `agent_call` — the task/step/model ids its usage lands on. A payload that does not parse
  // touches nothing: a node id built from an undefined scope names no node, and a refetch of it
  // answers 404 forever.
  touches: (event, model) => {
    const subject = NOTE_SUBJECT[event.kind]?.(event.payload)
    const linkTargets = subject ? (subject.links ?? []).map(l => noteNodeId(subject.scope, l.id)) : []
    return [
      ...taskAndParent(event, model),
      ...(subject ? [noteNodeId(subject.scope, subject.id)] : []),
      ...linkTargets,
      ...agentCallTargets(event, model),
    ].map(id => ({ id }))
  },
})
