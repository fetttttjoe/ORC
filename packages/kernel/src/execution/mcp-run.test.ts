import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVENT_KIND } from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { createMcpHub } from '@orc/mcp-client'
import { apiLoopExecutor } from '@orc/executor-api-loop'
import { scriptModel } from '@orc/executor-api-loop/test-model'
import { EventLog } from '../eventlog'
import { Kernel } from '../kernel'
import { fold } from '../projections'
import { loadConfig, deriveSystemUrl } from '../config'
import { createTestDb } from '../test-helpers'
import { SkillIndex } from '../plugins/skills'
import { createDbosPort, type DbosPort } from './dbos-port'

const FIXTURE = fileURLToPath(new URL('../../../../plugins/mcp-client/src/fixture-server.ts', import.meta.url))

describe('MCP + skills through a durable run (integration)', () => {
  let kernel: Kernel
  let port: DbosPort
  let log: EventLog
  let teardown: () => Promise<void>

  beforeAll(async () => {
    const db = await createTestDb()
    log = await EventLog.open(db.url)
    kernel = new Kernel(log)

    const skillsRoot = mkdtempSync(path.join(tmpdir(), 'orc-mcp-run-'))
    mkdirSync(path.join(skillsRoot, 'haiku-style'), { recursive: true })
    writeFileSync(
      path.join(skillsRoot, 'haiku-style', 'SKILL.md'),
      `---\nname: haiku-style\ndescription: write everything as haiku\n---\nAlways answer in haiku.`,
    )
    const skills = await SkillIndex.open(skillsRoot)
    const hub = createMcpHub({ fixture: { command: 'bun', args: [FIXTURE] } }, new Set(['fixture']))

    // the model calls the real MCP echo tool, then signals with its result
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'mcp__fixture__echo', input: { text: 'ping' } }] },
      { toolCalls: [{ toolCallId: 'c2', toolName: 'signal', input: { outcome: 'success', summary: 'echoed' } }] },
    ])
    const config = { ...loadConfig(), databaseUrl: db.url, systemDatabaseUrl: deriveSystemUrl(db.url) }
    port = await createDbosPort({
      log, config,
      providers: new Map([['fake', { costs: {}, languageModel: () => model }]]),
      executors: new Map([['api-loop', apiLoopExecutor()]]),
      skills, tools: hub,
    })
    await port.launch()
    teardown = async () => {
      await port.shutdown()
      await hub.close()
      skills.close()
      await log.close()
      rmSync(skillsRoot, { recursive: true, force: true })
      await db.drop()
    }
  })
  afterAll(async () => { await teardown() })

  it('runs to done with skill_loaded + real MCP tool events, and replay holds', async () => {
    const t = await kernel.createTask({ title: 'mcp run', spec: 'echo ping' })
    await kernel.proposePlan(t.id, draftFixture([stepFixture({
      modelRef: 'fake/m', skillRefs: ['haiku-style'], toolRefs: ['fixture/echo'],
    })]))
    await kernel.approvePlan(t.id)

    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe('done')

    const events = await kernel.eventsFor(t.id)
    const kinds = events.map(e => e.kind)
    expect(kinds).toContain(EVENT_KIND.skill_loaded)
    const call = events.find(e => e.kind === EVENT_KIND.tool_call)!
    expect((call.payload as { toolName: string }).toolName).toBe('mcp__fixture__echo')
    const result = events.find(e => e.kind === EVENT_KIND.tool_result)!
    expect(JSON.stringify(result.payload)).toContain('echo: ping')
    expect((result.payload as { isError: boolean }).isError).toBe(false)

    // the skill body reached the model: recorded in the agent_call request (R9)
    const agentCall = events.find(e => e.kind === EVENT_KIND.agent_call)!
    expect(JSON.stringify(agentCall.payload)).toContain('Always answer in haiku.')

    // replay identity: fold(events) twice gives identical JSON (golden-replay style)
    const snap = (x: unknown) => JSON.stringify(x, (_k, v) => (v instanceof Map ? [...v.entries()] : v))
    expect(snap(fold(events))).toBe(snap(fold(events)))
  })
})
