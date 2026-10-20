# packages/contracts/src/execution.ts

## Facts
- packages/contracts/src/execution.ts defines the ExecutorContext, AgentExecutor and ExecutionPort interfaces that the kernel and executor packages implement, decoupling the runtime from any specific execution backend. {lmhtpkk4 @packages/contracts/src/execution.ts#ExecutorContext #architecture-current}

## Why
- `rejected` is a verdict, not a malfunction: a retry re-runs only incomplete steps, so retrying a rejecting step would reproduce the same verdict; a verdict is answered by changing the plan. {c53h3hkx @packages/contracts/src/execution.ts#FailureClass}
- listModels rejects when it cannot answer and returns [] only when it answered with nothing usable, because discovery's append-on-change must tell a positively empty catalog from silence. {lerwnl39 @packages/contracts/src/execution.ts#ModelProvider}
- `partial` is a third outcome so an agent out of iterations reports what remains instead of dying as agent_error, whose retry forgets everything but the workspace; the runtime, not the agent, grants continuation rounds. {u1h5eqmu @packages/contracts/src/execution.ts#SignalOutcome}
