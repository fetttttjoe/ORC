// EventSource plumbing only: parse the frame, ask frame-plan.ts what it means, apply the plan
import { QueryClient } from '@tanstack/svelte-query'
import { fetchView, invalidateTouch } from '$lib/api/view-client'
import type { ProjectEntry } from '$lib/api/types'
import { Envelope as EnvelopeSchema } from '$lib/api/schemas'
import { VIEW } from '@orc/ui-core/wire'
import { ScopeType } from '@orc/contracts/scope'
import { ID_LESS_SEQ, planFrame } from '$lib/frame-plan'
import { graph } from '$lib/stores/graph.svelte'
import { ledger } from '$lib/stores/ledger.svelte'
import { operator } from '$lib/stores/operator.svelte'

export interface StreamHandle {
  close(): void
}

export function connectStream(opts: {
  project: string
  fromSeq: number
  queryClient: QueryClient
  onProjects: (p: ProjectEntry[]) => void
  onLive: (live: boolean) => void
  onSeqRegression: () => void
}): StreamHandle {
  const { project, queryClient } = opts

  // a catch-up frame (patch, no summary) means the narrative missed a window — refill it
  const backfill = (): void => {
    const from = ledger.lastRowSeq
    // the ledger is the whole project's narrative, so its backfill is a project-scoped read
    void fetchView(project, VIEW.timeline, { scope: { type: ScopeType.project }, sinceSeq: from })
      .then(({ data }) => {
        for (const row of data ?? []) ledger.add(row)
      })
      .catch(() => {})
  }

  const es = new EventSource(`/api/stream?project=${encodeURIComponent(project)}&fromSeq=${opts.fromSeq}`)
  es.onopen = () => opts.onLive(true)
  es.onerror = () => opts.onLive(false)
  es.onmessage = ev => {
    const frame = EnvelopeSchema.safeParse(JSON.parse(ev.data))
    if (!frame.success) {
      // drop a half-understood frame and say so; the next cumulative patch self-heals it
      console.error('stream: envelope did not match its schema —', frame.error.issues[0]?.message)
      return
    }
    const envSeq = Number(ev.lastEventId) || ID_LESS_SEQ
    const plan = planFrame(graph.seq, envSeq, frame.data)
    if (plan.projects) opts.onProjects(plan.projects)
    // operator/touched apply before the regression return: planFrame never withholds them
    if (plan.operator) operator.state = plan.operator
    for (const t of plan.touched) invalidateTouch(queryClient, project, t)
    if (plan.regression) {
      opts.onSeqRegression()
      return
    }
    if (plan.seq !== null) graph.seq = plan.seq
    if (plan.patch) graph.applyPatch(plan.patch)
    if (plan.summary) ledger.add(plan.summary)
    else if (plan.backfill) backfill()
    opts.onLive(true)
  }
  return { close: () => es.close() }
}
