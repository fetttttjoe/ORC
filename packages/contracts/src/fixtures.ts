// Shared test fixtures (import via '@orc/contracts/fixtures') — the single place a
// PlanStep/Plan/EventRecord shape change has to touch across every package's tests.
import { z } from 'zod'
import type { EventRecord } from './events'
import { EventKind } from './event-kinds'
import { AUTHOR_SOURCE, type MemoryAuthor } from './author'
import { ClaimClass, ClaimInput, claimId, type StampedAddition } from './claim'
import { Door, NO_CHAT } from './origin'
import { IsolationTier, STRATEGY, type Plan, type PlanDraft, type PlanStep } from './plan'
import {
  EpisodicNoteInput, NOTE_TIER, MemoryPlanNoteInput, SemanticNoteInput,
  type EpisodicNote, type MemoryPlanNote, type SemanticNote,
} from './memory'
import type { PlanNote } from './plan-note'
import { TASK_STATUS, type TaskNode } from './task'

// The ONE workspace id every test-side author and task literal names — the kernel's test-helpers
// re-exports this exact binding and builds TEST_WORKSPACE (the seeded workspace_created) from it,
// so the two can never disagree. It lives here rather than there because contracts is the bottom of
// the dependency graph and its own tests need the id too, and here rather than once per test file
// because MemoryAuthor.workspaceId is required on every author — a per-file copy would be twenty
// spellings of one uuid. A uuid because Workspace.id is z.uuid(), not a readable 'test-ws'.
export const TEST_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002'

// A stored note of each tier. One fixture per tier rather than one superset literal: the tiers
// exist precisely so a note cannot carry another lane's fields, and a test fixture that ignored
// that would let a wrong-lane field look legal.
const NOTE_PROVENANCE = {
  createdAt: '2026-07-18T00:00:00.000Z', createdBy: 'cli',
  updatedAt: '2026-07-18T00:00:00.000Z', updatedBy: 'cli', revision: 1,
  // the same workspace every test-side author names, so a fixture note and a fixture write agree
  // about which checkout the note came from
  workspaceId: TEST_WORKSPACE_ID,
}

export function semanticNoteFixture(over: Partial<SemanticNote> = {}): SemanticNote {
  const authored = SemanticNoteInput.parse({ tier: NOTE_TIER.semantic, id: 'n', title: 'N' })
  return { ...authored, sources: [], ...NOTE_PROVENANCE, ...over }
}

export function memoryPlanNoteFixture(over: Partial<MemoryPlanNote> = {}): MemoryPlanNote {
  const authored = MemoryPlanNoteInput.parse({ tier: NOTE_TIER.plan, id: 'masterplan', scope: 'plan-t1', title: 'Plan' })
  return { ...authored, ...NOTE_PROVENANCE, ...over }
}

export function planNoteFixture(over: Partial<PlanNote> = {}): PlanNote {
  return {
    id: 'masterplan', title: 'Plan', summary: '', body: '', rationale: '', uncertainty: [],
    dependsOn: [], zone: [], skillRefs: [], toolRefs: [], modelRef: '', subplans: [], ...over,
  }
}

export function episodicNoteFixture(over: Partial<EpisodicNote> = {}): EpisodicNote {
  const authored = EpisodicNoteInput.parse({ tier: NOTE_TIER.episodic, id: 'step-a', scope: 'plan-t1', title: 'Step A' })
  return { ...authored, ...NOTE_PROVENANCE, ...over }
}

export function eventFixture(over: Partial<EventRecord> = {}): EventRecord {
  return {
    seq: 1, projectId: 'p1', idempotencyKey: null, chatId: null, door: Door.cli,
    taskId: 't1', stepId: null, runToken: null,
    kind: EventKind.task_created, payload: {}, usage: null, ts: '2026-07-18T00:00:00.000Z',
    ...over,
  }
}

// One spelling of a test-side author: workspaceId and origin are both required, so a per-file
// literal would be twenty copies to edit the next time provenance gains a key.
export function authorFixture(over: Partial<MemoryAuthor> = {}): MemoryAuthor {
  return { source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID, origin: NO_CHAT(Door.cli), ...over }
}

// one spelling of a stored claim and of a stamped addition, so a new claim field is one edit
export function claimFixture(text: string, over: Partial<ClaimInput> = {}): ClaimInput {
  return ClaimInput.parse({ id: claimId(text), text, class: ClaimClass.fact, anchors: [], ...over })
}

export function additionFixture(text: string, over: Partial<StampedAddition> = {}): StampedAddition {
  return { text, class: ClaimClass.fact, anchors: [], ...over }
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
    id: 't1', parentId: null, workspaceId: TEST_WORKSPACE_ID, type: 'generic', title: 'hello', spec: '',
    status: TASK_STATUS.draft, zone: [], budgetUSD: null, depth: 0,
    createdAt: '2026-07-16T00:00:00.000Z',
    ...over,
  }
}

// Test-only narrowing so `!` never appears in a test: a thrown, named error beats a silent
// null/undefined slipping through into an assertion.
export const must = <T>(v: T | null | undefined, what: string): T => {
  if (v === null || v === undefined) throw new Error(`expected ${what}`)
  return v
}

// A tool result's `output` is `unknown` by contract (ToolResult carries no schema); a test reads it
// through these instead of a cast, so a tool that returns the wrong shape fails the parse, not a
// later property access.
const UnknownRecord = z.record(z.string(), z.unknown())
export const recordOf = (v: unknown): Record<string, unknown> => UnknownRecord.parse(v)
export const listOf = (v: unknown): unknown[] => z.array(z.unknown()).parse(v)
