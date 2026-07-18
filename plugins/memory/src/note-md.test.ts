import { describe, expect, it } from 'bun:test'
import { noteRelPath, renderNoteFile } from './note-md'

const note = {
  id: 'auth-token-refresh', scope: 'project', title: 'Auth token refresh flow',
  categories: ['architecture', 'security'], tags: ['auth'], links: ['session-model'],
  paths: ['packages/kernel/src/auth.ts'], rules: ['Refresh tokens are single-use.'],
  summary: 'Refresh tokens rotate on use.', body: '# Detail\nrotation logic',
  createdAt: '2026-07-18T09:12:04Z', createdBy: 'api-loop·sonnet-5·research',
  updatedAt: '2026-07-18T11:30:22Z', updatedBy: 'api-loop·opus·review', revision: 3,
}

describe('renderNoteFile', () => {
  it('emits type: memory frontmatter with all sourced fields and the body', () => {
    const md = renderNoteFile(note as any)
    expect(md).toStartWith('---\n')
    expect(md).toContain('type: memory')
    expect(md).toContain('id: auth-token-refresh')
    expect(md).toContain('updatedBy: api-loop·opus·review')
    expect(md).toContain('revision: 3')
    expect(md).toContain('# Detail\nrotation logic')
    expect(md).not.toContain('readCount') // Tier-2 never in the file
  })
  it('paths under scope subdir only for non-project scopes', () => {
    expect(noteRelPath(note as any)).toBe('auth-token-refresh.md')
    expect(noteRelPath({ ...note, scope: 'infra' } as any)).toBe('infra/auth-token-refresh.md')
  })
})
