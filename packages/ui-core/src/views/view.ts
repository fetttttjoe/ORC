import type { z } from 'zod'
import type { EventRecord } from '@orc/contracts'
import type { State } from '@orc/kernel'
import type { Graph } from '../graph'
import type { TouchableName, ViewName, WIRE } from '../wire'

// narrow face of the read cache: no storage or subscribers, so a hand-built model can test a view
export interface ReadModel {
  readonly seq: number
  readonly events: ReadonlyArray<EventRecord>
  readonly state: State
  readonly graph: Graph
}

// inferred from the wire: a read the browser's schema would reject fails the build here
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
