import { expect, test, type APIRequestContext } from '@playwright/test'
import type { z } from 'zod'
import { ScopeType } from '@orc/contracts/scope'
import { must } from '@orc/contracts/fixtures'
import { issueLine } from '@orc/contracts/guards'
import * as S from '../web/src/lib/api/schemas'

// A failure means the server changed shape or a schema is wrong; never loosen the schema to pass

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
  expect(Array.isArray(Catalog.parse(body).data)).toBe(true)
})

test('the graph snapshot and timeline match, including every node and link field', async ({ request }) => {
  check(S.GraphSnapshot, await json(request, `/api/graph?project=${PROJECT}`), '/api/graph')
  await view(request, S.VIEW.timeline, { scope: { type: ScopeType.project }, limit: 50 }, S.LogRows, 'the timeline view')
})

test('every node kind parses as ITS OWN shape, not merely as something', async ({ request }) => {
  // Per-kind schemas, not the union: a `run: null` the schema calls optional must fail here
  const byKind = { task: S.TaskDetail, step: S.StepDetail, artifact: S.ArtifactDetail, model: S.ModelDetail } as const
  const snapshot = S.GraphSnapshot.parse(await json(request, `/api/graph?project=${PROJECT}`))
  const seen = new Set<string>()
  for (const node of snapshot.nodes) {
    if (seen.has(node.type)) continue // one of each kind is enough to pin the shape
    const res = await request.get(viewPath(S.VIEW.node, { id: node.id }))
    if (res.status() === 404) continue
    seen.add(node.type)
    check(S.ViewEnvelope(byKind[node.type]), await res.json(), `the node view (${node.type})`)
  }
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
  expect((await request.get(viewPath('nope'))).status()).toBe(404)
  // hand-built: the builder cannot produce malformed JSON
  expect((await request.get(`${viewPath(S.VIEW.timeline)}&${S.VIEW_ROUTE.params}=%7Bnot-json`)).status()).toBe(400)
  expect((await request.get(viewPath(S.VIEW.timeline, { scope: { type: ScopeType.project }, limit: 0 }))).status()).toBe(400)
})
