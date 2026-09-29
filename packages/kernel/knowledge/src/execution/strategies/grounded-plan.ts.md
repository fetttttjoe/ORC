# packages/kernel/src/execution/strategies/grounded-plan.ts

## Facts
- groundedPlanOmission in packages/kernel/src/execution/strategies/grounded-plan.ts refuses a signalled success on the grounded-plan authoring step (STEP_ID.plan with STRATEGY.groundedPlan) when the run's events show no resulting split, catching an agent that narrated a plan instead of calling finalize_plan. {y61m16ic @packages/kernel/src/execution/strategies/grounded-plan.ts#groundedPlanOmission #architecture-current}
