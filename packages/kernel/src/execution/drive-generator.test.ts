import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { UnifiedEventType, type Checkpoint, type ExecutorContext, type OperationCheckpoint } from '@orc/contracts'
import { stepFixture } from '@orc/contracts/fixtures'
import { apiLoopExecutor, executeTool, releaseWriteClaims, TOOL_NAME } from '@orc/executor-api-loop'
import { scriptModel } from '@orc/executor-api-loop/test-model'
import { driveGenerator } from './dbos-port'
import { runOrigin } from './run-chat'

// the model type, inferred from scriptModel so this file needs no dependency on the `ai` package
type Model = ReturnType<typeof scriptModel>

// pass-through seams: run fn, ignore drafts, enough to execute fs_write without DBOS/Postgres
const passCheckpoint: Checkpoint = async (_name, fn) => fn()
const passOperation: OperationCheckpoint = async (_spec, fn) => fn(1)

function ctx(model: Model, workspaceDir: string, runToken: string): ExecutorContext<Model> {
  return {
    step: stepFixture({ instructions: 'write then join', maxIterations: 3 }),
    taskSpec: 't', depOutputs: {}, skills: [], extraTools: [], model, runToken, workspaceDir,
    origin: runOrigin('run:t1:v1'), // the step executes inside its run's chat
    checkpoint: passCheckpoint, operation: passOperation, budgetRemainingUSD: async () => null,
  }
}

describe('driveGenerator releases a suspended step\'s write-claim when the driver throws', () => {
  it('gen.return() in finally runs loop.ts cleanup even when the callback throws at a gate', async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), 'orc-drivegen-'))
    const runToken = 'step:t1:s1:a1'
    // one turn: fs_write (takes a claim) THEN join_splits (yields a 'gate')
    const model = scriptModel([{ toolCalls: [
      { toolCallId: 'w1', toolName: TOOL_NAME.fs_write, input: { path: 'shared.md', content: 'from A' } },
      { toolCallId: 'j1', toolName: TOOL_NAME.join_splits, input: { splitIds: ['sp1'] } },
    ] }])
    const gen = apiLoopExecutor().startTurn(ctx(model, workspaceDir, runToken))

    // the port throws (a cancelled recv) while the generator is suspended at the gate, claim held
    await expect(driveGenerator(gen, async ev => {
      if (ev.type === UnifiedEventType.gate) throw new Error('recv cancelled')
      return undefined
    })).rejects.toThrow('recv cancelled')

    // tools.ts exposes no claim getter: a DIFFERENT writer succeeding proves the claim was released
    const rival = await executeTool(
      TOOL_NAME.fs_write, { path: 'shared.md', content: 'from B' }, workspaceDir, [], undefined,
      { writer: 'someone-else' },
    )
    expect(rival.isError).toBe(false)
    releaseWriteClaims('someone-else')
  })
})
