import { describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execTool } from './exec-tool'

const ws = () => mkdtempSync(path.join(tmpdir(), 'orc-exec-'))
const tool = (allowlist: string[], dir = ws()) => execTool({ workspaceDir: dir, allowlist })[0]!

describe('exec tool', () => {
  it('is not offered at all when the allowlist is empty — registration gate, not a runtime error', () => {
    expect(execTool({ workspaceDir: ws(), allowlist: [] })).toEqual([])
  })

  it('runs an allowlisted command in the workspace and returns exitCode/stdout/stderr', async () => {
    const dir = ws()
    const r = await tool(['pwd'], dir).execute({ command: 'pwd' })
    expect(r.isError).toBe(false)
    const out = r.output as { exitCode: number; stdout: string; stderr: string }
    expect(out.exitCode).toBe(0)
    expect(out.stdout.trim()).toBe(realpathSync(dir))
    expect(out.stderr).toBe('')
  })

  it('a non-zero exit is a result, not a tool error — the model must read it, not retry blindly', async () => {
    const r = await tool(['ls']).execute({ command: 'ls no-such-file-here' })
    expect(r.isError).toBe(false)
    const out = r.output as { exitCode: number; stderr: string }
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
    expect((r.output as { stdout: string }).stdout.trim()).toBe('hi; rm -rf /')
  })

  it('clips a huge stream head+tail with an omission marker', async () => {
    const r = await tool(['seq']).execute({ command: 'seq 1 100000' })
    expect(r.isError).toBe(false)
    const out = (r.output as { stdout: string }).stdout
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
