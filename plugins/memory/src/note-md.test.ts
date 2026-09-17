import { describe, expect, it } from 'bun:test'
import { claimId, DECISION_STATUS, NOTE_KIND, type SemanticNote } from '@orc/contracts'
import { planNoteFixture, semanticNoteFixture } from '@orc/contracts/fixtures'
import { CLAIMS_HEADING, noteRelPath, renderNoteFile } from './note-md'

const SINGLE_USE = 'Refresh tokens are single-use.'

const note = (over: Partial<SemanticNote> & { id: string }): SemanticNote => semanticNoteFixture({
  sourceRevision: 'abc123def',
  title: 'Auth token refresh flow',
  categories: ['architecture', 'security'], tags: ['auth'],
  links: [{ id: 'session-model', kind: 'refines' }, { id: 'cookie-auth', kind: 'supersedes', confidence: 0.9 }],
  paths: ['packages/kernel/src/auth.ts'],
  claims: [{ id: claimId(SINGLE_USE), text: SINGLE_USE, sourceRevision: 'abc123def' }],
  summary: 'Refresh tokens rotate on use.', body: '# Detail\nrotation logic',
  createdAt: '2026-07-18T09:12:04Z', createdBy: 'api-loop·sonnet-5·research',
  updatedAt: '2026-07-18T11:30:22Z', updatedBy: 'api-loop·opus·review', revision: 3,
  ...over,
})

describe('renderNoteFile', () => {
  it('emits type: memory frontmatter with all sourced fields and the body', () => {
    const md = renderNoteFile(note({ id: 'auth-token-refresh' }))
    expect(md).toStartWith('---\n')
    expect(md).toContain('type: memory')
    expect(md).toContain('id: auth-token-refresh')
    expect(md).toContain('updatedBy: api-loop·opus·review')
    expect(md).toContain('revision: 3')
    expect(md).toContain('# Detail\nrotation logic')
    expect(md).not.toContain('readCount') // Tier-2 never in the file
  })
  // The vault file is the human read surface for a decision: whether an ADR is still in force has
  // to be visible without opening the tool. Spread, never written as a hollow key — a `status:` on
  // every fact note would say a lifecycle governs knowledge that has none.
  it("renders a decision's status into frontmatter and omits the key on every other note", () => {
    const decision = semanticNoteFixture({ id: 'd', kind: NOTE_KIND.decision, status: DECISION_STATUS.superseded })
    expect(renderNoteFile(decision)).toContain('status: superseded')
    expect(renderNoteFile(semanticNoteFixture({ id: 'f' }))).not.toContain('status:')
  })
  it('renders typed links (id + kind [+ confidence]) in frontmatter', () => {
    const md = renderNoteFile(note({ id: 'auth-token-refresh' }))
    expect(md).toContain('id: session-model')
    expect(md).toContain('kind: refines')
    expect(md).toContain('kind: supersedes')
    expect(md).toContain('confidence: 0.9')
  })
  it('renders claims with their ids so a human can invalidate one by name', () => {
    const md = renderNoteFile(note({ id: 'auth-token-refresh' }))
    expect(md).toContain(CLAIMS_HEADING)
    expect(md).toContain(`- [${claimId(SINGLE_USE)}] ${SINGLE_USE}`)
    // the id is what `orc memory claims --invalidate` takes, so it has to be readable off the file
    expect(md).toContain(claimId(SINGLE_USE))
  })
  it('omits the Claims section for a semantic note that asserts none', () => {
    expect(renderNoteFile(note({ id: 'bare', claims: [] }))).not.toContain(CLAIMS_HEADING)
  })
  it('paths under scope subdir only for non-project scopes', () => {
    expect(noteRelPath(note({ id: 'auth-token-refresh' }))).toBe('auth-token-refresh.md')
    expect(noteRelPath(note({ id: 'auth-token-refresh', scope: 'infra' }))).toBe('infra/auth-token-refresh.md')
  })
  it('renders a plan-note with decomposes_into links, rationale, and uncertainty', () => {
    const md = renderNoteFile(planNoteFixture({
      id: 'master', scope: 'project', title: 'build web', rationale: 'why',
      uncertainty: ['schema unknown'], links: [{ id: 'db', kind: 'decomposes_into' }],
    }))
    expect(md).toContain('tier: plan')
    expect(md).not.toContain(CLAIMS_HEADING) // a plan note has no retrieval surface to render
    expect(md).toContain('decomposes_into')
    expect(md).toContain('schema unknown')
    expect(md).toContain('## Rationale')
    expect(md).toContain('why')
    expect(md).toContain('## Uncertainty')
    expect(md).toContain('- schema unknown')
    expect(md).toContain('## Decomposes into')
    expect(md).toContain('[db](./db.md)')
  })
  it('omits Rationale/Uncertainty/Decomposes-into sections when the note carries none', () => {
    const md = renderNoteFile(note({ id: 'auth-token-refresh' }))
    expect(md).not.toContain('## Rationale')
    expect(md).not.toContain('## Uncertainty')
    expect(md).not.toContain('## Decomposes into')
    expect(md).not.toContain('## Depends on')
  })

  // The vault is the human read surface, so it owes the same standing the tools report: a note
  // still living in an unmerged checkout is not yet project knowledge, and a file that says nothing
  // reads as if it were.
  it('names the workspace a note is still pending in, and says nothing once it is trunk knowledge', () => {
    const pending = note({ id: 'auth-token-refresh', workspaceId: 'w1' })
    const view = { workspaces: new Map([['w1', { onTrunk: false, title: 'Requests rework' }]]), merged: new Set<string>() }
    expect(renderNoteFile(pending, view)).toContain('provisional: w1')
    expect(renderNoteFile(pending, { ...view, merged: new Set(['w1']) })).not.toContain('provisional:')
    // no view bound (a render path with no log to fold) claims nothing either way
    expect(renderNoteFile(pending)).not.toContain('provisional:')
  })

  it('renders citations with their retrieval time, and no empty section when uncited', () => {
    const cited = renderNoteFile(note({
      id: 'finding', kind: 'research',
      sources: [
        { url: 'https://example.test/a', title: 'Paper A', retrievedAt: '2026-07-18T00:00:00Z' },
        { url: 'https://example.test/b', retrievedAt: '2026-07-18T00:00:00Z' },
      ],
    }))
    expect(cited).toContain('## Sources')
    expect(cited).toContain('- [Paper A](https://example.test/a) — retrieved 2026-07-18T00:00:00Z')
    expect(cited).toContain('- [https://example.test/b](https://example.test/b)') // falls back to the url
    expect(renderNoteFile(note({ id: 'plain' }))).not.toContain('## Sources')
  })
})
