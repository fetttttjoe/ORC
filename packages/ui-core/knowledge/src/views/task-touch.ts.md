# packages/ui-core/src/views/task-touch.ts

## Why
- A child task's change stales its parent because the parent's rendered plan carries the children's step states and would freeze at its mount-time values; agent_call is excluded here because widening the shared set would put every task-keyed view on the loop's cadence. {mj5b5wxe @packages/ui-core/src/views/task-touch.ts#taskAndParent}
