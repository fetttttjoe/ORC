import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { UNIFIED_EVENT_TYPE, type Checkpoint, type ExecutorContext, type OperationCheckpoint } from '@orc/contracts'
import { stepFixture } from '@orc/contracts/fixtures'
import { apiLoopExecutor, executeTool, releaseWriteClaims, TOOL_NAME } from '@orc/executor-api-loop'
import { scriptModel } from '@orc/executor-api-loop/test-model'
import { driveGenerator } from './dbos-port'

// the model type, inferred from scriptModel so this file needs no dependency on the `ai` package
type Model = ReturnType<typeof scriptModel>

// pass-through seams: run fn, ignore drafts — enough to execute the fs_write tool (which takes the
// write-claim) as it flows through ctx.operation, without any DBOS/Postgres machinery.
const passCheckpoint: Checkpoint = async (_name, fn) => fn()
const passOperation: OperationCheckpoint = async (_spec, fn) => fn()

function ctx(model: Model, workspaceDir: string, runToken: string): ExecutorContext<Model> {
  return {
    step: stepFixture({ instructions: 'write then join', maxIterations: 3 }),
    taskSpec: 't', depOutputs: {}, skills: [], extraTools: [], model, runToken, workspaceDir,
    checkpoint: passCheckpoint, operation: passOperation, budgetRemainingUSD: async () => null,
  }
}

describe('driveGenerator releases a suspended step\'s write-claim when the driver throws', () => {
  it('gen.return() in finally runs loop.ts cleanup even when the callback throws at a gate', async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), 'orc-drivegen-'))
    const runToken = 'step:t1:s1:a1'
    // one turn: fs_write (takes a claim on shared.md under runToken) THEN join_splits (yields a
    // 'gate' — loop.ts runs the fs_write tool before the join handling in the same iteration).
    const model = scriptModel([{ toolCalls: [
      { toolCallId: 'w1', toolName: TOOL_NAME.fs_write, input: { path: 'shared.md', content: 'from A' } },
      { toolCallId: 'j1', toolName: TOOL_NAME.join_splits, input: { splitIds: ['sp1'] } },
    ] }])
    const gen = apiLoopExecutor().startTurn(ctx(model, workspaceDir, runToken))

    // the real failure this fix addresses: the port throws (a cancelled recv) while the generator
    // is suspended at the gate, by which point the fs_write claim is already held.
    await expect(driveGenerator(gen, async ev => {
      if (ev.type === UNIFIED_EVENT_TYPE.gate) throw new Error('recv cancelled')
      return undefined
    })).rejects.toThrow('recv cancelled')

    // tools.ts exposes no claim getter, so check release behaviorally like tools.test.ts does: a
    // DIFFERENT writer to the SAME path is refused iff the claim is still held. It succeeds here →
    // gen.return() ran loop.ts's `finally { releaseWriteClaims }`, so the claim was NOT leaked.
    const rival = await executeTool(
      TOOL_NAME.fs_write, { path: 'shared.md', content: 'from B' }, workspaceDir, [], undefined,
      { writer: 'someone-else' },
    )
    expect(rival.isError).toBe(false)
    releaseWriteClaims('someone-else')
  })
})
