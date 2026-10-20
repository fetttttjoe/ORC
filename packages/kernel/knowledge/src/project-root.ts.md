# packages/kernel/src/project-root.ts

## Why
- resolveProjectRoot re-roots a directory only when git-dir and git-common-dir differ (a linked worktree), because identity is gitignored and re-rooting a subdirectory project would mint a duplicate project. {21lxi4nc @packages/kernel/src/project-root.ts#resolveProjectRoot}
