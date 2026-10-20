import type { Kernel } from './kernel'

// The Kernel's surface, classified. Types only — nothing here runs.

// every appending method takes `origin: Origin` last; a verb with no test row fails to compile
export type KernelMutationVerb =
  | 'createTask'
  | 'createGroundedTask'
  | 'proposePlan'
  | 'editPlan'
  | 'approvePlan'
  | 'proposeSplit'
  | 'annotatePlan'
  | 'writePlanNote'
  | 'replyFeedback'
  | 'reportCoverage'
  | 'requestRun'
  | 'cancelSubtree'
  | 'ensureWorkspace'
  | 'createWorkspace'
  | 'restoreWorkspace'
  | 'retitleWorkspace'
  | 'setWorkspaceArchived'
  | 'mergeWorkspace'
  | 'identifyProject'

// Every method that only DERIVES from the log. A read takes no origin: it records nothing.
export type KernelReads = Pick<Kernel,
  | 'listAnnotations'
  | 'listTaskChangedPaths'
  | 'listTaskKnowledgeWrites'
  | 'listPlanNotes'
  | 'openFeedback'
  | 'openFeedbackInSubtree'
  | 'gatedChildren'
  | 'approvedPlanHash'
  | 'nonHumanPlanApproval'
  | 'planNotesChangedSince'
  | 'latestCoverage'
  | 'listWorkspaces'
  | 'state'
  | 'getTask'
  | 'listTasks'
  | 'getPlan'
  | 'eventsFor'
  | 'eventsSince'
  | 'subscribe'
>

// `never[]` params match any method and nothing else; `approvalDoors` is a field
type KernelMethod = { [K in keyof Kernel]-?: Kernel[K] extends (...args: never[]) => unknown ? K : never }[keyof Kernel]
type Unclassified = Exclude<KernelMethod, KernelMutationVerb | keyof KernelReads>

// guard, not dead code: a method that is neither verb nor read fails here by name
const VERBS_COVER_KERNEL: [Unclassified] extends [never] ? true : Unclassified = true
void VERBS_COVER_KERNEL
