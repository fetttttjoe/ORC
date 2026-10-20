# packages/cli/src/cwd-workspace.ts

## Why
- cwdAuthor throws when the checkout has no workspace record, because Author.workspaceId is captured at write time and never recoverable, so a placeholder would file the claim under the wrong checkout forever. {hluyniue @packages/cli/src/cwd-workspace.ts#cwdAuthor}
- cwdWorkspace throws on a miss rather than returning undefined, because boot adoption records the checkout before any handler runs, so a miss means no project context and a null would only resurface as a less actionable kernel refusal. {wthib8r7 @packages/cli/src/cwd-workspace.ts#cwdWorkspace}
