import { describe, expect, it } from 'bun:test'
import {
  AUTHOR_SOURCE, DECISION_REFUSAL, DecisionStatus, Door, EVENT_KIND, KNOWLEDGE_REFUSAL, KnowledgeToolName,
  type EventInput, type MemoryAuthor, type ResolvedTool,
} from '@orc/contracts'
import { DECISION_STEP_TOOLS, decisionTools } from './decision-tools'
import { createMemoryBackend } from './memory-backend'
import { createKnowledgePort } from './port'

const author: MemoryAuthor = { source: AUTHOR_SOURCE.agent, workspaceId: 'ws-1', origin: { chatId: 'c-1', door: Door.supervisor }, taskId: 't-1', stepId: 's-1', runToken: 'r-1' }
const ADR = { title: 'Use files', context: 'c', decision: 'd', consequences: 'q' }
const setup = () => {
  const sent: EventInput[] = []
  const stored: EventInput[] = []
  const port = createKnowledgePort({
    backend: createMemoryBackend({ exists: () => true }), checkoutOf: async () => '/checkout',
    append: async e => {
      sent.push(e)
      if (e.idempotencyKey == null || !stored.some(s => s.idempotencyKey === e.idempotencyKey)) stored.push(e)
    },
  })
  const tools = decisionTools({ port }, author)
  const tool = (name: KnowledgeToolName): ResolvedTool => {
    const found = tools.find(t => t.name === name)
    if (!found) throw new Error(`missing ${name}`)
    return found
  }
  return { sent, stored, tools, tool }
}

describe('decision tools', () => {
  it('are the list, read and record tools, named by the enum', () => {
    expect(DECISION_STEP_TOOLS).toEqual([KnowledgeToolName.decisionList, KnowledgeToolName.decisionRead, KnowledgeToolName.recordDecision])
    expect(setup().tools.map(t => t.name)).toEqual([...DECISION_STEP_TOOLS])
  })
  it('advertise their required fields, and record_decision has no status', () => {
    const { tool } = setup()
    expect(tool(KnowledgeToolName.decisionList).inputSchema).toMatchObject({ type: 'object' })
    expect(tool(KnowledgeToolName.decisionList).inputSchema).not.toHaveProperty('required')
    expect(tool(KnowledgeToolName.decisionRead).inputSchema).toMatchObject({ type: 'object', required: ['id'] })
    const record = tool(KnowledgeToolName.recordDecision).inputSchema
    expect(record).toMatchObject({ type: 'object', required: ['title', 'context', 'decision', 'consequences'] })
    expect(record).toHaveProperty('properties.supersedes')
    expect(record).not.toHaveProperty('properties.status')
  })
  it('a record reaches the port under the step author and the run-token key, and answers id, status, superseded, warnings', async () => {
    const { tool, sent } = setup()
    const result = await tool(KnowledgeToolName.recordDecision).execute(ADR, 'call-1')
    expect(result).toEqual({ output: { id: 'use-files', status: DecisionStatus.accepted, superseded: null, warnings: [] }, isError: false })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: EVENT_KIND.knowledge_written, idempotencyKey: 'r-1:tool:call-1:knowledge', payload: { author, decisionsRecorded: [{ id: 'use-files' }] } })
  })
  it('a replayed call answers the same and leaves one stored record', async () => {
    const { tool, stored } = setup()
    const first = await tool(KnowledgeToolName.recordDecision).execute(ADR, 'call-1')
    const again = await tool(KnowledgeToolName.recordDecision).execute(ADR, 'call-1')
    expect(again).toEqual(first)
    expect(stored).toHaveLength(1)
  })
  it('a changed decision is recorded as a supersession that names the old id', async () => {
    const { tool } = setup()
    await tool(KnowledgeToolName.recordDecision).execute(ADR, 'call-1')
    const result = await tool(KnowledgeToolName.recordDecision).execute({ ...ADR, title: 'Use more files', supersedes: 'use-files' }, 'call-2')
    expect(result.output).toEqual({ id: 'use-more-files', status: DecisionStatus.accepted, superseded: 'use-files', warnings: [] })
  })
  it('recording an existing title again with other content is refused', async () => {
    const { tool } = setup()
    await tool(KnowledgeToolName.recordDecision).execute(ADR, 'call-1')
    const result = await tool(KnowledgeToolName.recordDecision).execute({ ...ADR, decision: 'other' }, 'call-2')
    expect(result).toEqual({ output: { error: DECISION_REFUSAL.exists('use-files') }, isError: true })
  })
  it('list answers an empty list first, then one summary line per decision; read answers the whole decision', async () => {
    const { tool } = setup()
    expect(await tool(KnowledgeToolName.decisionList).execute({}, 'l-1')).toEqual({ output: { decisions: [] }, isError: false })
    await tool(KnowledgeToolName.recordDecision).execute(ADR, 'call-1')
    const listed = await tool(KnowledgeToolName.decisionList).execute({}, 'l-2')
    expect(listed.output).toMatchObject({ decisions: [{ id: 'use-files', title: 'Use files', status: DecisionStatus.accepted, summary: 'd', supersedes: null, supersededBy: null }] })
    expect((await tool(KnowledgeToolName.decisionList).execute({ status: DecisionStatus.deprecated }, 'l-3')).output).toEqual({ decisions: [] })
    const read = await tool(KnowledgeToolName.decisionRead).execute({ id: 'use-files' }, 'r-1')
    expect(read.output).toMatchObject({ id: 'use-files', context: 'c', decision: 'd', consequences: 'q', considered: [] })
    expect(await tool(KnowledgeToolName.decisionRead).execute({ id: 'nope' }, 'r-2')).toEqual({ output: { error: DECISION_REFUSAL.noSuchDecision('nope') }, isError: true })
  })
  it('unavailable knowledge refuses every tool with the reason', async () => {
    const off = decisionTools({ unavailable: 'no plugin' }, author)
    for (const t of off) expect(await t.execute({}, 'c')).toEqual({ output: { error: KNOWLEDGE_REFUSAL.unavailable('no plugin') }, isError: true })
  })
})
