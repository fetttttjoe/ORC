import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ResolvedTool } from '@orc/contracts'
import { resolveInWorkspace } from '@orc/contracts'
import { TOOL_NAME, executeTool, toolSet } from './tools'

const ws = () => mkdtempSync(path.join(tmpdir(), 'orc-ws-'))

describe('workspace scoping (trust boundary)', () => {
  it('rejects .. traversal and absolute escapes', () => {
    const dir = ws()
    expect(() => resolveInWorkspace(dir, '../outside.txt')).toThrow()
    expect(() => resolveInWorkspace(dir, '/etc/passwd')).toThrow()
    expect(resolveInWorkspace(dir, 'sub/file.txt')).toBe(path.join(dir, 'sub', 'file.txt'))
  })
  it('rejects symlink escapes', async () => {
    const dir = ws()
    // Point the symlink at a real file outside the workspace. If the realpath
    // guard is missing or wrong, this read succeeds and returns the secret —
    // a bare "does it error" check on a nonexistent target would pass either
    // way (ENOENT masks a missing guard), so this asserts on an actual file.
    const outside = mkdtempSync(path.join(tmpdir(), 'orc-outside-'))
    writeFileSync(path.join(outside, 'secret.txt'), 'top-secret')
    symlinkSync(outside, path.join(dir, 'sneaky'))
    const r = await executeTool(TOOL_NAME.fs_read, { path: 'sneaky/secret.txt' }, dir)
    expect(r.isError).toBe(true)
  })
  it('rejects fs_write through a symlinked dir at a deep nonexistent path (ancestor-walk loop)', async () => {
    const dir = ws()
    // Nothing below `sneaky` exists yet, so resolveInWorkspace's
    // `while (!existsSync(probe)) probe = path.dirname(probe)` loop must climb
    // past b/ and a/ before it finds `sneaky` itself — unlike the read test above,
    // which finds an existing file on the first probe and never iterates.
    const outside = mkdtempSync(path.join(tmpdir(), 'orc-outside-'))
    symlinkSync(outside, path.join(dir, 'sneaky'))
    const r = await executeTool(TOOL_NAME.fs_write, { path: 'sneaky/a/b/new.txt', content: 'x' }, dir)
    expect(r.isError).toBe(true)
    expect(readdirSync(outside)).toEqual([])
  })
})

describe('fs tools', () => {
  it('fs_write outside the declared zone fails with a named fence; inside passes; reads unfenced', async () => {
    const dir = ws()
    const denied = await executeTool(TOOL_NAME.fs_write, { path: 'src/x.ts', content: 'x' }, dir, [], undefined, ['docs/**'])
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.output)).toContain('zone fence')
    const ok = await executeTool(TOOL_NAME.fs_write, { path: 'docs/notes.md', content: 'n' }, dir, [], undefined, ['docs/**'])
    expect(ok.isError).toBe(false)
    // reads are never fenced — the zone is a WRITE boundary
    const read = await executeTool(TOOL_NAME.fs_read, { path: 'docs/notes.md' }, dir, [], undefined, ['other/**'])
    expect(read.isError).toBe(false)
  })

  it('write → read → list roundtrip, mkdir -p for parents', async () => {
    const dir = ws()
    const w = await executeTool(TOOL_NAME.fs_write, { path: 'a/b/hello.txt', content: 'hi' }, dir)
    expect(w.isError).toBe(false)
    const r = await executeTool(TOOL_NAME.fs_read, { path: 'a/b/hello.txt' }, dir)
    expect(r.output).toEqual({ content: 'hi' })
    const l = await executeTool(TOOL_NAME.fs_list, { path: 'a/b' }, dir)
    expect(l.output).toEqual({ entries: ['hello.txt'] })
  })
  it('read of a missing file is an error result, not a throw', async () => {
    const r = await executeTool(TOOL_NAME.fs_read, { path: 'ghost.txt' }, ws())
    expect(r.isError).toBe(true)
  })
  it('malformed input is an error result', async () => {
    const r = await executeTool(TOOL_NAME.fs_write, { nope: true }, ws())
    expect(r.isError).toBe(true)
  })
  it('unknown tool name is an error result', async () => {
    const r = await executeTool('rm_rf', {}, ws())
    expect(r.isError).toBe(true)
  })
})

describe('toolSet', () => {
  it('declares all four tools and none has execute', () => {
    const tools = toolSet()
    for (const name of Object.values(TOOL_NAME)) {
      expect(tools[name]).toBeDefined()
      expect((tools[name] as { execute?: unknown }).execute).toBeUndefined()
    }
  })
})

const extraTool = (over: Partial<ResolvedTool> = {}): ResolvedTool => ({
  ref: 'srv/hello',
  name: 'mcp__srv__hello',
  description: 'says hello',
  inputSchema: { type: 'object', properties: { who: { type: 'string' } } },
  execute: async input => ({ output: { hi: (input as { who?: string }).who }, isError: false }),
  ...over,
})

describe('extra tools', () => {
  it('toolSet declares extra tools alongside builtins', () => {
    const set = toolSet([extraTool()])
    expect(Object.keys(set)).toContain('mcp__srv__hello')
    expect(Object.keys(set)).toContain(TOOL_NAME.signal)
  })

  it('executeTool routes to the extra tool by mangled name', async () => {
    const r = await executeTool('mcp__srv__hello', { who: 'orc' }, '/tmp', [extraTool()])
    expect(r).toEqual({ output: { hi: 'orc' }, isError: false })
  })

  it('an extra tool that throws becomes an isError result, not an exception', async () => {
    const bad = extraTool({ execute: async () => { throw new Error('transport died') } })
    const r = await executeTool('mcp__srv__hello', {}, '/tmp', [bad])
    expect(r.isError).toBe(true)
  })

  it('unknown names still error', async () => {
    const r = await executeTool('mcp__other__x', {}, '/tmp', [extraTool()])
    expect(r.isError).toBe(true)
  })

  it('threads the real provider toolCallId through to the extra tool', async () => {
    let seen: string | undefined
    const capture = extraTool({ execute: async (_input, toolCallId) => { seen = toolCallId; return { output: {}, isError: false } } })
    await executeTool('mcp__srv__hello', {}, '/tmp', [capture], 'call_123')
    expect(seen).toBe('call_123')
  })
})
