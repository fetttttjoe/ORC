import { afterAll, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { TaskStatus } from '@orc/contracts'
import { parseSkillMd } from '@orc/kernel'
import { authorFixture } from '@orc/contracts/fixtures'
import { KNOWLEDGE_READ_TOOLS, knowledgeTools } from '@orc/knowledge-core'
import { BRIEF_COMMAND } from './brief-commands'
import { EXIT_CODE } from './exit'
import { buildServeTools } from './mcp-serve'
import { actionsStub, sessionsStub } from './test-helpers'

// lives here, not beside the plugin: Claude Code copies that directory into its cache on install

const REPO = fileURLToPath(new URL('../../..', import.meta.url))
const PLUGIN = path.join(REPO, 'plugin')
const HOOK = path.join(PLUGIN, 'hooks', 'session-start.sh')
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))

// strict, so a key Claude Code would ignore (or act on) cannot slip in unnoticed
const PluginManifest = z.strictObject({
  name: z.literal('orc'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(1),
  author: z.strictObject({ name: z.string().min(1) }),
  mcpServers: z.strictObject({ orc: z.strictObject({ command: z.string().min(1) }) }),
})
const Marketplace = z.strictObject({
  name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  owner: z.strictObject({ name: z.string().min(1) }),
  metadata: z.strictObject({ description: z.string().min(1) }),
  plugins: z.array(z.strictObject({ name: z.string().min(1), source: z.string().startsWith('./'), description: z.string().min(1) })).length(1),
})
const HookHandler = z.strictObject({ type: z.literal('command'), command: z.string().min(1), timeout: z.number().int().positive() })
const HooksFile = z.strictObject({
  hooks: z.strictObject({ SessionStart: z.array(z.strictObject({ hooks: z.array(HookHandler).length(1) })).length(1) }),
})

describe('plugin manifests', () => {
  const manifest = PluginManifest.parse(readJson(path.join(PLUGIN, '.claude-plugin', 'plugin.json')))

  // a manifest naming hooks/hooks.json is a duplicate hooks file at load, which validate accepts
  it('plugin.json carries exactly the fields orc uses, and serves the MCP door through the bundled wrapper', () => {
    expect(manifest.mcpServers.orc.command).toBe('${CLAUDE_PLUGIN_ROOT}/bin/orc-mcp')
  })

  it('the marketplace lists this one plugin at a path that holds its manifest', () => {
    const market = Marketplace.parse(readJson(path.join(REPO, '.claude-plugin', 'marketplace.json')))
    const entry = market.plugins[0]
    expect(entry?.name).toBe(manifest.name)
    expect(statSync(path.join(REPO, entry?.source ?? '', '.claude-plugin', 'plugin.json')).isFile()).toBe(true)
  })

  it('one SessionStart hook for every session source, pointing at the script that exists', () => {
    const file = HooksFile.parse(readJson(path.join(PLUGIN, 'hooks', 'hooks.json')))
    const handler = file.hooks.SessionStart[0]?.hooks[0]
    expect(handler?.command).toBe('"${CLAUDE_PLUGIN_ROOT}"/hooks/session-start.sh')
    expect(statSync(HOOK).isFile()).toBe(true)
  })

  // Claude Code execs both files directly: without the mode bit the server and hook never start
  it.each(['bin/orc-run', 'bin/orc-mcp', 'hooks/session-start.sh'])('%s is executable', rel => {
    expect(statSync(path.join(PLUGIN, rel)).mode & 0o100).toBe(0o100)
  })
})

describe('plugin skills', () => {
  const SKILLS = path.join(PLUGIN, 'skills')
  const read = (name: string) => parseSkillMd(readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8'), name)
  const served = new Set(buildServeTools({
    sessions: sessionsStub(), projectId: 'p1', actions: actionsStub(), autonomy: 'gated',
    knowledgeTools: knowledgeTools({ unavailable: 'skills-check' }, authorFixture(), KNOWLEDGE_READ_TOOLS),
  }).map(t => t.name))

  it('ships exactly the three skills', () => {
    expect(new Set(readdirSync(SKILLS))).toEqual(new Set(['request', 'adr', 'workspace']))
  })

  it.each(['request', 'adr', 'workspace'])('%s parses under the strict frontmatter, named after its directory', name => {
    const { manifest, errors } = read(name)
    expect(errors).toEqual([])
    expect(manifest?.name).toBe(name)
  })

  // every backticked lowercase word is read as a tool name: eight served tools are one word
  it.each(['request', 'adr', 'workspace'])('%s names only tools the MCP door serves', name => {
    const statuses = new Set<string>(Object.values(TaskStatus))
    const named = [...read(name).body.matchAll(/`([a-z][a-z_]*)`/g)].map(m => m[1] ?? '').filter(t => !statuses.has(t))
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter(t => !served.has(t))).toEqual([])
  })
})

// the hook runs for real against a stand-in `orc`: always exit 0, at most one line when empty
describe('session-start hook', () => {
  const tmp: string[] = []
  afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }) })

  // `stub` is the body of a fake executable put first on PATH under `as`; null leaves PATH bare.
  const runHook = (stub: string | null, env: Record<string, string> = {}, as: 'orc' | 'bun' = 'orc') => runScript(HOOK, [], stub, env, as)

  async function runScript(script: string, args: string[], stub: string | null, env: Record<string, string> = {}, as: 'orc' | 'bun' = 'orc') {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-hook-'))
    tmp.push(dir)
    if (stub !== null) {
      writeFileSync(path.join(dir, as), `#!/usr/bin/env bash\n${stub}\n`)
      chmodSync(path.join(dir, as), 0o755)
    }
    // deliberately NOT the caller's PATH, which holds the developer's real linked `orc`
    const child = Bun.spawn([script, ...args], {
      cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: { PATH: `${dir}:/usr/bin:/bin`, CLAUDE_PROJECT_DIR: dir, ...env },
    })
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { exitCode, stdout, stderr, dir }
  }

  it('prints what orc brief printed, from the session\'s project directory', async () => {
    const r = await runHook(`[ "$1" = "${BRIEF_COMMAND}" ] || exit 9\necho "# orc — demo"\necho "cwd=$PWD"`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe(`# orc — demo\ncwd=${r.dir}\n`)
  })

  it('says nothing in a directory that is no orc project', async () => {
    const r = await runHook(`echo "project is not initialized — run 'orc init'" >&2\nexit ${EXIT_CODE.noProject}`)
    expect(r).toMatchObject({ exitCode: 0, stdout: '' })
  })

  it('a failing orc costs one line, with the credentials taken out of it', async () => {
    const r = await runHook(`echo "Postgres is not reachable at postgresql://postgres:s3cret@localhost:5433/orc — start it" >&2\necho "second line" >&2\nexit ${EXIT_CODE.failure}`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('orc: unavailable — Postgres is not reachable at postgresql://localhost:5433/orc — start it\n')
    expect(r.stdout).not.toContain('s3cret')
  })

  it('a failure that printed nothing still gets its one line', async () => {
    const r = await runHook('exit 7')
    expect(r).toMatchObject({ exitCode: 0, stdout: 'orc: unavailable — orc brief exited 7\n' })
  })

  it('orc missing from PATH is said in one line', async () => {
    const missing = await runHook(null)
    expect(missing.exitCode).toBe(0)
    expect(missing.stdout).toStartWith('orc: unavailable — orc is not on PATH')
    expect(missing.stdout.trimEnd().split('\n')).toHaveLength(1)
  })

  it('an orc that succeeds with nothing to say adds nothing, not a blank line', async () => {
    expect(await runHook('exit 0')).toMatchObject({ exitCode: 0, stdout: '' })
  })

  it('a blank first line of stderr is no reason: the exit code is named instead', async () => {
    const r = await runHook('echo "   " >&2\nexit 7')
    expect(r).toMatchObject({ exitCode: 0, stdout: 'orc: unavailable — orc brief exited 7\n' })
  })

  it('every URL on the line loses its credentials, not only the first', async () => {
    const r = await runHook('echo "log postgresql://a:one@h1/db and ws://root:two@h2:8000/rpc" >&2\nexit 1')
    expect(r.stdout).toBe('orc: unavailable — log postgresql://h1/db and ws://h2:8000/rpc\n')
    // URL parsing splits userinfo from host at the LAST '@', so a password may hold one
    const at = await runHook('echo "down: postgresql://u:p@ss@host:5433/db" >&2\nexit 1')
    expect(at.stdout).toBe('orc: unavailable — down: postgresql://host:5433/db\n')
  })

  // The way around an unlinked CLI: the checkout named by ORC_HOME, run through bun.
  it('without orc on PATH, ORC_HOME runs the brief from that checkout', async () => {
    const r = await runHook('echo "$@"', { ORC_HOME: '/opt/orchestrator' }, 'bun')
    expect(r).toMatchObject({ exitCode: 0, stdout: `/opt/orchestrator/packages/cli/src/bin.ts ${BRIEF_COMMAND}\n` })
  })

  // the MCP wrapper shares the hook's resolver (bin/orc-run) and adds the cd to the project
  const MCP = path.join(PLUGIN, 'bin', 'orc-mcp')

  it('the MCP wrapper serves from the session\'s project directory and passes its arguments on', async () => {
    const r = await runScript(MCP, ['--autonomy', 'full'], 'echo "$PWD|$*"')
    expect(r).toMatchObject({ exitCode: 0, stdout: `${r.dir}|mcp serve --autonomy full\n` })
  })

  it('the MCP wrapper without an orc fails loudly — a server that cannot start must not look started', async () => {
    const r = await runScript(MCP, [], null)
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('orc is not on PATH')
    expect(r.stdout).toBe('')
  })

  it('a project directory that is gone is silence, not an error', async () => {
    const r = await runHook('echo should-not-run', { CLAUDE_PROJECT_DIR: '/nonexistent/orc-hook-test' })
    expect(r).toMatchObject({ exitCode: 0, stdout: '' })
  })
})
