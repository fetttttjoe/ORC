import { describe, expect, it } from 'bun:test'
import { LINK_KIND, MemoryNoteInput, slugId } from '@orc/contracts'
import { CONSOLIDATED_TAG, consolidatedNote, isSubstantive } from './consolidate'

describe('consolidatedNote', () => {
  it('promotes step outcomes into one durable project note, linked derived_from what the task read', () => {
    const draft = consolidatedNote({
      taskTitle: 'Explain memory heat',
      steps: [{ title: 'Step A', summary: 'edges strengthen via memory_accessed' }, { title: 'Step B', summary: '   ' }],
      derivedFrom: ['area-memory', 'area-memory', 'projector-re-materialization'], // dup on purpose
    })
    expect(draft.id).toBe(slugId('outcome Explain memory heat'))
    expect(draft.scope).toBe('project')
    expect(draft.retention).toBe('durable')
    expect(draft.tags).toEqual([CONSOLIDATED_TAG])
    // deduped, typed provenance edges — project→project, so they resolve in the graph
    expect(draft.links).toEqual([
      { id: 'area-memory', kind: LINK_KIND.derived_from },
      { id: 'projector-re-materialization', kind: LINK_KIND.derived_from },
    ])
    // a blank-summary step is dropped from the body; the first real summary seeds the note summary
    expect(draft.body).toBe('- Step A: edges strengthen via memory_accessed')
    expect(draft.summary).toBe('edges strengthen via memory_accessed')
    // validates as a real note draft — no surprises at the store boundary
    expect(() => MemoryNoteInput.parse(draft)).not.toThrow()
  })

  it('with no steps and no provenance still yields a valid (if thin) durable note', () => {
    const draft = consolidatedNote({ taskTitle: 'Empty task', steps: [], derivedFrom: [] })
    expect(draft.body).toBe('')
    expect(draft.links).toEqual([])
    expect(draft.summary).toBe('Empty task')
    expect(() => MemoryNoteInput.parse(draft)).not.toThrow()
  })

  it('uses distilled text when provided, keeping the task-keyed id, scope, and links', () => {
    const draft = consolidatedNote(
      { taskTitle: 'Explain memory heat', steps: [{ title: 'a', summary: 'raw' }], derivedFrom: ['area-memory'] },
      { title: 'How memory heat works', summary: 'Edges strengthen on use.', body: '- via records the edge' },
    )
    expect(draft.title).toBe('How memory heat works') // distilled, not "Outcome: …"
    expect(draft.summary).toBe('Edges strengthen on use.')
    expect(draft.body).toBe('- via records the edge') // distilled body, not the extractive bullet
    expect(draft.id).toBe(slugId('outcome Explain memory heat')) // id stays task-keyed → idempotent
    expect(draft.scope).toBe('project')
    expect(draft.links).toEqual([{ id: 'area-memory', kind: LINK_KIND.derived_from }])
    expect(() => MemoryNoteInput.parse(draft)).not.toThrow()
  })
})

describe('isSubstantive', () => {
  it('gates on real work: read project knowledge OR multiple steps; skips trivial single lookups', () => {
    expect(isSubstantive({ steps: [{ title: 'a', summary: 'x' }], derivedFrom: ['area-memory'] })).toBe(true) // has provenance
    expect(isSubstantive({ steps: [{ title: 'a', summary: 'x' }, { title: 'b', summary: 'y' }], derivedFrom: [] })).toBe(true) // composed
    expect(isSubstantive({ steps: [{ title: 'a', summary: 'x' }], derivedFrom: [] })).toBe(false) // trivial single lookup
    expect(isSubstantive({ steps: [], derivedFrom: [] })).toBe(false)
  })
})
