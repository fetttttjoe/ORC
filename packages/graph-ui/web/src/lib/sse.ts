// envelope fan-out: patch → graph, summary → ledger + query invalidation
import { QueryClient } from '@tanstack/svelte-query'
import { api } from '$lib/api/client'
import type { Envelope, ProjectEntry } from '$lib/api/types'
import { Envelope as EnvelopeSchema } from '$lib/api/schemas'
import { graph } from '$lib/stores/graph.svelte'
import { ledger } from '$lib/stores/ledger.svelte'
import { invalidations } from '$lib/invalidation'
import { EVENT_KIND } from '$lib/event-kinds'
import { TERMINAL_TASK_STATUS, TaskStatus } from '@orc/contracts/task'


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

  const applyRow = (row: Parameters<typeof ledger.add>[0]): void => {
    if (!ledger.add(row)) return
    if (row.kind === EVENT_KIND.task_status_changed && row.taskId) {
      const status = TaskStatus.safeParse(graph.taskStatus(row.taskId))
      ledger.retireGatesFor(row.taskId, status.success && TERMINAL_TASK_STATUS.has(status.data))
    }
    for (const key of invalidations(row, id => graph.parentOf(id))) void queryClient.invalidateQueries({ queryKey: key })
  }

  // a catch-up frame (patch, no summary) means the narrative missed a window — refill it
  const backfill = (): void => {
    const from = ledger.lastRowSeq
    void api
      .log(project, { sinceSeq: from })
      .then(rows => {
        for (const row of rows) applyRow(row)
      })
      .catch(() => {})
  }

  const es = new EventSource(`/api/stream?project=${encodeURIComponent(project)}&fromSeq=${opts.fromSeq}`)
  es.onopen = () => opts.onLive(true)
  es.onerror = () => opts.onLive(false)
  es.onmessage = ev => {
    const frame = EnvelopeSchema.safeParse(JSON.parse(ev.data))
    if (!frame.success) {
      // never apply a half-understood frame to the graph store: drop it and say so. The next
      // envelope carries a cumulative patch, so one rejected frame self-heals.
      console.error('stream: envelope did not match its schema —', frame.error.issues[0]?.message)
      return
    }
    const env: Envelope = frame.data
    const envSeq = Number(ev.lastEventId) || 0
    if (env.projects) opts.onProjects(env.projects)
    // seq went backwards: the log was reset out-of-band, resync from a snapshot
    if (envSeq && envSeq < graph.seq) {
      opts.onSeqRegression()
      return
    }
    if (envSeq) graph.seq = envSeq
    if (env.patch) graph.applyPatch(env.patch)
    if (env.summary) applyRow(env.summary)
    else if (env.patch) backfill()
    opts.onLive(true)
  }
  return { close: () => es.close() }
}
