# packages/cli/src/workspace-adopt.ts

## Why
- adoptCwd treats a detached HEAD as off-trunk but a directory outside git as trunk, which is why it probes gitDirs rather than reading branch === null alone: outside git there is nothing to be behind, while a detached checkout has a trunk it is not on. {bj958lav @packages/cli/src/workspace-adopt.ts#adoptCwd}
- adoptCwd archives and re-mints the record when the checkout's branch has moved, carrying over managed, baseBranch and kind, because a mint cannot derive them and dropping managed makes `archive --remove` refuse a worktree orc itself created. {y8f4np36 @packages/cli/src/workspace-adopt.ts#adoptCwd}
