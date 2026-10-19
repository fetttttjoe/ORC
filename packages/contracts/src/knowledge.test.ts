import { describe, expect, it } from 'bun:test'
import { EVENT_KIND } from './event-kinds'
import { PAYLOAD_SCHEMAS } from './events'
import { errorMessage } from './guards'
import {
  ClaimClass, DeliveryMode, KNOWLEDGE_DEFAULTS, KNOWLEDGE_ID_RE, KNOWLEDGE_LIMITS, KnowledgeAnchor, KnowledgeConfig, KnowledgeDraft, KnowledgePatch,
  knowledgeIdFrom, newKnowledgeId,
} from './knowledge'

const author = { source: 'agent', workspaceId: 'ws-1', origin: { chatId: null, door: 'supervisor' } }
const failure = (r: { success: boolean; error?: unknown }): string => (r.success ? '' : errorMessage(r.error))

describe('knowledge ids', () => {
  it('a fresh id is 8 lowercase letters or digits, and two are different', () => {
    const a = newKnowledgeId()
    expect(a).toMatch(KNOWLEDGE_ID_RE)
    expect(newKnowledgeId()).not.toBe(a)
  })
  it('an id from a seed is stable and well-formed', () => {
    expect(knowledgeIdFrom('call-1:0')).toBe(knowledgeIdFrom('call-1:0'))
    expect(knowledgeIdFrom('call-1:0')).not.toBe(knowledgeIdFrom('call-1:1'))
    expect(knowledgeIdFrom('x')).toMatch(KNOWLEDGE_ID_RE)
  })
})

describe('KnowledgeDraft', () => {
  it('a minimal draft gets empty anchors, tags and sources and no decision', () => {
    expect(KnowledgeDraft.parse({ text: '  The store is the only writer.  ', class: ClaimClass.fact }))
      .toEqual({ text: 'The store is the only writer.', class: ClaimClass.fact, anchors: [], tags: [], sources: [], decision: null })
  })
  it('accepts an https source and refuses one with credentials, spaces or another scheme', () => {
    const draft = (sources: string[]) => KnowledgeDraft.safeParse({ text: 't', class: ClaimClass.fact, sources })
    expect(draft(['https://bun.sh/docs/cli/test#changed']).success).toBe(true)
    expect(draft(['https://user:pw@host/x']).success).toBe(false)
    expect(draft(['https://host/a b']).success).toBe(false)
    expect(draft(['ftp://host/x']).success).toBe(false)
  })
  it('refuses a claim over two lines, one ending with }, and a blank one', () => {
    expect(failure(KnowledgeDraft.safeParse({ text: 'a\nb', class: ClaimClass.fact }))).toContain('one line')
    expect(failure(KnowledgeDraft.safeParse({ text: 'ends {x}', class: ClaimClass.fact }))).toContain('cannot end with }')
    expect(KnowledgeDraft.safeParse({ text: '   ', class: ClaimClass.fact }).success).toBe(false)
  })
  it('refuses a class other than fact or why', () => {
    expect(KnowledgeDraft.safeParse({ text: 't', class: 'story' }).success).toBe(false)
  })
  it('refuses an upper-case tag and accepts a kebab one', () => {
    expect(KnowledgeDraft.safeParse({ text: 't', class: ClaimClass.why, tags: ['Drift'] }).success).toBe(false)
    expect(KnowledgeDraft.parse({ text: 't', class: ClaimClass.why, tags: ['event-log'] }).tags).toEqual(['event-log'])
  })
})

describe('KnowledgeAnchor', () => {
  it('normalises the path and defaults the symbol to null', () => {
    expect(KnowledgeAnchor.parse({ path: './src\\a.ts' })).toEqual({ path: 'src/a.ts', symbol: null })
  })
  it.each([['/etc/passwd'], ['C:\\secret.txt'], ['../x.ts'], ['a/../x.ts'], ['a\0b'], ['.'], ['src/a b.ts'], ['src/a#b.ts'], ['src/{a}.ts'], ['src/@a.ts']])(
    'refuses the path %p', path => {
      expect(KnowledgeAnchor.safeParse({ path }).success).toBe(false)
    })
  it('refuses a symbol with a space or a sigil', () => {
    expect(KnowledgeAnchor.safeParse({ path: 'src/a.ts', symbol: 'a b' }).success).toBe(false)
    expect(KnowledgeAnchor.safeParse({ path: 'src/a.ts', symbol: 'a#b' }).success).toBe(false)
    expect(KnowledgeAnchor.parse({ path: 'src/a.ts', symbol: 'createStore.write' }).symbol).toBe('createStore.write')
  })
})

describe('KnowledgePatch', () => {
  const add = [{ text: 't', class: ClaimClass.fact }]
  it('fills defaults', () => {
    expect(KnowledgePatch.parse({ add })).toMatchObject({ change: [], retire: [], why: null, decision: null })
  })
  it('refuses an empty patch', () => {
    expect(failure(KnowledgePatch.safeParse({}))).toContain('at least one claim')
  })
  it('refuses changing and retiring the same claim, and changing one claim twice', () => {
    expect(failure(KnowledgePatch.safeParse({ change: [{ id: 'aaaaaaaa', text: 'x' }], retire: ['aaaaaaaa'] }))).toContain('change and retire')
    expect(failure(KnowledgePatch.safeParse({ change: [{ id: 'aaaaaaaa' }, { id: 'aaaaaaaa' }] }))).toContain('at most once')
  })
  it('refuses adding and retiring the same claim, and allows retiring another', () => {
    expect(failure(KnowledgePatch.safeParse({ add: [{ text: 't', class: ClaimClass.fact, id: 'aaaaaaaa' }], retire: ['aaaaaaaa'] })))
      .toContain('add and retire')
    expect(KnowledgePatch.safeParse({ add: [{ text: 't', class: ClaimClass.fact, id: 'aaaaaaaa' }], retire: ['bbbbbbbb'] }).success).toBe(true)
  })
  it('refuses adding one id twice, and allows two additions without ids', () => {
    const named = { text: 't', class: ClaimClass.fact, id: 'aaaaaaaa' }
    expect(failure(KnowledgePatch.safeParse({ add: [named, named] }))).toContain('adds each claim at most once')
    expect(KnowledgePatch.safeParse({ add: [...add, ...add] }).success).toBe(true)
  })
  it('refuses retiring one claim twice', () => {
    expect(failure(KnowledgePatch.safeParse({ retire: ['aaaaaaaa', 'aaaaaaaa'] }))).toContain('retires each claim at most once')
  })
  it('refuses adding and changing the same claim', () => {
    expect(failure(KnowledgePatch.safeParse({ add: [{ text: 't', class: ClaimClass.fact, id: 'aaaaaaaa' }], change: [{ id: 'aaaaaaaa', text: 'x' }] })))
      .toContain('add and change')
  })
  it('refuses a malformed id and a malformed decision slug', () => {
    expect(KnowledgePatch.safeParse({ retire: ['ABC'] }).success).toBe(false)
    expect(KnowledgePatch.safeParse({ add, decision: 'Not A Slug' }).success).toBe(false)
  })
})

describe('KnowledgeConfig', () => {
  it('defaults options and refuses unknown keys', () => {
    expect(KnowledgeConfig.parse({ plugin: 'git-files' })).toEqual({ plugin: 'git-files', options: {} })
    expect(KnowledgeConfig.safeParse({ plugin: 'git-files', extra: 1 }).success).toBe(false)
  })
})

describe('knowledge defaults', () => {
  it('stay inside the port caps', () => {
    expect(KNOWLEDGE_DEFAULTS.pageItems).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.pageItems)
    expect(KNOWLEDGE_DEFAULTS.searchItems).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.searchItems)
  })
})

describe('knowledge events', () => {
  it('both kinds exist and parse their payloads', () => {
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.knowledge_delivered].safeParse({ ids: ['abcd1234'], mode: DeliveryMode.card, subject: 'src/a.ts', author }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.knowledge_written].safeParse({
      added: [{ id: 'abcd1234', location: 'knowledge/src/a.ts.md' }], changed: [], retired: [], files: ['knowledge/src/a.ts.md'], why: null, decision: null, decisionsRecorded: [], decisionsSuperseded: [], asserted: [], author,
    }).success).toBe(true)
  })
  it('a delivery carries at most 200 ids', () => {
    const ids = Array.from({ length: 201 }, (_, i) => knowledgeIdFrom(String(i)))
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.knowledge_delivered].safeParse({ ids, mode: DeliveryMode.card, subject: 's', author }).success).toBe(false)
  })
})
