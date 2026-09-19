import { describe, expect, it } from 'bun:test'
import { AUTHOR_SOURCE, authorSourceOf, composeAuthor } from './author'
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
  // A door with nothing to compose from renders as ITSELF. The old `|| 'agent'` fallthrough made a
  // bare `{ source: 'mcp', workspaceId }` — exactly what cwdAuthor builds for the MCP door, which
  // has no executor/model/role — render as 'agent', and deriveNoteProvenance stamps that into
  // createdBy, which is STICKY across rewrites: every decision recorded over MCP would have read as
  // an agent's forever.
  it('a bare door composes to its own source, never to agent; a pipeline still composes', () => {
    expect(composeAuthor(authorFixture({ source: AUTHOR_SOURCE.mcp }))).toBe('mcp')
    expect(composeAuthor(authorFixture({ source: AUTHOR_SOURCE.agent }))).toBe('agent')
    expect(composeAuthor(authorFixture({ source: AUTHOR_SOURCE.mcp, executor: 'mcp-serve' }))).toBe('mcp-serve')
  })
})
