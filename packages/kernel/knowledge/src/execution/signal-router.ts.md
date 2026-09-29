# packages/kernel/src/execution/signal-router.ts

## Facts
- createSignalRouter in packages/kernel/src/execution/signal-router.ts subscribes to the EventLog and reacts to run_requested, plan_approved-with-pending-split, terminal task_status_changed, feedback_provided, and commit_recorded events, recording any reaction failure as a reaction_failed event instead of throwing. {yvn3h1kq @packages/kernel/src/execution/signal-router.ts#createSignalRouter #architecture-current}
