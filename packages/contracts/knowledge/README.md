# packages/contracts

## Facts
- packages/contracts (@orc/contracts) is the shared zod-schema and pure-function seam layer every other orc package imports from — it depends on nothing in the workspace, only npm's zod. It defines the vocabulary (TaskNode/TaskStatus, Plan/PlanStep, EventKind→PAYLOAD_SCHEMAS, the memory-note/MemoryStore domain, Scope, ExecutorContext/AgentExecutor/ExecutionPort) that kernel, storage, executor, memory, providers, cli and ui all speak in common. {dwybroyq @packages/contracts #architecture-current}
