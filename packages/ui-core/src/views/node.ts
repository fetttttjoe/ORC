import { EVENT_KIND, ZERO_USAGE, addUsage, type EventRecord, type Usage } from '@orc/contracts'
import { stepUsage, taskUsage } from '@orc/kernel'
import { NODE_PREFIX, modelNodeId, stepNodeId } from '../graph'
import { NODE_KIND, VIEW, type ModelDetail } from '../wire'
import { taskAndParent } from './task-touch'
import { defineView, type ReadModel } from './view'

// reads the same approved-version lookup the model node sums over, so agent_call touches one node
function modelRefOf(model: ReadModel, taskId: string, stepId: string): string | null {
  const tp = model.state.plans.get(taskId)
  const version = tp?.approvedVersion != null ? tp.versions.find(v => v.version === tp.approvedVersion) : undefined
  return version?.steps.find(st => st.id === stepId)?.modelRef ?? null
}

// agent_call is off STATE_CHANGE, so taskAndParent misses it; it moves task, step, model nodes
function agentCallTargets(event: EventRecord, model: ReadModel): string[] {
  if (event.kind !== EVENT_KIND.agent_call || event.taskId === null || event.stepId === null) return []
  const ref = modelRefOf(model, event.taskId, event.stepId)
  return [event.taskId, stepNodeId(event.taskId, event.stepId), ...(ref ? [modelNodeId(ref)] : [])]
}

// the id's prefix is the graph's own (NODE_PREFIX): a node the graph emitted can be asked about
export const node = defineView({
  name: VIEW.node,
  push: false,

  // each answer names its kind (the union's discriminant): a renamed field fails the build
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
      // every task this model took over, with usage summed from the agent_call events of its steps
      const ref = nodeId.slice(NODE_PREFIX.model.length)

      const tasks: ModelDetail['tasks'] = []
      // summed here: the wire's usage is optional per task, and re-reading it would depend on that
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
    // dedup by (path, sha): a verify step re-declaring an output is one artifact
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
