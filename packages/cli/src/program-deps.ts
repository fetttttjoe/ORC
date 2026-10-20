import { Door, NO_CHAT, type ExecutionPort, type TaskNode } from '@orc/contracts'
import type { EventLog, Kernel, PluginHost, ProjectConfig, Storage } from '@orc/kernel'
import type { McpHub } from '@orc/mcp-client'
import type { OrcActions } from '@orc/ui-core'
import type { buildModelDiscovery } from './actions'
import type { TailResult } from './watch'

// every command here enters through the terminal: identity (which door), never authority
export const CLI_ORIGIN = NO_CHAT(Door.cli)

export interface ProgramPlugin {
  host: PluginHost
  hub: McpHub
  config: ProjectConfig
  log: EventLog
  storage?: Storage
}

export interface ProgramDeps {
  requireKernel: () => Kernel
  needPlugin: () => ProgramPlugin
  noProject: (message: string) => unknown
  plugin: ProgramPlugin | undefined
  portFactory: (() => Promise<ExecutionPort>) | undefined
  discovery: ReturnType<typeof buildModelDiscovery> | undefined
  actions: () => OrcActions
  requireTask: (taskId: string) => Promise<TaskNode>
  derivedPlanFor: (taskId: string) => Promise<string>
  report: (result: TailResult, rootId: string) => Promise<void>
  rootOf: (taskId: string) => Promise<string>
  watchFrom: (taskId: string, since: number | undefined) => Promise<void>
}
