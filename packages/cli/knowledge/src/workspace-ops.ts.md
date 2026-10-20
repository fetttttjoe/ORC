# packages/cli/src/workspace-ops.ts

## Why
- A worktree made by createRequestWorkspace sits under the project's .orc/, and loadConfig's upward walk stops there only because a tracked .orc/config.json materializes; a project that does not track one lets a command run inside the worktree adopt the main checkout's workspace. {m5vr3ydw @packages/cli/src/workspace-ops.ts#createRequestWorkspace}
- The already-merged refusal lives in mergeTarget as well as the kernel because git's `merge --no-ff` of a contained branch prints "Already up to date", exits 0 and commits nothing, so a command that asked git first would merge for nothing before hearing the fact was already written. {agmnhdmg @packages/cli/src/workspace-ops.ts#mergeTarget}
- requireLiveWorkspace refuses an unknown id with the kernel's own KernelError and code, so a door that checks first and one that does not are indistinguishable on a typo to callers that switch on KERNEL_ERROR_CODE, which a plain Error would break. {0r5e8ds1 @packages/cli/src/workspace-ops.ts#requireLiveWorkspace}
