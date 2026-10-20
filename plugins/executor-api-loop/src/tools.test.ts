import { describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { ResolvedTool } from '@orc/contracts'
import { resolveInWorkspace, STEP_ROLE } from '@orc/contracts'
import { TOOL_NAME, executeTool, releaseWriteClaims, toolSet } from './tools'

const ws = () => mkdtempSync(path.join(tmpdir(), 'orc-ws-'))

// tool results (execute() returns { output: unknown }); named subsets parsed at the read boundary.
const FsReadOutput = z.object({ content: z.string() })
const FsListOutput = z.object({ entries: z.array(z.string()) })
const HelloToolInput = z.object({ who: z.string().optional() })

describe('workspace scoping (trust boundary)', () => {
  it('rejects .. traversal and absolute escapes', () => {
    const dir = ws()
    expect(() => resolveInWorkspace(dir, '../outside.txt')).toThrow()
    expect(() => resolveInWorkspace(dir, '/etc/passwd')).toThrow()
    expect(resolveInWorkspace(dir, 'sub/file.txt')).toBe(path.join(dir, 'sub', 'file.txt'))
  })
  it('rejects symlink escapes', async () => {
    const dir = ws()
    // the target must be a real file: ENOENT would mask a missing realpath guard
    const outside = mkdtempSync(path.join(tmpdir(), 'orc-outside-'))
    writeFileSync(path.join(outside, 'secret.txt'), 'top-secret')
    symlinkSync(outside, path.join(dir, 'sneaky'))
    const r = await executeTool(TOOL_NAME.fs_read, { path: 'sneaky/secret.txt' }, dir)
    expect(r.isError).toBe(true)
  })
  it('rejects fs_write through a symlinked dir at a deep nonexistent path (ancestor-walk loop)', async () => {
    const dir = ws()
    // nothing below `sneaky` exists, so the ancestor walk must climb past b/ and a/
    const outside = mkdtempSync(path.join(tmpdir(), 'orc-outside-'))
    symlinkSync(outside, path.join(dir, 'sneaky'))
    const r = await executeTool(TOOL_NAME.fs_write, { path: 'sneaky/a/b/new.txt', content: 'x' }, dir)
    expect(r.isError).toBe(true)
    expect(readdirSync(outside)).toEqual([])
  })
})

describe('the write fence refuses .git, zone or no zone', () => {
  it('refuses a write under .git even with no zone declared', async () => {
    const dir = ws()
    mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true })
    const r = await executeTool(TOOL_NAME.fs_write, { path: '.git/hooks/pre-commit', content: '#!/bin/sh\necho pwned\n' }, dir)
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('.git')
    expect(existsSync(path.join(dir, '.git', 'hooks', 'pre-commit'))).toBe(false)
  })

  it('refuses fs_edit and fs_delete under .git too — a fence with a hole is not a fence', async () => {
    const dir = ws()
    mkdirSync(path.join(dir, '.git'), { recursive: true })
    writeFileSync(path.join(dir, '.git', 'config'), '[core]\n')
    expect((await executeTool(TOOL_NAME.fs_edit, { path: '.git/config', old_string: 'core', new_string: 'x' }, dir)).isError).toBe(true)
    expect((await executeTool(TOOL_NAME.fs_delete, { path: '.git/config' }, dir)).isError).toBe(true)
    expect(existsSync(path.join(dir, '.git', 'config'))).toBe(true)
  })

  it('a path merely CONTAINING .git in a name is fine — only the directory is fenced', async () => {
    const dir = ws()
    expect((await executeTool(TOOL_NAME.fs_write, { path: 'docs/.gitignore', content: 'node_modules\n' }, dir)).isError).toBe(false)
    expect((await executeTool(TOOL_NAME.fs_write, { path: 'src/gitlab.ts', content: 'x' }, dir)).isError).toBe(false)
  })
})

describe('a write preserves what a file IS, not just what it says', () => {
  const mode = (p: string): number => statSync(p).mode & 0o777

  it('fs_write keeps an executable file executable', async () => {
    const dir = ws()
    const abs = path.join(dir, 'run.sh')
    writeFileSync(abs, '#!/bin/sh\necho one\n')
    chmodSync(abs, 0o755)
    expect((await executeTool(TOOL_NAME.fs_write, { path: 'run.sh', content: '#!/bin/sh\necho two\n' }, dir)).isError).toBe(false)
    expect(mode(abs)).toBe(0o755)
  })

  it('fs_edit keeps an executable file executable', async () => {
    const dir = ws()
    const abs = path.join(dir, 'run.sh')
    writeFileSync(abs, '#!/bin/sh\necho one\n')
    chmodSync(abs, 0o755)
    expect((await executeTool(TOOL_NAME.fs_edit, { path: 'run.sh', old_string: 'one', new_string: 'two' }, dir)).isError).toBe(false)
    expect(mode(abs)).toBe(0o755)
  })

  it('a NEW file is created plain — a write never grants a bit nobody asked for', async () => {
    const dir = ws()
    await executeTool(TOOL_NAME.fs_write, { path: 'fresh.txt', content: 'x' }, dir)
    expect(mode(path.join(dir, 'fresh.txt')) & 0o111).toBe(0)
  })

  it('a read-only file keeps its mode too — this is about identity, not just the x bit', async () => {
    const dir = ws()
    const abs = path.join(dir, 'locked.txt')
    writeFileSync(abs, 'a')
    chmodSync(abs, 0o640)
    await executeTool(TOOL_NAME.fs_write, { path: 'locked.txt', content: 'b' }, dir)
    expect(mode(abs)).toBe(0o640)
    expect(readFileSync(abs, 'utf8')).toBe('b')
  })
})

describe('fs tools', () => {
  it('fs_write outside the declared zone fails with a named fence; inside passes; reads unfenced', async () => {
    const dir = ws()
    const denied = await executeTool(TOOL_NAME.fs_write, { path: 'src/x.ts', content: 'x' }, dir, [], undefined, { zone: ['docs/**'] })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.output)).toContain('zone fence')
    const ok = await executeTool(TOOL_NAME.fs_write, { path: 'docs/notes.md', content: 'n' }, dir, [], undefined, { zone: ['docs/**'] })
    expect(ok.isError).toBe(false)
    // reads are never fenced — the zone is a WRITE boundary
    const read = await executeTool(TOOL_NAME.fs_read, { path: 'docs/notes.md' }, dir, [], undefined, { zone: ['other/**'] })
    expect(read.isError).toBe(false)
  })

  it('concurrent sibling writes to one path are refused mechanically; release frees the claim', async () => {
    const dir = ws()
    const a = { writer: 'step:t:a:a1' }
    const b = { writer: 'step:t:b:a1' }
    expect((await executeTool(TOOL_NAME.fs_write, { path: 'shared.md', content: 'A' }, dir, [], undefined, a)).isError).toBe(false)
    // same step rewrites its own file freely (iterations)
    expect((await executeTool(TOOL_NAME.fs_write, { path: 'shared.md', content: 'A2' }, dir, [], undefined, a)).isError).toBe(false)
    const clash = await executeTool(TOOL_NAME.fs_write, { path: 'shared.md', content: 'B' }, dir, [], undefined, b)
    expect(clash.isError).toBe(true)
    expect(JSON.stringify(clash.output)).toContain('concurrent write refused')
    // step A ends → claims release → the sequential successor may write (dependsOn ordering)
    releaseWriteClaims(a.writer)
    expect((await executeTool(TOOL_NAME.fs_write, { path: 'shared.md', content: 'B' }, dir, [], undefined, b)).isError).toBe(false)
    releaseWriteClaims(b.writer)
  })

  it('a refused fs_edit does not leave the path claimed against a sibling', async () => {
    const dir = ws()
    const a = { writer: 'step:t:a:a1' }
    const b = { writer: 'step:t:b:a1' }
    writeFileSync(path.join(dir, 'shared.md'), 'hello world')

    const refused = await executeTool(TOOL_NAME.fs_edit, { path: 'shared.md', old_string: 'nope', new_string: 'x' }, dir, [], undefined, a)
    expect(refused.isError).toBe(true)

    // b must still be able to take the path — a wrote nothing
    const bWrite = await executeTool(TOOL_NAME.fs_write, { path: 'shared.md', content: 'B' }, dir, [], undefined, b)
    expect(bWrite.isError).toBe(false)
    releaseWriteClaims(a.writer)
    releaseWriteClaims(b.writer)
  })

  // a read-only parent directory makes the atomic temp-file write throw EACCES
  it('an fs_edit whose write throws does not leave the path claimed against a sibling', async () => {
    const dir = ws()
    const a = { writer: 'step:t:a:a1' }
    const b = { writer: 'step:t:b:a1' }
    mkdirSync(path.join(dir, 'ro'))
    writeFileSync(path.join(dir, 'ro', 'f.md'), 'hello')
    chmodSync(path.join(dir, 'ro'), 0o555)
    try {
      const threw = await executeTool(TOOL_NAME.fs_edit, { path: 'ro/f.md', old_string: 'hello', new_string: 'bye' }, dir, [], undefined, a)
      expect(threw.isError).toBe(true)
      chmodSync(path.join(dir, 'ro'), 0o755)
      const bWrite = await executeTool(TOOL_NAME.fs_write, { path: 'ro/f.md', content: 'B' }, dir, [], undefined, b)
      expect(bWrite.isError).toBe(false)
    } finally {
      chmodSync(path.join(dir, 'ro'), 0o755)
      releaseWriteClaims(a.writer)
      releaseWriteClaims(b.writer)
    }
  })

  it('a refused fs_edit does not release a claim an earlier successful write took', async () => {
    const dir = ws()
    const a = { writer: 'step:t:a:a1' }
    const b = { writer: 'step:t:b:a1' }
    expect((await executeTool(TOOL_NAME.fs_write, { path: 'shared.md', content: 'A' }, dir, [], undefined, a)).isError).toBe(false)
    // a's own later edit refuses — but a legitimately still owns the path it wrote
    expect((await executeTool(TOOL_NAME.fs_edit, { path: 'shared.md', old_string: 'nope', new_string: 'x' }, dir, [], undefined, a)).isError).toBe(true)
    const clash = await executeTool(TOOL_NAME.fs_write, { path: 'shared.md', content: 'B' }, dir, [], undefined, b)
    expect(clash.isError).toBe(true)
    expect(JSON.stringify(clash.output)).toContain('concurrent write refused')
    releaseWriteClaims(a.writer)
  })

  it('fs_write is atomic: content lands whole and no temp files remain', async () => {
    const dir = ws()
    await executeTool(TOOL_NAME.fs_write, { path: 'out/f.txt', content: 'whole' }, dir)
    const r = await executeTool(TOOL_NAME.fs_read, { path: 'out/f.txt' }, dir)
    expect(FsReadOutput.parse(r.output).content).toBe('whole')
    const l = await executeTool(TOOL_NAME.fs_list, { path: 'out' }, dir)
    expect(FsListOutput.parse(l.output).entries).toEqual(['f.txt']) // no .tmp residue
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
  it('read of a directory names the correction, not a raw errno', async () => {
    const dir = ws()
    await executeTool(TOOL_NAME.fs_write, { path: 'sub/f.txt', content: 'x' }, dir)
    const r = await executeTool(TOOL_NAME.fs_read, { path: 'sub' }, dir)
    expect(r.isError).toBe(true)
    expect(r.output).toEqual({ error: "'sub' is a directory — use fs_list to see its entries" })
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

describe('fs_edit', () => {
  it('replaces only the named text and leaves the rest of the file byte-identical', async () => {
    const dir = ws()
    const original = 'line one\nsubgraph CLI ["packages/cli"]\nline three\n'
    writeFileSync(path.join(dir, 'doc.md'), original)
    const r = await executeTool(TOOL_NAME.fs_edit, { path: 'doc.md', old_string: 'line three', new_string: 'line three\nline four' }, dir)
    expect(r.isError).toBe(false)
    expect(readFileSync(path.join(dir, 'doc.md'), 'utf8')).toBe('line one\nsubgraph CLI ["packages/cli"]\nline three\nline four\n')
  })

  it('writes new_string verbatim — $ replacement patterns are not interpreted', async () => {
    const dir = ws()
    writeFileSync(path.join(dir, 'mk'), 'echo OLD\n')
    const r = await executeTool(TOOL_NAME.fs_edit, { path: 'mk', old_string: 'OLD', new_string: '$$HOME and $& kept' }, dir)
    expect(r.isError).toBe(false)
    expect(readFileSync(path.join(dir, 'mk'), 'utf8')).toBe('echo $$HOME and $& kept\n')
  })

  it('refuses an ambiguous match instead of guessing which site to change', async () => {
    const dir = ws()
    writeFileSync(path.join(dir, 'doc.md'), 'x\nsame\ny\nsame\n')
    const r = await executeTool(TOOL_NAME.fs_edit, { path: 'doc.md', old_string: 'same', new_string: 'changed' }, dir)
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('appears 2 times')
    expect(readFileSync(path.join(dir, 'doc.md'), 'utf8')).toBe('x\nsame\ny\nsame\n') // untouched
  })

  it('refuses a match it cannot find, and names the correction', async () => {
    const dir = ws()
    writeFileSync(path.join(dir, 'doc.md'), 'hello\n')
    const r = await executeTool(TOOL_NAME.fs_edit, { path: 'doc.md', old_string: 'goodbye', new_string: 'x' }, dir)
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('fs_read')
  })

  it('refuses a file that does not exist and points at fs_write', async () => {
    const r = await executeTool(TOOL_NAME.fs_edit, { path: 'missing.md', old_string: 'a', new_string: 'b' }, ws())
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('fs_write')
  })

  // the zone fence and the sibling write-claim are write-path gates, not fs_write gates
  it('honours the zone write-fence', async () => {
    const dir = ws()
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, 'src', 'x.ts'), 'a')
    const denied = await executeTool(TOOL_NAME.fs_edit, { path: 'src/x.ts', old_string: 'a', new_string: 'b' }, dir, [], undefined, { zone: ['docs/**'] })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.output)).toContain('zone fence')
    expect(readFileSync(path.join(dir, 'src', 'x.ts'), 'utf8')).toBe('a') // fence refused before any write
  })
})

describe('toolSet', () => {
  it('declares every TOOL_NAME entry and none has execute', () => {
    const tools = toolSet()
    for (const name of Object.values(TOOL_NAME)) {
      expect(tools[name]).toBeDefined()
      expect(tools[name]?.execute).toBeUndefined()
    }
  })
})

const extraTool = (over: Partial<ResolvedTool> = {}): ResolvedTool => ({
  ref: 'srv/hello',
  name: 'mcp__srv__hello',
  description: 'says hello',
  inputSchema: { type: 'object', properties: { who: { type: 'string' } } },
  execute: async input => ({ output: { hi: HelloToolInput.parse(input).who }, isError: false }),
  ...over,
})

describe('fs_read line range', () => {
  const withFile = async () => {
    const dir = ws()
    await executeTool(TOOL_NAME.fs_write, { path: 'f.txt', content: 'a\nb\nc\nd\ne' }, dir)
    return dir
  }
  it('returns the inclusive 1-indexed line span when start and end are given', async () => {
    const r = await executeTool(TOOL_NAME.fs_read, { path: 'f.txt', start: 2, end: 4 }, await withFile())
    expect(r.isError).toBe(false)
    expect(r.output).toEqual({ content: 'b\nc\nd' })
  })
  it('reads from start to end-of-file when only start is given', async () => {
    const r = await executeTool(TOOL_NAME.fs_read, { path: 'f.txt', start: 4 }, await withFile())
    expect(r.output).toEqual({ content: 'd\ne' })
  })
  it('reads the whole file when no range is given (unchanged behaviour)', async () => {
    const r = await executeTool(TOOL_NAME.fs_read, { path: 'f.txt' }, await withFile())
    expect(r.output).toEqual({ content: 'a\nb\nc\nd\ne' })
  })
  it('a start past end-of-file is a readable error, not a crash', async () => {
    const r = await executeTool(TOOL_NAME.fs_read, { path: 'f.txt', start: 99 }, await withFile())
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('5 lines')
  })
})

describe('fs_delete', () => {
  it('deletes a file inside the workspace and reports it', async () => {
    const dir = ws()
    writeFileSync(path.join(dir, 'scratch.md'), 'probe')
    const r = await executeTool(TOOL_NAME.fs_delete, { path: 'scratch.md' }, dir)
    expect(r.isError).toBe(false)
    expect(existsSync(path.join(dir, 'scratch.md'))).toBe(false)
  })
  it('a missing file is an error to read, not a crash', async () => {
    const dir = ws()
    const r = await executeTool(TOOL_NAME.fs_delete, { path: 'ghost.md' }, dir)
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('ghost.md')
  })
  it('the zone write-fence applies to deletion', async () => {
    const dir = ws()
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, 'src', 'x.ts'), 'code')
    const denied = await executeTool(TOOL_NAME.fs_delete, { path: 'src/x.ts' }, dir, [], undefined, { zone: ['docs/**'] })
    expect(denied.isError).toBe(true)
    expect(existsSync(path.join(dir, 'src', 'x.ts'))).toBe(true)
  })
  it('scouts do not get it', () => {
    expect(Object.keys(toolSet([], { role: STEP_ROLE.scout }))).not.toContain(TOOL_NAME.fs_delete)
  })
})

describe('scout role', () => {
  it('a scout toolSet has no file-writing tools; reads stay', () => {
    const set = toolSet([], { role: STEP_ROLE.scout })
    expect(Object.keys(set)).not.toContain(TOOL_NAME.fs_write)
    expect(Object.keys(set)).not.toContain(TOOL_NAME.fs_edit)
    expect(Object.keys(set)).toContain(TOOL_NAME.fs_read)
    expect(Object.keys(set)).toContain(TOOL_NAME.signal)
  })
  it('every other role keeps the full set', () => {
    const set = toolSet([], { role: STEP_ROLE.worker })
    expect(Object.keys(set)).toContain(TOOL_NAME.fs_write)
    expect(Object.keys(set)).toContain(TOOL_NAME.fs_edit)
  })
  it('a readOnlySource step (the plan step) has no file-writing tools regardless of role', () => {
    // the plan step is role=auditor like verify steps that write scratch, so the flag fences it
    const set = toolSet([], { role: STEP_ROLE.auditor, readOnlySource: true })
    expect(Object.keys(set)).not.toContain(TOOL_NAME.fs_write)
    expect(Object.keys(set)).not.toContain(TOOL_NAME.fs_edit)
    expect(Object.keys(set)).not.toContain(TOOL_NAME.fs_delete)
    expect(Object.keys(set)).toContain(TOOL_NAME.fs_read)
  })
  it('an auditor WITHOUT the flag (a verify step) keeps write+delete for scratch', () => {
    const set = toolSet([], { role: STEP_ROLE.auditor })
    expect(Object.keys(set)).toContain(TOOL_NAME.fs_write)
    expect(Object.keys(set)).toContain(TOOL_NAME.fs_delete)
  })
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

describe('fs_edit diagnoses double-encoded arguments', () => {
  it('names the double encoding instead of blaming the copy', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-edit-'))
    writeFileSync(path.join(dir, 'f.ts'), 'const a = 1\nconst b = 2\n')
    const r = await executeTool('fs_edit', { path: 'f.ts', old_string: 'const a = 1\\nconst b = 2', new_string: 'x' }, dir)
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('encoded twice')
  })

  it('still gives the plain not-found message when the text is simply absent', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-edit-'))
    writeFileSync(path.join(dir, 'f.ts'), 'const a = 1\n')
    const r = await executeTool('fs_edit', { path: 'f.ts', old_string: 'nowhere', new_string: 'x' }, dir)
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('copy the exact text')
  })
})

describe('every tool argument is checked for double encoding, not just fs_edit', () => {
  const oneLineFile = `# Notes\\n\\n- first\\n- second\\n${'filler text '.repeat(20)}`

  it('refuses an fs_write whose newlines are escape sequences — and writes nothing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-write-'))
    const r = await executeTool('fs_write', { path: 'notes.md', content: oneLineFile }, dir)
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('encoded twice')
    expect(JSON.stringify(r.output)).toContain('content') // names the argument to resend
    expect(existsSync(path.join(dir, 'notes.md'))).toBe(false)
  })

  it('lets real source through — escaped quotes and \\n inside a line are valid text', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-write-'))
    const source = `const greet = "say \\"hi\\""\nconst nl = "\\n"\n${'// filler\n'.repeat(40)}`
    const r = await executeTool('fs_write', { path: 'a.ts', content: source }, dir)
    expect(r.isError).toBe(false)
    expect(readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe(source)
  })
})

describe('fs_delete takes a write claim like every other write tool', () => {
  it('refuses to delete a path a sibling step has claimed, and leaves the file intact', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-claim-del-'))
    const a = { writer: 'step:t:a:a1' }
    const b = { writer: 'step:t:b:a1' }
    expect((await executeTool(TOOL_NAME.fs_write, { path: 'shared.md', content: 'A' }, dir, [], undefined, a)).isError).toBe(false)

    const clash = await executeTool(TOOL_NAME.fs_delete, { path: 'shared.md' }, dir, [], undefined, b)
    expect(clash.isError).toBe(true)
    expect(JSON.stringify(clash.output)).toContain('concurrent write refused')
    expect(existsSync(path.join(dir, 'shared.md'))).toBe(true)

    // once A ends, the successor may delete it — the claim gates ordering, it does not forbid
    releaseWriteClaims(a.writer)
    expect((await executeTool(TOOL_NAME.fs_delete, { path: 'shared.md' }, dir, [], undefined, b)).isError).toBe(false)
    releaseWriteClaims(b.writer)
  })
})
