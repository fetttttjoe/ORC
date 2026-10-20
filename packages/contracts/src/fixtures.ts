// shared test fixtures: one place for a PlanStep, Plan or EventRecord shape change
import { z } from 'zod'
import type { EventRecord } from './events'
import { EventKind } from './event-kinds'
import { AUTHOR_SOURCE, type Author } from './author'
import { Door, NO_CHAT } from './origin'
import { IsolationTier, STRATEGY, type Plan, type PlanDraft, type PlanStep } from './plan'
import type { PlanNote } from './plan-note'
import { TASK_STATUS, TaskType, type TaskNode } from './task'

// the one test workspace id; a uuid because Workspace.id is z.uuid(); kernel re-exports it
export const TEST_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002'

export function planNoteFixture(over: Partial<PlanNote> = {}): PlanNote {
  return {
    id: 'masterplan', title: 'Plan', summary: '', body: '', rationale: '', uncertainty: [],
    dependsOn: [], zone: [], skillRefs: [], toolRefs: [], modelRef: '', subplans: [], ...over,
  }
}

export function eventFixture(over: Partial<EventRecord> = {}): EventRecord {
  return {
    seq: 1, projectId: 'p1', idempotencyKey: null, chatId: null, door: Door.cli,
    taskId: 't1', stepId: null, runToken: null,
    kind: EventKind.task_created, payload: {}, usage: null, ts: '2026-07-18T00:00:00.000Z',
    ...over,
  }
}

// workspaceId and origin are required, so a per-file literal would be twenty edits
export function authorFixture(over: Partial<Author> = {}): Author {
  return { source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID, origin: NO_CHAT(Door.cli), ...over }
}

export function stepFixture(over: Partial<PlanStep> = {}): PlanStep {
  return {
    id: 's1', role: 'worker', title: 's1', instructions: 'do',
    executorRef: 'api-loop', modelRef: 'fake/m', skillRefs: [], toolRefs: [],
    isolation: IsolationTier.local, zone: [], maxIterations: 5, dependsOn: [],
    ...over,
  }
}

export function draftFixture(steps: PlanStep[] = [stepFixture()]): PlanDraft {
  return { strategyRef: STRATEGY.single, costEstimateUSD: null, steps }
}

export function planFixture(over: Partial<Plan> = {}): Plan {
  return { taskId: 't1', version: 1, ...draftFixture(), ...over }
}

export function taskFixture(over: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 't1', parentId: null, workspaceId: TEST_WORKSPACE_ID, type: TaskType.generic, title: 'hello', spec: '',
    status: TASK_STATUS.draft, zone: [], budgetUSD: null, depth: 0,
    createdAt: '2026-07-16T00:00:00.000Z',
    ...over,
  }
}

// test-only narrowing so a test never needs a non-null assertion
export const must = <T>(v: T | null | undefined, what: string): T => {
  if (v === null || v === undefined) throw new Error(`expected ${what}`)
  return v
}

// reads a tool result's unknown output through a schema, not a cast
const UnknownRecord = z.record(z.string(), z.unknown())
export const recordOf = (v: unknown): Record<string, unknown> => UnknownRecord.parse(v)
export const listOf = (v: unknown): unknown[] => z.array(z.unknown()).parse(v)
