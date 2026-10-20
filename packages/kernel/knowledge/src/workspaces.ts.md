# packages/kernel/src/workspaces.ts

## Why
- workspaceHealth scans the whole log twice per workspace, so listing a project costs O(workspaces x events); its cost past a handful of checkouts is unmeasured. {tvcnrt4y @packages/kernel/src/workspaces.ts#workspaceHealth}
