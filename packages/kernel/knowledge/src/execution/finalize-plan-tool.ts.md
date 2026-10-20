# packages/kernel/src/execution/finalize-plan-tool.ts

## Why
- finalize_plan rebuilds the plan from the logged plan notes rather than from model input, so the executable plan cannot drift from what the human approved. {5j6efe4k @packages/kernel/src/execution/finalize-plan-tool.ts#finalizePlanTool}
- finalize_plan reports an approval recorded from a non-accepted door separately from no approval, because an agent reading the generic refusal as nobody approving would retry what cannot work. {tctm0jga @packages/kernel/src/execution/finalize-plan-tool.ts#finalizePlanTool}
