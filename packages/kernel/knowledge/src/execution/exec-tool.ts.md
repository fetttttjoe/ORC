# packages/kernel/src/execution/exec-tool.ts

## Facts
- execTool in packages/kernel/src/execution/exec-tool.ts registers no tool at all when its allowlist is empty, and otherwise runs allowlisted commands with no shell (commandArgv splits on whitespace but honours single and double quotes; shell metacharacters stay literal), caching results per (workspace, command, tree-fingerprint) for a 15-minute REUSE_TTL_MS. {xt2x4ho7 @packages/kernel/src/execution/exec-tool.ts#execTool #architecture-current}

## Why
- exec is not a sandbox, because an allowlisted 'bun test' runs model-written code with unrestricted writes, so enabling execAllowlist grants host code execution and the tool is absent unless configured. {6kxumitq @packages/kernel/src/execution/exec-tool.ts#execTool}
- exec commands come from the operator's execAllowlist and the model may only extend one at a token boundary, so 'bun test' permits 'bun test x.test.ts' but never 'bun testx'. {hk23u8ws @packages/kernel/src/execution/exec-tool.ts#execTool}
- exec exists so a step can run the acceptance gates itself; without it an implementer could ship an unexecuted suite and an honest auditor could only refuse certification. {jcv77b8n @packages/kernel/src/execution/exec-tool.ts#execTool}
