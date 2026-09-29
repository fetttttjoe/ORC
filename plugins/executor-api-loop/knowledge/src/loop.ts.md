# plugins/executor-api-loop/src/loop.ts

## Facts
- apiLoopExecutor (plugins/executor-api-loop/src/loop.ts) exposes an AgentExecutor whose startTurn generator loops up to ctx.step.maxIterations calling generateText and executing tool calls, ending the turn only on a valid `signal` tool call. {bkm9r1o0 @plugins/executor-api-loop/src/loop.ts#apiLoopExecutor #architecture-current}

## Why
- The final iteration of apiLoopExecutor's loop offers only {signal: signalTool} instead of the full tool set, forcing the model to call signal rather than continue exploring when maxIterations is about to be exhausted. {2xbms7zi @plugins/executor-api-loop/src/loop.ts #architecture-current}
- loop.ts's callModel rethrows transient errors as-is so the port's durable checkpoint retries with backoff, and wraps non-transient errors with terminalError so they are not retried. {qwiij6r9 @plugins/executor-api-loop/src/loop.ts#callModel #architecture-current}
