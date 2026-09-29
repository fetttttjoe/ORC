# plugins/executor-api-loop

## Facts
- plugins/executor-api-loop implements apiLoopExecutor, the AgentExecutor that drives generateText/tool-call turns to completion, offers built-in fs/signal/join_splits/ask_human tools, enforces a zone write-fence and in-process write claims on every write, and classifies provider errors as transient vs terminal for retry/rate-limit handling. {aoyozj2p @plugins/executor-api-loop #architecture-current}
