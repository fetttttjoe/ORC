# packages/contracts/src/plan.ts

## Facts
- packages/contracts/src/plan.ts's validatePlan() rejects plans with duplicate or unknown step ids, plans where every step is parallel (no dependsOn), concurrent steps declaring overlapping zones, and dependency cycles. {achnk7p0 @packages/contracts/src/plan.ts#validatePlan #architecture-current}

## Why
- GroundedApprovalDoor is set by the operator in config, never by a prompt, since accepting 'mcp' lets the driving agent approve plans it authored; it has no 'web' member because a web-UI reply is recorded as 'cli'. {ru1hx5f3 @packages/contracts/src/plan.ts#GroundedApprovalDoor}
- validatePlan rejects a multi-step plan whose steps are all parallel, because verify would audit files a draft step has not written yet; exempting plans with a verify step does not help, since that exemption is reachable only when verify is itself unordered. {p6che8e9 @packages/contracts/src/plan.ts#validatePlan}
