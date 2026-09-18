import { shouldAdmitLogRow, summarizeEvent, type LogRow } from '../summarize'
import { VIEW } from '../wire'
import { defineView } from './view'

// The project's event feed, one summary row per event, newest last.
export const timeline = defineView({
  name: VIEW.timeline,
  push: false,

  // Untargeted (`taskId` undefined = whole-project Conversation view): every event, unfiltered —
  // slice then summarize, so a 20-row pane never summarizes the whole log. Task-scoped: summarize,
  // then route through shouldAdmitLogRow — the ONE per-task admission rule, and server-side on
  // purpose: the browser asks for a task's rows rather than filtering a whole-project tail itself,
  // so a project-scoped memory row is admitted only when payload.author.taskId matches the filter,
  // never blanket-admitted by null taskId. Filter must precede slice to return the last `limit`
  // MATCHING rows, not the last `limit` events of which few may match. `sinceSeq`/`kinds` narrow
  // the SAME rows before the slice, for the same reason the task filter does: a poller asking for
  // "everything after seq N" must get the newest matching rows, not the newest `limit` events of
  // which few (or none) are new. An EMPTY `kinds` is NO filter, not a filter matching nothing: a
  // caller whose kind selection came out empty is asking for whatever happened, and the schema
  // agrees rather than rejecting it.
  read(model, { taskId, kinds, sinceSeq, beforeSeq, limit = 200 }) {
    const kindSet = kinds && kinds.length > 0 ? new Set<string>(kinds) : null
    const narrow = (rows: LogRow[]) => rows.filter(r =>
      (sinceSeq === undefined || r.seq > sinceSeq) && (beforeSeq === undefined || r.seq < beforeSeq) && (kindSet === null || kindSet.has(r.kind)))
    if (taskId === undefined && sinceSeq === undefined && beforeSeq === undefined && kindSet === null) return model.events.slice(-limit).map(summarizeEvent)
    if (taskId === undefined) return narrow(model.events.map(summarizeEvent)).slice(-limit)
    return narrow(model.events.map(summarizeEvent).filter(r => shouldAdmitLogRow(r, taskId))).slice(-limit)
  },

  // Any event lands in some window of the feed, so every timeline query is stale. A narrower
  // pattern would have to decide here whether this event's kind is in a query's kind set and
  // whether its payload attributes it to a query's task — that is shouldAdmitLogRow's rule again,
  // and a second copy of it in the invalidation path is the disagreement this seam exists to
  // prevent.
  touches: () => [{}],
})
