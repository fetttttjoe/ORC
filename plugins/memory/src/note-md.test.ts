import { describe, expect, it } from 'bun:test'
import type { MemoryNote } from '@orc/contracts'
import { noteRelPath, renderNoteFile } from './note-md'

const note: MemoryNote = {
  id: 'auth-token-refresh', scope: 'project', kind: 'fact', sourceRevision: 'abc123def',
  title: 'Auth token refresh flow',
  categories: ['architecture', 'security'], tags: ['auth'],
  links: [{ id: 'session-model', kind: 'refines' }, { id: 'cookie-auth', kind: 'supersedes', confidence: 0.9 }],
  paths: ['packages/kernel/src/auth.ts'], rules: ['Refresh tokens are single-use.'],
  summary: 'Refresh tokens rotate on use.', body: '# Detail\nrotation logic',
  rationale: '', uncertainty: [],
  createdAt: '2026-07-18T09:12:04Z', createdBy: 'api-loop·sonnet-5·research',
  updatedAt: '2026-07-18T11:30:22Z', updatedBy: 'api-loop·opus·review', revision: 3,
}

describe('renderNoteFile', () => {
  it('emits type: memory frontmatter with all sourced fields and the body', () => {
    const md = renderNoteFile(note)
    expect(md).toStartWith('---\n')
    expect(md).toContain('type: memory')
    expect(md).toContain('id: auth-token-refresh')
    expect(md).toContain('updatedBy: api-loop·opus·review')
    expect(md).toContain('revision: 3')
    expect(md).toContain('# Detail\nrotation logic')
    expect(md).not.toContain('readCount') // Tier-2 never in the file
  })
  it('renders typed links (id + kind [+ confidence]) in frontmatter', () => {
    const md = renderNoteFile(note)
    expect(md).toContain('id: session-model')
    expect(md).toContain('kind: refines')
    expect(md).toContain('kind: supersedes')
    expect(md).toContain('confidence: 0.9')
  })
  it('paths under scope subdir only for non-project scopes', () => {
    expect(noteRelPath(note)).toBe('auth-token-refresh.md')
    expect(noteRelPath({ ...note, scope: 'infra' })).toBe('infra/auth-token-refresh.md')
  })
})
