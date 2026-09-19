import type { Kernel } from './kernel'

// The Kernel's surface, classified. Types only — nothing here runs.

// Every method that APPENDS. Each takes `origin: Origin` as its required last parameter, and the
// table-driven kernel test is a Record over this union, so a new verb with no row fails to compile.
export type KernelMutationVerb =
  | 'createTask'
  | 'createGroundedTask'
  | 'proposePlan'
  | 'editPlan'
  | 'approvePlan'
  | 'proposeSplit'
  | 'annotatePlan'
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

// Every method that only DERIVES from the log. A read takes no origin: it records nothing.
export type KernelReads = Pick<Kernel,
  | 'listAnnotations'
  | 'listTaskChangedPaths'
  | 'listTaskNoteWrites'
  | 'listTaskVerifiedNotes'
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

// `never[]` params: the bottom function type, so this matches any method and nothing else —
// `approvalDoors` is a field and stays out.
type KernelMethod = { [K in keyof Kernel]-?: Kernel[K] extends (...args: never[]) => unknown ? K : never }[keyof Kernel]
type Unclassified = Exclude<KernelMethod, KernelMutationVerb | keyof KernelReads>

// Deliberately unused: a new Kernel method that is neither a mutation verb nor a read makes this
// line fail with its own name, which is how an append without an Origin gets caught at build time.
// Deleting it as dead code removes the guard.
const VERBS_COVER_KERNEL: [Unclassified] extends [never] ? true : Unclassified = true
void VERBS_COVER_KERNEL
