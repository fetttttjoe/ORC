// Shared CLI-test scaffolding: a throwaway-SurrealDB dropper and a `Command`-per-call CLI runner.
// One spelling of the SurrealDB dropper and the CLI runner, so the six CLI test files that need
// them cannot drift against each other.
import { spyOn } from 'bun:test'
import type { Command } from 'commander'
import { Surreal } from 'surrealdb'
import type { ExecutionPort } from '@orc/contracts'
import { projectDatabaseName, type EventLog, type Kernel, type PluginHost, type ProjectConfig, type Storage } from '@orc/kernel'
import type { McpHub } from '@orc/mcp-client'
import { buildProgram } from './main'

// `use()` selects only the namespace, and the (internally-generated, `t_[a-z0-9]+`) db name is
// inlined directly, since `REMOVE DATABASE IF EXISTS type::database($db)` is not a valid function
// path in SurrealDB v3.2.0. Connection details come from the injected config — no literals.
export async function dropSurrealDb(config: ProjectConfig): Promise<void> {
  const s = new Surreal()
  await s.connect(config.projectDbUrl)
  await s.signin({ username: config.projectDbUser, password: config.projectDbPassword })
  await s.use({ namespace: config.projectDbNamespace })
  // createMemory opens the project-derived name; drop base and derived alike
  for (const name of [config.projectDbName, projectDatabaseName(config.projectDbName, config.projectId)])
    await s.query(`REMOVE DATABASE IF EXISTS \`${name}\`;`).catch(() => {})
  await s.close()
}

type PluginContext = { host: PluginHost; hub: McpHub; config: ProjectConfig; log: EventLog; storage?: Storage }

// exitOverride must reach NESTED subcommands too (e.g. `memory neighbors`): commander only copies
// the setting to children created AFTER the call, and buildProgram builds every subcommand up
// front — so an option error on one would call process.exit(1) and kill the whole test process
// mid-suite instead of rejecting.
function overrideExits(program: Command): Command {
  const walk = (c: Command): void => {
    c.exitOverride()
    for (const sub of c.commands) walk(sub)
  }
  walk(program)
  return program
}

// One console.log spy per CLI under test, and `run()` hands back only the lines ITS OWN
// invocation printed (never the accumulated buffer): a cumulative array makes assertions
// unfalsifiable, since lines an earlier call in the same test printed already carry whatever the
// next call would too.
export function cli(kernel: Kernel | null, port?: () => Promise<ExecutionPort>, plugin?: PluginContext) {
  const lines: string[] = []
  spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
  const run = async (...args: string[]): Promise<string[]> => {
    const from = lines.length
    // fresh Command instance per invocation; commander does not re-parse cleanly
    await overrideExits(buildProgram(kernel, port, plugin)).parseAsync(args, { from: 'user' })
    return lines.slice(from)
  }
  return { run, lines }
}
