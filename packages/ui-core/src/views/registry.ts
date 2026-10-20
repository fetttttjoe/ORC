import type { z } from 'zod'
import type { EventRecord } from '@orc/contracts'
import { issueLine } from '@orc/contracts/guards'
import { ViewName, WIRE, type Touch } from '../wire'
import type { ProjectSessions } from '../sessions'
import type { ReadModel, Touchable, View, ViewParams, ViewResult } from './view'
import { models } from './models'
import { node } from './node'
import { operatorStateView } from './operator-state'
import { planNotes } from './plan-notes'
import { plans } from './plans'
import { chats } from './chats'
import { timeline } from './timeline'
import { transcript } from './transcript'

type ViewTable = Partial<{ [N in ViewName]: View<N> }>

export const VIEWS = { timeline, chats, node, transcript, plans, planNotes, models, operatorState: operatorStateView } satisfies ViewTable
// fails the build when a view is named on the wire and never implemented
type Implemented = keyof typeof VIEWS
export type ViewsCoverNames = Exclude<ViewName, Implemented> extends never ? true : never
const _covers: ViewsCoverNames = true
void _covers

// widened for runtime names; the mapped key forces each entry's name to equal its key
const BY_NAME: ViewTable = VIEWS

// name is the resolved view: a second lookup in a door could disagree with the first
export type ViewOutcome =
  | { ok: true; name: ViewName; seq: number; data: unknown }
  | { ok: false; status: 400 | 404; error: string }

// a mapped type over N: the form the compiler keeps from widening to every view's params
type ParamSchemas<N extends ViewName> = { [K in N]: { params: z.ZodType<ViewParams<K>> } }

const answer = <N extends ViewName>(view: View<N>, wire: ParamSchemas<N>, model: ReadModel, raw: unknown): ViewOutcome => {
  const parsed = wire[view.name].params.safeParse(raw)
  if (!parsed.success) {
    // .at(0) not [0]: an issue-less ZodError would answer 'undefined: undefined'
    const issue = parsed.error.issues.at(0)
    return { ok: false, status: 400, error: issue ? issueLine(issue) : 'params did not match the schema' }
  }
  const data = view.read(model, parsed.data)
  return data === null ? { ok: false, status: 404, error: `${view.name}: not found` } : { ok: true, name: view.name, seq: model.seq, data }
}

// the one read path, HTTP-free; an unknown name and an unimplemented view are one answer
export function readView(model: ReadModel, name: string, rawParams: unknown): ViewOutcome {
  const known = ViewName.safeParse(name)
  const view = known.success ? BY_NAME[known.data] : undefined
  if (!view) return { ok: false, status: 404, error: `unknown view: ${name}` }
  return answer(view, WIRE, model, rawParams)
}

// in-process read: typed params and result, no re-parse; null = the view's no such subject
export async function viewOf<N extends ViewName>(
  sessions: Pick<ProjectSessions, 'model'>, projectId: string, name: N, params: ViewParams<N>,
): Promise<ViewResult<N> | null> {
  const view = BY_NAME[name]
  const model = await sessions.model(projectId)
  return view ? view.read(model, params) : null
}

// the list is the registry itself: a read missing here is a pane that never refreshes
const TOUCHABLES: ReadonlyArray<Touchable> = Object.values(VIEWS)

// what an appended event makes stale: lets the stream frame stay a notification
export const touchesOf = (event: EventRecord, model: ReadModel): Touch[] =>
  TOUCHABLES.flatMap(t => t.touches(event, model).map(params => ({ name: t.name, params })))
