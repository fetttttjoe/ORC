import { describe, expect, it } from 'bun:test'
import {
  AUTHOR_SOURCE, ClaimClass, DeliveryMode, Door, EVENT_KIND, KNOWLEDGE_REFUSAL, KnowledgeToolName, knowledgeIdFrom,
  type EventInput, type MemoryAuthor, type ResolvedTool,
} from '@orc/contracts'
import { createMemoryBackend } from './memory-backend'
import { createKnowledgePort } from './port'
import { KNOWLEDGE_READ_TOOLS, KNOWLEDGE_STEP_TOOLS, knowledgeTools } from './tools'

const author: MemoryAuthor = { source: AUTHOR_SOURCE.agent, workspaceId: 'ws-1', origin: { chatId: 'c-1', door: Door.supervisor }, taskId: 't-1', stepId: 's-1', runToken: 'r-1' }
const setup = () => {
  const events: EventInput[] = []
  const port = createKnowledgePort({ backend: createMemoryBackend({ exists: () => true }), checkoutOf: async () => '/checkout', append: async e => { events.push(e) } })
  const tools = knowledgeTools({ port }, author, KNOWLEDGE_STEP_TOOLS)
  const tool = (name: KnowledgeToolName): ResolvedTool => {
    const found = tools.find(t => t.name === name)
    if (!found) throw new Error(`missing ${name}`)
    return found
  }
  return { events, tools, tool }
}
const add = (text: string) => ({ add: [{ text, class: ClaimClass.fact, anchors: [{ path: 'src/a.ts' }] }], why: 'learned it' })

describe('knowledge tools', () => {
  it('are named by the enum, in order, and a read-only set is the first two', () => {
    expect(setup().tools.map(t => t.name)).toEqual([KnowledgeToolName.card, KnowledgeToolName.search, KnowledgeToolName.write])
    expect(knowledgeTools({ unavailable: 'x' }, author, KNOWLEDGE_READ_TOOLS).map(t => t.name)).toEqual([KnowledgeToolName.card, KnowledgeToolName.search])
  })
  it('advertise JSON schemas from the zod inputs: card needs a path, write needs a why', () => {
    const { tool } = setup()
    expect(tool(KnowledgeToolName.card).inputSchema).toMatchObject({ type: 'object', required: ['path'] })
    expect(tool(KnowledgeToolName.write).inputSchema).toMatchObject({ type: 'object', required: ['why'] })
  })
  it('write, card and search round-trip, with evidence keyed by the run token and tool call id', async () => {
    const { tool, events } = setup()
    const written = await tool(KnowledgeToolName.write).execute(add('The store writes events.'), 'call-1')
    expect(written.isError).toBe(false)
    const card = await tool(KnowledgeToolName.card).execute({ path: 'src/a.ts' }, 'call-2')
    expect(card.output).toMatchObject({ path: 'src/a.ts', claims: [{ text: 'The store writes events.' }], next: null })
    const search = await tool(KnowledgeToolName.search).execute({ query: 'store events' }, 'call-3')
    expect(search.output).toMatchObject({ query: 'store events', claims: [{ text: 'The store writes events.' }] })
    expect(events.map(e => [e.kind, e.idempotencyKey])).toEqual([
      [EVENT_KIND.knowledge_written, 'r-1:tool:call-1:knowledge'],
      [EVENT_KIND.knowledge_delivered, 'r-1:tool:call-2:knowledge'],
      [EVENT_KIND.knowledge_delivered, 'r-1:tool:call-3:knowledge'],
    ])
    expect(events[1]).toMatchObject({ payload: { mode: DeliveryMode.card } })
  })
  it('a retried write adds nothing new; an agent-sent id is ignored', async () => {
    const { tool } = setup()
    const input = { ...add('once'), add: [{ ...add('once').add[0], id: 'zzzzzzzz' }] }
    const first = await tool(KnowledgeToolName.write).execute(input, 'call-9')
    const second = await tool(KnowledgeToolName.write).execute(input, 'call-9')
    expect(first.output).toMatchObject({ added: [{ id: knowledgeIdFrom('r-1:tool:call-9:knowledge:0') }] })
    expect(second.output).toEqual(first.output)
    expect((await tool(KnowledgeToolName.card).execute({ path: '.' }, 'call-10')).output).toMatchObject({ claims: [{ text: 'once' }] })
  })
  it('a write without a why is refused and writes nothing', async () => {
    const { tool, events } = setup()
    const refused = await tool(KnowledgeToolName.write).execute({ add: add('no why').add }, 'call-4')
    expect(refused.isError).toBe(true)
    expect(events).toEqual([])
  })
  it('every knowledge_* tool named inside a description exists in KnowledgeToolName', () => {
    const known = new Set<string>(Object.values(KnowledgeToolName))
    for (const t of setup().tools) {
      const mentioned = t.description.match(/\bknowledge_[a-z]+\b/g) ?? []
      expect(mentioned.filter(name => !known.has(name))).toEqual([])
    }
  })
  it('unavailable knowledge keeps every tool and answers the reason', async () => {
    const tools = knowledgeTools({ unavailable: KNOWLEDGE_REFUSAL.off() }, author, KNOWLEDGE_STEP_TOOLS)
    expect(tools.map(t => t.name)).toEqual([...KNOWLEDGE_STEP_TOOLS])
    for (const t of tools) expect(await t.execute({}, 'c')).toEqual({ output: { error: KNOWLEDGE_REFUSAL.unavailable(KNOWLEDGE_REFUSAL.off()) }, isError: true })
  })
})
