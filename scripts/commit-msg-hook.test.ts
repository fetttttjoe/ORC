import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** The hook must never edit the message: the key assertion is that the file is unchanged */
const HOOK = path.join(import.meta.dir, 'hooks', 'commit-msg')

interface Run {
  code: number
  stderr: string
  /** what the hook left in the message file — must always equal what went in */
  file: string
}

async function runHook(message: string): Promise<Run> {
  const dir = await mkdtemp(path.join(tmpdir(), 'orc-hook-'))
  try {
    const file = path.join(dir, 'COMMIT_EDITMSG')
    await writeFile(file, message)
    const proc = Bun.spawn(['sh', HOOK, file], { stdout: 'pipe', stderr: 'pipe' })
    const stderr = await new Response(proc.stderr).text()
    const code = await proc.exited
    return { code, stderr, file: await readFile(file, 'utf8') }
  }
  finally { await rm(dir, { recursive: true, force: true }) }
}

const SUBJECT = 'fix(memory): report degraded rebuild when notes silently drop'

describe('the commit-msg hook never edits the message', () => {
  it('leaves an over-long message byte-identical while refusing it', async () => {
    const message = `${SUBJECT}\n\nrebuild() now performs per-id accounting: it diffs the log's expected\nnote ids against what landed and returns degraded=true.\n`
    const run = await runHook(message)
    expect(run.code).toBe(1)
    expect(run.file).toBe(message)
    expect(run.stderr).toContain('3 content lines')
  })

  it('leaves an accepted message byte-identical too', async () => {
    const message = `${SUBJECT}\n\nper-id accounting diffs expected note ids against what landed.\n`
    const run = await runHook(message)
    expect(run.code).toBe(0)
    expect(run.file).toBe(message)
  })
})

describe('what the hook accepts', () => {
  it('takes a bare subject', async () => {
    expect((await runHook(`${SUBJECT}\n`)).code).toBe(0)
  })

  it('takes a subject plus one body line', async () => {
    expect((await runHook(`${SUBJECT}\n\none body line explaining the why.\n`)).code).toBe(0)
  })

  it('takes a subject naming provider-anthropic', async () => {
    const run = await runHook('fix(provider-anthropic): pin the model catalog\n')
    expect(run.code).toBe(0)
    expect(run.file).toContain('provider-anthropic')
  })

  it('takes a body naming a claude model ref', async () => {
    const run = await runHook(`feat(cli): default to claude-opus-5\n\nthe anthropic catalog now returns it first.\n`)
    expect(run.code).toBe(0)
  })

  it('ignores git comment lines and the --verbose scissors', async () => {
    const message = [
      SUBJECT,
      '',
      '# Please enter the commit message for your changes.',
      '# On branch main',
      '# ------------------------ >8 ------------------------',
      'diff --git a/x b/x',
      '+a line that would otherwise count',
      '+and another',
      '',
    ].join('\n')
    expect((await runHook(message)).code).toBe(0)
  })
})

describe('what the hook refuses', () => {
  it('refuses an empty message', async () => {
    const run = await runHook('\n#comment only\n')
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('empty')
  })

  it('refuses a subject that is not a conventional commit', async () => {
    const run = await runHook('made the thing work\n')
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('not a conventional commit')
  })

  it('refuses AI attribution trailers', async () => {
    const run = await runHook(`${SUBJECT}\n\nCo-authored-by: Claude <noreply@anthropic.com>\n`)
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('AI attribution')
  })
})
