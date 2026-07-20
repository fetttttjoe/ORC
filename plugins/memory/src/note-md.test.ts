import { describe, expect, it } from 'bun:test'
import type { MemoryNote } from '@orc/contracts'
import { noteRelPath, renderNoteFile } from './note-md'

const note = (over: Partial<MemoryNote> & { id: string }): MemoryNote => ({
  scope: 'project', kind: 'fact', sourceRevision: 'abc123def',
  title: 'Auth token refresh flow',
  categories: ['architecture', 'security'], tags: ['auth'],
  links: [{ id: 'session-model', kind: 'refines' }, { id: 'cookie-auth', kind: 'supersedes', confidence: 0.9 }],
  paths: ['packages/kernel/src/auth.ts'], rules: ['Refresh tokens are single-use.'],
  summary: 'Refresh tokens rotate on use.', body: '# Detail\nrotation logic',
  sources: [], rationale: '', uncertainty: [],
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
  it('renders typed links (id + kind [+ confidence]) in frontmatter', () => {
    const md = renderNoteFile(note({ id: 'auth-token-refresh' }))
    expect(md).toContain('id: session-model')
    expect(md).toContain('kind: refines')
    expect(md).toContain('kind: supersedes')
    expect(md).toContain('confidence: 0.9')
  })
  it('paths under scope subdir only for non-project scopes', () => {
    expect(noteRelPath(note({ id: 'auth-token-refresh' }))).toBe('auth-token-refresh.md')
    expect(noteRelPath(note({ id: 'auth-token-refresh', scope: 'infra' }))).toBe('infra/auth-token-refresh.md')
  })
  it('renders a plan-note with decomposes_into links, rationale, and uncertainty', () => {
    const md = renderNoteFile(note({
      id: 'master', kind: 'plan', title: 'build web', rationale: 'why',
      uncertainty: ['schema unknown'], links: [{ id: 'db', kind: 'decomposes_into' }],
    }))
    expect(md).toContain('kind: plan')
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
