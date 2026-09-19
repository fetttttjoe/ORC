import type { WorkspaceWithHealth } from '@orc/contracts'
import type { KernelReads } from '@orc/kernel'
import type { WorkspaceConfig, WorkspaceOps } from './workspace-ops'

// never the mutating Kernel: a door holding it could append an event without an origin
export interface WorkspaceDoor {
  workspaces: WorkspaceOps
  reads: KernelReads
  config: () => WorkspaceConfig
  listWorkspaces: (includeArchived: boolean) => Promise<WorkspaceWithHealth[]>
}
