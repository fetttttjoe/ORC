import { projectDatabaseName, type ProjectConfig } from '@orc/kernel'
import { SurrealMemory } from './surreal'

// The SurrealDB knowledge service — the peer of openStorage for Postgres. It encapsulates
// how the knowledge read model is reached: connection, auth, and the project-derived
// database boundary. Business logic (the memory gateway, projector, tools, ranking)
// consumes this and never opens a Surreal session itself.
export type Knowledge = SurrealMemory

export async function openKnowledge(config: ProjectConfig): Promise<Knowledge> {
  new URL(config.projectDbUrl) // fail fast on a malformed setting; the adapter takes the raw string
  return SurrealMemory.open({
    url: config.projectDbUrl,
    ns: config.projectDbNamespace,
    // native database boundary isolates projects — tool inputs can never reach another project
    db: projectDatabaseName(config.projectDbName, config.projectId),
    username: config.projectDbUser,
    password: config.projectDbPassword,
  })
}
