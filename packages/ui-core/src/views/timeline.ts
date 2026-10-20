import { inScope } from '@orc/contracts'
import { summarizeEvent } from '../summarize'
import { VIEW } from '../wire'
import { scopeIndexOf, scopePatternsOf } from './scope-index'
import { defineView } from './view'

// The event feed of one scope, one summary row per event, newest last.
export const timeline = defineView({
  name: VIEW.timeline,
  push: false,

  // narrow before the slice so a poller after seq N gets the newest matches; empty kinds = no filter
  read(model, { scope, kinds, sinceSeq, beforeSeq, limit = 200 }) {
    const index = scopeIndexOf(model)
    const kindSet = kinds && kinds.length > 0 ? new Set<string>(kinds) : null
    return model.events.filter(e =>
      (sinceSeq === undefined || e.seq > sinceSeq) && (beforeSeq === undefined || e.seq < beforeSeq)
      && (kindSet === null || kindSet.has(e.kind)) && inScope(e, scope, index))
      .slice(-limit).map(summarizeEvent)
  },

  // built from the event's own workspace, task and chat: a bare [{}] refetched every chat pane
  touches: scopePatternsOf,
})
