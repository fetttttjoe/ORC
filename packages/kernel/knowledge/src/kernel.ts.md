# packages/kernel/src/kernel.ts

## Facts
- Kernel (packages/kernel/src/kernel.ts) is the single writer for task/plan/workspace lifecycle events, appending every event through EventLog transactions. {9pphnp9p @packages/kernel/src/kernel.ts#Kernel #architecture-current}
- Kernel.proposeSplit rejects a child plan draft that assigns role committer/finisher or reuses FINISH_STEP_ID/CHECKS_STEP_ID unless authoredBy equals SPLIT_ORIGIN.freeze, so only the kernel's own finalize_plan freeze can grant commit/finish privileges to a step. {4txv1lrd @packages/kernel/src/kernel.ts#proposeSplit #architecture-current}

## Why
- Kernel.createGroundedTask seeds a policy-auto-approved [analyze, plan] step template because the real human approval gate is the conversational approve inside the plan step, not this scaffold. {zd2we067 @packages/kernel/src/kernel.ts#createGroundedTask #architecture-current}
