# plugins/executor-api-loop/src/transient.ts

## Facts
- transient.ts's isTransient() classifies a provider error as retryable by walking its error chain (error-chain.ts errorChainNodes) and checking isRetryable, HTTP status in {408,409,429,500,502,503,504}, known network error codes (ECONNRESET, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, UND_ERR_*), or DOMException name TimeoutError. {e6heynic @plugins/executor-api-loop/src/transient.ts#isTransient @plugins/executor-api-loop/src/error-chain.ts#errorChainNodes #architecture-current}
