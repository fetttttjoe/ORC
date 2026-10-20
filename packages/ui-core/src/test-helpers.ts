// one spelling of 'a read model built from these events', shared with the CLI's tool tests
import type { EventRecord } from '@orc/contracts'
import { emptyFold, foldInto } from '@orc/kernel'
import { buildGraph } from './graph'
import type { ReadModel } from './views/view'

// folded from a hand-written log: a view answering from more than ReadModel could not be tested so
export const modelOf = (events: ReadonlyArray<EventRecord>): ReadModel => {
  const acc = events.reduce(foldInto, emptyFold())
  return { seq: events.at(-1)?.seq ?? 0, events, state: acc.state, graph: buildGraph(acc.state) }
}
