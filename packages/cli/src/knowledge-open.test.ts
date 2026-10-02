import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AUTHOR_SOURCE, CheckVerdict, ClaimClass, ClaimState, DeliveryMode, Door, EVENT_KIND, KNOWLEDGE_REFUSAL,
  type EventInput, type EventKind, type EventRecord, type KnowledgeAccess, type MemoryAuthor,
} from '@orc/contracts'
import { eventFixture } from '@orc/contracts/fixtures'
import { EVIDENCE_NOT_RECORDED, REGISTRY_REFUSAL } from '@orc/knowledge-core'
import { KERNEL_ERROR_CODE, KernelError } from '@orc/kernel'
import { knowledgeAccess, knowledgeAccessWithoutEvidence, NO_LOG_TO_APPEND, openKnowledge } from './knowledge-open'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const gitCheckout = (): string => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-kcli-')))
  Bun.spawnSync(['git', 'init', '-q', dir])
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function outer() {\n  function inner() {}\n}\n')
  dirs.push(dir)
  return dir
}
const author: MemoryAuthor = { source: AUTHOR_SOURCE.agent, workspaceId: 'ws-1', origin: { chatId: 'chat-1', door: Door.supervisor }, taskId: 't-1', stepId: 's-1', runToken: 'r-1' }
const fact = (text: string) => ({ text, class: ClaimClass.fact, anchors: [{ path: 'src/a.ts' }] })

const opened = () => openKnowledge({ knowledge: { plugin: 'git-files', options: {} } })
const portOf = (access: KnowledgeAccess) => {
  if ('unavailable' in access) throw new Error(access.unavailable)
  return access.port
}
const NO_EVENTS = async (): Promise<EventRecord[]> => []
const NO_SEQ = async (): Promise<number> => 0
const quiet = { append: async () => eventFixture(), after: NO_EVENTS, earliestSeq: NO_SEQ }
const memoryLog = () => {
  const records: EventRecord[] = []
  const asked: Array<[number, EventKind[] | undefined]> = []
  return {
    records,
    asked,
    append: async (input: EventInput): Promise<EventRecord> => {
      const record = eventFixture({ seq: records.length + 1, kind: input.kind, payload: input.payload, idempotencyKey: input.idempotencyKey ?? null })
      records.push(record)
      return record
    },
    after: async (seq: number, kinds?: EventKind[]): Promise<EventRecord[]> => {
      asked.push([seq, kinds])
      return records.filter(r => r.seq > seq && (kinds === undefined || kinds.includes(r.kind)))
    },
    earliestSeq: async (): Promise<number> => records[0]?.seq ?? 0,
  }
}
const commit = (dir: string): void => {
  for (const args of [['add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'basis']]) Bun.spawnSync(['git', '-C', dir, ...args])
}

describe('openKnowledge', () => {
  it('null config is off; an unknown plugin or bad options are unavailable with the reason; git-files opens a backend', () => {
    expect(openKnowledge({ knowledge: null })).toEqual({ unavailable: KNOWLEDGE_REFUSAL.off() })
    expect(openKnowledge({ knowledge: { plugin: 'nope', options: {} } })).toEqual({ unavailable: REGISTRY_REFUSAL.unknownPlugin('nope', ['git-files']) })
    expect('unavailable' in openKnowledge({ knowledge: { plugin: 'git-files', options: { dirName: 42 } } })).toBe(true)
    expect('backend' in opened()).toBe(true)
  })
})

describe('knowledgeAccess', () => {
  it('an unavailable opening stays unavailable', () => {
    expect(knowledgeAccess({ unavailable: 'why' }, quiet, '/p')).toEqual({ unavailable: 'why' })
  })
  it('two accesses over one backend reach two checkouts', async () => {
    const backend = opened()
    const [a, b] = [gitCheckout(), gitCheckout()]
    await portOf(knowledgeAccess(backend, quiet, a)).write({ author, idempotencyKey: null }, { add: [fact('only in a')] })
    expect((await portOf(knowledgeAccess(backend, quiet, b)).card({ author, idempotencyKey: null, mode: DeliveryMode.card }, '.')).claims).toEqual([])
    expect(existsSync(path.join(a, 'knowledge/src/a.ts.md'))).toBe(true)
    expect(existsSync(path.join(b, 'knowledge'))).toBe(false)
  })
  it('the opened backend validates anchor symbols against the real outline of the checkout', async () => {
    const dir = gitCheckout()
    const port = portOf(knowledgeAccess(opened(), quiet, dir))
    const call = { author, idempotencyKey: null }
    const anchored = (symbol: string) => ({ add: [{ ...fact('symbolic'), anchors: [{ path: 'src/a.ts', symbol }] }] })
    await expect(port.write(call, anchored('outr'))).rejects.toThrow('closest: outer')
    const [added] = (await port.write(call, anchored('inner'))).added
    expect((await port.get({ ...call, mode: DeliveryMode.get }, [added?.id ?? '']))[0]?.anchors).toEqual([{ path: 'src/a.ts', symbol: 'outer.inner' }])
  })
  it('a holds check in the log clears the claim for every access over that log; a checked payload that does not parse is skipped', async () => {
    const dir = gitCheckout()
    const log = memoryLog()
    const call = { author, idempotencyKey: null }
    const first = portOf(knowledgeAccess(opened(), log, dir))
    const [ref] = (await first.write(call, { add: [{ ...fact('outer declares its inner helper'), anchors: [{ path: 'src/a.ts', symbol: 'outer' }] }] })).added
    const id = ref?.id ?? ''
    commit(dir)
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function outer() {\n  function inner() { return 1 }\n}\n')
    expect((await first.drift(call, { ids: [id] })).map(d => d.state)).toEqual([ClaimState.suspect])
    await first.check(call, { id, verdict: CheckVerdict.holds, why: 'outer still declares inner' })
    log.records.push(eventFixture({ seq: log.records.length + 1, kind: EVENT_KIND.knowledge_checked, payload: { id, verdict: 'maybe' } }))
    const second = portOf(knowledgeAccess(opened(), log, dir))
    expect((await second.drift(call, { ids: [id] })).map(d => d.state)).toEqual([ClaimState.clean])
  })
  it('a purge of the log drops the holds check it held, so the next drift through the same log reads suspect again', async () => {
    const dir = gitCheckout()
    const log = memoryLog()
    const call = { author, idempotencyKey: null }
    const port = portOf(knowledgeAccess(opened(), log, dir))
    const [ref] = (await port.write(call, { add: [{ ...fact('outer declares its inner helper'), anchors: [{ path: 'src/a.ts', symbol: 'outer' }] }] })).added
    const id = ref?.id ?? ''
    commit(dir)
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function outer() {\n  function inner() { return 1 }\n}\n')
    await port.check(call, { id, verdict: CheckVerdict.holds, why: 'outer still declares inner' })
    expect((await port.drift(call, { ids: [id] })).map(d => d.state)).toEqual([ClaimState.clean])
    log.records.splice(0)
    expect((await port.drift(call, { ids: [id] })).map(d => d.state)).toEqual([ClaimState.suspect])
  })
  it('drift reads through one access ask the log for writes and checks once from 0, then only after the last seq', async () => {
    const log = memoryLog()
    const call = { author, idempotencyKey: null }
    const port = portOf(knowledgeAccess(opened(), log, gitCheckout()))
    await port.write(call, { add: [fact('a declares outer')] })
    await port.drift(call)
    await port.write(call, { add: [fact('outer declares inner')] })
    await port.drift(call)
    expect(log.asked).toEqual([[0, [EVENT_KIND.knowledge_written, EVENT_KIND.knowledge_checked]], [1, [EVENT_KIND.knowledge_written, EVENT_KIND.knowledge_checked]]])
  })
  describe('the log append wrapper', () => {
    it('swallows an idempotency conflict: the write resolves with no evidence warning', async () => {
      const port = portOf(knowledgeAccess(opened(), { append: async () => { throw new KernelError(KERNEL_ERROR_CODE.idempotency_conflict, 'replay') }, after: NO_EVENTS, earliestSeq: NO_SEQ }, gitCheckout()))
      expect((await port.write({ author, idempotencyKey: 'k-1' }, { add: [fact('x')] })).warnings).toEqual([])
    })
    it('surfaces any other append error as an evidence-not-recorded warning', async () => {
      const port = portOf(knowledgeAccess(opened(), { append: async () => { throw new Error('log down') }, after: NO_EVENTS, earliestSeq: NO_SEQ }, gitCheckout()))
      expect((await port.write({ author, idempotencyKey: 'k-2' }, { add: [fact('x')] })).warnings).toEqual([EVIDENCE_NOT_RECORDED('log down')])
    })
  })
})

describe('knowledgeAccessWithoutEvidence', () => {
  it('reads drift from the checkout alone, refuses to record, and keeps the unavailable reason', async () => {
    const dir = gitCheckout()
    const port = portOf(knowledgeAccessWithoutEvidence(opened(), dir))
    const [ref] = (await port.write({ author, idempotencyKey: null }, { add: [fact('about a')] })).added
    expect((await port.drift({ author, idempotencyKey: null }, {})).map(d => d.claim.id)).toEqual([ref?.id])
    await expect(port.check({ author, idempotencyKey: null }, { id: ref?.id ?? '', verdict: CheckVerdict.holds, why: 'w' })).resolves.toMatchObject({ warnings: [expect.stringContaining(NO_LOG_TO_APPEND)] })
    expect(knowledgeAccessWithoutEvidence({ unavailable: KNOWLEDGE_REFUSAL.off() }, dir)).toEqual({ unavailable: KNOWLEDGE_REFUSAL.off() })
  })
})
