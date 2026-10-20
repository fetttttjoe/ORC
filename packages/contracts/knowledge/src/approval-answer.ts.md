# packages/contracts/src/approval-answer.ts

## Why
- ApprovalAnswer is spelled once so the kernel and the browser bundle cannot diverge on what approves; it omits a bare 'y' because finalize_plan force-auto-approves, so a stray keystroke would execute an unread plan. {dnanc1dp @packages/contracts/src/approval-answer.ts#ApprovalAnswer}
