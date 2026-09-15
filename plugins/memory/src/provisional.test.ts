import { describe, expect, it } from 'bun:test'
import { provisionalOf } from './provisional'

// One workspace of each standing, so every branch below is exercised against the same view: a
// live feature workspace and the trunk checkout itself.
const ws = new Map([
  ['w1', { onTrunk: false, title: 'Req' }],
  ['trunk', { onTrunk: true, title: 'main' }],
])

describe('provisionalOf', () => {
  it('flags a note from an unmerged non-trunk workspace; merged, trunk and unknown workspaces are final', () => {
    expect(provisionalOf({ workspaceId: 'w1' }, ws, new Set())).toEqual({ workspaceId: 'w1', title: 'Req' })
    expect(provisionalOf({ workspaceId: 'w1' }, ws, new Set(['w1']))).toBeNull()
    expect(provisionalOf({ workspaceId: 'trunk' }, ws, new Set())).toBeNull()
    // unknown workspace: never invent a flag — a reader told "provisional in <nothing>" has no
    // workspace to go and merge, and the honest answer to "is this pending?" is that we cannot say
    expect(provisionalOf({ workspaceId: 'gone' }, ws, new Set())).toBeNull()
  })

  // The merge set is keyed by workspace id and nothing else: a merge recorded for a SIBLING
  // workspace must not clear this note's flag.
  it('clears only the merged workspace', () => {
    expect(provisionalOf({ workspaceId: 'w1' }, ws, new Set(['other']))).toEqual({ workspaceId: 'w1', title: 'Req' })
  })
})
