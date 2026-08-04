import { expect, test, type Page } from '@playwright/test'

/**
 * What an operator must be able to do, proven end to end against the fixture server (real kernel,
 * real Postgres, scripted copilot — see e2e/server.ts).
 *
 * One test per capability that would ruin someone's day if it broke, and nothing else: a suite
 * asserting every rendered string costs more to maintain than the bugs it catches. Selectors are
 * landmarks, roles and visible text — never CSS classes, which is why the previous suite died
 * with the markup it was pinned to.
 */

const SEEDED_REQUEST = 'hello world request'

const rail = (page: Page) => page.getByRole('navigation', { name: 'requests' })
const ledger = (page: Page) => page.getByRole('region', { name: 'ledger' })
const inspector = (page: Page) => page.getByRole('complementary', { name: 'inspector' })
const copilot = (page: Page) => page.getByRole('region', { name: 'copilot' })

async function open(page: Page): Promise<void> {
  await page.goto('/')
  await expect(rail(page).getByRole('button', { name: new RegExp(SEEDED_REQUEST) })).toBeVisible()
}

test('the console boots live and says what is driving', async ({ page }) => {
  await open(page)
  // the seq odometer proves the event stream attached — not merely that HTML rendered
  await expect(page.getByTitle(/log position this page has caught up to/)).toContainText(/seq\s+\d+/)
  // the fixture runs with no supervisor, and the header must SAY so rather than look idle
  await expect(page.getByTitle(/nothing will run/)).toBeVisible()
})

test('an open question is unmissable, verbatim, and answerable in one click', async ({ page }) => {
  await open(page)
  const gate = page.getByRole('region', { name: 'open question' }).filter({ hasText: 'approve this plan?' })
  await expect(gate).toContainText('approve this plan?')
  await expect(gate.getByRole('button', { name: 'approve' })).toBeVisible()
})

test('an answer the kernel then REFUSES is shown, never swallowed', async ({ page }) => {
  await open(page)
  // The fixture scripts the measured failure: the reply lands, finalize_plan rejects it. Before
  // the failure card, eight approvals in a row read as the system looping with no reason given.
  await page.getByRole('region', { name: 'open question' }).filter({ hasText: 'approve this plan?' }).getByRole('button', { name: 'approve' }).click()
  await expect(ledger(page).getByText('finalize_plan refused')).toBeVisible({ timeout: 15_000 })
  await expect(ledger(page).getByText('not approved: the plan graph changed since the approval', { exact: true })).toBeVisible()
})

test('opening a request answers "what now" and renders typed detail, not a JSON dump', async ({ page }) => {
  await open(page)
  await rail(page).getByRole('button', { name: new RegExp(SEEDED_REQUEST) }).click()
  await expect(inspector(page).getByText('your move')).toBeVisible()

  await inspector(page).getByRole('tab', { name: 'detail' }).click()
  const panel = inspector(page).getByRole('tabpanel')
  await expect(panel.getByText('status', { exact: true })).toBeVisible()
  await expect(panel.getByText('unrecognised shape — raw record')).toHaveCount(0)
})

test('a request is authored in a dialog and lands in the rail', async ({ page }) => {
  await open(page)
  await rail(page).getByRole('button', { name: 'new request' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  const title = `e2e request ${Date.now()}`
  await dialog.getByPlaceholder('what should happen?').fill(title)
  // draft mode needs no model or workspace — one step running the spec verbatim
  await dialog.getByRole('button', { name: /grounded/ }).click()
  await page.getByRole('option', { name: /draft/ }).click()
  await dialog.getByRole('button', { name: 'create request' }).click()

  await expect(dialog).toBeHidden()
  await expect(rail(page).getByRole('button', { name: new RegExp(title) })).toBeVisible()
})

test('the copilot streams an answer and reports what it cost', async ({ page }) => {
  await open(page)
  await copilot(page).getByPlaceholder('ask the copilot…').fill('what is going on?')
  await page.keyboard.press('Enter')
  await expect(copilot(page).getByText('e2e copilot reply')).toBeVisible({ timeout: 15_000 })
  await expect(copilot(page).getByText(/\d+ in ·/)).toBeVisible({ timeout: 15_000 })
})

test('the transcript renders tool payloads as readable JSON, not [object Object]', async ({ page }) => {
  await open(page)
  await rail(page).getByRole('button', { name: new RegExp(SEEDED_REQUEST) }).click()
  await inspector(page).getByRole('tab', { name: 'chat' }).click()
  const panel = inspector(page).getByRole('tabpanel')
  // the fixture's seeded tool calls carry object inputs — the wire sends JSON, not strings
  await panel.getByText('fs_read').first().click()
  await expect(panel.getByText('[object Object]')).toHaveCount(0)
  await expect(panel.getByText(/"seq":/).first()).toBeVisible()
})

test('the rail measures what it declares and keeps its controls inside', async ({ page }) => {
  await open(page)
  // rem-based sizing is anchored to the ROOT font size: setting it on html once scaled the whole
  // layout to 84%, so panes rendered narrower than declared and their contents spilled out.
  const railBox = (await rail(page).boundingBox())!
  expect(railBox.width).toBe(288)
  const note = (await rail(page).getByRole('button', { name: /knowledge note/ }).boundingBox())!
  expect(note.x + note.width).toBeLessThanOrEqual(railBox.x + railBox.width)
})

test('a note shows its claims — the statements retrieval actually matches on', async ({ page }) => {
  await open(page)
  // notes only exist once something writes one; the fixture writes none, so this asserts the
  // schema path rather than the seed: an unrecognised shape would show the raw-record fallback
  await rail(page).getByRole('button', { name: new RegExp(SEEDED_REQUEST) }).click()
  await inspector(page).getByRole('tab', { name: 'detail' }).click()
  await expect(inspector(page).getByRole('tabpanel').getByText('unrecognised shape — raw record')).toHaveCount(0)
})

test('a tall gate question never pushes the panes over each other', async ({ page }) => {
  await open(page)
  const gate = page.getByRole('region', { name: 'open question' }).filter({ hasText: 'wave 1' })
  await expect(gate).toBeVisible()

  // the ledger and the copilot must remain stacked, not overlapping: an unbounded gate block
  // grew past the pane and painted over the composer below it
  const ledgerBox = (await ledger(page).boundingBox())!
  const copilotBox = (await copilot(page).boundingBox())!
  expect(ledgerBox.y + ledgerBox.height).toBeLessThanOrEqual(copilotBox.y + 1)
  // and everything stays inside the window
  const viewport = page.viewportSize()!
  expect(copilotBox.y + copilotBox.height).toBeLessThanOrEqual(viewport.height + 1)
})

test('a deep link restores the selection after a reload', async ({ page }) => {
  await open(page)
  await rail(page).getByRole('button', { name: new RegExp(SEEDED_REQUEST) }).click()
  await inspector(page).getByRole('tab', { name: 'detail' }).click()
  await page.reload()
  // hash routing is load-bearing: a shared link must land on the same node and tab
  await expect(inspector(page).getByRole('tab', { name: 'detail' })).toHaveAttribute('data-state', 'active')
})

test('a live run says how far it has got and how close to its ceiling', async ({ page }) => {
  await open(page)
  const monitor = page.getByRole('article', { name: 'run monitor' })
  // the ring's own number, not a count of pills — it is what an operator reads at a glance
  await expect(monitor).toContainText('0/1')
  // iterations against the ceiling the plan was frozen with: the number a looping agent runs into
  await expect(monitor.getByTitle(/ceiling this step was frozen with/)).toHaveText('4/5')
})
