import { afterAll, describe, expect, it } from 'bun:test'
import { Door, NOTE_TIER, NO_CHAT, type NoteView } from '@orc/contracts'
import { planNoteFixture } from '@orc/contracts/fixtures'
import { renderNoteFile } from './note-md'
import { createLiveMemory, type LiveMemory } from './test-helpers'
import { TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'

// The plan tier's execution payload — dependsOn/skillRefs/toolRefs/modelRef — was authored, logged,
// and then silently re-defaulted to []/'' on every read: noteTable, applyEvent's SET, and toNote()
// all omitted the four columns, so MemoryNote.parse filled the tier's defaults over what the log
// held. budget.ts's FitterCoversNote names the same four fields leaking once before on the read cap.
describe('plan-tier execution payload round-trip', () => {
  let live: LiveMemory | undefined
  afterAll(async () => { await live?.close() })

  it('dependsOn/skillRefs/toolRefs/modelRef survive store → projector → get', async () => {
    live = await createLiveMemory()
    await live.store.write({
      id: 'sub-a', scope: 'plan-t9', tier: NOTE_TIER.plan, title: 'Subplan A',
      rationale: 'split so the web lookup and the refactor can use different models',
      dependsOn: ['sub-b'], skillRefs: ['web-research'], toolRefs: ['files'],
      modelRef: 'anthropic/claude',
    }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID, origin: NO_CHAT(Door.cli) })
    await live.projector.catchUp()
    const got = await live.store.get('sub-a', 'plan-t9')
    expect(got).not.toBeNull()
    const v: NoteView | undefined = got ?? undefined
    expect(v?.dependsOn).toEqual(['sub-b'])
    expect(v?.skillRefs).toEqual(['web-research'])
    expect(v?.toolRefs).toEqual(['files'])
    expect(v?.modelRef).toBe('anthropic/claude')
  })
})

describe('vault markdown for a plan note', () => {
  it('renders the execution payload, and omits the keys when empty', () => {
    const md = renderNoteFile(planNoteFixture({
      dependsOn: ['sub-b'], skillRefs: ['web-research'], toolRefs: ['files'],
      modelRef: 'anthropic/claude',
    }))
    expect(md).toContain('dependsOn:')
    expect(md).toContain('- sub-b')
    expect(md).toContain('skillRefs:')
    expect(md).toContain('- web-research')
    expect(md).toContain('toolRefs:')
    expect(md).toContain('- files')
    expect(md).toContain('modelRef: anthropic/claude')
    // a plan note that carries none shows its real shape, not a union's worth of hollow keys
    const bare = renderNoteFile(planNoteFixture())
    expect(bare).not.toContain('dependsOn:')
    expect(bare).not.toContain('skillRefs:')
    expect(bare).not.toContain('toolRefs:')
    expect(bare).not.toContain('modelRef:')
  })
})
