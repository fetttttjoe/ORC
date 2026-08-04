// Ports the status-precedence semantics of the retired page/status-style onto the app palette:
// status override precedence failed > blocked > running > type default, and note/artifact/model
// are NEVER recolored by a coincidental detail string.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { colorFor, dim, EDGE_COLOR, edgeColorFor, FLASH_COLOR, isActive, LABEL_COLOR, STATUS_COLORS, TYPE_COLORS } from './colors'

describe('status override precedence', () => {
  it('overrides task/step color for live statuses', () => {
    expect(colorFor('step', 'running')).toBe(STATUS_COLORS.running)
    expect(colorFor('task', 'running')).toBe(STATUS_COLORS.running)
    expect(colorFor('step', 'failed')).toBe(STATUS_COLORS.failed)
    expect(colorFor('task', 'failed')).toBe(STATUS_COLORS.failed)
    expect(colorFor('task', 'blocked')).toBe(STATUS_COLORS.blocked)
    expect(colorFor('step', 'blocked')).toBe(STATUS_COLORS.blocked)
    expect(colorFor('task', 'cancelled')).toBe(STATUS_COLORS.cancelled)
  })

  it('failed and blocked outrank running — a dead node must never read as live steel', () => {
    expect(colorFor('task', 'failed')).not.toBe(colorFor('task', 'running'))
    expect(colorFor('task', 'blocked')).not.toBe(colorFor('task', 'running'))
    // blocked shares failed's temperature (rust), exactly as StatusPill maps them
    expect(colorFor('task', 'blocked')).toBe(colorFor('task', 'failed'))
  })

  it('running outranks the type default — the override must be VISIBLE on rest-state steel', () => {
    expect(colorFor('task', 'running')).not.toBe(TYPE_COLORS.task)
    expect(colorFor('step', 'running')).not.toBe(TYPE_COLORS.step)
  })

  it('keeps type colors for settled statuses', () => {
    expect(colorFor('step', 'completed')).toBe(TYPE_COLORS.step)
    expect(colorFor('step', 'pending')).toBe(TYPE_COLORS.step)
    expect(colorFor('task', 'done')).toBe(TYPE_COLORS.task)
  })

  it('never overrides note/artifact/model — their detail is not a lifecycle', () => {
    // a note's detail is its KIND, an artifact's its SIZE — must never be recolored
    expect(colorFor('note', 'running')).toBe(TYPE_COLORS.note)
    expect(colorFor('note', 'failed')).toBe(TYPE_COLORS.note)
    expect(colorFor('artifact', '12B')).toBe(TYPE_COLORS.artifact)
    expect(colorFor('artifact', 'blocked')).toBe(TYPE_COLORS.artifact)
    expect(colorFor('model', 'anthropic')).toBe(TYPE_COLORS.model)
    expect(colorFor('model', 'running')).toBe(TYPE_COLORS.model)
  })
})

describe('isActive — drives the running size bump', () => {
  it('marks only running tasks/steps as active', () => {
    expect(isActive('step', 'running')).toBe(true)
    expect(isActive('task', 'running')).toBe(true)
    expect(isActive('step', 'completed')).toBe(false)
    expect(isActive('task', 'blocked')).toBe(false)
    expect(isActive('note', 'running')).toBe(false)
  })
})

describe('edgeColorFor — heat lerps the rule chrome toward paper', () => {
  it('renders EDGE_COLOR at heat 0 and paper at heat 1', () => {
    // #2e3742 (--color-rule) and #e6e1d6 (--color-paper) as rgb triplets
    expect(edgeColorFor(0)).toBe('rgb(46, 55, 66)')
    expect(EDGE_COLOR).toBe('#2e3742') // the triplet above IS the hex — same canvas color
    expect(edgeColorFor(1)).toBe('rgb(230, 225, 214)')
  })

  it('clamps out-of-range heat instead of extrapolating', () => {
    expect(edgeColorFor(-1)).toBe(edgeColorFor(0))
    expect(edgeColorFor(2)).toBe(edgeColorFor(1))
  })
})

/**
 * The WebGL copies must equal the CSS tokens they name.
 *
 * colors.ts hardcodes hexes because a canvas cannot read CSS custom properties, and it names the
 * source token in a comment beside each one. That comment was the whole enforcement: "change a
 * token there, grep the name here" — the same silent-drift shape CLAUDE.md warns about for tuned
 * constants quoted in docs. Nothing failed when they diverged; the graph just stopped matching the
 * rest of the console. This reads app.css and makes the divergence a test failure.
 *
 * Only EXACT copies are listed. TYPE_COLORS.task/step/artifact/note are deliberately derived
 * (dimmed, or mixed toward another token) and have no token to equal.
 */
describe('the hardcoded canvas colors still equal their app.css tokens', () => {
  const css = readFileSync(new URL('../../../app.css', import.meta.url), 'utf8')
  const TOKEN = /--color-([a-z-]+):\s*(#[0-9a-f]{6})/g
  const tokens = new Map([...css.matchAll(TOKEN)].map(m => [m[1] ?? '', m[2] ?? '']))

  const EXACT: ReadonlyArray<readonly [label: string, hex: string, token: string]> = [
    ['STATUS_COLORS.failed', STATUS_COLORS.failed ?? '', 'rust'],
    ['STATUS_COLORS.blocked', STATUS_COLORS.blocked ?? '', 'rust'],
    ['STATUS_COLORS.running', STATUS_COLORS.running ?? '', 'machine'],
    ['STATUS_COLORS.cancelled', STATUS_COLORS.cancelled ?? '', 'fog'],
    ['TYPE_COLORS.model', TYPE_COLORS.model, 'worker'],
    ['EDGE_COLOR', EDGE_COLOR, 'rule'],
    ['LABEL_COLOR', LABEL_COLOR, 'paper'],
    ['FLASH_COLOR', FLASH_COLOR, 'human'],
  ]

  it('parses the @theme block at all — a rename here must not silently pass everything', () => {
    expect(tokens.get('ink')).toMatch(/^#[0-9a-f]{6}$/)
    expect(tokens.size).toBeGreaterThan(8)
  })

  for (const [label, hex, token] of EXACT) {
    it(`${label} === --color-${token}`, () => {
      expect(hex).toBe(tokens.get(token) ?? `--color-${token} is not declared in app.css`)
    })
  }

  it('dim() fades toward --color-ink, the page ground', () => {
    // dim(x, 1) is the ground itself; the mix constants 0x0e/0x11/0x16 are ink spelled as numbers
    expect(dim('#ffffff', 1)).toBe(tokens.get('ink'))
  })
})

describe('the worker reads as a worker', () => {
  /**
   * A model node is the thing that actually ran the step, and it was --color-mist — the same grey
   * as ordinary chrome — so it sank into the background. It sits outside the two-temperature axis
   * for the same reason notes do: it carries no lifecycle, it is an actor.
   */
  it('is its own hue, not shared with any other node type', () => {
    const others = (Object.entries(TYPE_COLORS) as [string, string][]).filter(([t]) => t !== 'model')
    for (const [type, hex] of others)
      expect(TYPE_COLORS.model, `model must not share a colour with ${type}`).not.toBe(hex)
    expect(TYPE_COLORS.model).not.toBe('#8b93a1') // --color-mist, the chrome it used to be
  })

  it('never takes a lifecycle override — a model is not running or failed, it is used', () => {
    for (const status of Object.keys(STATUS_COLORS))
      expect(colorFor('model', status)).toBe(TYPE_COLORS.model)
    expect(isActive('model', 'running')).toBe(false)
  })

  it('the `uses` edge is drawn in the worker family, every other edge in the shared chrome', () => {
    expect(edgeColorFor(0, 'uses')).not.toBe(edgeColorFor(0))
    for (const other of ['child', 'plan', 'depends', 'out', 'wrote'])
      expect(edgeColorFor(0, other), `${other} must stay chrome`).toBe(edgeColorFor(0))
    // an unknown edge type falls back rather than rendering undefined
    expect(edgeColorFor(0, 'not-a-real-edge')).toBe(edgeColorFor(0))
  })

  it('heat still lifts a uses edge toward paper, so walked connections read as lit', () => {
    expect(edgeColorFor(1, 'uses')).toBe(edgeColorFor(1))  // both reach paper at full heat
    expect(edgeColorFor(0.5, 'uses')).not.toBe(edgeColorFor(0.5, 'child'))
  })
})
