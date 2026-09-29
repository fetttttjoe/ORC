---
status: accepted
tags: area-cli, area-execution
---

# A step's git operations run in the step's own checkout, never the supervisor's

## Context

One supervisor serves every workspace at once; a task in an orc worktree writes its source, knowledge and decision files into its own checkout; commitTool was built with config.dir, so it previewed and committed the supervisor's checkout, and nothing reported it.

## Decision

Every tool a step uses to read or change the tree (fs, exec, knowledge, decisions, commit) is bound to p.workspaceDir, the checkout the step runs in; config.dir is only the supervisor's own home.

## Consequences

A task in a worktree commits into its branch; a new step tool that touches the tree takes p.workspaceDir, and a test runs it with a second checkout as the run cwd.

## Considered

- Keep config.dir (it commits the wrong checkout).
- Resolve each author's workspace per call from the workspace table (it folds the whole log on every call).
