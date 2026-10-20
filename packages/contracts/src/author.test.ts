import { describe, expect, it } from 'bun:test'
import { AUTHOR_SOURCE, AuthorSource, authorSourceOf, composeAuthor, stepAuthor } from './author'
import { authorFixture } from './fixtures'
import { Door } from './origin'

describe('authorSourceOf', () => {
  it('maps every door to the source that door stamps today', () => {
    expect(authorSourceOf(Door.web)).toBe(AUTHOR_SOURCE.cli)
    expect(authorSourceOf(Door.cli)).toBe(AUTHOR_SOURCE.cli)
    expect(authorSourceOf(Door.mcp)).toBe(AUTHOR_SOURCE.mcp)
    expect(authorSourceOf(Door.supervisor)).toBe(AUTHOR_SOURCE.agent)
    expect(authorSourceOf(Door.hook)).toBe(AUTHOR_SOURCE.cli)
  })
})

describe('composeAuthor', () => {
  it("'human' is an author source and renders as itself", () => {
    expect(composeAuthor(authorFixture({ source: AUTHOR_SOURCE.human }))).toBe('human')
    expect(composeAuthor(authorFixture({ source: AUTHOR_SOURCE.cli }))).toBe('cli')
  })
  it('a bare door composes to its own source, never to agent; a pipeline still composes', () => {
    expect(composeAuthor(authorFixture({ source: AUTHOR_SOURCE.mcp }))).toBe('mcp')
    expect(composeAuthor(authorFixture({ source: AUTHOR_SOURCE.agent }))).toBe('agent')
    expect(composeAuthor(authorFixture({ source: AUTHOR_SOURCE.mcp, executor: 'mcp-serve' }))).toBe('mcp-serve')
  })
})

describe('stepAuthor', () => {
  it("stepAuthor takes exactly the author fields from a step's params", () => {
    const author = authorFixture()
    const params = {
      origin: author.origin, workspaceId: 'ws-1', taskId: 't-1', stepId: 's-1', runToken: 'rt-1',
      executor: 'api-loop', model: 'm-1', role: 'builder',
      modelRef: 'anthropic/m-1', workspaceDir: '/w', step: { id: 's-1' }, ancestorTaskIds: ['t-0'],
    }
    expect(stepAuthor(params)).toEqual({
      source: AuthorSource.agent, origin: params.origin, workspaceId: 'ws-1', taskId: 't-1', stepId: 's-1',
      runToken: 'rt-1', executor: 'api-loop', model: 'm-1', role: 'builder',
    })
  })
})
