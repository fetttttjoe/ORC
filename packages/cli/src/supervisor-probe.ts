import { existsSync } from 'node:fs'
import { liveSupervisors, runtimeLockHeld, staleSupervisors, type Storage } from '@orc/kernel'
import { supervisorHealth } from './serve'
import { servePidFile } from './serve-paths'

// one derivation of supervisor health for every door that reports it
export async function probeSupervisor(storage: Storage, projectRoot: string, config?: { databaseUrl: string; projectId: string }) {
  const now = new Date()
  // the runtime lock answers 'is anything driving', which the heartbeat cannot
  const held = config ? await runtimeLockHeld(config.databaseUrl, config.projectId) : false
  return supervisorHealth(await liveSupervisors(storage, now), await staleSupervisors(storage, now), existsSync(servePidFile(projectRoot)), held)
}
