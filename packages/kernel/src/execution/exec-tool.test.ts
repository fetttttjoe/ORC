import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { execTool } from './exec-tool'

// the success-shape of an exec result — parse (never cast) the tool output the assertions read
const ExecOut = z.object({ exitCode: z.number(), stdout: z.string(), stderr: z.string() })
// the same shape plus what the log/bracket adds
const ExecLog = ExecOut.extend({ logPath: z.string(), cached: z.literal(true).optional() })

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

  /**
   * The clip is head+tail, so anything in the MIDDLE of a long run is unreachable — and an agent
   * that needed one line from there had exactly one move: run the whole suite again. Observed live:
   * a heal step ran `bun run typecheck` and `bun test` (~10 minutes) inside a run that changed no
   * source file at all. The full stream goes to a file so a missed grep costs an fs_read.
   */
  it('writes the FULL output to a log file so a missed grep costs a read, not a re-run', async () => {
    const dir = ws()
    // a middle the clip is guaranteed to drop: two fat ends around a unique marker
    writeFileSync(path.join(dir, 'noisy.sh'), `printf 'a%.0s' $(seq 1 9000)\necho MIDDLE_MARKER\nprintf 'b%.0s' $(seq 1 9000)\n`)
    const r = await tool(['sh'], dir).execute({ command: 'sh noisy.sh' })
    const out = ExecLog.parse(r.output)
    expect(out.stdout).not.toContain('MIDDLE_MARKER') // clipped away, as before
    const full = readFileSync(path.join(dir, out.logPath), 'utf8')
    expect(full).toContain('MIDDLE_MARKER')
    expect(full).toContain('sh noisy.sh') // the log names what produced it
  }, 15_000)

  /**
   * The BRACKET: sibling steps in one wave each ran the same gate against the same unchanged tree,
   * paying the full suite every time. A repeat of an identical command on an identical fingerprint
   * returns the first run's result instead of re-executing — flagged `cached`, never silently.
   */
  it('reuses an identical run against an unchanged tree instead of re-executing', async () => {
    const dir = ws()
    // side-effecting: each real execution appends a line, so the count IS the execution count
    writeFileSync(path.join(dir, 'count.sh'), 'echo ran >> runs.txt\necho done\n')
    const t = execTool({ workspaceDir: dir, allowlist: ['sh'], fingerprint: async () => 'TREE-1' })[0]!
    const first = ExecLog.parse((await t.execute({ command: 'sh count.sh' })).output)
    expect(first.cached).toBeUndefined()
    const second = ExecLog.parse((await t.execute({ command: 'sh count.sh' })).output)
    expect(second.cached).toBe(true)
    expect(second.logPath).toBe(first.logPath) // same evidence, not a second copy
    expect(readFileSync(path.join(dir, 'runs.txt'), 'utf8').trim().split('\n')).toHaveLength(1)
  }, 15_000)

  it('a changed tree re-runs — the bracket is keyed on the fingerprint, never on time alone', async () => {
    const dir = ws()
    writeFileSync(path.join(dir, 'count.sh'), 'echo ran >> runs.txt\necho done\n')
    let tree = 'TREE-1'
    const t = execTool({ workspaceDir: dir, allowlist: ['sh'], fingerprint: async () => tree })[0]!
    await t.execute({ command: 'sh count.sh' })
    tree = 'TREE-2' // something edited a file
    const second = ExecLog.parse((await t.execute({ command: 'sh count.sh' })).output)
    expect(second.cached).toBeUndefined()
    expect(readFileSync(path.join(dir, 'runs.txt'), 'utf8').trim().split('\n')).toHaveLength(2)
  }, 15_000)

  // An unfingerprintable workspace (no repo) must never reuse: with nothing to invalidate against,
  // a cache hit could serve a result for a tree that has completely changed.
  it('never reuses when the tree cannot be fingerprinted', async () => {
    const dir = ws()
    writeFileSync(path.join(dir, 'count.sh'), 'echo ran >> runs.txt\necho done\n')
    const t = execTool({ workspaceDir: dir, allowlist: ['sh'], fingerprint: async () => null })[0]!
    await t.execute({ command: 'sh count.sh' })
    const second = ExecLog.parse((await t.execute({ command: 'sh count.sh' })).output)
    expect(second.cached).toBeUndefined()
    expect(readFileSync(path.join(dir, 'runs.txt'), 'utf8').trim().split('\n')).toHaveLength(2)
  }, 15_000)

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

  it('a refused compound command teaches the one-command rule', async () => {
    // observed live (#31697): an agent tried `cd packages/ui-core && bun test … | tail -60` and
    // burned an iteration learning by refusal that exec has no shell. The refusal should say so.
    const r = await tool(['bun test']).execute({ command: 'cd packages/ui-core && bun test src/x.test.ts 2>&1 | tail -60' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('no shell')
    expect(JSON.stringify(r.output)).toContain('workspace root')
  })

  it('allowlist entries extend at token boundaries only', async () => {
    const t = tool(['echo hi'])
    expect((await t.execute({ command: 'echo hi there' })).isError).toBe(false) // extra args ok
    expect((await t.execute({ command: 'echo hix' })).isError).toBe(true) // 'echo hi' is not a prefix of 'echo hix'
  })

  /**
   * Quoting is a SEPARATE concern from shelling. Splitting on whitespace shattered every
   * multi-word argument into argv tokens the target program read as filenames, so a grep pattern
   * with a space could not be expressed at all: measured live, an agent's
   * `grep -n "export const X" f.ts` came back `grep: const: No such file or directory`, and a
   * later run reported grep "non-functional throughout" and left a question unanswered.
   */
  it('a quoted multi-word argument survives as ONE argv token', async () => {
    const dir = ws()
    writeFileSync(path.join(dir, 'f.txt'), 'export const NOTE_CATEGORIES = 1\nunrelated line\n')
    const r = await tool(['grep'], dir).execute({ command: 'grep -n "export const NOTE_CATEGORIES" f.txt' })
    const out = ExecOut.parse(r.output)
    expect(out.stderr).toBe('')
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('export const NOTE_CATEGORIES')
  })

  it("single quotes group too, and an empty quoted argument stays an argument", async () => {
    const dir = ws()
    writeFileSync(path.join(dir, 'f.txt'), 'alpha beta\n')
    const r = await tool(['grep'], dir).execute({ command: "grep -c 'alpha beta' f.txt" })
    expect(ExecOut.parse(r.output).stdout.trim()).toBe('1')
    // `echo ""` must pass one EMPTY argument, not drop it — whitespace-splitting cannot express this
    const e = await tool(['echo'], dir).execute({ command: 'echo "" tail' })
    expect(ExecOut.parse(e.output).stdout).toBe(' tail\n')
  })

  it('an unterminated quote is refused by name, not silently mis-split', async () => {
    const r = await tool(['grep']).execute({ command: 'grep -n "unclosed f.txt' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('quote')
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
