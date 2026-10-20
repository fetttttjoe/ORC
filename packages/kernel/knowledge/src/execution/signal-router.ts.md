# packages/kernel/src/execution/signal-router.ts

## Facts
- createSignalRouter in packages/kernel/src/execution/signal-router.ts subscribes to the EventLog and reacts to run_requested, plan_approved-with-pending-split, terminal task_status_changed, feedback_provided, and commit_recorded events, recording any reaction failure as a reaction_failed event instead of throwing. {yvn3h1kq @packages/kernel/src/execution/signal-router.ts#createSignalRouter #architecture-current}

## Why
- signal-router's run_requested catch-up skips tasks in TERMINAL_TASK_STATUS, not its local TERMINAL, because blocked is the state a retry resumes from while a request left for a settled task would be re-refused on every boot. {02f3ode4 @packages/kernel/src/execution/signal-router.ts#createSignalRouter}
- signal-router's reactionFailed contains its own append, so a diagnosis that throws never replaces the failure it describes, and keys by the cause's seq or splitId so a boot-time sweep retry logs once. {vu9zxm0x @packages/kernel/src/execution/signal-router.ts#createSignalRouter.reactionFailed}
