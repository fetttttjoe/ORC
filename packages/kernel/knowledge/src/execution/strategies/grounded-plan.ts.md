# packages/kernel/src/execution/strategies/grounded-plan.ts

## Facts
- groundedPlanOmission in packages/kernel/src/execution/strategies/grounded-plan.ts refuses a signalled success on the grounded-plan authoring step (STEP_ID.plan with STRATEGY.groundedPlan) when the run's events show no resulting split, catching an agent that narrated a plan instead of calling finalize_plan. {y61m16ic @packages/kernel/src/execution/strategies/grounded-plan.ts#groundedPlanOmission #architecture-current}
- Every grounded-task check — planApprovalStamp, Kernel.writePlanNote and knowledgeOwnerTaskIds — compares task.type to TaskType.grounded from @orc/contracts; the kernel spells no task-type literal of its own. {oif2khgh @packages/kernel/src/execution/strategies/grounded-plan.ts#planApprovalStamp @packages/kernel/src/kernel.ts#Kernel.writePlanNote @packages/kernel/src/projections.ts#knowledgeOwnerTaskIds #task-type #task-type-is-a-string-enum}

## Why
- The auditor, committer and finisher contracts live in role skills whose refs the kernel appends at the freeze, so a planner can neither author nor remove one, and enforcement stays in tool code rather than skill prose. {bh4gehbh @packages/kernel/src/execution/strategies/grounded-plan.ts#instantiateFrozenPlan}
