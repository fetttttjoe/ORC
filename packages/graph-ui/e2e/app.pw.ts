import { expect, test } from '@playwright/test'

test('shell boots: chats, requests, live status', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.brand')).toContainText('orc')
  await expect(page.locator('.navitem', { hasText: 'e2e-project' })).toBeVisible()
  await expect(page.locator('.navitem', { hasText: 'hello world request' })).toBeVisible()
  await expect(page.locator('.statusbar')).toContainText('live', { timeout: 10_000 })
})

test('request click opens the inspector journey; view modes switch', async ({ page }) => {
  await page.goto('/')
  await page.locator('.navitem', { hasText: 'hello world request' }).click()
  await expect(page.locator('.inspector')).toBeVisible()
  await expect(page.locator('.inspector .rail-stage.now')).toContainText('approve')
  await expect(page.locator('.inspector .move')).toContainText('your move')
  // deep link carries the selection
  expect(page.url()).toContain('tab=request')

  await page.locator('.viewmodes .tab', { hasText: 'graph' }).click()
  await expect(page.locator('.conv')).toBeHidden()
  expect(page.url()).toContain('view=graph')
  await page.locator('.viewmodes .tab', { hasText: 'split' }).click()
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
  const input = page.locator('.conv-input')
  await input.fill('what is going on?')
  await input.press('Enter')
  await expect(page.locator('.bubble.user')).toContainText('what is going on?')
  await expect(page.locator('.bubble.assistant')).toContainText('e2e copilot reply', { timeout: 10_000 })
  await expect(page.locator('.conv-usage')).toContainText('10 in / 3 out')
})

test('approve from the road advances the request live', async ({ page }) => {
  await page.goto('/')
  await page.locator('.navitem', { hasText: 'hello world request' }).click()
  await page.locator('.inspector .move button', { hasText: 'approve plan' }).click()
  // SSE-driven repaint: stage moves to execute, system card lands in the conversation
  await expect(page.locator('.inspector .rail-stage.now')).toContainText('execute', { timeout: 10_000 })
  await expect(page.locator('.sys-card', { hasText: 'plan approved' })).toBeVisible()
})
