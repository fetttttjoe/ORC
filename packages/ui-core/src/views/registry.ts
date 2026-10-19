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
// Fails the build when a view is named on the wire and never implemented: the route would answer
// 404 for a name the browser was told exists.
type Implemented = keyof typeof VIEWS
export type ViewsCoverNames = Exclude<ViewName, Implemented> extends never ? true : never
const _covers: ViewsCoverNames = true
void _covers

// The same table under its widened type, because a name resolved at runtime is a `ViewName` and
// cannot index the exact one. `VIEWS` keeps the exact type so the guard above can still see which
// names are missing; the mapped key forces each entry's `name` to equal its key, so a lookup here
// can never hand back a view answering under another view's name.
const BY_NAME: ViewTable = VIEWS

// `name` is the RESOLVED view. Carried out rather than left for the caller to re-derive: a door
// that needs to know which view answered would otherwise run the enum lookup a second time, and a
// resolution rule spelled twice is one that can disagree with itself.
export type ViewOutcome =
  | { ok: true; name: ViewName; seq: number; data: unknown }
  | { ok: false; status: 400 | 404; error: string }

// The wire's schemas, correlated to the view being answered. Spelled as a mapped type over `N`
// rather than as `(typeof WIRE)[N]['params']` because indexing a MAPPED type by its own key
// parameter is the one form the compiler simplifies back to `ViewParams<N>`. Measured: a plain
// indexed access resolves through the constraint to the union of EVERY view's params, the parse
// then yields that union, and no single view's `read` accepts it — that version compiled only with
// a cast. This one also rejects a table whose entry parses another view's params.
type ParamSchemas<N extends ViewName> = { [K in N]: { params: z.ZodType<ViewParams<K>> } }

const answer = <N extends ViewName>(view: View<N>, wire: ParamSchemas<N>, model: ReadModel, raw: unknown): ViewOutcome => {
  const parsed = wire[view.name].params.safeParse(raw)
  if (!parsed.success) {
    // The first issue names the field a caller has to fix; its path is empty when the whole value
    // is wrong (a number where an object belongs), which is what `(root)` says. `.at(0)` rather
    // than `[0]` because an issue-less ZodError is not something zod produces, but it is also not
    // something this index can promise — reading it as if it were always there is how a door
    // starts answering "undefined: undefined" to whoever hits that case first.
    const issue = parsed.error.issues.at(0)
    return { ok: false, status: 400, error: issue ? issueLine(issue) : 'params did not match the schema' }
  }
  const data = view.read(model, parsed.data)
  return data === null ? { ok: false, status: 404, error: `${view.name}: not found` } : { ok: true, name: view.name, seq: model.seq, data }
}

// The ONE read path: a door hands over a name and whatever the request carried, and gets back a
// status it can answer with. Nothing here knows about HTTP, so a second door answers the same
// reads without a second copy of the parse-then-read sequence.
//
// `name` is a plain string because what reaches a door is a URL path segment or a JSON field, not
// a `ViewName` — the enum decides whether it is one, the same way params go through zod rather
// than through a cast. A name that is no view and a view not yet implemented are one answer here:
// the caller asked for something this server cannot read.
export function readView(model: ReadModel, name: string, rawParams: unknown): ViewOutcome {
  const known = ViewName.safeParse(name)
  const view = known.success ? BY_NAME[known.data] : undefined
  if (!view) return { ok: false, status: 404, error: `unknown view: ${name}` }
  return answer(view, WIRE, model, rawParams)
}

// The read path for a caller that is already INSIDE the process — the copilot's tools, the MCP
// door — and therefore holds typed params and wants a typed result. readView is for a door taking
// params off a request: it parses, and answers with a status. This one skips both, because a
// re-parse here would cost a full deep copy of every answer (a 500-row log, a whole transcript) to
// re-derive a type the compiler already checked at the call site.
//
// `null` is the view's own "no such subject" — the 404 a route would answer with. A name the table
// has no entry for answers null as well, and only the coverage guard above keeps that honest: the
// wire's enum may lead the table while a view is being added, never after.
//
// The model is taken AFTER the last await and used immediately: it is the session's live state,
// coherent only within its tick (see ProjectSessions.model). An await between taking it and
// reading it is how an answer ends up describing two different moments.
export async function viewOf<N extends ViewName>(
  sessions: Pick<ProjectSessions, 'model'>, projectId: string, name: N, params: ViewParams<N>,
): Promise<ViewResult<N> | null> {
  const view = BY_NAME[name]
  const model = await sessions.model(projectId)
  return view ? view.read(model, params) : null
}

// A read missing here is a pane that never refreshes, so the list is the registry itself rather than a hand-kept copy of it.
const TOUCHABLES: ReadonlyArray<Touchable> = Object.values(VIEWS)

// What one appended event makes stale. A client holding these refetches exactly the queries that
// changed, which is what lets the stream frame stay a notification instead of growing with the read
// model.
export const touchesOf = (event: EventRecord, model: ReadModel): Touch[] =>
  TOUCHABLES.flatMap(t => t.touches(event, model).map(params => ({ name: t.name, params })))
