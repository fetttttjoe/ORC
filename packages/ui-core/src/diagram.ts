// contracts/plan-layering owns the layering: the browser's graph positions by the same ranks
import { layerSteps } from '@orc/contracts/plan-layering'

export interface DiagramStep { id: string; title: string; dependsOn: string[] }
// status is the step-run status from the run fold
export interface StepStatusEntry { status?: string; failureClass?: string }
export interface StepStatusLookup { get(id: string): StepStatusEntry | undefined }

export interface TodoWave {
  wave: number
  parallel: boolean
  // failureClass travels with status: a rejected step offers replan, a broken one retry
  steps: Array<{ id: string; title: string; status: string; failureClass?: string }>
}

export function todoWaves(steps: DiagramStep[], states?: StepStatusLookup): TodoWave[] {
  return layerSteps(steps).layers.map(l => ({
    wave: l.wave,
    parallel: l.parallel,
    steps: l.steps.map(s => {
      const st = states?.get(s.id)
      return { id: s.id, title: s.title, status: st?.status ?? 'pending', ...(st?.failureClass !== undefined && { failureClass: st.failureClass }) }
    }),
  }))
}
