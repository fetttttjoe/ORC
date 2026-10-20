# packages/kernel/src/execution/commit-tool.ts

## Why
- git_commit never passes --no-verify, so the commit-msg hook that refuses messages over two lines applies and its text is surfaced in the failure error. {3byntyrf @packages/kernel/src/execution/commit-tool.ts#commitTool}
- commit-tool's floor keeps three path sets because a pathspec matching nothing is an error: addable for add, paths for the commit (HEAD-only staged deletions included, else they silently uncommit), skippedIgnored for ignored untracked files, which would make add exit 1. {mayyrd7k @packages/kernel/src/execution/commit-tool.ts#commitTool.floorSets}
- commit-tool's git helper inherits the process environment, extended only for the temporary index, because git is operator infrastructure (signing agents, config) and the model contributes only argv data. {3ungz70h @packages/kernel/src/execution/commit-tool.ts#git}
- commit-tool's git helper passes --literal-pathspecs so recorded paths cannot act as pathspec magic, with an opt-out because check-ignore rejects the flag. {5czzqsnu @packages/kernel/src/execution/commit-tool.ts#git}
