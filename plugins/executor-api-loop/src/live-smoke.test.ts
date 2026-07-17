import { describe, expect, it } from 'bun:test'
// Live end-to-end against real providers. Run explicitly:
//   ORC_LIVE_SMOKE=1 ANTHROPIC_API_KEY=... bun test plugins/executor-api-loop/src/live-smoke.test.ts
//   ORC_LIVE_SMOKE=1 OLLAMA_MODEL=llama3 bun test plugins/executor-api-loop/src/live-smoke.test.ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Checkpoint, ExecutorContext } from '@orc/contracts'
import { stepFixture } from '@orc/contracts/fixtures'
import type { LanguageModel } from 'ai'
import { apiLoopExecutor } from './loop'

const LIVE = process.env.ORC_LIVE_SMOKE === '1'

const passthrough: Checkpoint = async (_n, fn, toEvents) => {
  const r = await fn()
  void toEvents?.(r)
  return r
}

function liveCtx(model: LanguageModel): ExecutorContext<LanguageModel> {
  return {
    step: stepFixture({
      title: 'smoke', modelRef: 'live/m', maxIterations: 6,
      instructions: "Write the single word 'ping' to a file named pong.txt, then signal success with summary 'pong'.",
    }),
    taskSpec: 'live smoke test', depOutputs: {}, skills: [], extraTools: [], model,
    runToken: 'step:smoke:s1:a1',
    workspaceDir: mkdtempSync(path.join(tmpdir(), 'orc-smoke-')),
    checkpoint: passthrough,
    budgetRemainingUSD: async () => null,
  }
}

describe.skipIf(!LIVE)('live smoke', () => {
  it.skipIf(!process.env.ANTHROPIC_API_KEY)('anthropic completes a real step', async () => {
    const { createAnthropicProvider } = await import('@orc/provider-anthropic')
    const model = createAnthropicProvider().languageModel('claude-sonnet-5')
    const events = []
    for await (const ev of apiLoopExecutor().startTurn(liveCtx(model))) events.push(ev)
    expect(events.at(-1)?.type).toBe('done')
  }, 120_000)

  it.skipIf(!process.env.OLLAMA_MODEL)('ollama completes a real step', async () => {
    const { createOllamaProvider } = await import('@orc/provider-ollama')
    const model = createOllamaProvider().languageModel(process.env.OLLAMA_MODEL!)
    const events = []
    for await (const ev of apiLoopExecutor().startTurn(liveCtx(model))) events.push(ev)
    expect(events.at(-1)?.type).toBe('done')
  }, 300_000)
})
