import { expect, test, type Page } from '@playwright/test'
import { must } from '@orc/contracts/fixtures'

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

// A node is only truly on screen when its CENTER lands inside the canvas box: toBeVisible is
// satisfied by any non-zero box, including one the canvas transform has pushed outside the
// clipped container — the empty-box-until-manual-fit failure renders every node "visible" while
// the operator sees nothing. Shared by every flow-canvas test so each drawing carries the same
// guarantee, not only the one that caught the bug.
type Boxed = { boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> }
async function expectCenteredInside(canvas: Boxed, node: Boxed): Promise<void> {
  await expect(async () => {
    const [box, n] = [await canvas.boundingBox(), await node.boundingBox()]
    if (!box || !n) throw new Error('no bounding box yet')
    const cx = n.x + n.width / 2
    const cy = n.y + n.height / 2
    if (cx < box.x || cx > box.x + box.width || cy < box.y || cy > box.y + box.height)
      throw new Error(`node center (${cx},${cy}) outside canvas box (${box.x},${box.y} ${box.width}x${box.height})`)
  }).toPass({ timeout: 5_000 })
}

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

test('the finish step\'s question is answerable in one click too', async ({ page }) => {
  await open(page)
  // The kernel-appended finish step reads the same approval word as the plan gate — "record the
  // decision (if any) and finish" — so the one-click button must be there. It is keyed on the step
  // id, and a fixture with only a plan gate cannot tell that rule from "every gate gets a button".
  const gate = page.getByRole('region', { name: 'open question' }).filter({ hasText: 'Reply approve to finish' })
  await expect(gate).toContainText('Reply approve to finish')
  await expect(gate.getByRole('button', { name: 'approve' })).toBeVisible()
})

test('two open questions on one task render as two gate cards, not one', async ({ page }) => {
  await open(page)
  // operatorState.openQuestions is keyed by (taskId, topic); a task-only `{#each}` key used to
  // collapse this pair into one DOM node — the fixture's multi-question task carries two distinct
  // topics on the same task specifically to catch that regression.
  await expect(page.getByRole('region', { name: 'open question' }).filter({ hasText: 'which model should analyze this?' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'open question' }).filter({ hasText: 'which checkout should this run in?' })).toBeVisible()
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
  await expect(copilot(page).getByText('e2e copilot reply').first()).toBeVisible({ timeout: 15_000 })
  await expect(copilot(page).getByText(/\d+ in ·/)).toBeVisible({ timeout: 15_000 })

  // ONE copy, not two. The pane renders the journaled history plus the optimistic rows of the turn
  // in flight; when the post-send refetch pulled the exchange back, nothing dropped the optimistic
  // copy, so every question and answer sat on screen twice — permanently, measured at 2 copies
  // still there 3s later. It surfaced as an intermittent strict-mode violation on the assertion
  // above (whether the refetch beat the assertion decided it), which read as a flaky test rather
  // than the user-visible duplication it was.
  await expect(copilot(page).getByText('what is going on?')).toHaveCount(1)
  await expect(copilot(page).getByText('e2e copilot reply')).toHaveCount(1)
})

test('a copilot exchange survives 450 events of agent-loop noise after it', async ({ page }) => {
  await open(page)
  // The copilot pane used to restore history from a fixed-size tail of the whole project log; the
  // fixture's 450 tool_call rows after the one seeded exchange pushed it out of a 400-row window
  // entirely (observed, not hypothesised — see e2e/server.ts). The view registry's timeline read
  // filters by kind BEFORE slicing, so the exchange is found regardless of what ran after it.
  await expect(copilot(page).getByText('a step failed and was retried; the retry is running now')).toBeVisible()
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
  const railBox = must(await rail(page).boundingBox(), 'rail bounding box')
  expect(railBox.width).toBe(288)
  const note = must(await rail(page).getByRole('button', { name: /knowledge note/ }).boundingBox(), 'knowledge note bounding box')
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
  const ledgerBox = must(await ledger(page).boundingBox(), 'ledger bounding box')
  const copilotBox = must(await copilot(page).boundingBox(), 'copilot bounding box')
  expect(ledgerBox.y + ledgerBox.height).toBeLessThanOrEqual(copilotBox.y + 1)
  // and everything stays inside the window
  const viewport = must(page.viewportSize(), 'viewport size')
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

/**
 * The plan's dependency graph actually DRAWS. Asserting the toggle exists would have passed while
 * the canvas rendered nothing — Svelte Flow needs a sized container and resolves parentId against
 * node order, and both fail silently into an empty box. So this reaches inside the canvas for a
 * step's own title and for its wave container.
 */
test('the plan graph draws its steps inside wave containers, and collapses on demand', async ({ page }) => {
  await open(page)
  await rail(page).getByRole('button', { name: new RegExp(SEEDED_REQUEST) }).click()

  const graph = inspector(page).getByRole('group', { name: 'plan dependency graph' })
  await expect(graph).toBeVisible()
  // a wave container: the subflow, not just a node sitting in a column
  await expect(graph.getByText(/^wave 1$/)).toBeVisible()
  // and the seeded plan's step drawn INSIDE it — proof the child resolved against its parent
  // rather than landing at the canvas origin, which is how a broken subflow fails
  const step = graph.getByText('s1', { exact: true }).first()
  await expect(step).toBeVisible()
  // ...and inside the viewport once the initial fit settles — see expectCenteredInside
  await expectCenteredInside(graph, step)

  const toggle = inspector(page).getByRole('button', { name: /dependency graph/ })
  await toggle.click()
  await expect(graph).toBeHidden()
  await toggle.click()
  await expect(graph).toBeVisible()
})

/**
 * The rail must stay usable once a project has history. It renders every request in four groups;
 * with the settled pile expanded that overflows any laptop viewport, and a rail that grows instead
 * of scrolling puts "new request" and the live work off-screen with no way back.
 */
test('the request rail scrolls instead of growing, and keeps the selection highlighted', async ({ page }) => {
  // A short viewport reproduces what 20+ settled requests do on a normal one: content taller than
  // the rail's own box. The bug this pins is a rail that GROWS to fit — pushing "new request" and
  // the live work off-screen with no scrollbar to get back.
  await page.setViewportSize({ width: 1440, height: 420 })
  await open(page)
  const nav = rail(page)

  // the settled pile is the one group collapsed by default; expanding it is what overflows
  const settled = nav.getByRole('button', { name: /settled/ })
  if (await settled.count()) await settled.first().click()

  const scroller = nav.locator('[data-sidebar="content"]')
  await expect(scroller).toBeVisible()

  // it must never extend past the window — that is the "grows instead of scrolls" failure
  expect(await scroller.evaluate(el => el.getBoundingClientRect().bottom > window.innerHeight + 1)).toBe(false)

  // and when the content IS taller than the box, it must actually move
  if (await scroller.evaluate(el => el.scrollHeight > el.clientHeight + 1)) {
    await scroller.evaluate(el => { el.scrollTop = 150 })
    expect(await scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
  }

  // selecting a STEP inside a request keeps that request's row highlighted
  await page.setViewportSize({ width: 1440, height: 900 })
  const row = nav.getByRole('button', { name: new RegExp(SEEDED_REQUEST) })
  await row.click()
  await expect(row).toHaveAttribute('data-active', 'true')
  await inspector(page).getByRole('group', { name: 'plan dependency graph' }).getByText('s1', { exact: true }).first().click()
  await expect(row).toHaveAttribute('data-active', 'true')

  // ...and the selection must be VISIBLE, not merely attributed. data-active was set correctly all
  // along while --color-sidebar-accent was undefined, so the styled row rendered identically to
  // every other one — an assertion on the attribute alone passed straight through that.
  const other = nav.getByRole('button', { name: /gated plan request/ })
  const bgOf = (l: typeof row) => l.evaluate(el => getComputedStyle(el).backgroundColor)
  expect(await bgOf(row)).not.toBe(await bgOf(other))
})

/**
 * Multi-wave topology, which the single-step fixture cannot reach: three wave containers, four
 * steps distributed across them, and the two parallel steps sharing a container. A subflow that
 * fails to resolve its children drops them all at the canvas origin — visible here as steps
 * appearing outside their wave, or wave 2 holding the wrong count.
 */
test('the plan graph draws a diamond across three wave containers', async ({ page }) => {
  await open(page)
  await rail(page).getByRole('button', { name: /shaped plan request/ }).click()

  const graph = inspector(page).getByRole('group', { name: 'plan dependency graph' })
  await expect(graph).toBeVisible()

  for (const wave of ['wave 1', 'wave 2', 'wave 3']) {
    await expect(graph.getByText(new RegExp(`^${wave}$`))).toBeVisible()
  }
  // wave 2 is the parallel one — the rail and the graph must agree on that
  await expect(graph.getByText('2 in parallel')).toBeVisible()

  for (const step of ['analyze', 'left', 'right', 'join']) {
    const node = graph.getByText(step, { exact: true }).first()
    await expect(node).toBeVisible()
    await expectCenteredInside(graph, node)
  }
})

/**
 * The expanded canvas. It renders the SAME PlanGraph in a bigger box — so the assertion that
 * matters is that the dialog's canvas actually draws the plan, not merely that a dialog opened.
 * This is where plan editing will live, and an empty full-size canvas would be worse than none.
 */
test('the plan graph opens full size and draws the same plan', async ({ page }) => {
  await open(page)
  await rail(page).getByRole('button', { name: /shaped plan request/ }).click()

  await inspector(page).getByRole('button', { name: 'expand plan graph' }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'plan dependencies' })
  await expect(dialog).toBeVisible()

  const big = dialog.getByRole('group', { name: 'plan dependency graph' })
  await expect(big).toBeVisible()
  await expect(big.getByText('join', { exact: true }).first()).toBeVisible()
  await expectCenteredInside(big, big.getByText('join', { exact: true }).first())
  // and it is genuinely bigger than the inline one
  const box = await big.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThan(460)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  // closing the dialog must not collapse the inline panel
  await expect(inspector(page).getByRole('group', { name: 'plan dependency graph' })).toBeVisible()
})

/**
 * A log scrolls in TIME, never sideways. One long id or summary used to widen the whole column,
 * and the horizontal scrollbar that appeared moved the seq spine — the thing the ledger is read by
 * — off screen. Checked at a narrow viewport because that is where it showed up.
 */
test('the ledger never scrolls horizontally, however narrow the pane', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 })
  await open(page)
  const scroller = ledger(page).locator('div').filter({ has: page.locator('[data-seq]') }).first()
  const overflows = await ledger(page).evaluate(el => {
    for (const d of el.querySelectorAll('div')) if (d.scrollWidth > d.clientWidth + 1) return true
    return false
  })
  expect(overflows).toBe(false)
  await expect(scroller.or(ledger(page))).toBeVisible()
})

/**
 * A REJECTED run offers replan, never retry. Retry re-runs only what did not complete, so the
 * rejecting auditor would meet the same completed siblings and reach the same verdict — the loop
 * that ran three identical audit passes before the failure class existed.
 *
 * The whole click-path is exercised because the first attempt at this affordance shipped a button
 * wired to `revise`, which resumes an open feedback gate; a finished run has none, so it succeeded
 * silently and did nothing. Asserting the control exists would have passed against that.
 */
test('a rejected run offers a replan and no retry, and reopening yields a new version', async ({ page }) => {
  await open(page)
  await rail(page).getByRole('button', { name: /rejected plan request/ }).click()

  const move = inspector(page).getByRole('region', { name: 'your move' }).or(inspector(page))
  await expect(move.getByText(/rejected the work/)).toBeVisible()
  await expect(inspector(page).getByRole('button', { name: /retry/i })).toHaveCount(0)

  const reopen = inspector(page).getByRole('button', { name: /reopen plan for editing/ })
  await expect(reopen).toBeVisible()
  await reopen.click()

  // edit appends a NEW plan version and stamps blocked -> awaiting_approval (kernel.editPlan)
  await expect(inspector(page).getByRole('button', { name: /^v2/ })).toBeVisible({ timeout: 10_000 })
})
