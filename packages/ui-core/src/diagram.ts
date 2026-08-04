// The wave layering the request view and the conversation cards render, in the shape those
// surfaces want (ids, titles and run statuses per wave).
//
// The LAYERING itself is not decided here — contracts/plan-layering owns it, because the browser's
// dependency graph positions by the same ranks and the two used to compute them separately. They
// disagreed on cyclic plans: this file used to drop those steps, the graph parked them, so one
// plan rendered with different steps depending on the surface. One algorithm, two presentations.
//
// This file also used to emit mermaid text (planMermaid / decompositionMermaid). Both went when
// the console stopped rendering them — the browser dropped the mermaid dependency and now draws
// the plan itself, so the strings were built and shipped on every request with no reader. The
// vault's DAGs are a SEPARATE renderer (vault-projector/src/render.ts) and are unaffected: it
// emits mermaid into markdown, which is the only thing that renders in a vault.
import { layerSteps } from '@orc/contracts/plan-layering'

export interface DiagramStep { id: string; title: string; dependsOn: string[] }
// `status` is the step-RUN status (from the run fold). The `approved` bit that used to sit beside
// it existed only to give mermaid an 'armed' class; nothing reads it now, and a field kept "just
// in case" is a field that quietly stops being maintained.
export interface StepStatusEntry { status?: string; failureClass?: string }
export interface StepStatusLookup { get(id: string): StepStatusEntry | undefined }

export interface TodoWave {
  wave: number
  parallel: boolean
  // `failureClass` travels with the status because "it failed" and "why" are one fact to every
  // surface that renders it: a REJECTED step offers replan, a broken one offers retry, and a rail
  // carrying only `status` forces each consumer to go re-fetch the reason separately.
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
