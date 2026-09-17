import { expect, test, type APIRequestContext } from '@playwright/test'
import { must } from '@orc/contracts/fixtures'
import * as S from '../web/src/lib/api/schemas'

/**
 * The wire contract, asserted against a REAL server response for every endpoint the app calls.
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

async function json(request: APIRequestContext, path: string): Promise<unknown> {
  const res = await request.get(path)
  expect(res.status(), `${path} should answer 200`).toBe(200)
  return res.json()
}

/** report the failing FIELD, not just "parse failed" — the whole point of the exercise */
function check(schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } } }, value: unknown, what: string): void {
  const parsed = schema.safeParse(value)
  const detail = parsed.error?.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
  expect(parsed.success, `${what} did not match its schema — ${detail}`).toBe(true)
}

test('session, projects and health answer the shapes the app parses', async ({ request }) => {
  check(S.SessionInfo, await json(request, '/api/session'), '/api/session')
  check(S.ProjectList, await json(request, '/api/projects'), '/api/projects')
  check(S.Health, await json(request, '/api/health'), '/api/health')
})

test('the models catalog is a bare array of refs', async ({ request }) => {
  const models = await json(request, `/api/models?project=${PROJECT}`)
  check(S.ModelRefs, models, '/api/models')
  // the flow-breaking regression: a `{refs: […]}` wrapper here empties the model picker, which
  // disables "create request" in grounded mode entirely
  expect(Array.isArray(models)).toBe(true)
})

test('the graph snapshot and log match, including every node and link field', async ({ request }) => {
  const snapshot = await json(request, `/api/graph?project=${PROJECT}`)
  check(S.GraphSnapshot, snapshot, '/api/graph')
  check(S.LogRows, await json(request, `/api/log?project=${PROJECT}&limit=50`), '/api/log')
})

test('every node kind parses as ITS OWN shape, not merely as something', async ({ request }) => {
  // Deliberately NOT S.NodeDetail: that union ends in a permissive record so an unknown node
  // kind cannot break the pane — which also meant this test could never fail. Each kind is
  // asserted against the schema its view actually renders from, so a `run: null` the schema
  // calls `.optional()` fails HERE instead of silently degrading to the raw-record fallback.
  const byKind = { task: S.TaskDetail, step: S.StepDetail, note: S.NoteDetail, artifact: S.ArtifactDetail, model: S.ModelDetail } as const
  const snapshot = S.GraphSnapshot.parse(await json(request, `/api/graph?project=${PROJECT}`))
  const seen = new Set<string>()
  for (const node of snapshot.nodes) {
    if (seen.has(node.type)) continue // one of each kind is enough to pin the shape
    const res = await request.get(`/api/node?project=${PROJECT}&id=${encodeURIComponent(node.id)}`)
    if (res.status() === 404) continue
    seen.add(node.type)
    check(byKind[node.type], await res.json(), `/api/node (${node.type})`)
  }
  expect(seen.size, 'the fixture should hold at least tasks and steps').toBeGreaterThan(1)
})

test('plans, plan-notes and transcript match for a real task', async ({ request }) => {
  const snapshot = S.GraphSnapshot.parse(await json(request, `/api/graph?project=${PROJECT}`))
  const task = snapshot.nodes.find(n => n.type === 'task')
  expect(task, 'the fixture seeds at least one task').toBeDefined()
  const taskId = must(task, 'task node').id

  const plans = await request.get(`/api/plans?project=${PROJECT}&task=${taskId}`)
  if (plans.status() === 200) check(S.PlansView, await plans.json(), '/api/plans')

  const notes = await request.get(`/api/plan-notes?project=${PROJECT}&task=${taskId}`)
  if (notes.status() === 200) check(S.PlanNotesView, await notes.json(), '/api/plan-notes')

  check(S.Transcript, await json(request, `/api/transcript?project=${PROJECT}&task=${taskId}`), '/api/transcript')
})
