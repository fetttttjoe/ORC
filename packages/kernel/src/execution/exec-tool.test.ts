import { describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { execTool } from './exec-tool'

// the success-shape of an exec result — parse (never cast) the tool output the assertions read
const ExecOut = z.object({ exitCode: z.number(), stdout: z.string(), stderr: z.string() })

const ws = () => mkdtempSync(path.join(tmpdir(), 'orc-exec-'))
const tool = (allowlist: string[], dir = ws()) => execTool({ workspaceDir: dir, allowlist })[0]!

describe('exec tool', () => {
  // 'close' waits for the stdio STREAMS, not the process. A command that leaves a grandchild
  // holding the inherited pipes exits while close never fires — and the timeout kills only the
  // CHILD, so the grandchild keeps them open and the tool hangs forever. `bun test` is on the
  // default allowlist, so a suite that starts a background server hit exactly this.
  it('settles when the command exits even if a grandchild holds the pipes open', async () => {
    // the script backgrounds a sleeper that INHERITS stdout and outlives sh, then sh exits at once
    const dir = ws()
    writeFileSync(path.join(dir, 'bg.sh'), 'sleep 30 &\necho done\n')
    const res = await tool(['sh'], dir).execute({ command: 'sh bg.sh' })
    const out = ExecOut.parse(res.output)
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('done')
  }, 10_000)

  it('is not offered at all when the allowlist is empty — registration gate, not a runtime error', () => {
    expect(execTool({ workspaceDir: ws(), allowlist: [] })).toEqual([])
  })

  it('runs an allowlisted command in the workspace and returns exitCode/stdout/stderr', async () => {
    const dir = ws()
    const r = await tool(['pwd'], dir).execute({ command: 'pwd' })
    expect(r.isError).toBe(false)
    const out = ExecOut.parse(r.output)
    expect(out.exitCode).toBe(0)
    expect(out.stdout.trim()).toBe(realpathSync(dir))
    expect(out.stderr).toBe('')
  })

  it('a non-zero exit is a result, not a tool error — the model must read it, not retry blindly', async () => {
    const r = await tool(['ls']).execute({ command: 'ls no-such-file-here' })
    expect(r.isError).toBe(false)
    const out = ExecOut.parse(r.output)
    expect(out.exitCode).not.toBe(0)
    expect(out.stderr).toContain('no-such-file-here')
  })

  it('refuses a command not on the allowlist, naming what IS allowed', async () => {
    const r = await tool(['bun test']).execute({ command: 'rm -rf /' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('bun test')
  })

  it('allowlist entries extend at token boundaries only', async () => {
    const t = tool(['echo hi'])
    expect((await t.execute({ command: 'echo hi there' })).isError).toBe(false) // extra args ok
    expect((await t.execute({ command: 'echo hix' })).isError).toBe(true) // 'echo hi' is not a prefix of 'echo hix'
  })

  it('shell metacharacters are inert argv tokens — no shell, no chaining', async () => {
    const r = await tool(['echo']).execute({ command: 'echo hi; rm -rf /' })
    expect(r.isError).toBe(false)
    // echo printed the tokens literally; nothing was chained or executed
    expect(ExecOut.parse(r.output).stdout.trim()).toBe('hi; rm -rf /')
  })

  it('clips a huge stream head+tail with an omission marker', async () => {
    const r = await tool(['seq']).execute({ command: 'seq 1 100000' })
    expect(r.isError).toBe(false)
    const out = ExecOut.parse(r.output).stdout
    expect(out).toContain('chars omitted')
    expect(out.startsWith('1\n')).toBe(true) // head survives
    expect(out.trimEnd().endsWith('100000')).toBe(true) // tail survives
  })

  it('a missing binary is a tool error, not a crash', async () => {
    const r = await tool(['no-such-binary-xyz']).execute({ command: 'no-such-binary-xyz' })
    expect(r.isError).toBe(true)
  })

  it('rejects malformed input with a readable message', async () => {
    const r = await tool(['ls']).execute({ command: '' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('invalid exec input')
  })
})
