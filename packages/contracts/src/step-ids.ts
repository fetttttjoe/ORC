// zero imports: kernel, plugins and the browser all match on these names
export const STEP_ID = { analyze: 'analyze', plan: 'plan', verify: 'verify', commit: 'commit', checks: 'checks', finish: 'finish' } as const
export type StepId = (typeof STEP_ID)[keyof typeof STEP_ID]
export const VERIFY_STEP_ID = STEP_ID.verify
export const COMMIT_STEP_ID = STEP_ID.commit
export const CHECKS_STEP_ID = STEP_ID.checks
export const FINISH_STEP_ID = STEP_ID.finish

// the executor the checks step runs under — no model, it runs the operator's configured commands
export const CHECKS_EXECUTOR_REF = 'checks'

// root of a grounded plan-note graph: authored, looked up by finalize_plan, frozen from here
export const MASTERPLAN_NOTE_ID = 'masterplan'
