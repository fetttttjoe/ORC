import { expect, test } from '@playwright/test'
import { z } from 'zod'

// Named response contracts — the asserted subsets of the page's API types (page/api.ts
// Session / GraphSnapshot). Runtime-parsed because e2e reads raw HTTP, never the typed
// api layer; shapes are declared HERE, never inline at a call site.
const SessionResponse = z.object({ projectId: z.string(), token: z.string() })
const GraphNodeView = z.object({ label: z.string() })
const GraphResponse = z.object({ nodes: z.array(GraphNodeView) })

test('shell boots: chats, requests, live status', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.brand')).toContainText('orc')
  await expect(page.locator('.navitem', { hasText: 'e2e-project' })).toBeVisible()
  await expect(page.locator('.navitem', { hasText: 'hello world request' })).toBeVisible()
  await expect(page.locator('.statusbar')).toContainText('live', { timeout: 10_000 })
})

test('request click opens the inspector journey', async ({ page }) => {
  await page.goto('/')
  await page.locator('.navitem', { hasText: 'hello world request' }).click()
  await expect(page.locator('.inspector')).toBeVisible()
  await expect(page.locator('.inspector .rail-stage.now')).toContainText('approve')
  await expect(page.locator('.inspector .move')).toContainText('your move')
  // deep link carries the selection
  expect(page.url()).toContain('tab=request')
  // split is the ONE layout (7616abb): the conversation pane is always present
  await expect(page.locator('.conv')).toBeVisible()
})

test('conversation list is scrollable (flex min-height regression)', async ({ page }) => {
  await page.goto('/')
  const conv = page.locator('.conv-list')
  expect(await conv.evaluate(n => getComputedStyle(n).overflowY)).toBe('auto')
  expect(await conv.evaluate(n => getComputedStyle(n).minHeight)).toBe('0px')
  expect(await conv.evaluate(n => getComputedStyle(n.parentElement!).minHeight)).toBe('0px')
})

test('copilot exchange streams into the conversation', async ({ page }) => {
  await page.goto('/')
  // the pane binds its project asynchronously (setProject → reload renders the placeholder);
  // typing before that is a silent no-op by design — wait for the ready signal
  await expect(page.locator('.conv-list .empty')).toBeVisible()
  // the composer, not an inline answer box: an open question puts a second .conv-input in the
  // feed, and only the composer is a direct child row of .conv
  const input = page.locator('.conv > .conv-inputrow .conv-input')
  await input.fill('what is going on?')
  await input.press('Enter')
  await expect(page.locator('.bubble.user')).toContainText('what is going on?')
  await expect(page.locator('.bubble.assistant')).toContainText('e2e copilot reply', { timeout: 10_000 })
  await expect(page.locator('.conv-usage')).toContainText('10 in / 3 out')
  // P6 acceptance: the exchange is journaled — a reload rebuilds the bubbles FROM THE LOG
  await page.reload()
  await expect(page.locator('.bubble.user')).toContainText('what is going on?', { timeout: 10_000 })
  await expect(page.locator('.bubble.assistant')).toContainText('e2e copilot reply')
})

test('note authoring: create, link, edit, delete from the page', async ({ page }) => {
  await page.goto('/')
  await page.locator('button', { hasText: '+ note' }).click()
  // openDialog renders each field as label.field > (input|textarea); submit sits in .dlg-buttons
  const dlg = page.locator('.dlg')
  await dlg.locator('label.field', { hasText: 'title' }).locator('input').fill('E2e Authored Note')
  await dlg.locator('label.field', { hasText: 'body' }).locator('textarea').fill('hello')
  await dlg.locator('.dlg-buttons button', { hasText: 'save' }).click()
  // the shell navigates to the new note — its detail card renders via the SSE-driven refresh
  await expect(page.locator('.inspector')).toContainText('E2e Authored Note', { timeout: 10_000 })
  // edit: change the summary — the card refreshes with it
  await page.locator('.inspector button', { hasText: 'edit' }).click()
  await dlg.locator('label.field', { hasText: 'summary' }).locator('input').fill('now-edited')
  await dlg.locator('.dlg-buttons button', { hasText: 'save' }).click()
  await expect(page.locator('.inspector')).toContainText('now-edited', { timeout: 10_000 })
  // delete: typed confirm — the inspector empties and the node leaves the graph
  await page.locator('.inspector button', { hasText: 'delete' }).click()
  await dlg.locator('label.field input').fill('e2e-authored-note')
  await dlg.locator('.dlg-buttons button', { hasText: 'delete' }).click()
  await expect(page.locator('.inspector')).toBeHidden({ timeout: 10_000 })
  const { projectId } = SessionResponse.parse(await (await page.request.get('/api/session')).json())
  await expect.poll(async () => {
    const g = GraphResponse.parse(await (await page.request.get(`/api/graph?project=${projectId}`)).json())
    return g.nodes.some(n => n.label === 'E2e Authored Note')
  }, { timeout: 10_000 }).toBe(false)
})

// The failure this pair of fixes exists for: a broken gate rejected eight consecutive approvals
// and the pane showed none of it, because the rejection lived only in the event log. One click
// answers the gate; the rejection that follows must land on screen as its own card.
test('approving the plan gate: one click, and a rejected approval says why', async ({ page }) => {
  await page.goto('/')
  const answerRow = page.locator('.conv-inputrow.answer')
  await expect(answerRow).toBeVisible({ timeout: 10_000 })
  await answerRow.locator('button', { hasText: 'approve' }).click()
  // the receipt lands…
  await expect(page.locator('.sys-card', { hasText: 'answered' })).toBeVisible({ timeout: 10_000 })
  // …and so does the reason it did not take — tool name and error text, not a question card
  const failure = page.locator('.card.failure')
  await expect(failure).toBeVisible({ timeout: 10_000 })
  await expect(failure).toContainText('finalize_plan')
  await expect(failure).toContainText('the plan graph changed since the approval')
})

test('approve from the road advances the request live', async ({ page }) => {
  await page.goto('/')
  await page.locator('.navitem', { hasText: 'hello world request' }).click()
  await page.locator('.inspector .move button', { hasText: 'approve plan' }).click()
  // SSE-driven repaint: stage moves to execute, system card lands in the conversation
  await expect(page.locator('.inspector .rail-stage.now')).toContainText('execute', { timeout: 10_000 })
  await expect(page.locator('.sys-card', { hasText: 'plan approved' })).toBeVisible()
})

// The scrolling container is the .inspector overlay — .log has no overflow of its own. This pins
// the shell-v2 regression where the pin-to-bottom logic still targeted the pre-rename '.detail'
// class: closest() found nothing, so neither the initial render nor live rows ever scrolled the
// panel, and the newest row sat below the fold exactly when the log was busiest.
test('log tab pins to the newest row, and live rows keep it pinned', async ({ page }) => {
  await page.goto('/')
  await page.locator('.navitem', { hasText: 'hello world request' }).click()
  await page.locator('.inspector .tab', { hasText: 'Log' }).click()
  const inspector = page.locator('.inspector')
  await expect(page.locator('.log-row').first()).toBeVisible()
  // the 60 seeded tool calls overflow the panel — without overflow "pinned" is trivially true
  await expect.poll(() => inspector.evaluate(n => n.scrollHeight > n.clientHeight)).toBe(true)
  // same tolerance the pin logic uses: within 40px of the bottom counts as pinned
  const pinned = () => inspector.evaluate(n => n.scrollTop + n.clientHeight >= n.scrollHeight - 40)
  await expect.poll(pinned).toBe(true)
  // a live event streams a new row in — the panel follows it instead of staying put
  const { projectId, token } = SessionResponse.parse(await (await page.request.get('/api/session')).json())
  await page.request.post('/api/actions/writeNote', {
    headers: { 'x-orc-token': token, 'x-orc-project': projectId },
    data: { id: 'live-pin-note', title: 'live pin note' },
  })
  await expect(page.locator('.log-row', { hasText: 'live-pin-note' })).toBeVisible({ timeout: 10_000 })
  await expect.poll(pinned).toBe(true)
})
