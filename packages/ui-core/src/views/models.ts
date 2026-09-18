import { EVENT_KIND, ModelsDiscoveredPayload, type EventRecord } from '@orc/contracts'
import { VIEW } from '../wire'
import { defineView } from './view'

// latest models_discovered per provider IS the catalog (append-on-change upstream)
function foldModelCatalog(events: ReadonlyArray<Pick<EventRecord, 'kind' | 'payload'>>): Map<string, string[]> {
  const catalog = new Map<string, string[]>()
  for (const e of events) {
    if (e.kind !== EVENT_KIND.models_discovered) continue
    const p = ModelsDiscoveredPayload.safeParse(e.payload)
    if (p.success) catalog.set(p.data.providerId, p.data.models)
  }
  return catalog
}

// The event-sourced model catalog, as the `provider/model` refs every door names a model by.
export const models = defineView({
  name: VIEW.models,
  push: false,

  // [] until a discovery has been appended — an empty catalog, never a missing one: the project
  // exists whether or not anyone has asked a provider what it serves.
  read: model => [...foldModelCatalog(model.events).entries()].flatMap(([pid, refs]) => refs.map(m => `${pid}/${m}`)).sort(),

  // Nothing else can change it: the catalog is exactly the discovery events.
  touches: event => (event.kind === EVENT_KIND.models_discovered ? [{}] : []),
})
