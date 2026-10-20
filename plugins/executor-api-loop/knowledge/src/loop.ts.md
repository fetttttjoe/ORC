# plugins/executor-api-loop/src/loop.ts

## Facts
- apiLoopExecutor (plugins/executor-api-loop/src/loop.ts) exposes an AgentExecutor whose startTurn generator loops up to ctx.step.maxIterations calling generateText and executing tool calls, ending the turn only on a valid `signal` tool call. {bkm9r1o0 @plugins/executor-api-loop/src/loop.ts#apiLoopExecutor #architecture-current}

## Why
- The final iteration of apiLoopExecutor's loop offers only {signal: signalTool} instead of the full tool set, forcing the model to call signal rather than continue exploring when maxIterations is about to be exhausted. {2xbms7zi @plugins/executor-api-loop/src/loop.ts #architecture-current}
- loop.ts's callModel rethrows transient errors as-is so the port's durable checkpoint retries with backoff, and wraps non-transient errors with terminalError so they are not retried. {qwiij6r9 @plugins/executor-api-loop/src/loop.ts#callModel #architecture-current}
- dedupeToolUseParts strips repeated tool_use ids from the assistant message replayed to the provider, because that raw output otherwise keeps two tool_use blocks answered by one tool_result and the next request fails with a 400. {wa2wykty @plugins/executor-api-loop/src/loop.ts#dedupeToolUseParts}
- uniqueByCallId drops a repeated provider tool call id where provider output enters, because a shared operationId would make the journal keep one row while the loop pushed two tool_result blocks and the provider would answer 400. {jarb3v5p @plugins/executor-api-loop/src/loop.ts#uniqueByCallId}
- withoutToolResults removes the SDK's own error result for an invalid tool call so the loop's result, which names the tool's contract, is the only answer for that id; keeping both makes the provider reject the request. {bq8oyyap @plugins/executor-api-loop/src/loop.ts#withoutToolResults}
