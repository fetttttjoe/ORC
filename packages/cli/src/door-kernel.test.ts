import { expect, test } from 'bun:test'
import type { KernelMutationVerb, KernelReads } from '@orc/kernel'
import type { WorkspaceDoor } from './door-kernel'
import type { wsCommand } from './ws-commands'

// a door holds reads: asking it for a mutation verb must not compile
// @ts-expect-error `createTask` is a kernel mutation verb and a door cannot reach it
type DoorCannotCreateTask = WorkspaceDoor['reads']['createTask']
void (undefined as unknown as DoorCannotCreateTask)

// the same question of what the terminal's workspace surface is actually wired with
type WsDoor = ReturnType<Parameters<typeof wsCommand>[0]['requireDoor']>
// @ts-expect-error `setWorkspaceArchived` is a kernel mutation verb; ws-commands reaches it only through `workspaces`
type WsCannotArchive = WsDoor['reads']['setWorkspaceArchived']
void (undefined as unknown as WsCannotArchive)
// @ts-expect-error the ws door is built without `actions`
type WsCannotAct = WsDoor['actions']
void (undefined as unknown as WsCannotAct)
// the verbs it reaches are the ops', which take their Origin last: no append without one
void (undefined as unknown as Parameters<WsDoor['workspaces']['restore']>[1])

// one row per mutation verb, keyed by the union: a new kernel verb fails here until listed
type WithheldFromDoor<V extends KernelMutationVerb> = V extends keyof KernelReads ? never : true
const DOOR_WITHHOLDS: { [V in KernelMutationVerb]: WithheldFromDoor<V> } = {
  createTask: true,
  createGroundedTask: true,
  proposePlan: true,
  editPlan: true,
  approvePlan: true,
  proposeSplit: true,
  annotatePlan: true,
  writePlanNote: true,
  replyFeedback: true,
  reportCoverage: true,
  requestRun: true,
  cancelSubtree: true,
  ensureWorkspace: true,
  createWorkspace: true,
  restoreWorkspace: true,
  retitleWorkspace: true,
  setWorkspaceArchived: true,
  mergeWorkspace: true,
  identifyProject: true,
}

test('every kernel mutation verb is withheld from a door', () => {
  expect(Object.values(DOOR_WITHHOLDS).every(v => v)).toBe(true)
  expect(Object.keys(DOOR_WITHHOLDS).length).toBeGreaterThan(0)
})
