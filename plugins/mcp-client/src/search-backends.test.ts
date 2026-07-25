import { describe, expect, it } from 'bun:test'
import { SEARCH_BACKEND, createTavilySearch, createWikipediaSearch, selectSearchProvider } from './search-backends'

// A wrong edit here breaks nothing visibly — the tools keep working against a different corpus.
describe('selectSearchProvider', () => {
  it('defaults to the keyless backend so the simulation runs without an account', () => {
    expect(selectSearchProvider({}).id).toBe(SEARCH_BACKEND.wikipedia)
    expect(selectSearchProvider({ TAVILY_API_KEY: undefined }).id).toBe(SEARCH_BACKEND.wikipedia)
  })

  // `export K=` is how a key gets unset in practice
  it('treats a blank key as no key, not as a broken one', () => {
    expect(selectSearchProvider({ TAVILY_API_KEY: '' }).id).toBe(SEARCH_BACKEND.wikipedia)
    expect(selectSearchProvider({ TAVILY_API_KEY: '   ' }).id).toBe(SEARCH_BACKEND.wikipedia)
  })

  it('upgrades to the keyed backend when a key is present', () => {
    expect(selectSearchProvider({ TAVILY_API_KEY: 'tvly-x' }).id).toBe(SEARCH_BACKEND.tavily)
  })
})

describe('SearchProvider implementations', () => {
  it('each reports the backend it is, so a result can name the corpus it came from', () => {
    expect(createWikipediaSearch().id).toBe(SEARCH_BACKEND.wikipedia)
    expect(createTavilySearch('tvly-x').id).toBe(SEARCH_BACKEND.tavily)
  })

  it('every backend id is a value from the registry — no scattered literals', () => {
    const ids = [createWikipediaSearch().id, createTavilySearch('k').id]
    for (const id of ids) expect(Object.values(SEARCH_BACKEND)).toContain(id)
  })
})
