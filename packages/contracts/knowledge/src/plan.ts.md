# packages/contracts/src/plan.ts

## Facts
- packages/contracts/src/plan.ts's validatePlan() rejects plans with duplicate or unknown step ids, plans where every step is parallel (no dependsOn), concurrent steps declaring overlapping zones, and dependency cycles. {achnk7p0 @packages/contracts/src/plan.ts#validatePlan #architecture-current}
