import type { z } from 'zod'
import type { EventRecord } from '@orc/contracts'
import type { State } from '@orc/kernel'
import type { Graph } from '../graph'
import type { TouchableName, ViewName, WIRE } from '../wire'

// The narrow face of the read cache. A view sees folded state and the events behind it — never
// storage, never subscribers — so it can be tested against a hand-built model and answered from
// any door without that door knowing how the cache is kept.
export interface ReadModel {
  readonly seq: number
  readonly events: ReadonlyArray<EventRecord>
  readonly state: State
  readonly graph: Graph
}

// Params and result are the WIRE's, inferred rather than re-declared: a read that returns a shape
// the browser's schema would reject then fails the build here instead of parsing to nothing there.
export type ViewParams<N extends ViewName> = z.infer<(typeof WIRE)[N]['params']>
export type ViewResult<N extends ViewName> = z.infer<(typeof WIRE)[N]['result']>

/** A named thing one event can make stale; the rule lives beside whatever owns the thing. */
export interface Touchable<P = Record<string, unknown>> {
  name: TouchableName
  /** the param PATTERNS this event makes stale; `[{}]` means "every query of mine" */
  touches(event: EventRecord, model: ReadModel): Array<P>
}

export interface View<N extends ViewName> extends Touchable<Partial<ViewParams<N>>> {
  name: N
  // a pushed view ships its value inside the stream frame; the rest ship a touch and are refetched
  push: boolean
  // null is "no such thing" (the route answers 404), never "empty"
  read(model: ReadModel, params: ViewParams<N>): ViewResult<N> | null
}

export const defineView = <N extends ViewName>(v: View<N>): View<N> => v
