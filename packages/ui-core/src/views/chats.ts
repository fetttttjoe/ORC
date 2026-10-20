import { chatDigests, EVENT_KIND, inScope, PAYLOAD_SCHEMAS, ScopeType } from '@orc/contracts'
import { VIEW } from '../wire'
import { scopeIndexOf, scopePatternsOf } from './scope-index'
import { defineView } from './view'

// newest-opened first; every field derived from the log by chatDigests
export const chats = defineView({
  name: VIEW.chats,
  push: false,

  // in scope = any of the chat's events is: filtered digests would sum a partial cost
  read(model, { scope }) {
    const index = scopeIndexOf(model)
    const ids = new Set<string>()
    for (const event of model.events) if (event.chatId !== null && inScope(event, scope, index)) ids.add(event.chatId)
    return chatDigests(model.events).filter(d => ids.has(d.chatId))
  },

  // the rule is the event's scopes, not a kind list: a list missed kinds and served stale digests
  touches(event, model) {
    if (event.chatId === null) return []
    const patterns = scopePatternsOf(event, model)
    if (event.kind !== EVENT_KIND.chat_opened) return patterns
    const opened = PAYLOAD_SCHEMAS.chat_opened.safeParse(event.payload)
    if (opened.success && opened.data.parent !== null) patterns.push({ scope: { type: ScopeType.chat, id: opened.data.parent.chatId } })
    return patterns
  },
})
