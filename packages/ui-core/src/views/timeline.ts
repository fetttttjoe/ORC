import { inScope } from '@orc/contracts'
import { summarizeEvent } from '../summarize'
import { VIEW } from '../wire'
import { scopeIndexOf, scopePatternsOf } from './scope-index'
import { defineView } from './view'

// The event feed of one scope, one summary row per event, newest last.
export const timeline = defineView({
  name: VIEW.timeline,
  push: false,

  // Every narrowing input — scope, seq bounds, kinds — reads off the EventRecord, so all of it runs
  // in one pass over the events and summarizeEvent sees at most `limit` of them, never the whole log.
  // inScope is the one membership rule: a project-scoped row belongs to the task its author
  // names, never to every task filter.
  // Narrowing must precede the slice, so a poller asking for "everything after seq N" gets the newest
  // MATCHING rows rather than the newest `limit` events of which none are new.
  // An EMPTY `kinds` is NO filter, not a filter matching nothing: a caller whose kind selection came
  // out empty is asking for whatever happened, and the schema agrees rather than rejecting it.
  read(model, { scope, kinds, sinceSeq, beforeSeq, limit = 200 }) {
    const index = scopeIndexOf(model)
    const kindSet = kinds && kinds.length > 0 ? new Set<string>(kinds) : null
    return model.events.filter(e =>
      (sinceSeq === undefined || e.seq > sinceSeq) && (beforeSeq === undefined || e.seq < beforeSeq)
      && (kindSet === null || kindSet.has(e.kind)) && inScope(e, scope, index))
      .slice(-limit).map(summarizeEvent)
  },

  // Every scope this event lands in, and no other: the pattern is built from the event's own
  // workspace/task/chat, so a chat pane holding its transcript is not refetched by another chat's
  // traffic — which a bare `[{}]` did, at agent-loop cadence.
  touches: scopePatternsOf,
})
