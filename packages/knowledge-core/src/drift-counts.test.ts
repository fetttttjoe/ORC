import { describe, expect, it } from 'bun:test'
import { ClaimClass, ClaimState, type ClaimDrift } from '@orc/contracts'
import { driftCounts } from './drift-counts'

const drift = (state: ClaimState): ClaimDrift => ({
  claim: { id: `id-${state}`, text: 't', class: ClaimClass.fact, anchors: [], tags: [], sources: [], decision: null, location: 'knowledge/a.md' },
  state, basis: null, anchors: [],
})

describe('driftCounts', () => {
  it('is zero in every state for no drifts', () => {
    expect(driftCounts([])).toEqual({ clean: 0, suspect: 0, unknown: 0, unanchored: 0 })
  })
  it('counts each state separately', () => {
    const states = [ClaimState.clean, ClaimState.suspect, ClaimState.suspect, ClaimState.unanchored]
    expect(driftCounts(states.map(drift))).toEqual({ clean: 1, suspect: 2, unknown: 0, unanchored: 1 })
  })
})
