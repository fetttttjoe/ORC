import { expect, test } from '@playwright/test'

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
  const input = page.locator('.conv-input')
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
  const { projectId } = await (await page.request.get('/api/session')).json() as { projectId: string }
  await expect.poll(async () => {
    const g = await (await page.request.get(`/api/graph?project=${projectId}`)).json() as { nodes: Array<{ label: string }> }
    return g.nodes.some(n => n.label === 'E2e Authored Note')
  }, { timeout: 10_000 }).toBe(false)
})

test('approve from the road advances the request live', async ({ page }) => {
  await page.goto('/')
  await page.locator('.navitem', { hasText: 'hello world request' }).click()
  await page.locator('.inspector .move button', { hasText: 'approve plan' }).click()
  // SSE-driven repaint: stage moves to execute, system card lands in the conversation
  await expect(page.locator('.inspector .rail-stage.now')).toContainText('execute', { timeout: 10_000 })
  await expect(page.locator('.sys-card', { hasText: 'plan approved' })).toBeVisible()
})
