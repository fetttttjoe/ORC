import { todoWaves, type StepStatusEntry } from '../diagram'
import { VIEW } from '../wire'
import { taskAndParent } from './task-touch'
import { defineView } from './view'

// A task's plan versions, which one is approved, and the wave layering of the version on show.
export const plans = defineView({
  name: VIEW.plans,
  push: false,

  // null = no plan proposed yet; an empty versions list would read as an emptied plan
  read(model, { taskId }) {
    const tp = model.state.plans.get(taskId)
    if (!tp) return null
    const shown = (tp.approvedVersion != null ? tp.versions.find(v => v.version === tp.approvedVersion) : undefined) ?? tp.versions.at(-1)
    // fresh Map: the raw run-status fold is never mutated; a step with no run entry is pending
    const states = new Map<string, StepStatusEntry>(
      [...(model.state.steps.get(taskId) ?? [])].map(([id, st]) =>
        [id, { status: st.status, ...(st.failure && { failureClass: st.failure.class }) }]),
    )
    return {
      versions: tp.versions,
      approvedVersion: tp.approvedVersion,
      visual: shown ? { version: shown.version, waves: todoWaves(shown.steps, states) } : null,
    }
  },

  touches: (event, model) => taskAndParent(event, model).map(taskId => ({ taskId })),
})
