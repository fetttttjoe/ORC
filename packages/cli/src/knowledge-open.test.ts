import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AUTHOR_SOURCE, ClaimClass, DeliveryMode, Door, KNOWLEDGE_REFUSAL, type KnowledgeAccess, type MemoryAuthor } from '@orc/contracts'
import { eventFixture } from '@orc/contracts/fixtures'
import { EVIDENCE_NOT_RECORDED, REGISTRY_REFUSAL } from '@orc/knowledge-core'
import { KERNEL_ERROR_CODE, KernelError } from '@orc/kernel'
import { knowledgeAccess, openKnowledge } from './knowledge-open'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const gitCheckout = (): string => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-kcli-')))
  Bun.spawnSync(['git', 'init', '-q', dir])
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, 'src', 'a.ts'), '')
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
const quiet = { append: async () => eventFixture() }

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
  describe('the log append wrapper', () => {
    it('swallows an idempotency conflict: the write resolves with no evidence warning', async () => {
      const port = portOf(knowledgeAccess(opened(), { append: async () => { throw new KernelError(KERNEL_ERROR_CODE.idempotency_conflict, 'replay') } }, gitCheckout()))
      expect((await port.write({ author, idempotencyKey: 'k-1' }, { add: [fact('x')] })).warnings).toEqual([])
    })
    it('surfaces any other append error as an evidence-not-recorded warning', async () => {
      const port = portOf(knowledgeAccess(opened(), { append: async () => { throw new Error('log down') } }, gitCheckout()))
      expect((await port.write({ author, idempotencyKey: 'k-2' }, { add: [fact('x')] })).warnings).toEqual([EVIDENCE_NOT_RECORDED('log down')])
    })
  })
})
