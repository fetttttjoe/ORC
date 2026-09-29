// The step-id vocabulary of the grounded-plan strategy. Zero imports on purpose: every side of
// every seam needs these names — the kernel stamps them, plugins match on them without importing
// the kernel, and the browser keys its plan-gate affordance on them. Splitting them was why
// 'masterplan', 'analyze', 'scout' and 'implementer' ended up as scattered literals; a consumer
// that cannot import the constant retypes the string.
//
// VERIFY_STEP_ID: validatePlan accepts it as the alternative to explicit dependencies, and the
// grounded freezer maps it to the auditor role.
// COMMIT_STEP_ID: appended by the kernel's withCommitStep; the only step git_commit registers for.
// FINISH_STEP_ID: appended by the kernel's withFinishStep; the only step task_claims
// registers for (stepMayReconcile in plan.ts) — mirrors COMMIT_STEP_ID's role.
export const STEP_ID = { analyze: 'analyze', plan: 'plan', verify: 'verify', commit: 'commit', checks: 'checks', finish: 'finish' } as const
export type StepId = (typeof STEP_ID)[keyof typeof STEP_ID]
export const VERIFY_STEP_ID = STEP_ID.verify
export const COMMIT_STEP_ID = STEP_ID.commit
export const CHECKS_STEP_ID = STEP_ID.checks
export const FINISH_STEP_ID = STEP_ID.finish

// the executor the checks step runs under — no model, it runs the operator's configured commands
export const CHECKS_EXECUTOR_REF = 'checks'

// The root of a grounded plan-note graph — what the authoring agent names, finalize_plan looks up,
// and the freezer decomposes from.
export const MASTERPLAN_NOTE_ID = 'masterplan'
