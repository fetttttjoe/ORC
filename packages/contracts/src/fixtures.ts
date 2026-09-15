// Shared test fixtures (import via '@orc/contracts/fixtures') — the single place a
// PlanStep/Plan/EventRecord shape change has to touch across every package's tests.
import type { EventRecord } from './events'
import { STRATEGY, type Plan, type PlanDraft, type PlanStep } from './plan'
import {
  EpisodicNoteInput, NOTE_TIER, PlanNoteInput, SemanticNoteInput,
  type EpisodicNote, type PlanNote, type SemanticNote,
} from './memory'

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

export function planNoteFixture(over: Partial<PlanNote> = {}): PlanNote {
  const authored = PlanNoteInput.parse({ tier: NOTE_TIER.plan, id: 'masterplan', scope: 'plan-t1', title: 'Plan' })
  return { ...authored, ...NOTE_PROVENANCE, ...over }
}

export function episodicNoteFixture(over: Partial<EpisodicNote> = {}): EpisodicNote {
  const authored = EpisodicNoteInput.parse({ tier: NOTE_TIER.episodic, id: 'step-a', scope: 'plan-t1', title: 'Step A' })
  return { ...authored, ...NOTE_PROVENANCE, ...over }
}

export function eventFixture(over: Partial<EventRecord> = {}): EventRecord {
  return {
    seq: 1, projectId: 'p1', idempotencyKey: null,
    taskId: 't1', stepId: null, runToken: null,
    kind: 'task_created', payload: {}, usage: null, ts: '2026-07-18T00:00:00.000Z',
    ...over,
  }
}

export function stepFixture(over: Partial<PlanStep> = {}): PlanStep {
  return {
    id: 's1', role: 'worker', title: 's1', instructions: 'do',
    executorRef: 'api-loop', modelRef: 'fake/m', skillRefs: [], toolRefs: [],
    isolation: 'local', zone: [], maxIterations: 5, dependsOn: [],
    ...over,
  }
}

export function draftFixture(steps: PlanStep[] = [stepFixture()]): PlanDraft {
  return { strategyRef: STRATEGY.single, costEstimateUSD: null, steps }
}

export function planFixture(over: Partial<Plan> = {}): Plan {
  return { taskId: 't1', version: 1, ...draftFixture(), ...over }
}
