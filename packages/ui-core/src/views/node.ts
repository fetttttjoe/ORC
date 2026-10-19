import { EVENT_KIND, ZERO_USAGE, addUsage, type EventRecord, type Usage } from '@orc/contracts'
import { stepUsage, taskUsage } from '@orc/kernel'
import { NODE_PREFIX, modelNodeId, stepNodeId } from '../graph'
import { NODE_KIND, VIEW, type ModelDetail } from '../wire'
import { taskAndParent } from './task-touch'
import { defineView, type ReadModel } from './view'

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
    }
  },

  // A task node and its parent, and — for `agent_call` — the task/step/model ids its usage lands on.
  touches: (event, model) => [...taskAndParent(event, model), ...agentCallTargets(event, model)].map(id => ({ id })),
})
