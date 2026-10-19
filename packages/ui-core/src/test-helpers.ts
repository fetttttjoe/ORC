// Test scaffolding for anything that reads through a view: ONE spelling of "a read model built
// from these events", shared with the packages that compose this one (the CLI's served-tool tests
// build their session stub on it).
import type { EventRecord } from '@orc/contracts'
import { emptyFold, foldInto } from '@orc/kernel'
import { buildGraph } from './graph'
import type { ReadModel } from './views/view'

// What a session would hold, folded from a hand-written log — no database, no subscription. A view
// that answered from anything but `ReadModel` could not be exercised this way, which is as much
// the property under test as any assertion made with it; and a door test can hand a tool a real
// log instead of a canned answer, so a tool can never be fed a shape the fold could not produce.
export const modelOf = (events: ReadonlyArray<EventRecord>): ReadModel => {
  const acc = events.reduce(foldInto, emptyFold())
  return { seq: events.at(-1)?.seq ?? 0, events, state: acc.state, graph: buildGraph(acc.state) }
}
