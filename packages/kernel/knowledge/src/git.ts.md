# packages/kernel/src/git.ts

## Why
- spawnGit is synchronous because loadConfig is sync and runs first in every entry point, so an async probe on that path would make the whole config loader async. {d9o7laia @packages/kernel/src/git.ts#spawnGit}
- spawnGit returns the exit code and both streams because a merge conflict prints its report to stdout and leaves stderr empty, so a stderr-only refusal would be blank exactly when the operator has a half-merged tree. {ne2csv6f @packages/kernel/src/git.ts#spawnGit}
