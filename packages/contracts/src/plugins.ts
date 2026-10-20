import { z } from 'zod'
import type { AgentExecutor, ModelProvider } from './execution'
import type { EventRecord } from './events'
import type { Analyzer } from './analysis'


export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const SkillManifest = z.strictObject({
  name: z.string().min(1).max(64).regex(SKILL_NAME_RE),
  description: z.string().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().max(500).optional(),
  allowedTools: z.string().optional(), // frontmatter key 'allowed-tools'; parsed, NOT enforced
  metadata: z.record(z.string(), z.string()).optional(),
})
export type SkillManifest = z.infer<typeof SkillManifest>

export interface SkillIndexEntry {
  name: string // directory name (identity even when the manifest is invalid)
  dir: string
  valid: boolean
  errors: string[]
  manifest: SkillManifest | null
}

export interface LoadedSkill {
  name: string
  body: string
  hash: string // sha256 hex of body — the event log records which CONTENT ran (R9)
}


export const MCP_SERVER_ID_RE = /^[a-z0-9-]+$/

export const McpServerConfig = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
})
export type McpServerConfig = z.infer<typeof McpServerConfig>

export const TOOL_REF_RE = /^[a-z0-9]+(-[a-z0-9]+)*\/.+$/

export function parseToolRef(ref: string): { serverId: string; toolName: string } {
  if (!TOOL_REF_RE.test(ref)) throw new Error(`malformed tool ref '${ref}' (expected '<server-id>/<tool-name>')`)
  const slash = ref.indexOf('/')
  return { serverId: ref.slice(0, slash), toolName: ref.slice(slash + 1) }
}

// model-facing tool name: providers require [a-zA-Z0-9_-]; Claude Code's mcp__ convention
export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName.replaceAll(/[^a-zA-Z0-9_-]/g, '_')}`
}

export interface ResolvedTool {
  ref: string
  name: string // mangled, model-facing
  description: string
  inputSchema: Record<string, unknown> // JSON Schema, as delivered by the server
  // toolCallId is the provider's real id; optional so MCP tools stay unchanged
  execute(input: unknown, toolCallId?: string): Promise<{ output: unknown; isError: boolean }>
}

export interface ToolSource {
  resolve(refs: string[]): Promise<ResolvedTool[]> // throws on undeclared/untrusted server or unknown tool
  close(): Promise<void>
}


export enum HookName {
  session_start = 'session_start',
  session_shutdown = 'session_shutdown',
  event_appended = 'event_appended',
}

export interface HookHandlers {
  session_start: () => void | Promise<void>
  session_shutdown: () => void | Promise<void>
  event_appended: (e: EventRecord) => void | Promise<void>
}

export interface ExtensionApi {
  registerProvider(id: string, provider: ModelProvider<unknown>): void
  registerExecutor(id: string, executor: AgentExecutor<unknown>): void
  registerAnalyzer(id: string, analyzer: Analyzer): void
  on<H extends HookName>(hook: H, handler: HookHandlers[H]): void
}

export interface ExtensionManifest {
  id: string
  activate(api: ExtensionApi): void | Promise<void>
  deactivate?(): void | Promise<void>
}
