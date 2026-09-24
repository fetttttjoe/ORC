import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AUTHOR_SOURCE, ClaimClass, Door, type MemoryAuthor } from '@orc/contracts'
import { EVIDENCE_NOT_RECORDED } from '@orc/knowledge-core'
import { KERNEL_ERROR_CODE, KernelError } from '@orc/kernel'
import { knowledgeBackendFor, openKnowledgePort } from './knowledge-open'

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
const portOn = (append: () => Promise<never>) => {
  const port = openKnowledgePort({ config: { knowledge: { plugin: 'git-files', options: {} }, dir: gitCheckout() }, log: { append } })
  if (port === null) throw new Error('expected a port')
  return port
}

describe('knowledge-open', () => {
  it('the default config resolves the git-files backend; null resolves nothing', () => {
    expect(knowledgeBackendFor({ knowledge: { plugin: 'git-files', options: {} } })).not.toBeNull()
    expect(knowledgeBackendFor({ knowledge: null })).toBeNull()
    expect(openKnowledgePort({ config: { knowledge: null, dir: '/p' }, log: { append: async () => { throw new Error('unused') } } })).toBeNull()
  })

  describe('the log append wrapper', () => {
    it('swallows an idempotency conflict: the write resolves with no evidence warning', async () => {
      const port = portOn(async () => { throw new KernelError(KERNEL_ERROR_CODE.idempotency_conflict, 'replay') })
      const result = await port.write({ author, idempotencyKey: 'k-1' }, { add: [fact('x')] })
      expect(result.warnings).toEqual([])
    })
    it('surfaces any other append error as an evidence-not-recorded warning', async () => {
      const port = portOn(async () => { throw new Error('log down') })
      const result = await port.write({ author, idempotencyKey: 'k-2' }, { add: [fact('x')] })
      expect(result.warnings).toEqual([EVIDENCE_NOT_RECORDED('log down')])
    })
  })
})
