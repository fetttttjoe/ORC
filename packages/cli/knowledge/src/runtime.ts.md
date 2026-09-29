# packages/cli/src/runtime.ts

## Facts
- packages/cli/src/runtime.ts's buildRuntime() assembles the step tool set inside its stepTools closure from bound memory tools, bound knowledge tools (bindStepKnowledge), splitTool, readAnnotationsTool, reportCoverageTool, scopedChangesTool, finishTools, commitTool, execTool, and finalizePlanTool, each gated on step role/config; memoryVerifyTool is no longer among them. {x285dzet @packages/cli/src/runtime.ts#buildRuntime}
