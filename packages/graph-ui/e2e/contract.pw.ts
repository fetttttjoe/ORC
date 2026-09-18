import { expect, test, type APIRequestContext } from '@playwright/test'
import type { z } from 'zod'
import { must } from '@orc/contracts/fixtures'
import { issueLine } from '@orc/contracts/guards'
import * as S from '../web/src/lib/api/schemas'

/**
 * The wire contract, asserted against a REAL server response for every read the app makes.
 *
 * These exist because type-level shapes are erased: four separate bugs shipped where the server
 * renamed or re-nested a field and the UI rendered nothing at all — an empty model picker that
 * made the primary flow impossible, artifacts shown as "unrecognised shape", a model's whole
 * cost lens blank, and a note's claims missing. Each was invisible until someone looked at the
 * screen. Here the same schemas the client parses with fail loudly instead, naming the field.
 *
 * A failure means one of two things, and both are worth a build break: the server changed shape,
 * or a schema is wrong about what the server sends. Never "loosen the schema to make it pass" —
 * find out which side moved.
 */

const PROJECT = '00000000-0000-4000-8000-000000000001' // TEST_PROJECT_ID, seeded by e2e/server.ts

/** the wire's own URL builder, bound to this fixture's project — one spelling of the format */
const viewPath = (name: string, params?: unknown): string => S.viewPath(name, PROJECT, params)

async function json(request: APIRequestContext, path: string): Promise<unknown> {
  const res = await request.get(path)
  expect(res.status(), `${path} should answer 200`).toBe(200)
  return res.json()
}

/** report the failing FIELD, not just "parse failed" — the whole point of the exercise */
function check(schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } } }, value: unknown, what: string): void {
  const parsed = schema.safeParse(value)
  const detail = parsed.error?.issues.map(issueLine).join('; ')
  expect(parsed.success, `${what} did not match its schema — ${detail}`).toBe(true)
}

/** every view answers inside the envelope, so the shape under test is what `data` carries */
async function view(request: APIRequestContext, name: string, params: unknown, schema: z.ZodType, what: string): Promise<void> {
  check(S.ViewEnvelope(schema), await json(request, viewPath(name, params)), what)
}

test('session, projects and health answer the shapes the app parses', async ({ request }) => {
  check(S.SessionInfo, await json(request, '/api/session'), '/api/session')
  check(S.ProjectList, await json(request, '/api/projects'), '/api/projects')
  check(S.Health, await json(request, '/api/health'), '/api/health')
})

test('the models catalog is a bare array of refs', async ({ request }) => {
  const Catalog = S.ViewEnvelope(S.ModelRefs)
  const body = await json(request, viewPath(S.VIEW.models))
  check(Catalog, body, 'the models view')
  // the flow-breaking regression: a `{refs: […]}` wrapper here empties the model picker, which
  // disables "create request" in grounded mode entirely
  expect(Array.isArray(Catalog.parse(body).data)).toBe(true)
})

test('the graph snapshot and timeline match, including every node and link field', async ({ request }) => {
  check(S.GraphSnapshot, await json(request, `/api/graph?project=${PROJECT}`), '/api/graph')
  await view(request, S.VIEW.timeline, { limit: 50 }, S.LogRows, 'the timeline view')
})

test('every node kind parses as ITS OWN shape, not merely as something', async ({ request }) => {
  // Deliberately NOT S.NodeDetail as one union: each kind is asserted against the schema its pane
  // actually renders from, so a `run: null` the schema calls `.optional()` fails HERE instead of
  // matching some other member of the union.
  const byKind = { task: S.TaskDetail, step: S.StepDetail, note: S.NoteDetail, artifact: S.ArtifactDetail, model: S.ModelDetail } as const
  const snapshot = S.GraphSnapshot.parse(await json(request, `/api/graph?project=${PROJECT}`))
  const seen = new Set<string>()
  for (const node of snapshot.nodes) {
    if (seen.has(node.type)) continue // one of each kind is enough to pin the shape
    const res = await request.get(viewPath(S.VIEW.node, { id: node.id }))
    if (res.status() === 404) continue
    seen.add(node.type)
    check(S.ViewEnvelope(byKind[node.type]), await res.json(), `the node view (${node.type})`)
  }
  // EVERY kind, not "more than one": four wire-vs-server disagreements stayed invisible while the
  // fixture seeded no note and no artifact, and a bar of "at least tasks and steps" is what let
  // them. A kind the fixture stops producing fails here rather than going quietly unchecked.
  expect([...seen].sort(), 'the fixture seeds one node of every kind').toEqual(Object.keys(byKind).sort())
})

test('plans, plan notes and transcript match for a real task', async ({ request }) => {
  const snapshot = S.GraphSnapshot.parse(await json(request, `/api/graph?project=${PROJECT}`))
  const task = snapshot.nodes.find(n => n.type === 'task')
  expect(task, 'the fixture seeds at least one task').toBeDefined()
  const taskId = must(task, 'task node').id

  // a task nobody planned answers 404 — that is the view's own null, not an empty plan
  const plans = await request.get(viewPath(S.VIEW.plans, { taskId }))
  if (plans.status() === 200) check(S.ViewEnvelope(S.PlansView), await plans.json(), 'the plans view')

  await view(request, S.VIEW.planNotes, { taskId }, S.PlanNotesView, 'the plan-notes view')
  await view(request, S.VIEW.transcript, { taskId }, S.Transcript, 'the transcript view')
})

test('a name that is no view, and params that fail their schema, are refused', async ({ request }) => {
  // The browser is told which views exist by one enum; a door that answered 200 for anything else
  // would let a typo render as an empty pane instead of as an error.
  expect((await request.get(viewPath('nope'))).status()).toBe(404)
  // hand-built on purpose: the builder cannot produce malformed JSON, and this is the shape a
  // client that encoded its params wrongly actually sends
  expect((await request.get(`${viewPath(S.VIEW.timeline)}&${S.VIEW_ROUTE.params}=%7Bnot-json`)).status()).toBe(400)
  expect((await request.get(viewPath(S.VIEW.timeline, { limit: 0 }))).status()).toBe(400)
})
