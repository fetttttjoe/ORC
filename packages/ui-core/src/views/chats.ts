import { chatDigests, EVENT_KIND, inScope, PAYLOAD_SCHEMAS, ScopeType } from '@orc/contracts'
import { VIEW } from '../wire'
import { scopeIndexOf, scopePatternsOf } from './scope-index'
import { defineView } from './view'

// The chats of one scope, newest-opened first — every field derived from the log by chatDigests.
export const chats = defineView({
  name: VIEW.chats,
  push: false,

  // IN SCOPE = any of the chat's events is. Digesting the FILTERED events instead would sum a
  // partial cost and drop the end of a run whose status change fell outside the scope.
  read(model, { scope }) {
    const index = scopeIndexOf(model)
    const ids = new Set<string>()
    for (const event of model.events) if (event.chatId !== null && inScope(event, scope, index)) ids.add(event.chatId)
    return chatDigests(model.events).filter(d => ids.has(d.chatId))
  },

  // Every event carrying a chatId moves that chat's digest — its lastSeq and usage at the least —
  // so the rule is the event's scopes, not a list of the kinds the fold reads: three kinds the fold
  // read were missing from such a list in review, and each served a stale digest forever. A child's
  // open is the one event that also moves a digest it does NOT belong to: the parent's caused.runs
  // is read off it.
  touches(event, model) {
    if (event.chatId === null) return []
    const patterns = scopePatternsOf(event, model)
    if (event.kind !== EVENT_KIND.chat_opened) return patterns
    const opened = PAYLOAD_SCHEMAS.chat_opened.safeParse(event.payload)
    if (opened.success && opened.data.parent !== null) patterns.push({ scope: { type: ScopeType.chat, id: opened.data.parent.chatId } })
    return patterns
  },
})
