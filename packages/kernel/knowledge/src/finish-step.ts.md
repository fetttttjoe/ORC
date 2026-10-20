# packages/kernel/src/finish-step.ts

## Why
- FINISH_EXEMPT_STRATEGIES are groundedPlan, whose frozen child gets the finish step at the freeze, and sweep, a machine-drafted task nobody waits on, because a finish step would park it on a human indefinitely. {aojcgdfa @packages/kernel/src/finish-step.ts#FINISH_EXEMPT_STRATEGIES}
- reconcileFinishStep leaves exempt and child drafts untouched rather than stripping, because a frozen child already ends with the step the freeze appended and nothing would put a stripped one back. {xm94gzv4 @packages/kernel/src/finish-step.ts#reconcileFinishStep}
- The finish step inherits modelRef and maxIterations from the plan's last step and has no budget of its own, so a one-iteration last step caps the finish step's work. {xaut2tq0 @packages/kernel/src/finish-step.ts#withFinishStepFull}
- withoutKernelFinishStep strips only a trailing finish step matching both id and role (and the checks step before it), so an edit door never doubles the appended steps while a planner's step merely named finish is kept and refused by assertNoKernelStepId. {irla3ruj @packages/kernel/src/finish-step.ts#withoutKernelFinishStep}
