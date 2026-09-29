# packages/kernel/src/execution/exec-tool.ts

## Facts
- execTool in packages/kernel/src/execution/exec-tool.ts registers no tool at all when its allowlist is empty, and otherwise runs allowlisted commands with no shell (argv split on whitespace, shell metacharacters are inert), caching results per (workspace, command, tree-fingerprint) for a 15-minute REUSE_TTL_MS. {xt2x4ho7 @packages/kernel/src/execution/exec-tool.ts#execTool #architecture-current}
