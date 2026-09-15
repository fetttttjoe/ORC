import { describe, expect, it } from 'bun:test'
import { NOTE_TIER, type NoteSummary } from '@orc/contracts'
import { provisionalNoteCounts } from './provisional-count'

const note = (id: string, workspaceId: string): NoteSummary => ({
  id, scope: 'project', title: id, tier: NOTE_TIER.semantic, categories: [], tags: [], summary: '',
  hits: 0, lastAccessedAt: null, sourceRevision: null, paths: [], workspaceId,
})

const WS = { trunk: 'w-trunk', open: 'w-open', landed: 'w-landed' } as const
const view = {
  workspaces: new Map([
    [WS.trunk, { onTrunk: true, title: 'the checkout' }],
    [WS.open, { onTrunk: false, title: 'Add search' }],
    [WS.landed, { onTrunk: false, title: 'Fix parser' }],
  ]),
  merged: new Set([WS.landed]),
}

describe('provisionalNoteCounts', () => {
  it('counts only the notes provisionalOf still flags, keyed by their workspace', async () => {
    const notes = [
      note('n1', WS.open), note('n2', WS.open),
      note('n3', WS.trunk),   // trunk knowledge — final by construction
      note('n4', WS.landed),  // the workspace transaction committed
      note('n5', 'w-unknown'), // a workspace the table does not know: we cannot tell, so no flag
    ]
    const counts = await provisionalNoteCounts({ list: async () => notes }, async () => view)
    // a Map, not a list of ids: the health derivation asks "how many", and every workspace with
    // none must be ABSENT rather than 0, so a caller can tell the two apart
    expect([...counts]).toEqual([[WS.open, 2]])
  })

  it('re-reads the workspace view per call — a merge recorded mid-session clears the count', async () => {
    const notes = [note('n1', WS.open)]
    let merged = new Set<string>()
    const probe = async () => ({ workspaces: view.workspaces, merged })
    expect((await provisionalNoteCounts({ list: async () => notes }, probe)).get(WS.open)).toBe(1)
    merged = new Set([WS.open])
    expect((await provisionalNoteCounts({ list: async () => notes }, probe)).has(WS.open)).toBe(false)
  })
})
