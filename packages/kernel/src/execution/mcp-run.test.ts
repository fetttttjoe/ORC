import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVENT_KIND, PAYLOAD_SCHEMAS, ROLE_SKILL } from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { createMcpHub } from '@orc/mcp-client'
import { apiLoopExecutor } from '@orc/executor-api-loop'
import { scriptModel } from '@orc/executor-api-loop/test-model'
import { openStorage, type EventLog, type Storage } from '../storage'
import { Kernel } from '../kernel'
import { fold } from '../projections'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID, testConfig } from '../test-helpers'
import { SkillIndex } from '../plugins/skills'
import { createDbosPort, type DbosPort } from './dbos-port'

const FIXTURE = fileURLToPath(new URL('../../../../plugins/mcp-client/src/fixture-server.ts', import.meta.url))

describe('MCP + skills through a durable run (integration)', () => {
  let kernel: Kernel
  let port: DbosPort
  let log: EventLog
  let storage: Storage
  let dbUrl: string
  let teardown: () => Promise<void>

  beforeAll(async () => {
    const db = await createTestDb()
    dbUrl = db.url
    storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    log = storage.events
    kernel = new Kernel(log)
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)

    const skillsRoot = mkdtempSync(path.join(tmpdir(), 'orc-mcp-run-'))
    mkdirSync(path.join(skillsRoot, 'haiku-style'), { recursive: true })
    writeFileSync(
      path.join(skillsRoot, 'haiku-style', 'SKILL.md'),
      `---\nname: haiku-style\ndescription: write everything as haiku\n---\nAlways answer in haiku.`,
    )
    // The kernel appends a finish step to every root plan and it declares ROLE_SKILL.finisher, so
    // this index must carry it or the step fails init with "unknown skill" — the same way the
    // shipped vault carries the role skills. A stand-in body: this file's subject is the MCP round
    // trip and the skill_loaded record, not which prose the finish contract holds.
    mkdirSync(path.join(skillsRoot, ROLE_SKILL.finisher), { recursive: true })
    writeFileSync(
      path.join(skillsRoot, ROLE_SKILL.finisher, 'SKILL.md'),
      `---\nname: ${ROLE_SKILL.finisher}\ndescription: finish-step contract\n---\nReconcile, then present the summary.`,
    )
    const skills = await SkillIndex.open(skillsRoot)
    const hub = createMcpHub({ fixture: { command: 'bun', args: [FIXTURE] } }, id => id === 'fixture')

    // the model calls the real MCP echo tool, then signals with its result
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'mcp__fixture__echo', input: { text: 'ping' } }] },
      { toolCalls: [{ toolCallId: 'c2', toolName: 'signal', input: { outcome: 'success', summary: 'echoed' } }] },
      // the appended finish step runs this same scripted model: one turn that signals, so the
      // script is not exhausted into empty text and the step does not loop to its iteration cap
      { toolCalls: [{ toolCallId: 'c3', toolName: 'signal', input: { outcome: 'success', summary: 'nothing to reconcile' } }] },
    ])
    const config = testConfig(db.url)
    port = await createDbosPort({
      storage, config,
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
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'mcp run', spec: 'echo ping' })
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
    expect(PAYLOAD_SCHEMAS.tool_call.parse(call.payload).toolName).toBe('mcp__fixture__echo')
    const result = events.find(e => e.kind === EVENT_KIND.tool_result)!
    expect(JSON.stringify(result.payload)).toContain('echo: ping')
    expect(PAYLOAD_SCHEMAS.tool_result.parse(result.payload).isError).toBe(false)

    // the skill body reached the model: recorded in the agent_call request (R9)
    const agentCall = events.find(e => e.kind === EVENT_KIND.agent_call)!
    expect(JSON.stringify(agentCall.payload)).toContain('Always answer in haiku.')

    // replay identity (golden-replay style): a fresh storage handle re-reads the durable log and
    // must fold to the same state — folding one in-memory array twice is tautological and passes
    // even when nothing was durably stored.
    const snap = (x: unknown) => JSON.stringify(x, (_k, v) => (v instanceof Map ? [...v.entries()] : v))
    const reopened = await openStorage(dbUrl, { projectId: TEST_PROJECT_ID })
    try {
      expect(snap(fold(await reopened.events.byTask(t.id)))).toBe(snap(fold(events)))
    } finally {
      await reopened.close()
    }
    // 30s: the run is two step workflows now — the scripted step and the kernel's appended finish
    // step — and bun's default 5s sat right on the boundary (5.5s observed under a loaded suite).
  }, 30_000)
})
