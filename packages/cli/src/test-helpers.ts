// shared CLI-test scaffolding: a Command-per-call runner and throwing stubs for the served tools
import { spyOn } from 'bun:test'
import type { Command } from 'commander'
import type { EventRecord, ExecutionPort } from '@orc/contracts'
import type { EventLog, Kernel, PluginHost, ProjectConfig, Storage } from '@orc/kernel'
import type { McpHub } from '@orc/mcp-client'
import type { OrcActions, ProjectSessions } from '@orc/ui-core'
import { modelOf } from '@orc/ui-core/test-helpers'
import { buildProgram } from './main'

type PluginContext = { host: PluginHost; hub: McpHub; config: ProjectConfig; log: EventLog; storage?: Storage }

// exitOverride must reach nested subcommands: commander copies it only to children created after
function overrideExits(program: Command): Command {
  const walk = (c: Command): void => {
    c.exitOverride()
    for (const sub of c.commands) walk(sub)
  }
  walk(program)
  return program
}

// run() returns only its own lines: a cumulative buffer makes assertions unfalsifiable
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

// honest stubs: every member throws unless overridden, so no cast lies about completeness
export const unsupported = (name: string) => async (): Promise<never> => { throw new Error(`${name} not available in this test`) }
export const sessionsStub = (over: Partial<ProjectSessions> = {}): ProjectSessions => ({
  projects: unsupported('projects'), model: unsupported('model'), snapshot: unsupported('snapshot'), subscribe: unsupported('subscribe'),
  subscribeProjects: unsupported('subscribeProjects'), notifyProjectsChanged: unsupported('notifyProjectsChanged'),
  since: unsupported('since'), reset: unsupported('reset'), close: unsupported('close'), ...over,
})

// answers every read from these EVENTS: the served tools read through the view registry
export const sessionsOf = (events: EventRecord[], over: Partial<ProjectSessions> = {}): ProjectSessions =>
  sessionsStub({ model: async () => modelOf(events), ...over })
export const actionsStub = (over: Partial<OrcActions> = {}): OrcActions => ({
  newTask: unsupported('newTask'), propose: unsupported('propose'), edit: unsupported('edit'),
  approve: unsupported('approve'), run: unsupported('run'), reply: unsupported('reply'),
  retry: unsupported('retry'), annotate: unsupported('annotate'), revise: unsupported('revise'),
  recordDecision: unsupported('recordDecision'), listDecisions: unsupported('listDecisions'), readDecision: unsupported('readDecision'),
  renameProject: unsupported('renameProject'), newProject: unsupported('newProject'),
  listWorkspaces: unsupported('listWorkspaces'), newWorkspace: unsupported('newWorkspace'),
  listModels: unsupported('listModels'),
  cancel: unsupported('cancel'), purgeProject: unsupported('purgeProject'), deleteProject: unsupported('deleteProject'), ...over,
})
